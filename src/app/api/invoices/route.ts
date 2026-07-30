import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { supplierInvoiceFiles, supplierInvoices } from "@/db/schema";
import { audit } from "@/lib/audit";
import { extractInvoiceFromPdf } from "@/lib/extract-invoice";
import { isUniqueViolation } from "@/lib/pg-error";
import { requireSession } from "@/lib/require-session";
import { supplierInvoiceInput } from "@/lib/validation";

export const runtime = "nodejs"; // Buffer
export const maxDuration = 60; // extraction takes 10–40s; 60 is the Hobby max

/** Vercel rejects request bodies over ~4.5MB before this code runs. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Manual supplier-invoice upload from /invoices: read the PDF with Claude and
 * save it as one invoice row plus the stored file. Unlike orders there is no
 * staging step — an invoice is a single editable row, so a wrong extraction is
 * fixed in place (or deleted) instead of being approved first.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "לא נשלח קובץ" }, { status: 400 });
  }

  const isPdfByType = file.type === "application/pdf";
  const isPdfByName = file.name.toLowerCase().endsWith(".pdf");
  if (!isPdfByType && !isPdfByName) {
    return NextResponse.json({ error: "יש להעלות קובץ PDF" }, { status: 415 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "הקובץ ריק" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `הקובץ גדול מדי (${(file.size / 1024 / 1024).toFixed(1)}MB) — המגבלה היא 4MB` },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return NextResponse.json({ error: "הקובץ אינו PDF תקין" }, { status: 415 });
  }

  const extracted = await extractInvoiceFromPdf(bytes.toString("base64"), file.name);
  if (!extracted.ok) {
    return NextResponse.json({ error: extracted.error }, { status: 502 });
  }
  const { invoice, warnings } = extracted;

  const parsed = supplierInvoiceInput.safeParse({ ...invoice, orderId: null });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "נתוני החשבונית שחולצו לא תקינים", details: parsed.error.issues },
      { status: 422 },
    );
  }

  let id: number;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(supplierInvoices)
        .values({ ...parsed.data, fileName: file.name, source: "extracted" })
        .returning({ id: supplierInvoices.id });
      await tx.insert(supplierInvoiceFiles).values({
        invoiceId: row.id,
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
        bytes,
      });
      return row.id;
    });
  } catch (e) {
    // The (supplier, invoice_number) guard: the same document twice.
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        {
          error: `חשבונית ${parsed.data.invoiceNumber} מהספק ${parsed.data.supplier} כבר קיימת`,
          duplicate: true,
        },
        { status: 409 },
      );
    }
    console.error("invoice upload failed", e);
    return NextResponse.json({ error: "שגיאה בשמירת החשבונית" }, { status: 500 });
  }

  await audit("supplier_invoice", id, "ingest", {
    source: "manual_upload",
    file: file.name,
    warnings,
  });
  revalidatePath("/invoices");

  return NextResponse.json(
    {
      ok: true,
      id,
      supplier: parsed.data.supplier,
      invoiceNumber: parsed.data.invoiceNumber,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      warnings,
    },
    { status: 201 },
  );
}
