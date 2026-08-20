import { z } from "zod";
import { parseNumericString } from "./numeric";
import { SHIPMENT_STATUSES } from "./shipment-status";
import { MANUAL_STATUSES } from "./status";

/** MoD orders: 10 digits starting with 444 → the customer is the purchasing-group number. */
export function isModOrderNumber(orderNumber: string): boolean {
  return /^444\d{7}$/.test(orderNumber.trim());
}

/**
 * Order-number prefixes that name the customer on their own, whatever the
 * document (or the extraction) says. Add a row here and every door in — manual
 * form, PDF extraction, staged approval — starts honouring it.
 */
const CUSTOMER_BY_ORDER_PREFIX: ReadonlyArray<readonly [prefix: string, customer: string]> = [
  ["966", "2470"],
];

/** The customer a number implies, or null when the prefix says nothing. */
export function customerFromOrderNumber(orderNumber: string): string | null {
  const trimmed = orderNumber.trim();
  return CUSTOMER_BY_ORDER_PREFIX.find(([prefix]) => trimmed.startsWith(prefix))?.[1] ?? null;
}

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .transform((s) => (s === "" ? null : s))
  .nullish()
  .transform((s) => s ?? null);

// Numeric columns round-trip through Drizzle as strings, so this normalises to
// `string | null`. Parsing itself lives in ./numeric so that a value typed as
// "₪1,200" means the same thing here, in the profit maths, and in the extractor.
const optionalNumeric = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => parseNumericString(v));

const optionalIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .or(z.literal(""))
  .transform((s) => (s ? s : null));

export const orderLineInput = z.object({
  pn: optionalText,
  sku: optionalText,
  qty: optionalNumeric,
  unitPrice: optionalNumeric,
  contractDueDate: optionalIsoDate,
  notes: optionalText,
});

export const orderInput = z.object({
  customerName: z.string().trim().min(1, "שם לקוח חובה"),
  customerNote: optionalText,
  orderNumber: z.string().trim().min(1, "מספר הזמנה חובה"),
  orderDate: optionalIsoDate,
  sourceFormat: z.enum(["standard", "mod", "manual"]).default("manual"),
  sourceFile: optionalText,
  lines: z.array(orderLineInput).min(1, "נדרשת לפחות שורה אחת"),
  allowDuplicate: z.boolean().default(false),
});

export const manualFieldsInput = z.object({
  lineId: z.number().int().positive(),
  poNumber: optionalText,
  supplier: optionalText,
  buyPrice: optionalNumeric,
  buyPriceUsd: optionalNumeric,
  shippingCost: optionalNumeric,
  deliveryUpdate: optionalText,
  paymentMethod: optionalText,
  bol: optionalText,
  carrier: optionalText,
  notes: optionalText,
  qty: optionalNumeric,
  unitPrice: optionalNumeric,
  contractDueDate: optionalIsoDate,
  deliveredAt: optionalIsoDate,
  manualStatus: z
    .enum(MANUAL_STATUSES)
    .nullish()
    .or(z.literal(""))
    .transform((s) => (s ? s : null)),
});

/** No currency on the document means shekels. */
const currencyField = z
  .string()
  .trim()
  .max(10)
  .nullish()
  .transform((s) => (s && s !== "" ? s.toUpperCase() : "ILS"));

const optionalId = z
  .number()
  .int()
  .positive()
  .nullish()
  .transform((v) => v ?? null);

/**
 * One supplier invoice, as typed in the form or as read from a PDF. Supplier +
 * invoice number are the identity of the document, so both are required; the
 * rest of the fields may be filled in later.
 */
export const supplierInvoiceInput = z.object({
  supplier: z.string().trim().min(1, "שם ספק חובה").max(200),
  invoiceNumber: z.string().trim().min(1, "מספר חשבונית חובה").max(100),
  invoiceDate: optionalIsoDate,
  poNumber: optionalText,
  orderId: optionalId,
  amount: optionalNumeric,
  currency: currencyField,
  notes: optionalText,
});

export const supplierInvoiceUpdate = supplierInvoiceInput.extend({
  id: z.number().int().positive(),
});

export type SupplierInvoiceInput = z.infer<typeof supplierInvoiceInput>;

/**
 * One component of what a shipment costs, exactly as the invoice itemizes it:
 * `אגרת מחשב למכס 21.00`, `שירות שחרור ממכס 71.00`, `מע"מ 12.78`. Couriers print
 * this breakdown and we used to throw it away, keeping only the total — so a
 * shipping cost of 531.78 arrived with nothing to explain it.
 *
 * Informational: the money that reaches an order line is still the shipment's
 * `amount`. These rows are what makes that amount readable.
 */
export const courierChargeInput = z.object({
  label: z.string().trim().min(1, "תיאור החיוב חובה").max(200),
  amount: optionalNumeric,
  kind: z
    .enum(["service", "tax", "fee", "vat", "discount", "other"])
    .nullish()
    .transform((k) => k ?? "other"),
});

/**
 * One charge on a courier invoice: a shipment, its tracking number, the line it
 * belongs to once someone (the matcher or the reviewer) has said which, and the
 * itemized charges the invoice says its total is made of.
 */
export const courierShipmentInput = z.object({
  bol: optionalText,
  reference: optionalText, // our PO / order number as the courier quotes it
  // Customs' id for the import, not an asmachta of ours. It has a field of its own
  // so it stops being crammed into `reference`, where it never matched anything and
  // could collide with a real order number and place the cost on the wrong line.
  customsDeclaration: optionalText,
  shipper: optionalText, // "פרטי השולח" — the supplier key's input
  shipmentDate: optionalIsoDate,
  description: optionalText,
  amount: optionalNumeric,
  charges: z.array(courierChargeInput).nullish().transform((c) => c ?? []),
  lineId: optionalId,
  // Which key placed this shipment. Persisted because "supplier" means "guessed",
  // and that has to still be visible when the row is reviewed tomorrow. Nullish:
  // rows staged before this field existed read back as null, which is "unknown"
  // and — correctly — not low-confidence, since those were all key matches.
  matchedBy: z
    .enum(["bol", "po", "order", "supplier", "manual"])
    .nullish()
    .transform((m) => m ?? null),
});

/**
 * A courier invoice waiting for approval — header plus the shipments it charges
 * for. One shape for both doors in (PDF extraction and the manual form) and it is
 * exactly what the staged row stores, so approving is "write what you reviewed".
 *
 * `warnings` are the extraction's own remarks, kept with the row so they are still
 * on screen when someone comes back to it tomorrow.
 */
export const courierInvoiceDraft = z.object({
  courier: z.string().trim().min(1, "שם הבלדר חובה").max(200),
  invoiceNumber: z.string().trim().min(1, "מספר חשבונית חובה").max(100),
  invoiceDate: optionalIsoDate,
  amount: optionalNumeric,
  currency: currencyField,
  notes: optionalText,
  fileName: optionalText,
  shipments: z.array(courierShipmentInput).default([]),
  warnings: z.array(z.string()).default([]),
});

/** Header-only edit of an approved courier invoice; allocations have their own action. */
export const courierInvoiceUpdate = z.object({
  id: z.number().int().positive(),
  courier: z.string().trim().min(1, "שם הבלדר חובה").max(200),
  invoiceNumber: z.string().trim().min(1, "מספר חשבונית חובה").max(100),
  invoiceDate: optionalIsoDate,
  amount: optionalNumeric,
  currency: currencyField,
  notes: optionalText,
});

/** Re-splitting an approved invoice between lines. */
export const courierAllocationsUpdate = z.object({
  invoiceId: z.number().int().positive(),
  shipments: z.array(courierShipmentInput).default([]),
});

export type CourierChargeInput = z.infer<typeof courierChargeInput>;
export type CourierShipmentInput = z.infer<typeof courierShipmentInput>;
export type CourierInvoiceDraft = z.infer<typeof courierInvoiceDraft>;

/** Payload accepted by POST /api/staged (from the external OCR pipeline). */
export const stagedPayload = z.object({
  // Empty means "not recognised on the document" — a staged row exists to be
  // reviewed, so it is better to keep the extracted lines and let the reviewer
  // type the name than to throw the whole order away. Approval still goes
  // through `orderInput`, which requires a customer.
  customer: z.string().trim().max(200).default(""),
  customerNote: optionalText,
  orderNumber: z.string().trim().min(1),
  orderDate: optionalIsoDate, // yyyy-mm-dd
  sourceFormat: z.enum(["standard", "mod", "manual"]).default("standard"),
  sourceFile: optionalText,
  lines: z
    .array(
      z.object({
        pn: optionalText,
        sku: optionalText,
        qty: optionalNumeric,
        unitPrice: optionalNumeric,
        contractDueDate: optionalIsoDate,
        notes: optionalText,
      }),
    )
    .min(1),
});

/**
 * Things a human should double-check before approving a staged order — emitted
 * by the PDF extractor and accepted (optionally) from the external OCR pipeline
 * as a top-level `warnings` array alongside the payload.
 *
 * Deliberately not part of `stagedPayload`: that schema is the documented API
 * contract *and* what the review card posts back after editing, and it strips
 * unknown keys, so warnings cannot be lost or tampered with through it. They are
 * stored in their own column (staged_orders.warnings).
 */
export const stagedWarnings = z
  .array(z.string().trim().min(1).max(500))
  .max(100)
  .nullish()
  .transform((w) => w ?? []);

/**
 * One bill-of-lading match accepted by POST /api/bol/matches (from the external
 * tracking agent).
 *
 * Two ways to say which line the number belongs to:
 *  - `lineId` from the worklist the agent was handed — bound to one line, nothing
 *    to re-match;
 *  - the keys the email itself quoted (`pn` / `poNumber` / `orderNumber`), for a
 *    tracking number that arrived without a worklist behind it. The server then
 *    finds the line (resolveBolLine) and refuses to guess when several fit.
 *
 * One of the two is required — a bill of lading with nothing to attach it to is
 * not a match.
 */
export const bolMatchInput = z
  .object({
    lineId: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((v) => v ?? null),
    bol: z.string().trim().min(1, "מספר שטר מטען חובה").max(200),
    // Search keys as they appear in the email; ignored when lineId is given.
    pn: optionalText,
    poNumber: optionalText,
    orderNumber: optionalText,
    supplier: optionalText,
    carrier: optionalText,
    statusText: optionalText,
    // Carrier's estimated arrival, when the email states one.
    etaDate: optionalIsoDate,
    // Set only when the email says the goods were handed over, and then it is the
    // date the carrier states — not the day the email was read. It is what picks
    // the representative rate, so a wrong date is a wrong profit.
    deliveredAt: optionalIsoDate,
    // Unit purchase price as the purchase order quotes it: dollars, unconverted.
    // The server converts; the agent must not do the arithmetic.
    buyPriceUsd: optionalNumeric,
    sourceEmailId: optionalText,
    sourceQuote: optionalText,
    confidence: z
      .union([z.string(), z.number()])
      .nullish()
      .transform((v) => {
        if (v === null || v === undefined || v === "") return null;
        const n = typeof v === "string" ? parseFloat(v) : v;
        if (!Number.isFinite(n)) return null;
        return String(Math.min(1, Math.max(0, n)));
      }),
  })
  .refine((m) => m.lineId !== null || Boolean(m.pn ?? m.poNumber ?? m.orderNumber), {
    message: "נדרש lineId או מפתח חיפוש (pn / poNumber / orderNumber)",
  });

/**
 * A status report for a shipment we already hold a bill of lading for.
 *
 * Deliberately a separate contract from `bolMatchInput`, because the two answer
 * different questions and have opposite guards. Finding a tracking number is a
 * once-per-line event that must never overwrite an existing value; checking where
 * that shipment has got to happens twice a day, for as long as it takes, and is
 * expected to overwrite the previous answer. Folding them together would mean
 * relaxing the never-overwrite rule that protects `bol`.
 *
 * `lineId` is required here — a status update has nothing to search by, and
 * guessing which line a carrier page refers to is not a thing worth doing.
 */
export const shipmentUpdateInput = z
  .object({
    lineId: z.number().int().positive(),
    status: z
      .enum(SHIPMENT_STATUSES)
      .nullish()
      .or(z.literal(""))
      .transform((s) => (s ? s : null)),
    /** The carrier's own wording, kept for a human to read and as a fallback classifier. */
    statusText: optionalText,
    deliveredAt: optionalIsoDate,
    etaDate: optionalIsoDate,
    carrier: optionalText,
    buyPriceUsd: optionalNumeric,
    /** Where this was read — a carrier tracking page, or the email id. */
    sourceUrl: optionalText,
    sourceEmailId: optionalText,
    sourceQuote: optionalText,
  })
  .refine(
    (m) =>
      Boolean(m.status ?? m.statusText ?? m.deliveredAt ?? m.etaDate ?? m.buyPriceUsd ?? m.carrier),
    {
      message:
        "אין מה לעדכן: נדרש status / statusText / deliveredAt / etaDate / buyPriceUsd / carrier",
    },
  );

export type StagedPayload = z.infer<typeof stagedPayload>;
export type OrderInput = z.infer<typeof orderInput>;
export type BolMatchInput = z.infer<typeof bolMatchInput>;
export type ShipmentUpdateInput = z.infer<typeof shipmentUpdateInput>;
