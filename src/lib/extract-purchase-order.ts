import Anthropic from "@anthropic-ai/sdk";
import { isOwnCompanyName, OWN_COMPANY_LABEL } from "./company";
import { asRecord, fmtAmount, isoDate, num, str } from "./extract-fields";
import type { PoLine } from "./po-match";

/**
 * Reading **our** purchase order to a supplier, for the one number on it that
 * exists nowhere else: the unit price we pay.
 *
 * A deliberate second extractor rather than a mode of ./extract-order, because
 * the two documents are mirror images and the fields mean opposite things. There,
 * the price on the page is what a customer pays us and lands in `unit_price`;
 * here it is what we pay a supplier and lands in `buy_price_usd`. Reading either
 * document with the other's extractor writes a cost as a revenue or the reverse,
 * which zeroes the profit on the order silently — so each one identifies the
 * document first and refuses the other outright.
 *
 * This extractor creates nothing. Its output is matched onto lines that already
 * exist from the customer's order (./po-match), and every match is reviewed by a
 * person before anything is written.
 */

export const PO_DOCUMENT_KINDS = ["our_purchase_order", "customer_order", "other"] as const;
export type PoDocumentKind = (typeof PO_DOCUMENT_KINDS)[number];

/** Currencies a unit cost may be read in. Anything else is reported, not guessed. */
export type PoCurrency = "USD" | "ILS";

export interface ExtractedPurchaseOrder {
  /** Our purchase-order number — the key the tracking agent already searches by. */
  poNumber: string;
  supplier: string;
  orderDate: string | null;
  currency: PoCurrency | null;
  lines: PoLine[];
}

export type PoExtractResult =
  | { ok: true; order: ExtractedPurchaseOrder; warnings: string[] }
  | { ok: false; error: string };

const MANUAL_FALLBACK = " ניתן להזין מחיר קנייה ידנית בעריכת השורה.";

/** USD / ILS in the spellings that turn up on paper, or null for anything else. */
export function normalizePoCurrency(raw: string | null): PoCurrency | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (/^(usd|us\$|\$|dollar|dollars|דולר|דולרים)$/.test(t)) return "USD";
  if (/^(ils|nis|₪|shekel|shekels|שקל|שקלים|ש"ח|שח)$/.test(t)) return "ILS";
  return null;
}

/**
 * Pure. The model's raw tool input into an ExtractedPurchaseOrder plus Hebrew
 * warnings. `today` is injected so the date checks are deterministic in tests,
 * exactly as ./extract-order does it.
 */
export function normalizeExtractedPurchaseOrder(
  raw: unknown,
  today: Date = new Date(),
): { order: ExtractedPurchaseOrder; warnings: string[]; documentKind: PoDocumentKind } {
  const obj = asRecord(raw);
  const warnings: string[] = [];

  if (Array.isArray(obj.warnings)) {
    for (const w of obj.warnings) if (typeof w === "string" && w.trim()) warnings.push(w.trim());
  }

  // An omitted kind reads as the expected document; the refusal below is for one
  // positively identified as the customer's.
  const rawKind = str(obj.documentKind);
  const documentKind: PoDocumentKind = PO_DOCUMENT_KINDS.includes(rawKind as PoDocumentKind)
    ? (rawKind as PoDocumentKind)
    : "our_purchase_order";

  const poNumber = str(obj.poNumber);
  if (!poNumber) warnings.push("לא זוהה מספר הזמנת רכש — יש למלא ידנית לפני אישור");

  const supplierRead = str(obj.supplier);
  let supplier = supplierRead;
  if (supplierRead && isOwnCompanyName(supplierRead)) {
    // Our own name in the supplier field means the document was read the wrong
    // way round — we are the buyer here, and the supplier is the other party.
    warnings.push(
      `השם שזוהה כספק ("${supplierRead}") הוא שם החברה שלנו — בהזמנת רכש אנחנו המזמינים, לא הספק. יש להזין את שם הספק ידנית`,
    );
    supplier = null;
  } else if (!supplier) {
    warnings.push("לא זוהה שם ספק — יש למלא ידנית לפני אישור");
  }

  const orderDate = isoDate(obj.orderDate, "תאריך ההזמנה", warnings);
  if (orderDate) {
    const year = Number(orderDate.slice(0, 4));
    if (year < 2000 || year > today.getFullYear() + 5) {
      warnings.push(`תאריך ההזמנה ${orderDate} חורג מהטווח הצפוי`);
    }
  }

  const currencyRaw = str(obj.documentCurrency);
  const currency = normalizePoCurrency(currencyRaw);
  if (!currency) {
    warnings.push(
      currencyRaw
        ? `המטבע במסמך (${currencyRaw}) אינו דולר ואינו שקל — מחיר הקנייה לא ייקלט`
        : "לא זוהה מטבע במסמך — מחיר הקנייה לא ייקלט בלי לדעת באיזה מטבע הוא",
    );
  }

  const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
  const lines: PoLine[] = rawLines.map((rl, i) => {
    const line = asRecord(rl);
    const n = i + 1;
    const pn = str(line.pn);
    const sku = str(line.sku);
    const unitCost = num(line.unitCost);
    if (!pn && !sku) {
      warnings.push(`שורה ${n}: אין מק"ט יצרן ואין מספר קטלוגי — לא ניתן להתאים אותה לשורה`);
    }
    if (unitCost === null) warnings.push(`שורה ${n}: לא נקרא מחיר ליחידה`);
    return { pn, sku, qty: num(line.qty), unitCost, notes: str(line.notes) };
  });

  // Same two sanity checks the customer-order extractor runs, and for the same
  // reason: a half-read multi-page document produces a perfectly valid payload.
  const documentTotal = num(obj.documentTotal);
  if (documentTotal !== null) {
    const computed = lines.reduce((s, l) => s + (l.qty ?? 0) * (l.unitCost ?? 0), 0);
    if (Math.abs(documentTotal - computed) > 1) {
      warnings.push(
        `סה"כ לא תואם: ${fmtAmount(documentTotal)} במסמך מול ${fmtAmount(computed)} מחושב`,
      );
    }
  }
  const declaredLines = num(obj.documentLineCount);
  if (declaredLines !== null && declaredLines > lines.length) {
    warnings.push(
      `חולצו ${lines.length} שורות אך המסמך מצהיר על ${declaredLines} — ייתכן שעמוד שלם לא נקרא`,
    );
  }

  if (documentKind === "customer_order") {
    warnings.push(
      "המסמך זוהה כהזמנה של לקוח אלינו, לא כהזמנת רכש שלנו לספק. המחיר בו הוא מחיר המכירה, ואין לקלוט אותו כמחיר קנייה",
    );
  } else if (documentKind === "other") {
    warnings.push("המסמך לא זוהה כהזמנת רכש — יש לבדוק מה הוא");
  }

  const order: ExtractedPurchaseOrder = {
    poNumber: poNumber ?? "",
    supplier: supplier ?? "",
    orderDate,
    currency,
    // Enforced in code, not requested in the prompt: the wrong document yields no
    // costs whatever the model returned beside that verdict.
    lines: documentKind === "our_purchase_order" ? lines : [],
  };

  return { order, warnings, documentKind };
}

const SYSTEM_PROMPT = `אתה מחלץ נתונים מ**הזמנת רכש שחברת האלקטרוניקה הישראלית ${OWN_COMPANY_LABEL} שולחת לספק**. אנחנו המזמינים; הספק (DigiKey, Mouser, יצרן, מפיץ) הוא זה שאמור לספק לנו. עליך להחזיר את הנתונים דרך הכלי submit_purchase_order בלבד. אל תמציא נתונים — שדה שלא נקרא בבירור, השמט אותו.

## שני מסמכים שנראים אותו דבר — חובה להבחין ביניהם

המילה "הזמנת רכש" משמשת בעברית לשני מסמכים הפוכים, ורק אחד מהם שייך לחילוץ הזה:

| | **הזמנת רכש שלנו** (זה מה שאתה מחלץ) | **הזמנת לקוח** (זה לא) |
|---|---|---|
| מי הוציא | אנחנו, ${OWN_COMPANY_LABEL} | הלקוח |
| מי הספק | ספק חוץ | אנחנו |
| השם שלנו מופיע ב | "מזמין" / "קונה" / "Buyer" / "Bill To" | "לכבוד" / "ספק" / "Vendor" / "To" |
| המחיר במסמך הוא | מחיר **קנייה** שלנו | מחיר **מכירה** ללקוח |

**documentKind** — קבע אותו לפני כל שדה אחר:
- \`our_purchase_order\` — אנחנו הוצאנו את ההזמנה לספק חוץ. זה המסמך הצפוי; המשך כרגיל.
- \`customer_order\` — **הלקוח** הוציא את ההזמנה ואנחנו הספק. אז **החזר lines ריק** והוסף warning. המסך הזה קולט מחירי קנייה, ומחיר מכירה שייקלט כמחיר קנייה מעוות את הרווח.
- \`other\` — כל דבר אחר (הצעת מחיר, חשבונית, אישור הזמנה מהספק, תעודת משלוח). lines ריק + warning שאומר מה המסמך כן.

שדות:
- poNumber = **מספר הזמנת הרכש שלנו**, כפי שהוא מופיע על המסמך. זה המזהה שהספק מצטט אחר כך באישורי המשלוח ובחשבונית, ולכן הוא השדה הכי חשוב כאן.
- supplier = שם הספק שאליו נשלחה ההזמנה. לא השם שלנו — אנחנו המזמינים.
- orderDate = תאריך ההזמנה, yyyy-mm-dd.
- documentCurrency = המטבע של המחירים במסמך. הזמנות רכש שלנו נקובות כמעט תמיד ב-USD. החזר את המטבע כפי שהוא מופיע (USD / ILS / $ / ₪).

שורות (lines) — כל העמודים, חובה:
- טבלת השורות נמשכת לעיתים על כמה עמודים. חלץ **כל** השורות מ**כל** העמודים. כותרת חוזרת, "המשך", מספרי עמוד וסיכומי ביניים אינם שורות.
- pn = מק"ט היצרן (Manufacturer Part Number), למשל STM32L432KBU6. זה המזהה שמחבר את השורה להזמנת הלקוח, ולכן הוא הכי חשוב מכל שדות השורה.
- sku = מספר קטלוגי של הספק או שלנו, אם מופיע בנפרד מ-pn.
- qty = כמות.
- unitCost = **מחיר ליחידה אחת שאנחנו משלמים**, במטבע המסמך. לא סכום השורה הכולל. אם במסמך מופיע רק סכום שורה — חלק בכמות.
- notes = תיאור המוצר ושם היצרן.
- documentLineCount = מספר השורות שהמסמך מצהיר עליו, לבדיקה שלא אבד עמוד.
- documentTotal = הסכום הכולל כפי שמופיע במסמך, לבקרת שפיות.

כללים:
- תאריכים בפורמט ISO בלבד, yyyy-mm-dd.
- מספרים: הסר סימני $ ו-₪ ופסיקי אלפים. **אל תמיר מטבע** — החזר את המספר כמו שהוא ואת המטבע בשדה שלו.
- warnings: כתוב בעברית כל דבר שדורש עין אנושית.`;

const SUBMIT_PO_TOOL: Anthropic.Tool = {
  name: "submit_purchase_order",
  description:
    "מחזיר את הנתונים המחולצים מהזמנת הרכש שלנו לספק. השמט כל שדה שלא נקרא בבירור. lines ו-warnings תמיד נדרשים (גם אם ריקים).",
  input_schema: {
    type: "object",
    properties: {
      poNumber: { type: "string", description: "מספר הזמנת הרכש שלנו." },
      supplier: { type: "string", description: "שם הספק שאליו נשלחה ההזמנה." },
      orderDate: { type: "string", description: "תאריך ההזמנה, yyyy-mm-dd." },
      documentCurrency: {
        type: "string",
        description: "מטבע המחירים במסמך (USD / ILS / $ / ₪). כמעט תמיד USD.",
      },
      documentTotal: { type: "number", description: "סכום ההזמנה הכולל, לבקרת שפיות." },
      documentKind: {
        type: "string",
        enum: [...PO_DOCUMENT_KINDS],
        description: `איזה מסמך זה. our_purchase_order = אנחנו (${OWN_COMPANY_LABEL}) הזמנו מספק חוץ (הצפוי). customer_order = לקוח הזמין מאיתנו — אז lines ריק, כי המחיר שם הוא מחיר מכירה. other = כל מסמך אחר.`,
      },
      lines: {
        type: "array",
        description: "שורות ההזמנה.",
        items: {
          type: "object",
          properties: {
            pn: { type: "string", description: 'מק"ט יצרן (Manufacturer P/N) — המזהה החשוב ביותר.' },
            sku: { type: "string", description: "מספר קטלוגי, אם מופיע בנפרד." },
            notes: { type: "string", description: "תיאור המוצר ושם היצרן." },
            qty: { type: "number", description: "כמות." },
            unitCost: {
              type: "number",
              description: "מחיר ליחידה אחת שאנחנו משלמים, במטבע המסמך.",
            },
          },
        },
      },
      documentLineCount: {
        type: "number",
        description: "מספר השורות שהמסמך מצהיר עליו, לזיהוי חילוץ חסר.",
      },
      warnings: {
        type: "array",
        description: "אזהרות בעברית לכל דבר שדורש בדיקה אנושית.",
        items: { type: "string" },
      },
    },
    required: ["lines", "warnings"],
  },
};

/**
 * Send a base64 PDF to Claude and return the purchase order, or a Hebrew error.
 * Server only. The timeout and retry settings match the other extractors — see
 * the note in ./extract-order for why maxRetries is 0.
 */
export async function extractPurchaseOrderFromPdf(
  pdfBase64: string,
  fileName: string,
): Promise<PoExtractResult> {
  const anthropic = new Anthropic({ maxRetries: 0, timeout: 50_000 });

  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create({
      model: process.env.EXTRACT_MODEL ?? "claude-sonnet-5",
      max_tokens: 16000,
      thinking: { type: "disabled" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [SUBMIT_PO_TOOL],
      tool_choice: { type: "tool", name: "submit_purchase_order" },
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
              text: `חלץ את פרטי הזמנת הרכש מהמסמך המצורף (שם הקובץ: ${fileName}) והחזר אותם דרך הכלי submit_purchase_order.`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: `שגיאת אימות בשירות החילוץ — יש לבדוק את מפתח ה-API.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, error: `שירות החילוץ עמוס כרגע — נסה שוב בעוד רגע.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return { ok: false, error: `החילוץ לקח יותר מדי זמן או שנכשל החיבור.${MANUAL_FALLBACK}` };
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, error: `שגיאה בשירות החילוץ.${MANUAL_FALLBACK}` };
    }
    return { ok: false, error: `שגיאה לא צפויה בזמן החילוץ.${MANUAL_FALLBACK}` };
  }

  if (message.stop_reason === "max_tokens") {
    return { ok: false, error: `המסמך ארוך מדי — פלט החילוץ נקטע.${MANUAL_FALLBACK}` };
  }
  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (toolUse?.type !== "tool_use") {
    return { ok: false, error: `לא התקבל פלט מובנה מהחילוץ.${MANUAL_FALLBACK}` };
  }

  const { order, warnings, documentKind } = normalizeExtractedPurchaseOrder(toolUse.input);

  if (documentKind === "customer_order") {
    return {
      ok: false,
      error:
        "המסמך הוא הזמנה של לקוח אלינו, לא הזמנת רכש שלנו לספק — ולכן הוא לא נקלט. המחיר שבו הוא מחיר המכירה. הזמנות לקוחות נקלטות במסך קליטת ההזמנות.",
    };
  }
  if (order.lines.length === 0) {
    const explanation = warnings.length ? ` (${warnings.join("; ")})` : "";
    return { ok: false, error: `לא זוהו שורות בהזמנת הרכש${explanation}.${MANUAL_FALLBACK}` };
  }

  return { ok: true, order, warnings };
}
