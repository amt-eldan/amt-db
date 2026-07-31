import { NextResponse } from "next/server";
import { getStagedCourierInvoiceFile } from "@/db/queries";
import { requireSession } from "@/lib/require-session";

export const runtime = "nodejs"; // Buffer

/**
 * The PDF of a courier invoice still waiting for approval. Deciding which lines a
 * charge belongs to means reading the document, so the reviewer can open it before
 * the invoice exists in the ledger.
 *
 * A static segment next to the sibling `[id]` route: Next matches "staged" here
 * before it treats it as an id.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const stagedId = Number(id);
  if (!Number.isInteger(stagedId) || stagedId <= 0) {
    return NextResponse.json({ error: "מזהה לא תקין" }, { status: 400 });
  }

  const file = await getStagedCourierInvoiceFile(stagedId);
  if (!file) {
    return NextResponse.json({ error: "לא נמצא קובץ לחשבונית" }, { status: 404 });
  }

  const name = encodeURIComponent(file.fileName ?? `courier-invoice-staged-${stagedId}.pdf`);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mimeType ?? "application/pdf",
      "Content-Disposition": `inline; filename*=UTF-8''${name}`,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
