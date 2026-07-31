import Anthropic from "@anthropic-ai/sdk";
import { asRecord, isoDate, num, str } from "./extract-fields";
import type { SupplierInvoiceInput } from "./validation";

/**
 * A supplier invoice extracted from a PDF by Claude, shaped exactly like the
 * manual form's input so the same zod schema and server action accept it.
 * `orderId` is never guessed by the model — the reviewer links the order.
 */
export type ExtractedInvoice = Omit<SupplierInvoiceInput, "orderId" | "currency"> & {
  currency: string | null;
};

export type ExtractInvoiceResult =
  | { ok: true; invoice: ExtractedInvoice; warnings: string[] }
  | { ok: false; error: string };

/** תוספת שמוצעת בכל הודעת כשל — תמיד אפשר להזין את החשבונית ידנית. */
const MANUAL_FALLBACK = " ניתן להזין את החשבונית ידנית בטופס.";

// ---------------------------------------------------------------------------
// Pure normalization (exported for the unit test — no API calls, `today`
// injected exactly like src/lib/extract-order.ts so date checks are deterministic)
// ---------------------------------------------------------------------------

/**
 * Pure. Turns the model's raw tool input into an ExtractedInvoice plus Hebrew
 * warnings for anything a human should double-check. `today` is injected so the
 * date-range check is testable.
 */
export function normalizeExtractedInvoice(
  raw: unknown,
  fileName: string,
  today: Date = new Date(),
): { invoice: ExtractedInvoice; warnings: string[] } {
  const obj = asRecord(raw);
  const warnings: string[] = [];

  // Model-emitted warnings come first; local checks append to them.
  if (Array.isArray(obj.warnings)) {
    for (const w of obj.warnings) if (typeof w === "string" && w.trim()) warnings.push(w.trim());
  }

  const supplier = str(obj.supplier);
  const invoiceNumber = str(obj.invoiceNumber);
  if (!supplier) warnings.push("לא זוהה שם הספק — יש למלא ידנית");
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

  // Prefer the total including VAT when the document shows both — that is the
  // amount actually paid to the supplier.
  const total = num(obj.totalAmount);
  const subtotal = num(obj.subtotalAmount);
  const amount = total ?? subtotal;
  if (amount === null) {
    warnings.push("לא זוהה סכום החשבונית — יש למלא ידנית");
  } else if (total === null) {
    warnings.push(`הסכום ${subtotal} נלקח מסכום לפני מע"מ — לא נמצא סכום כולל במסמך`);
  }

  const currency = str(obj.currency);
  if (currency && !/^(ils|nis|₪|שקל|ש"ח|שח)$/i.test(currency)) {
    warnings.push(`המטבע בחשבונית (${currency}) אינו שקל — לא בוצעה המרה, יש לבדוק ידנית`);
  }

  const notes = [str(obj.summary), str(obj.notes)].filter(Boolean).join(" · ") || null;

  return {
    invoice: {
      supplier: supplier ?? "",
      invoiceNumber: invoiceNumber ?? "",
      invoiceDate,
      poNumber: str(obj.poNumber),
      amount: amount === null ? null : String(amount),
      currency: currency && /^(ils|nis|₪|שקל|ש"ח|שח)$/i.test(currency) ? "ILS" : currency,
      notes: notes ?? `מתוך ${fileName}`,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Extraction via the Messages API
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `אתה מחלץ נתונים מחשבוניות של ספקים (Supplier Invoices) שמתקבלות אצל חברת אלקטרוניקה ישראלית. המסמך המצורף הוא PDF של חשבונית ספק. עליך להחזיר את הנתונים דרך הכלי submit_invoice בלבד. אל תמציא נתונים — שדה שלא נקרא בבירור, השמט אותו.

הספק (supplier):
- שם החברה שהוציאה את החשבונית (מי שמבקש את הכסף), לא שם החברה המקבלת.
- החברה שלנו היא הלקוח בחשבונית — אל תחזיר את שמה בשדה supplier.
- ספקים אופייניים: מפיצי רכיבים בארץ ובחו"ל (למשל DigiKey, Mouser, AXTON) וגם חברות הובלה ושילוח.

מספר חשבונית (invoiceNumber):
- המספר שהספק נתן למסמך ("חשבונית מס' ", Invoice No, Invoice #).
- מלכודת: אל תחזיר את מספר ההזמנה שלנו, מספר תעודת משלוח, מספר אסמכתא או מספר עוסק מורשה.

הזמנת רכש (poNumber):
- מספר ההזמנה שלנו כפי שהספק מצטט אותו במסמך (Your Order, PO Number, "הזמנתכם").

סכומים:
- subtotalAmount = הסכום לפני מע"מ.
- totalAmount = הסכום הכולל לתשלום, כולל מע"מ.
- אם מופיע רק אחד מהם — החזר אותו בשדה המתאים והשמט את השני. אל תחשב מע"מ בעצמך.
- currency = מטבע המסמך (ILS, USD, EUR). אם המטבע זר אל תמיר לשקלים והוסף warning.

כללים כלליים:
- תאריכים: החזר בפורמט ISO בלבד, yyyy-mm-dd. המר פורמטים כמו 15.7.2026, ‏15/7/2026 וגם 15/7/26. invoiceDate הוא תאריך הוצאת החשבונית, לא תאריך התשלום.
- מספרים: הסר סימני ₪ ו-$ ופסיקי אלפים.
- summary = תיאור קצר בעברית של מה נכלל בחשבונית (למשל "12 רכיבים, הובלה אווירית"), עד שורה אחת.
- אם המסמך אינו חשבונית ספק — השמט את invoiceNumber והוסף warning שמסביר מה המסמך כן (הצעת מחיר, תעודת משלוח, הזמנת רכש וכו').
- warnings: כתוב בעברית כל דבר שדורש עין אנושית (שדה מטושטש, נתון שלא היית בטוח בו, אי-התאמה בין סכומים וכו').`;

const SUBMIT_INVOICE_TOOL: Anthropic.Tool = {
  name: "submit_invoice",
  description:
    "מחזיר את הנתונים המחולצים מחשבונית הספק. השמט כל שדה שלא נקרא בבירור מהמסמך — אל תמציא. warnings תמיד נדרש (גם אם ריק).",
  input_schema: {
    type: "object",
    properties: {
      supplier: {
        type: "string",
        description: "שם הספק שהוציא את החשבונית (מי שמבקש את הכסף).",
      },
      invoiceNumber: {
        type: "string",
        description: "מספר החשבונית שהספק נתן למסמך.",
      },
      invoiceDate: {
        type: "string",
        description: "תאריך הוצאת החשבונית בפורמט yyyy-mm-dd.",
      },
      poNumber: {
        type: "string",
        description: "מספר הזמנת הרכש שלנו כפי שהוא מצוטט בחשבונית.",
      },
      subtotalAmount: { type: "number", description: 'הסכום לפני מע"מ.' },
      totalAmount: { type: "number", description: 'הסכום הכולל לתשלום, כולל מע"מ.' },
      currency: { type: "string", description: "מטבע המסמך (ILS, USD, EUR וכו')." },
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
 * Send a base64 PDF to Claude and return a structured supplier invoice (or a
 * Hebrew error message, all of which suggest the manual-entry fallback). Runs on
 * the server only — reads ANTHROPIC_API_KEY from the environment.
 */
export async function extractInvoiceFromPdf(
  pdfBase64: string,
  fileName: string,
): Promise<ExtractInvoiceResult> {
  // timeout is in MILLISECONDS (SDK default is 10 minutes). Without this the
  // request would outlive Vercel's 60s function limit and get killed with no
  // clean error. maxRetries: 0 because wall-clock = timeout × (retries + 1).
  const anthropic = new Anthropic({ maxRetries: 0, timeout: 50_000 });

  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create({
      model: process.env.EXTRACT_MODEL ?? "claude-sonnet-5",
      max_tokens: 4000,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      tools: [SUBMIT_INVOICE_TOOL],
      tool_choice: { type: "tool", name: "submit_invoice" },
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
              text: `חלץ את פרטי חשבונית הספק מהמסמך המצורף (שם הקובץ: ${fileName}) והחזר אותם דרך הכלי submit_invoice.`,
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
      return { ok: false, error: `שגיאת אימות מול Claude — בדוק את ANTHROPIC_API_KEY.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, error: `Claude עמוס כרגע (מגבלת קצב) — נסה שוב בעוד רגע.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return { ok: false, error: `החילוץ לקח יותר מדי זמן או שנכשל החיבור ל-Claude.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, error: `שגיאה מ-Claude בזמן החילוץ.${MANUAL_FALLBACK}` };
    }
    return { ok: false, error: `שגיאה לא צפויה בזמן החילוץ.${MANUAL_FALLBACK}` };
  }

  if (message.stop_reason === "max_tokens") {
    return { ok: false, error: `המסמך ארוך מדי — פלט החילוץ נקטע.${MANUAL_FALLBACK}` };
  }
  if (message.stop_reason === "refusal") {
    return { ok: false, error: `החילוץ נדחה על ידי המודל.${MANUAL_FALLBACK}` };
  }

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (toolUse?.type !== "tool_use") {
    return { ok: false, error: `לא התקבל פלט מובנה מהחילוץ.${MANUAL_FALLBACK}` };
  }

  const { invoice, warnings } = normalizeExtractedInvoice(toolUse.input, fileName);

  // Supplier + invoice number are the identity of the document; without them
  // there is nothing to save (and nothing to dedupe against).
  if (!invoice.supplier || !invoice.invoiceNumber) {
    const explanation = warnings.length ? ` (${warnings.join("; ")})` : "";
    return { ok: false, error: `לא זוהתה חשבונית ספק במסמך${explanation}.${MANUAL_FALLBACK}` };
  }

  return { ok: true, invoice, warnings };
}
