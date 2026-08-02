import { z } from "zod";
import { parseNumericString } from "./numeric";
import { MANUAL_STATUSES } from "./status";

/** MoD orders: 10 digits starting with 444 → the customer is the purchasing-group number. */
export function isModOrderNumber(orderNumber: string): boolean {
  return /^444\d{7}$/.test(orderNumber.trim());
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

/** Payload accepted by POST /api/staged (from the external OCR pipeline). */
export const stagedPayload = z.object({
  customer: z.string().trim().min(1),
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
 * tracking agent). `lineId` comes from the worklist the agent was handed, so a
 * match is bound to exactly one line rather than re-matched here.
 */
export const bolMatchInput = z.object({
  lineId: z.number().int().positive(),
  bol: z.string().trim().min(1, "מספר שטר מטען חובה").max(200),
  carrier: optionalText,
  statusText: optionalText,
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
