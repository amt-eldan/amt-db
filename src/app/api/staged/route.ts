import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { stagedOrders } from "@/db/schema";
import { audit } from "@/lib/audit";
import { stagedPayload } from "@/lib/validation";

/**
 * Ingest endpoint for the external OCR pipeline.
 * POST /api/staged  with  Authorization: Bearer <INGEST_TOKEN>
 * Body: a single staged-order payload or an array of them.
 */
export async function POST(request: NextRequest) {
  const token = process.env.INGEST_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  if (!token || header !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const items = Array.isArray(body) ? body : [body];
  const parsed = items.map((item) => stagedPayload.safeParse(item));
  const firstError = parsed.find((p) => !p.success);
  if (firstError && !firstError.success) {
    return NextResponse.json(
      { error: "validation failed", details: firstError.error.issues },
      { status: 422 },
    );
  }

  const inserted = await db
    .insert(stagedOrders)
    .values(parsed.map((p) => ({ payload: p.data! })))
    .returning({ id: stagedOrders.id });

  for (const row of inserted) {
    await audit("staged_order", row.id, "ingest");
  }
  return NextResponse.json({ ok: true, ids: inserted.map((r) => r.id) }, { status: 201 });
}
