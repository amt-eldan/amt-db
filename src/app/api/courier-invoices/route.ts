import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { stagedCourierInvoices } from "@/db/schema";
import { getCourierLineOptions } from "@/db/queries";
import { audit } from "@/lib/audit";
import { isLowConfidence, matchShipmentsToLines } from "@/lib/courier-match";
import { extractCourierInvoiceFromPdf } from "@/lib/extract-courier-invoice";
import { requireSession } from "@/lib/require-session";
import { courierInvoiceDraft } from "@/lib/validation";

export const runtime = "nodejs"; // Buffer
export const maxDuration = 60; // extraction takes 10–40s; 60 is the Hobby max

/** Vercel rejects request bodies over ~4.5MB before this code runs. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Courier-invoice upload from /courier: read the PDF with Claude, match every
 * shipment on it to the line that carries the same tracking number, and park the
 * result as *pending*. Nothing reaches courier_invoices here — a courier charge
 * changes the profit of an order line, so it waits for a human to confirm the
 * split (see actions/courier.ts → approveCourierInvoice).
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

  const extracted = await extractCourierInvoiceFromPdf(bytes.toString("base64"), file.name);
  if (!extracted.ok) {
    return NextResponse.json({ error: extracted.error }, { status: 502 });
  }
  const { invoice, warnings } = extracted;

  // Propose a line for each shipment now, while the tracking numbers are in hand;
  // the reviewer sees a filled-in split instead of an empty table.
  const lines = await getCourierLineOptions();
  const matched = matchShipmentsToLines(invoice.shipments, lines);
  const unmatched = matched.filter((s) => s.lineId === null).length;
  if (unmatched > 0) {
    warnings.push(
      unmatched === 1
        ? "משלוח אחד לא זוהה מול שורה קיימת — יש לבחור שורה ידנית"
        : `${unmatched} משלוחים לא זוהו מול שורות קיימות — יש לבחור שורה ידנית`,
    );
  }

  // A guess is not a match, and it must not be reported as one. Its own warning,
  // in its own words, so nobody reads "5 שויכו" and assumes five tracking numbers.
  const guessed = matched.filter((s) => isLowConfidence(s.matchedBy)).length;
  if (guessed > 0) {
    warnings.push(
      guessed === 1
        ? "משלוח אחד שויך לפי ספק ותאריך בלבד — שיוך משוער שדורש אישור לפני שהעלות תירשם"
        : `${guessed} משלוחים שויכו לפי ספק ותאריך בלבד — שיוכים משוערים שדורשים אישור לפני שהעלות תירשם`,
    );
  }

  const parsed = courierInvoiceDraft.safeParse({
    ...invoice,
    fileName: file.name,
    shipments: matched.map(
      ({
        bol,
        reference,
        customsDeclaration,
        shipper,
        shipmentDate,
        description,
        amount,
        charges,
        lineId,
        matchedBy,
      }) => ({
        bol,
        reference,
        customsDeclaration,
        shipper,
        shipmentDate,
        description,
        amount,
        charges,
        lineId,
        // Kept, not dropped: without it the staged row cannot tell a tracking-number
        // match from a guess, and the reviewer would be shown both the same way.
        matchedBy,
      }),
    ),
    warnings,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "נתוני החשבונית שחולצו לא תקינים", details: parsed.error.issues },
      { status: 422 },
    );
  }

  let stagedId: number;
  try {
    const [row] = await db
      .insert(stagedCourierInvoices)
      .values({
        payload: parsed.data,
        fileName: file.name,
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
        bytes,
      })
      .returning({ id: stagedCourierInvoices.id });
    stagedId = row.id;
  } catch (e) {
    console.error("courier invoice upload failed", e);
    return NextResponse.json({ error: "שגיאה בשמירת החשבונית" }, { status: 500 });
  }

  await audit("staged_courier_invoice", stagedId, "ingest", {
    source: "manual_upload",
    file: file.name,
    courier: parsed.data.courier,
    invoiceNumber: parsed.data.invoiceNumber,
    shipments: parsed.data.shipments.length,
    matchedLines: parsed.data.shipments.filter(
      (s) => s.lineId !== null && !isLowConfidence(s.matchedBy),
    ).length,
    guessedLines: guessed,
    warnings,
  });
  revalidatePath("/courier");

  return NextResponse.json(
    {
      ok: true,
      stagedId,
      courier: parsed.data.courier,
      invoiceNumber: parsed.data.invoiceNumber,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      shipments: parsed.data.shipments.length,
      matched: parsed.data.shipments.filter(
        (s) => s.lineId !== null && !isLowConfidence(s.matchedBy),
      ).length,
      guessed,
      warnings,
    },
    { status: 201 },
  );
}
