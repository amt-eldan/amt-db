import Anthropic from "@anthropic-ai/sdk";
import { asRecord, fmtAmount, isoDate, num, str } from "./extract-fields";
import type { CourierChargeInput, CourierShipmentInput } from "./validation";

/**
 * A courier invoice read out of a PDF: the header, plus one row per shipment it
 * charges for. The shipments are the whole point — each carries the tracking
 * number that ties a charge to an order line, which is what lets the cost reach
 * the monthly summary. `lineId` is never guessed by the model; matching happens
 * in code (lib/courier-match) and is confirmed by a human.
 *
 * Each shipment also carries the invoice's own itemization of its cost (`charges`)
 * where the document prints one, so a shipping cost of 531.78 arrives with the
 * customs fees, clearance service and VAT that make it up rather than as a lump
 * sum nobody can account for.
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

const CHARGE_KINDS = new Set<CourierChargeInput["kind"]>([
  "service",
  "tax",
  "fee",
  "vat",
  "discount",
  "other",
]);

function chargeKind(value: unknown): CourierChargeInput["kind"] {
  const kind = str(value)?.toLowerCase() as CourierChargeInput["kind"] | undefined;
  return kind && CHARGE_KINDS.has(kind) ? kind : "other";
}

/**
 * The itemized components of one shipment's cost. A component with no label
 * explains nothing, so it is dropped rather than shown as a nameless number.
 */
function normalizeCharges(raw: unknown): CourierChargeInput[] {
  if (!Array.isArray(raw)) return [];
  const charges: CourierChargeInput[] = [];
  for (const item of raw) {
    const obj = asRecord(item);
    const label = str(obj.label) ?? str(obj.description);
    if (!label) continue;
    const amount = num(obj.amount);
    charges.push({
      label,
      amount: amount === null ? null : String(amount),
      kind: chargeKind(obj.kind),
    });
  }
  return charges;
}

/** Money adds up in agorot: 0.1 + 0.2 must not become 0.30000000000000004. */
function sumMoney(values: number[]): number {
  return values.reduce((acc, v) => acc + Math.round(v * 100), 0) / 100;
}

/** How a warning names the shipment it is about, when the reviewer has to find it. */
function shipmentLabel(
  bol: string | null,
  reference: string | null,
  description: string | null,
  index: number,
): string {
  return bol ?? reference ?? description ?? `שורה ${index + 1}`;
}

function normalizeShipments(raw: unknown, warnings: string[]): CourierShipmentInput[] {
  if (!Array.isArray(raw)) return [];
  const shipments: CourierShipmentInput[] = [];
  let missingAmount = 0;
  const derived: string[] = [];
  const mismatched: string[] = [];

  raw.forEach((item, index) => {
    const obj = asRecord(item);
    const bol = str(obj.trackingNumber) ?? str(obj.bol);
    const reference = str(obj.reference);
    const charges = normalizeCharges(obj.charges);
    let amount = num(obj.amount);
    // The description carries the shipment's own date when it has one: it is
    // context for the reviewer, not a field anything computes with.
    const date = str(obj.date);
    const description = [str(obj.description), date].filter(Boolean).join(" · ") || null;

    // A row with nothing on it is a table artifact, not a charge.
    if (!bol && !reference && !description && amount === null && charges.length === 0) return;

    // The breakdown is what the total is made of, so the two must agree. When the
    // document itemized the charges but no line total was read, the components are
    // the better source — adding them up is not a guess.
    const itemized = charges
      .map((c) => (c.amount === null ? null : Number(c.amount)))
      .filter((v): v is number => v !== null);
    const chargeSum = itemized.length === 0 ? null : sumMoney(itemized);
    const label = shipmentLabel(bol, reference, description, index);
    if (amount === null && chargeSum !== null) {
      amount = chargeSum;
      derived.push(label);
    } else if (amount !== null && chargeSum !== null && Math.abs(chargeSum - amount) >= 0.01) {
      mismatched.push(`${label}: פירוט ${fmtAmount(chargeSum)} מול סכום ${fmtAmount(amount)}`);
    }
    if (amount === null) missingAmount++;

    shipments.push({
      bol,
      reference,
      description,
      amount: amount === null ? null : String(amount),
      charges,
      lineId: null,
    });
  });

  if (missingAmount > 0) {
    warnings.push(
      missingAmount === 1
        ? "למשלוח אחד בחשבונית לא זוהה סכום — יש להשלים ידנית"
        : `ל-${missingAmount} משלוחים בחשבונית לא זוהה סכום — יש להשלים ידנית`,
    );
  }
  if (derived.length > 0) {
    warnings.push(
      `עלות המשלוח חושבה מסכום פירוט החיובים (${derived.join(", ")}) — יש לוודא מול המסמך`,
    );
  }
  if (mismatched.length > 0) {
    warnings.push(`פירוט החיובים אינו מסתכם לעלות המשלוח — ${mismatched.join("; ")}`);
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

    // The header prints its own VAT figure, so the VAT rows in the breakdowns have
    // something to be checked against — the cheapest way to catch a component read
    // off the wrong row.
    const headerVat = num(obj.vatAmount);
    const itemizedVat = sumMoney(
      shipments.flatMap((s) =>
        s.charges
          .filter((c) => c.kind === "vat" && c.amount !== null)
          .map((c) => Number(c.amount)),
      ),
    );
    if (headerVat !== null && itemizedVat > 0 && Math.abs(itemizedVat - headerVat) >= 0.01) {
      warnings.push(
        `סך המע"מ בפירוט המשלוחים (${fmtAmount(itemizedVat)}) אינו תואם את המע"מ בחשבונית (${fmtAmount(headerVat)}) — יש לבדוק את פירוט החיובים`,
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
- amount = הסכום הכולל של אותו משלוח בלבד, כפי שהחשבונית מסכמת אותו (שורת "סה"כ" של המשלוח, כולל מע"מ אם היא כוללת אותו). אל תחשב ואל תפצל בעצמך.
- אל תמציא מספרי מעקב. משלוח בלי מספר מעקב — החזר אותו עם reference ו-description בלבד.
- שורות שאינן משלוח (סה"כ, מע"מ, הנחה) אינן shipments. חיוב נוסף שחל על כל החשבונית (למשל היטל דלק) אפשר להחזיר כמשלוח בלי מספר מעקב, עם description שמסביר מה זה.

פירוט החיובים של כל משלוח (charges) — חשוב לא פחות:
- הרבה חשבוניות בלדר מפרטות ממה מורכב הסכום של כל משלוח: אגרות, מיסי יבוא, שירות שחרור ממכס, דמי טיפול, היטל דלק, מע"מ. החזר כל מרכיב כזה כשורה ב-charges של המשלוח שהוא שייך לו.
- דוגמה מחשבונית מיסי יבוא של DHL: משלוח אחד עם charges של "מע"מ מהצהרת יבוא" 378.00, "אגרת מחשב למכס" 21.00, "אגרת ביטחון למכס" 49.00, "שירות שחרור ממכס" 71.00 ו-"מע"מ" 12.78, ו-amount 531.78 שהוא שורת ה-סה"כ שלו.
- ב-FedEx / UPS / TNT הפירוט מופיע לרוב באנגלית (Fuel Surcharge, Duty, Tax, Clearance Fee, Remote Area, VAT) ולעיתים בשורות מתחת למשלוח — אותו דבר בדיוק: כל שורה כזו היא charge של המשלוח שמעליה.
- label = התיאור כפי שהוא מודפס בחשבונית, בשפת המסמך. אל תתרגם ואל תקצר לקוד.
- amount = הסכום של אותו מרכיב בלבד.
- kind = סוג המרכיב: "vat" למע"מ בלבד, "tax" למיסי יבוא ומכס, "fee" לאגרות ודמי טיפול קבועים, "service" לשירותי שילוח ושחרור והיטלים, "discount" להנחה או זיכוי (סכום שלילי), "other" כשלא ברור.
- מלכודת חשובה: אל תחזיר את שורת ה-סה"כ של המשלוח כ-charge. היא ה-amount של המשלוח, ולא מרכיב שלו — אחרת הפירוט יסתכם בכפליים.
- מלכודת שנייה: אל תחזיר מרכיבי חיוב כמשלוחים נפרדים. הם נכנסים ל-charges של המשלוח שלהם.
- מרכיבי הפירוט של משלוח צריכים להסתכם ל-amount שלו. אם בחשבונית הם לא מסתכמים — החזר אותם כפי שהם והוסף warning; אל "תתקן" מספרים.
- אם החשבונית אינה מפרטת ממה מורכב הסכום — החזר charges ריק. אל תפצל סכום בעצמך.

סכומים:
- subtotalAmount = הסכום לפני מע"מ.
- totalAmount = הסכום הכולל לתשלום, כולל מע"מ.
- vatAmount = סך המע"מ בחשבונית, אם מודפס ("סה"כ מע"מ", VAT).
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
    "מחזיר את הנתונים המחולצים מחשבונית הבלדר: שורה לכל משלוח, ולכל משלוח את פירוט החיובים שמרכיבים את הסכום שלו. השמט כל שדה שלא נקרא בבירור מהמסמך — אל תמציא. warnings תמיד נדרש (גם אם ריק).",
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
      vatAmount: { type: "number", description: 'סך המע"מ בחשבונית, אם מודפס.' },
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
            amount: {
              type: "number",
              description: 'סה"כ החיוב עבור המשלוח הזה בלבד, כפי שהחשבונית מסכמת אותו.',
            },
            charges: {
              type: "array",
              description:
                'מרכיבי הסכום של המשלוח כפי שהחשבונית מפרטת אותם (אגרות, מיסי יבוא, שירות שחרור, היטל דלק, מע"מ). בלי שורת ה-סה"כ עצמה. ריק אם אין פירוט.',
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "תיאור המרכיב כפי שהוא מודפס בחשבונית, בשפת המסמך.",
                  },
                  amount: { type: "number", description: "הסכום של המרכיב הזה בלבד." },
                  kind: {
                    type: "string",
                    enum: ["service", "tax", "fee", "vat", "discount", "other"],
                    description:
                      'vat = מע"מ, tax = מיסי יבוא ומכס, fee = אגרה או דמי טיפול, service = שילוח / שחרור / היטל, discount = הנחה או זיכוי, other = לא ברור.',
                  },
                },
                required: ["label"],
              },
            },
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
      // A courier invoice can list dozens of shipments, and each one now carries
      // its charge breakdown too — the output per shipment is several times what
      // it was. Truncation here costs the whole extraction (stop_reason below).
      max_tokens: 16_000,
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
              text: `חלץ את פרטי חשבונית הבלדר מהמסמך המצורף (שם הקובץ: ${fileName}): שורה לכל משלוח, ולכל משלוח את פירוט החיובים שמרכיבים את הסכום שלו. החזר את הנתונים דרך הכלי submit_courier_invoice.`,
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
