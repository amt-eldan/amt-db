import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { stagedOrders } from "@/db/schema";
import { requireBearer } from "@/lib/api-auth";
import { audit } from "@/lib/audit";
import { stagedPayload, stagedWarnings } from "@/lib/validation";

/**
 * Ingest endpoint for the external OCR pipeline.
 * POST /api/staged  with  Authorization: Bearer <INGEST_TOKEN>
 * Body: a single staged-order payload or an array of them. Each may carry an
 * optional top-level `warnings` array for anything a human should double-check;
 * it is stored beside the payload and shown on the review card.
 */
export async function POST(request: NextRequest) {
  const denied = requireBearer(request, process.env.INGEST_TOKEN);
  if (denied) return denied;

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

  // `stagedPayload` strips unknown keys, so warnings are read off the raw item.
  const warnings = items.map((item) => {
    const w = stagedWarnings.safeParse((item as { warnings?: unknown })?.warnings);
    return w.success ? w.data : [];
  });

  const inserted = await db
    .insert(stagedOrders)
    .values(parsed.map((p, i) => ({ payload: p.data!, warnings: warnings[i] })))
    .returning({ id: stagedOrders.id });

  for (const [i, row] of inserted.entries()) {
    await audit("staged_order", row.id, "ingest", { warnings: warnings[i] }, "agent:ingest");
  }
  return NextResponse.json({ ok: true, ids: inserted.map((r) => r.id) }, { status: 201 });
}
