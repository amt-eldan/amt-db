import { NextResponse } from "next/server";
import { getCourierInvoiceFile } from "@/db/queries";
import { requireSession } from "@/lib/require-session";

export const runtime = "nodejs"; // Buffer

/**
 * The stored courier-invoice PDF, for viewing in the browser. Session-protected:
 * the bytes are business documents, so they never get a public URL and are never
 * cached by an intermediary.
 */
export async function GET(
  _request: Request,
  // Spelled out rather than via the global `RouteContext` helper, which only
  // exists after Next's type generation has run.
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }

  const file = await getCourierInvoiceFile(invoiceId);
  if (!file) {
    return NextResponse.json({ error: "לא נמצא קובץ לחשבונית" }, { status: 404 });
  }

  // RFC 5987 filename* so Hebrew names survive; inline so the browser shows it.
  const name = encodeURIComponent(file.fileName ?? `courier-invoice-${invoiceId}.pdf`);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${name}`,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
