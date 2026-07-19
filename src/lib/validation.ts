import { z } from "zod";
import { MANUAL_STATUSES } from "./status";

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

export type StagedPayload = z.infer<typeof stagedPayload>;
export type OrderInput = z.infer<typeof orderInput>;
