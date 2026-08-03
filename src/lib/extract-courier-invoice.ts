import Anthropic from "@anthropic-ai/sdk";
import { asRecord, fmtAmount, isoDate, num, str } from "./extract-fields";
import type { CourierShipmentInput } from "./validation";

/**
 * A courier invoice read out of a PDF: the header, plus one row per shipment it
 * charges for. The shipments are the whole point — each carries the tracking
 * number that ties a charge to an order line, which is what lets the cost reach
 * the monthly summary. `lineId` is never guessed by the model; matching happens
 * in code (lib/courier-match) and is confirmed by a human.
 */
export interface ExtractedCourierInvoice {
  courier: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  amount: string | null;
  currency: string | null;
  notes: string | null;
  shipments: CourierShipmentInput[];
}

export type ExtractCourierInvoiceResult =
  | { ok: true; invoice: ExtractedCourierInvoice; warnings: string[] }
  | { ok: false; error: string };

/** תוספת שמוצעת בכל הודעת כשל — תמיד אפשר להזין את החשבונית ידנית. */
const MANUAL_FALLBACK = " ניתן להזין את החשבונית ידנית בטופס.";

const SHEKEL = /^(ils|nis|₪|שקל|ש"ח|שח)$/i;

// ---------------------------------------------------------------------------
// Pure normalization (exported for the unit test — no API calls, `today`
// injected like the other extractors so the date checks are deterministic)
// ---------------------------------------------------------------------------

function normalizeShipments(raw: unknown, warnings: string[]): CourierShipmentInput[] {
  if (!Array.isArray(raw)) return [];
  const shipments: CourierShipmentInput[] = [];
  let missingAmount = 0;

  for (const item of raw) {
    const obj = asRecord(item);
    const bol = str(obj.trackingNumber) ?? str(obj.bol);
    const reference = str(obj.reference);
    const amount = num(obj.amount);
    // The description carries the shipment's own date when it has one: it is
    // context for the reviewer, not a field anything computes with.
    const date = str(obj.date);
    const description = [str(obj.description), date].filter(Boolean).join(" · ") || null;

    // A row with nothing on it is a table artifact, not a charge.
    if (!bol && !reference && !description && amount === null) continue;
    if (amount === null) missingAmount++;

    shipments.push({
      bol,
      reference,
      description,
      amount: amount === null ? null : String(amount),
      lineId: null,
    });
  }

  if (missingAmount > 0) {
    warnings.push(
      missingAmount === 1
        ? "למשלוח אחד בחשבונית לא זוהה סכום — יש להשלים ידנית"
        : `ל-${missingAmount} משלוחים בחשבונית לא זוהה סכום — יש להשלים ידנית`,
    );
  }
  return shipments;
}

/**
 * Pure. Turns the model's raw tool input into an ExtractedCourierInvoice plus
 * Hebrew warnings for anything a human should double-check.
 */
export function normalizeExtractedCourierInvoice(
  raw: unknown,
  fileName: string,
  today: Date = new Date(),
): { invoice: ExtractedCourierInvoice; warnings: string[] } {
  const obj = asRecord(raw);
  const warnings: string[] = [];

  // Model-emitted warnings come first; local checks append to them.
  if (Array.isArray(obj.warnings)) {
    for (const w of obj.warnings) if (typeof w === "string" && w.trim()) warnings.push(w.trim());
  }

  const courier = str(obj.courier);
  const invoiceNumber = str(obj.invoiceNumber);
  if (!courier) warnings.push("לא זוהה שם הבלדר — יש למלא ידנית");
  if (!invoiceNumber) warnings.push("לא זוהה מספר חשבונית — יש למלא ידנית");

  const invoiceDate = isoDate(obj.invoiceDate, "תאריך חשבונית", warnings);
  if (!invoiceDate) {
    warnings.push("לא זוהה תאריך חשבונית — יש למלא ידנית");
  } else {
    const year = Number(invoiceDate.slice(0, 4));
    if (year < 2000 || year > today.getFullYear() + 1) {
      warnings.push(
        `תאריך החשבונית ${invoiceDate} חורג מהטווח הצפוי (2000 עד ${today.getFullYear() + 1})`,
      );
    }
  }

  // Header total: what the courier is owed, so the printed total including VAT,
  // exactly like a supplier invoice.
  const total = num(obj.totalAmount);
  const subtotal = num(obj.subtotalAmount);
  const amount = total ?? subtotal;
  if (amount === null) {
    warnings.push("לא זוהה סכום החשבונית — יש למלא ידנית");
  } else if (total === null) {
    warnings.push(`הסכום ${fmtAmount(subtotal!)} נלקח מסכום לפני מע"מ — לא נמצא סכום כולל במסמך`);
  }

  const currency = str(obj.currency);
  if (currency && !SHEKEL.test(currency)) {
    warnings.push(
      `המטבע בחשבונית (${currency}) אינו שקל — לא בוצעה המרה, ולא ניתן לשייך עלות משלוח שאינה בשקלים`,
    );
  }

  const shipments = normalizeShipments(obj.shipments, warnings);
  if (shipments.length === 0) {
    warnings.push("לא זוהו משלוחים בחשבונית — יש לשייך את העלות לשורות ידנית");
  } else {
    // Per-shipment charges are usually pre-VAT while the header total is not, so
    // a sum that matches either one is fine and only a third number is a problem.
    const sum = shipments.reduce((acc, s) => acc + (s.amount ? Number(s.amount) : 0), 0);
    const matchesEither = [subtotal, total].some((v) => v !== null && Math.abs(sum - v) < 1);
    if (sum > 0 && amount !== null && !matchesEither) {
      warnings.push(
        `סכום המשלוחים (${fmtAmount(sum)}) אינו תואם את סכומי החשבונית (${fmtAmount(amount)}) — יש לבדוק אם חסר משלוח או חיוב נוסף`,
      );
    }
  }

  const notes = [str(obj.summary), str(obj.notes)].filter(Boolean).join(" · ") || null;

  return {
    invoice: {
      courier: courier ?? "",
      invoiceNumber: invoiceNumber ?? "",
      invoiceDate,
      amount: amount === null ? null : String(amount),
      currency: currency && SHEKEL.test(currency) ? "ILS" : currency,
      notes: notes ?? `מתוך ${fileName}`,
      shipments,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Extraction via the Messages API
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `אתה מחלץ נתונים מחשבוניות של חברות שילוח ובלדרות (Courier / Freight Invoices) שמתקבלות אצל חברת אלקטרוניקה ישראלית. המסמך המצורף הוא PDF של חשבונית בלדר. עליך להחזיר את הנתונים דרך הכלי submit_courier_invoice בלבד. אל תמציא נתונים — שדה שלא נקרא בבירור, השמט אותו.

הבלדר (courier):
- שם חברת השילוח שהוציאה את החשבונית (מי שמבקש את הכסף): DHL, UPS, FedEx, TNT, דואר ישראל, חברות בלדרות מקומיות וכו'.
- החברה שלנו היא הלקוח בחשבונית — אל תחזיר את שמה בשדה courier.

מספר חשבונית (invoiceNumber):
- המספר שהבלדר נתן למסמך ("חשבונית מס' ", Invoice No, Invoice Number).
- מלכודת: אל תחזיר מספר חשבון לקוח (Account Number), מספר אסמכתא או מספר עוסק מורשה.

משלוחים (shipments) — זה החלק החשוב:
- חשבונית בלדר היא בדרך כלל טבלה של משלוחים. החזר שורה אחת לכל משלוח.
- trackingNumber = מספר המשלוח / שטר המטען / Tracking Number / AWB / Waybill. זה השדה הקריטי — דרכו משויכת עלות המשלוח להזמנה שלנו.
- reference = מספר האסמכתא שלנו שהבלדר מצטט (Reference, Shipper Reference, "הזמנתכם") — לרוב מספר הזמנת רכש או מספר הזמנה.
- description = תיאור קצר (יעד, סוג שירות, משקל) — עד שורה אחת.
- date = תאריך המשלוח בפורמט yyyy-mm-dd, אם מופיע.
- amount = החיוב עבור אותו משלוח בלבד, כפי שמופיע בשורה. אל תחשב ואל תפצל בעצמך.
- אל תמציא מספרי מעקב. משלוח בלי מספר מעקב — החזר אותו עם reference ו-description בלבד.
- שורות שאינן משלוח (סה"כ, מע"מ, הנחה) אינן shipments. חיוב נוסף שחל על כל החשבונית (למשל היטל דלק) אפשר להחזיר כמשלוח בלי מספר מעקב, עם description שמסביר מה זה.

סכומים:
- subtotalAmount = הסכום לפני מע"מ.
- totalAmount = הסכום הכולל לתשלום, כולל מע"מ.
- אם מופיע רק אחד מהם — החזר אותו בשדה המתאים והשמט את השני. אל תחשב מע"מ בעצמך.
- currency = מטבע המסמך (ILS, USD, EUR). אם המטבע זר אל תמיר לשקלים והוסף warning.

כללים כלליים:
- תאריכים: החזר בפורמט ISO בלבד, yyyy-mm-dd. המר פורמטים כמו 15.7.2026, ‏15/7/2026 וגם 15/7/26. invoiceDate הוא תאריך הוצאת החשבונית.
- מספרים: הסר סימני ₪ ו-$ ופסיקי אלפים.
- summary = תיאור קצר בעברית של מה נכלל בחשבונית (למשל "4 משלוחים אוויריים לחו"ל"), עד שורה אחת.
- אם המסמך אינו חשבונית של חברת שילוח — השמט את invoiceNumber והוסף warning שמסביר מה המסמך כן (תעודת משלוח, חשבונית ספק רגילה, הצעת מחיר וכו').
- warnings: כתוב בעברית כל דבר שדורש עין אנושית (שדה מטושטש, סכום שלא הסתכם, מספר מעקב חלקי וכו').`;

const SUBMIT_COURIER_INVOICE_TOOL: Anthropic.Tool = {
  name: "submit_courier_invoice",
  description:
    "מחזיר את הנתונים המחולצים מחשבונית הבלדר, כולל שורה לכל משלוח. השמט כל שדה שלא נקרא בבירור מהמסמך — אל תמציא. warnings תמיד נדרש (גם אם ריק).",
  input_schema: {
    type: "object",
    properties: {
      courier: {
        type: "string",
        description: "שם חברת השילוח שהוציאה את החשבונית (מי שמבקש את הכסף).",
      },
      invoiceNumber: { type: "string", description: "מספר החשבונית שהבלדר נתן למסמך." },
      invoiceDate: { type: "string", description: "תאריך הוצאת החשבונית בפורמט yyyy-mm-dd." },
      subtotalAmount: { type: "number", description: 'הסכום לפני מע"מ.' },
      totalAmount: { type: "number", description: 'הסכום הכולל לתשלום, כולל מע"מ.' },
      currency: { type: "string", description: "מטבע המסמך (ILS, USD, EUR וכו')." },
      shipments: {
        type: "array",
        description: "שורה לכל משלוח שמחויב בחשבונית.",
        items: {
          type: "object",
          properties: {
            trackingNumber: {
              type: "string",
              description: "מספר המשלוח / שטר המטען / AWB כפי שמופיע בשורה.",
            },
            reference: {
              type: "string",
              description: "האסמכתא שלנו שהבלדר מצטט (הזמנת רכש או מספר הזמנה).",
            },
            description: { type: "string", description: "יעד / סוג שירות / משקל, עד שורה אחת." },
            date: { type: "string", description: "תאריך המשלוח בפורמט yyyy-mm-dd." },
            amount: { type: "number", description: "החיוב עבור המשלוח הזה בלבד." },
          },
        },
      },
      summary: {
        type: "string",
        description: "תיאור קצר בעברית של תכולת החשבונית, עד שורה אחת.",
      },
      warnings: {
        type: "array",
        description: "אזהרות בעברית לכל דבר שדורש בדיקה אנושית.",
        items: { type: "string" },
      },
    },
    required: ["warnings"],
  },
};

/**
 * Send a base64 PDF to Claude and return a structured courier invoice (or a
 * Hebrew error message, all of which suggest the manual-entry fallback). Runs on
 * the server only — reads ANTHROPIC_API_KEY from the environment.
 */
export async function extractCourierInvoiceFromPdf(
  pdfBase64: string,
  fileName: string,
): Promise<ExtractCourierInvoiceResult> {
  // timeout is in MILLISECONDS (SDK default is 10 minutes). Without this the
  // request would outlive Vercel's 60s function limit and get killed with no
  // clean error. maxRetries: 0 because wall-clock = timeout × (retries + 1).
  const anthropic = new Anthropic({ maxRetries: 0, timeout: 50_000 });

  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create({
      model: process.env.EXTRACT_MODEL ?? "claude-sonnet-5",
      max_tokens: 8000, // a courier invoice can list dozens of shipments
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      tools: [SUBMIT_COURIER_INVOICE_TOOL],
      tool_choice: { type: "tool", name: "submit_courier_invoice" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
            },
            {
              type: "text",
              text: `חלץ את פרטי חשבונית הבלדר מהמסמך המצורף (שם הקובץ: ${fileName}), כולל שורה לכל משלוח, והחזר אותם דרך הכלי submit_courier_invoice.`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    // Specific-first: AuthenticationError and RateLimitError extend APIError but
    // not APIConnectionError; APIConnectionError (incl. timeouts) extends APIError
    // and must be checked before it.
    if (err instanceof Anthropic.AuthenticationError) {
      return {
        ok: false,
        error: `שגיאת אימות בשירות החילוץ — יש לבדוק את מפתח ה-API.${MANUAL_FALLBACK}`,
      };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, error: `שירות החילוץ עמוס כרגע (מגבלת קצב) — נסה שוב בעוד רגע.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return { ok: false, error: `החילוץ לקח יותר מדי זמן או שנכשל החיבור לשירות החילוץ.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, error: `שגיאה בשירות החילוץ.${MANUAL_FALLBACK}` };
    }
    return { ok: false, error: `שגיאה לא צפויה בזמן החילוץ.${MANUAL_FALLBACK}` };
  }

  if (message.stop_reason === "max_tokens") {
    return { ok: false, error: `המסמך ארוך מדי — פלט החילוץ נקטע.${MANUAL_FALLBACK}` };
  }
  if (message.stop_reason === "refusal") {
    return { ok: false, error: `החילוץ נדחה.${MANUAL_FALLBACK}` };
  }

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (toolUse?.type !== "tool_use") {
    return { ok: false, error: `לא התקבל פלט מובנה מהחילוץ.${MANUAL_FALLBACK}` };
  }

  const { invoice, warnings } = normalizeExtractedCourierInvoice(toolUse.input, fileName);

  // Courier + invoice number are the identity of the document; without them there
  // is nothing to save (and nothing to dedupe against).
  if (!invoice.courier || !invoice.invoiceNumber) {
    const explanation = warnings.length ? ` (${warnings.join("; ")})` : "";
    return { ok: false, error: `לא זוהתה חשבונית בלדר במסמך${explanation}.${MANUAL_FALLBACK}` };
  }

  return { ok: true, invoice, warnings };
}
