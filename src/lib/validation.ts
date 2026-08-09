import { z } from "zod";
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

const optionalNumeric = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : v;
    return Number.isFinite(n) ? String(n) : null;
  });

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
  shippingCost: optionalNumeric,
  deliveryUpdate: optionalText,
  paymentMethod: optionalText,
  bol: optionalText,
  carrier: optionalText,
  notes: optionalText,
  qty: optionalNumeric,
  unitPrice: optionalNumeric,
  contractDueDate: optionalIsoDate,
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
 * One charge on a courier invoice: a shipment, its tracking number, and the line
 * it belongs to once someone (the matcher or the reviewer) has said which.
 */
export const courierShipmentInput = z.object({
  bol: optionalText,
  reference: optionalText, // our PO / order number as the courier quotes it
  description: optionalText,
  amount: optionalNumeric,
  lineId: optionalId,
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
 * One bill-of-lading match accepted by POST /api/bol/matches (from the external
 * tracking agent). `lineId` comes from the worklist the agent was handed, so a
 * match is bound to exactly one line rather than re-matched here.
 */
export const bolMatchInput = z.object({
  lineId: z.number().int().positive(),
  bol: z.string().trim().min(1, "מספר שטר מטען חובה").max(200),
  carrier: optionalText,
  statusText: optionalText,
  // Carrier's estimated arrival, when the email states one.
  etaDate: optionalIsoDate,
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
});

export type StagedPayload = z.infer<typeof stagedPayload>;
export type OrderInput = z.infer<typeof orderInput>;
export type BolMatchInput = z.infer<typeof bolMatchInput>;
