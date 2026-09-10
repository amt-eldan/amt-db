import { NextRequest, NextResponse } from "next/server";
import { getPoCandidateLines } from "@/db/queries";
import { extractPurchaseOrderFromPdf } from "@/lib/extract-purchase-order";
import { resolvePoLine, evaluatePoWrite, type PoCandidateLine } from "@/lib/po-match";
import { requireSession } from "@/lib/require-session";

export const runtime = "nodejs"; // Buffer
export const maxDuration = 60; // extraction takes 10–40s; 60 is the Hobby max

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Upload of **our** purchase order to a supplier, from /intake.
 *
 * Extracts it, matches each of its lines to an existing order line, and returns
 * the proposal. **It writes nothing** — the review screen shows which line each
 * cost would land on and a person applies it (see applyPurchaseOrder). That split
 * is the point: a customer order creates rows and is staged for approval, and a
 * purchase order changes the cost on rows that already exist, which deserves at
 * least as much of a look before it happens.
 *
 * Nothing is staged in the database either. The proposal is derived entirely from
 * the document plus the current lines, so re-uploading reproduces it, and a
 * half-reviewed import cannot sit in a table going stale.
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
  if (file.size === 0) return NextResponse.json({ error: "הקובץ ריק" }, { status: 400 });
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

  const extracted = await extractPurchaseOrderFromPdf(bytes.toString("base64"), file.name);
  if (!extracted.ok) {
    return NextResponse.json({ error: extracted.error }, { status: 502 });
  }
  const { order, warnings } = extracted;

  if (!order.poNumber) {
    return NextResponse.json(
      { error: "לא זוהה מספר הזמנת רכש במסמך — בלעדיו אין למה לשייך את המחירים." },
      { status: 422 },
    );
  }
  if (!order.currency) {
    return NextResponse.json(
      {
        error:
          "לא זוהה מטבע במסמך (או שהוא אינו דולר/שקל). מחיר קנייה בלי מטבע ידוע לא נקלט — יש להזין ידנית.",
      },
      { status: 422 },
    );
  }

  const candidates = await getPoCandidateLines();
  const byId = new Map<number, PoCandidateLine>(candidates.map((c) => [c.lineId, c]));

  const proposals = order.lines.map((poLine, i) => {
    const resolution = resolvePoLine(poLine, candidates);
    const base = {
      index: i + 1,
      pn: poLine.pn,
      sku: poLine.sku,
      qty: poLine.qty,
      unitCost: poLine.unitCost,
      notes: poLine.notes,
    };

    if (resolution.lineId === null) {
      return { ...base, lineId: null, reason: resolution.reason, ok: false as const };
    }

    const line = byId.get(resolution.lineId);
    const verdict = evaluatePoWrite(order.poNumber, poLine, line);
    return {
      ...base,
      lineId: resolution.lineId,
      matchedBy: resolution.matchedBy,
      tieBrokenBy: resolution.tieBrokenBy,
      orderNumber: line?.orderNumber ?? null,
      customerName: line?.customerName ?? null,
      lineQty: line?.qty ?? null,
      existingBuyPrice: line?.buyPrice ?? null,
      ok: verdict.write,
      reason: verdict.write ? undefined : verdict.reason,
      warnings: verdict.write && verdict.warnings.length ? verdict.warnings : undefined,
    };
  });

  return NextResponse.json({
    ok: true,
    poNumber: order.poNumber,
    supplier: order.supplier,
    orderDate: order.orderDate,
    currency: order.currency,
    sourceFile: file.name,
    warnings,
    proposals,
    matchable: proposals.filter((p) => p.ok).length,
  });
}
