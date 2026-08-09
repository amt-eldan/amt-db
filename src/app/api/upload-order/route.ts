import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { stagedOrders } from "@/db/schema";
import { audit } from "@/lib/audit";
import { extractOrderFromPdf } from "@/lib/extract-order";
import { requireSession } from "@/lib/require-session";
import { stagedPayload } from "@/lib/validation";

export const runtime = "nodejs"; // Buffer
export const maxDuration = 60; // extraction takes 10–40s; 60 is the Hobby max

/** Vercel rejects request bodies over ~4.5MB before this code runs. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Manual PDF upload from /intake: extract the order with Claude and stage it
 * for human approval. Session-protected (the proxy only exempts /login and
 * /api/staged; requireSession is defense in depth on top of that).
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

  const extracted = await extractOrderFromPdf(bytes.toString("base64"), file.name);
  if (!extracted.ok) {
    return NextResponse.json({ error: extracted.error }, { status: 502 });
  }
  const { order, warnings } = extracted;

  // The order number is the order's identity — without it there is nothing to
  // stage. A missing customer is not fatal: the row is staged with an empty name
  // and the review card asks for it (see the warnings this extraction carries).
  if (!order.orderNumber) {
    return NextResponse.json(
      { error: "לא זוהה מספר הזמנה במסמך. ניתן להזין את ההזמנה ידנית.", missing: ["מספר הזמנה"] },
      { status: 422 },
    );
  }

  const parsed = stagedPayload.safeParse({ ...order, sourceFile: file.name });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "נתוני ההזמנה שחולצו לא תקינים", details: parsed.error.issues },
      { status: 422 },
    );
  }

  const [row] = await db
    .insert(stagedOrders)
    .values({ payload: parsed.data })
    .returning({ id: stagedOrders.id });

  await audit("staged_order", row.id, "ingest", {
    source: "manual_upload",
    file: file.name,
    warnings,
  });
  revalidatePath("/intake");
  revalidatePath("/");

  return NextResponse.json(
    {
      ok: true,
      id: row.id,
      customer: parsed.data.customer,
      orderNumber: parsed.data.orderNumber,
      lineCount: parsed.data.lines.length,
      warnings,
    },
    { status: 201 },
  );
}
