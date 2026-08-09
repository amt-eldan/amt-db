import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { isOwnCompanyName, OWN_COMPANY_LABEL } from "./company";
import { asRecord, fmtAmount, isoDate, num, str } from "./extract-fields";
import { customerFromOrderNumber, isModOrderNumber, stagedPayload } from "./validation";

/**
 * A purchase order extracted from a PDF by Claude, shaped for the same
 * `payload` jsonb that the external OCR pipeline writes (minus `sourceFile`,
 * which the route fills in from the uploaded file name). `sourceFormat` is
 * decided in code from the order number, never by the model.
 */
export type ExtractedOrder = Omit<z.input<typeof stagedPayload>, "sourceFile">;

export type ExtractResult =
  | { ok: true; order: ExtractedOrder; warnings: string[] }
  | { ok: false; error: string };

/** תוספת שמוצעת בכל הודעת כשל — המשתמש תמיד יכול ליפול חזרה להזנה ידנית. */
const MANUAL_FALLBACK = " ניתן להזין את ההזמנה ידנית בטופס שבתחתית העמוד.";

// ---------------------------------------------------------------------------
// Pure normalization (exported for the unit test — no API calls, `today`
// injected exactly like src/lib/status.ts so date-range checks are deterministic)
// ---------------------------------------------------------------------------

/** year within 2000..today+5y — anything else deserves a human glance. */
function dateInRange(iso: string, today: Date): boolean {
  const year = Number(iso.slice(0, 4));
  return year >= 2000 && year <= today.getFullYear() + 5;
}

/**
 * Pure. Turns the model's raw tool input into an ExtractedOrder plus a list of
 * Hebrew warnings for anything a human should double-check. Exported for the
 * unit test; `today` is injected so the date-range check is testable.
 */
export function normalizeExtractedOrder(
  raw: unknown,
  fileName: string,
  today: Date = new Date(),
): { order: ExtractedOrder; warnings: string[] } {
  const obj = asRecord(raw);
  const warnings: string[] = [];

  // Model-emitted warnings come first; local checks append to them.
  if (Array.isArray(obj.warnings)) {
    for (const w of obj.warnings) if (typeof w === "string" && w.trim()) warnings.push(w.trim());
  }

  const customerNote = str(obj.customerNote);
  const orderNumber = str(obj.orderNumber);
  const isMod = isModOrderNumber(orderNumber ?? "");

  const read = str(obj.customer);

  // A number that names its own customer beats whatever was read off the page —
  // same reasoning as sourceFormat below: decided in code, never by the model.
  const byPrefix = customerFromOrderNumber(orderNumber ?? "");

  let customer: string | null;
  if (byPrefix) {
    if (read && read !== byPrefix && !isOwnCompanyName(read)) {
      warnings.push(
        `הלקוח שזוהה במסמך ("${read}") הוחלף ב-"${byPrefix}" לפי מספר ההזמנה ${orderNumber}`,
      );
    }
    customer = byPrefix;
  } else if (read && isOwnCompanyName(read)) {
    // The PO is addressed to us, so our own name sits in its "לכבוד" block.
    // Reading it as the customer is the one mistake the prompt cannot fully
    // prevent, and a wrong name here silently creates a bogus customer on
    // approval — so drop it and let the reviewer type the buyer's name instead.
    warnings.push(
      `השם שזוהה כלקוח ("${read}") הוא שם החברה שלנו — אנחנו הנמענים של ההזמנה, לא המזמינים. יש להזין את שם הלקוח המזמין ידנית לפני אישור`,
    );
    customer = null;
  } else {
    customer = read;
    if (!customer) warnings.push("לא זוהה שם לקוח — יש למלא ידנית לפני אישור");
  }

  // Header date. Absent → prominent warning (never fabricate — StagedCard lets
  // the reviewer fill it in). Present but out of range → warning.
  const orderDate = isoDate(obj.orderDate, "תאריך הזמנה", warnings);
  if (!orderDate) {
    warnings.push("לא זוהה תאריך הזמנה — יש למלא ידנית לפני אישור");
  } else if (!dateInRange(orderDate, today)) {
    warnings.push(
      `תאריך ההזמנה ${orderDate} חורג מהטווח הצפוי (2000 עד ${today.getFullYear() + 5})`,
    );
  }

  const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
  const lines = rawLines.map((rl, i) => {
    const line = asRecord(rl);
    const n = i + 1;
    const pn = str(line.pn);
    const qty = num(line.qty);
    const contractDueDate = isoDate(line.contractDueDate, `שורה ${n} — תאריך אספקה`, warnings);
    if (contractDueDate && !dateInRange(contractDueDate, today)) {
      warnings.push(`שורה ${n}: תאריך האספקה ${contractDueDate} חורג מהטווח הצפוי`);
    }
    if (!pn) warnings.push(`שורה ${n}: חסר מק"ט יצרן (P/N) — יש לבדוק`);
    if (qty === null || qty === 0) warnings.push(`שורה ${n}: כמות חסרה או אפס — יש לבדוק`);
    return {
      pn,
      sku: str(line.sku),
      qty,
      unitPrice: num(line.unitPrice),
      contractDueDate,
      notes: str(line.notes),
    };
  });

  // Sanity check: document total vs sum(qty × unitPrice). Warning, not failure.
  const documentTotal = num(obj.documentTotal);
  if (documentTotal !== null) {
    const computed = lines.reduce((s, l) => s + (l.qty ?? 0) * (l.unitPrice ?? 0), 0);
    if (Math.abs(documentTotal - computed) > 1) {
      warnings.push(
        `סה"כ לא תואם: ${fmtAmount(documentTotal)} במסמך מול ${fmtAmount(computed)} מחושב`,
      );
    }
  }

  // Foreign currency is never converted here — flag it.
  const currency = str(obj.documentCurrency);
  if (currency && !/^(ils|nis|₪|שקל|ש"ח|שח)$/i.test(currency)) {
    warnings.push(`המטבע במסמך (${currency}) אינו שקל — לא בוצעה המרה, יש לבדוק ידנית`);
  }

  // MoD order but the customer isn't a short purchasing-group number.
  if (isMod && customer && !/^\d{1,4}$/.test(customer)) {
    warnings.push(
      `הזמנת משהב"ט — הלקוח "${customer}" אינו מספר קבוצת רכש; יש לתקן למספר קצר (למשל 134)`,
    );
  }

  // PMO number with something stuck after it — likely a scanner suffix. Warn
  // only; auto-trimming could corrupt a genuine number.
  if (orderNumber && /^\d{4}P\d{5}/.test(orderNumber) && orderNumber.length > 10) {
    warnings.push(
      `מספר ההזמנה "${orderNumber}" ארוך מתבנית PMO הרגילה — ייתכן שנדבקה סיומת סורק, יש לוודא`,
    );
  }

  const order: ExtractedOrder = {
    customer: customer ?? "",
    customerNote,
    orderNumber: orderNumber ?? "",
    orderDate,
    sourceFormat: isMod ? "mod" : "standard",
    lines,
  };

  return { order, warnings };
}

// ---------------------------------------------------------------------------
// Extraction via the Messages API
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `אתה מחלץ נתונים מהזמנות רכש (Purchase Orders) שמתקבלות אצל חברת האלקטרוניקה הישראלית ${OWN_COMPANY_LABEL}. ההזמנה נשלחה אלינו: הלקוח הוא זה שהוציא אותה, ואנחנו הספק שאמור לספק את הסחורה. המסמך המצורף הוא PDF של הזמנה. עליך להחזיר את הנתונים דרך הכלי submit_order בלבד. אל תמציא נתונים — שדה שלא נקרא בבירור, השמט אותו.

הפורמטים שנראו בשטח: הזמנת רכש ממשלתית דיגיטלית (משרד ראש הממשלה), אותה הזמנה כשהיא סרוקה עם חתימות יד, פורטל משרד הביטחון, ו-PO ממערכות ERP של לקוחות (כגון ERPNext). ייתכנו גם פורמטים שלא נראו עדיין — התאם את עצמך.

מספר הזמנה (orderNumber):
- הזמנת משרד ראש הממשלה בפורמט כמו 0226P02772 (4 ספרות, האות P, 5 ספרות).
- מלכודת: אותו PDF מכיל לעיתים גם "בקשה להצעת מחיר" עם מספר אחר (למשל 26003501). חלץ את מספר ההזמנה מעמודי ההזמנה עצמה, לא מעמוד בקשת הצעת המחיר.
- התעלם מסיומות סורק בשם הקובץ: אם שם הקובץ הוא 0226P02772001.pdf מספר ההזמנה הוא 0226P02772.
- הזמנת משרד הביטחון: 10 ספרות שמתחילות ב-444.

לקוח (customer) — כאן הכי קל לטעות, קרא בעיון:
- הלקוח הוא הגורם שהוציא את ההזמנה, כלומר הקונה: בדרך כלל שם החברה שבראש המסמך (לוגו / נייר מכתבים), או השם שבשדות "מזמין", "קונה", "Bill To", "Buyer", "Ordered By".
- אנחנו הנמענים של ההזמנה, לא הלקוח. הבלוקים "לכבוד", "ספק", "אל", "Vendor", "Supplier", "To" מכילים את שמנו — ${OWN_COMPANY_LABEL} (מופיע גם כ-AMT, א.מ.ט, אטריום). לעולם אל תחזיר שם כזה בשדה customer. אם השם היחיד שהצלחת לקרוא הוא שלנו — השמט את customer לגמרי והוסף warning.
- מספר הזמנה שמתחיל ב-966 שייך תמיד ללקוח "2470" — החזר 2470 בשדה customer, גם אם במסמך מופיע שם אחר.
- customer הוא שם של ארגון, לא של אדם. שם של איש קשר, רוכש, מאשר או חותם (גם כשהוא מופיע ליד טלפון או אימייל) לא נכנס ל-customer; אם הוא רלוונטי — כתוב אותו ב-customerNote.
- הזמנת משרד הביטחון (מספר שמתחיל ב-444): הלקוח הוא מספר קבוצת הרכש (למשל 134, 131, 135, 137), שאותו משחזרים מכתובת האימייל של הרוכש. לעולם אל תכתוב "משרד הביטחון" בשדה customer — את התיאור המילולי כתוב ב-customerNote.

שורות (lines):
- pn = מק"ט היצרן (Manufacturer Part Number), למשל STM32L432KBU6.
- sku = מק"ט הלקוח / מספר קטלוגי, למשל 345056.
- unitPrice = מחיר ליחידה אחת, לפני מע"מ. לא סכום השורה הכולל ולא כולל מע"מ. אם במסמך מופיע רק סכום שורה — חלק בכמות כדי לקבל מחיר ליחידה.
- qty = כמות.
- contractDueDate = מועד האספקה הנדרש.
- תיאור המוצר ושם היצרן → notes של השורה.

בקרת שפיות (לשדות documentTotal ו-documentCurrency בלבד):
- documentTotal = הסכום הכולל של ההזמנה כפי שמופיע במסמך (מספר, לפני מע"מ אם אפשר), לצורך בדיקת התאמה מול סכום השורות.
- documentCurrency = המטבע של המסמך (למשל ILS, USD, EUR).

כללים כלליים:
- תאריכים: החזר בפורמט ISO בלבד, yyyy-mm-dd. המר פורמטים כמו 15.7.2026, ‏15/7/2026 וגם 15/7/26.
- מספרים: הסר סימני ₪ ו-$ ופסיקי אלפים. אם המטבע זר — אל תמיר לשקלים, השאר את המספר כמו שהוא והוסף warning.
- אם המסמך אינו הזמנת רכש — החזר lines ריק והוסף warning שמסביר מה המסמך כן (הצעת מחיר, חשבונית, וכו').
- אם המסמך מכיל כמה הזמנות — חלץ את ההזמנה הראשית והוסף warning על כך.
- warnings: כתוב בעברית כל דבר שדורש עין אנושית (שדה מטושטש, נתון שלא היית בטוח בו, אי-התאמה וכו').`;

const SUBMIT_ORDER_TOOL: Anthropic.Tool = {
  name: "submit_order",
  description:
    "מחזיר את הנתונים המחולצים מהזמנת הרכש. השמט כל שדה שלא נקרא בבירור מהמסמך — אל תמציא. lines ו-warnings תמיד נדרשים (גם אם ריקים).",
  input_schema: {
    type: "object",
    properties: {
      customer: {
        type: "string",
        description:
          `שם הארגון שהוציא את ההזמנה (הקונה), או מספר קבוצת הרכש. לעולם לא שמנו שלנו (${OWN_COMPANY_LABEL}) שמופיע בבלוק "לכבוד"/"ספק", ולא שם של איש קשר. בהזמנת משהב"ט (444) — מספר קבוצת הרכש, לא "משרד הביטחון".`,
      },
      customerNote: {
        type: "string",
        description: "תיאור מילולי נוסף על הלקוח / קבוצת הרכש, אם קיים.",
      },
      orderNumber: {
        type: "string",
        description: "מספר ההזמנה, ללא סיומות סורק.",
      },
      orderDate: {
        type: "string",
        description: "תאריך ההזמנה בפורמט yyyy-mm-dd.",
      },
      documentTotal: {
        type: "number",
        description: "הסכום הכולל של ההזמנה כפי שמופיע במסמך, לבקרת שפיות.",
      },
      documentCurrency: {
        type: "string",
        description: "מטבע המסמך (ILS, USD, EUR וכו').",
      },
      lines: {
        type: "array",
        description: "שורות ההזמנה.",
        items: {
          type: "object",
          properties: {
            pn: { type: "string", description: "מק\"ט יצרן (Manufacturer P/N)." },
            sku: { type: "string", description: "מק\"ט לקוח / קטלוגי." },
            notes: { type: "string", description: "תיאור המוצר ושם היצרן." },
            qty: { type: "number", description: "כמות." },
            unitPrice: {
              type: "number",
              description: "מחיר ליחידה אחת, לפני מע\"מ.",
            },
            contractDueDate: {
              type: "string",
              description: "מועד אספקה נדרש, yyyy-mm-dd.",
            },
          },
        },
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
 * Send a base64 PDF to Claude and return a structured order (or a Hebrew error
 * message, all of which suggest the manual-entry fallback). Runs on the server
 * only — reads ANTHROPIC_API_KEY from the environment.
 */
export async function extractOrderFromPdf(
  pdfBase64: string,
  fileName: string,
): Promise<ExtractResult> {
  // timeout is in MILLISECONDS (SDK default is 10 minutes). Without this the
  // request would outlive Vercel's 60s function limit and get killed with no
  // clean error. maxRetries: 0 because wall-clock = timeout × (retries + 1).
  const anthropic = new Anthropic({ maxRetries: 0, timeout: 50_000 });

  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create({
      model: process.env.EXTRACT_MODEL ?? "claude-sonnet-5",
      max_tokens: 16000,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      tools: [SUBMIT_ORDER_TOOL],
      tool_choice: { type: "tool", name: "submit_order" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
            },
            {
              type: "text",
              text: `חלץ את פרטי ההזמנה מהמסמך המצורף (שם הקובץ: ${fileName}) והחזר אותם דרך הכלי submit_order.`,
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
      return { ok: false, error: `שגיאת אימות בשירות החילוץ — יש לבדוק את מפתח ה-API.${MANUAL_FALLBACK}` };
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
    return { ok: false, error: `המסמך ארוך מדי — פלט החילוץ נקטע (JSON חלקי).${MANUAL_FALLBACK}` };
  }
  if (message.stop_reason === "refusal") {
    return { ok: false, error: `החילוץ נדחה.${MANUAL_FALLBACK}` };
  }

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (toolUse?.type !== "tool_use") {
    return { ok: false, error: `לא התקבל פלט מובנה מהחילוץ.${MANUAL_FALLBACK}` };
  }

  const { order, warnings } = normalizeExtractedOrder(toolUse.input, fileName);

  if (order.lines.length === 0) {
    const explanation = warnings.length ? ` (${warnings.join("; ")})` : "";
    return { ok: false, error: `לא זוהתה הזמנת רכש במסמך${explanation}.${MANUAL_FALLBACK}` };
  }

  return { ok: true, order, warnings };
}
