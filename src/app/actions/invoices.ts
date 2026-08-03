"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { supplierInvoices } from "@/db/schema";
import { audit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/pg-error";
import { requireSession } from "@/lib/require-session";
import { supplierInvoiceInput, supplierInvoiceUpdate } from "@/lib/validation";
import type { ActionResult } from "./orders";

function duplicateError(supplier: string, invoiceNumber: string): ActionResult {
  return {
    ok: false,
    duplicate: true,
    error: `חשבונית ${invoiceNumber} מהספק ${supplier} כבר קיימת`,
  };
}

export async function createSupplierInvoice(input: unknown): Promise<ActionResult> {
  await requireSession();
  const parsed = supplierInvoiceInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const data = parsed.data;

  let id: number;
  try {
    const [row] = await db
      .insert(supplierInvoices)
      .values({ ...data, source: "manual" })
      .returning({ id: supplierInvoices.id });
    id = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) return duplicateError(data.supplier, data.invoiceNumber);
    console.error("createSupplierInvoice failed", e);
    return { ok: false, error: "שגיאה בשמירת החשבונית" };
  }

  await audit("supplier_invoice", id, "create", {
    supplier: data.supplier,
    invoiceNumber: data.invoiceNumber,
    amount: data.amount,
    source: "manual",
  });
  revalidatePath("/invoices");
  revalidatePath("/");
  return { ok: true, message: `חשבונית ${data.invoiceNumber} נוספה` };
}

export async function updateSupplierInvoice(input: unknown): Promise<ActionResult> {
  await requireSession();
  const parsed = supplierInvoiceUpdate.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const { id, ...fields } = parsed.data;

  const [existing] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
  if (!existing) return { ok: false, error: "החשבונית לא נמצאה" };

  try {
    await db
      .update(supplierInvoices)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(supplierInvoices.id, id));
  } catch (e) {
    if (isUniqueViolation(e)) return duplicateError(fields.supplier, fields.invoiceNumber);
    console.error("updateSupplierInvoice failed", e);
    return { ok: false, error: "שגיאה בעדכון החשבונית" };
  }

  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const before = existing[k as keyof typeof existing];
    if (String(before ?? "") !== String(v ?? "")) diff[k] = { from: before, to: v };
  }
  await audit("supplier_invoice", id, "update", diff);
  revalidatePath("/invoices");
  revalidatePath("/");
  return { ok: true, message: "החשבונית עודכנה" };
}

export async function deleteSupplierInvoice(id: number): Promise<ActionResult> {
  await requireSession();
  const [existing] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
  if (!existing) return { ok: false, error: "החשבונית לא נמצאה" };

  // The stored PDF goes with it (supplier_invoice_files cascades).
  await db.delete(supplierInvoices).where(eq(supplierInvoices.id, id));
  await audit("supplier_invoice", id, "delete", {
    supplier: existing.supplier,
    invoiceNumber: existing.invoiceNumber,
  });
  revalidatePath("/invoices");
  revalidatePath("/");
  return { ok: true, message: "החשבונית נמחקה" };
}
