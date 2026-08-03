import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { orderLines, type OrderLine } from "@/db/schema";
import { requireBearer } from "@/lib/api-auth";
import { evaluateBolMatch } from "@/lib/bol-match";
import { applyLineFields } from "@/lib/line-fields";
import { normalizeCarrierStatus } from "@/lib/shipment-status";
import { bolMatchInput } from "@/lib/validation";

type MatchResult = {
  lineId: number;
  status: "written" | "skipped";
  reason?: string;
};

/**
 * Bill-of-lading matches found by the external tracking agent.
 * POST /api/bol/matches  with  Authorization: Bearer <BOL_AGENT_TOKEN>
 * Body: one match or an array of them (see `bolMatchInput`).
 *
 * Writes each confident match straight onto order_lines.bol. Guards, because
 * this write marks a shipment as arrived:
 *  - never overwrites a BOL that is already set (human or earlier run),
 *  - only touches open lines,
 *  - skips low-confidence matches rather than guessing,
 *  - records the source email + quote in audit_log for every write.
 */
export async function POST(request: NextRequest) {
  const denied = requireBearer(request, process.env.BOL_AGENT_TOKEN);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const items = Array.isArray(body) ? body : [body];
  const parsed = items.map((item) => bolMatchInput.safeParse(item));
  const firstError = parsed.find((p) => !p.success);
  if (firstError && !firstError.success) {
    return NextResponse.json(
      { error: "validation failed", details: firstError.error.issues },
      { status: 422 },
    );
  }

  const matches = parsed.map((p) => p.data!);

  // One lookup for the whole batch rather than a round-trip per match — a nightly
  // run covers tens of lines, and Neon is over the network.
  const byId = new Map<number, OrderLine>();
  const ids = [...new Set(matches.map((m) => m.lineId))];
  if (ids.length > 0) {
    const found = await db.select().from(orderLines).where(inArray(orderLines.id, ids));
    for (const line of found) byId.set(line.id, line);
  }

  const results: MatchResult[] = [];
  for (const match of matches) {
    const existing = byId.get(match.lineId);

    const verdict = evaluateBolMatch(existing, match);
    if (!verdict.write) {
      results.push({ lineId: match.lineId, status: "skipped", reason: verdict.reason });
      continue;
    }

    const line = existing!; // evaluateBolMatch only returns write:true for a line it found
    const fields: Record<string, unknown> = {
      bol: match.bol,
      carrier: match.carrier,
      bolSource: "auto",
      bolConfidence: match.confidence,
    };

    // The shipment is now trackable, so record where it stands. shipment_status is
    // the normalized value the /bol screen filters on; the carrier's own wording
    // goes to delivery_update — but only when that field is still empty, because a
    // human's note there must not be overwritten by an automated run (the same
    // never-clobber rule this endpoint already applies to `bol`).
    if (match.statusText) {
      fields.shipmentStatus = normalizeCarrierStatus(match.statusText);
      fields.shipmentStatusAt = new Date();
      if (!line.deliveryUpdate || line.deliveryUpdate.trim() === "") {
        fields.deliveryUpdate = match.statusText;
      }
    }
    if (match.etaDate) fields.shipmentEta = match.etaDate;

    await applyLineFields(
      line,
      fields,
      {
        agent: "bol-tracking",
        emailId: match.sourceEmailId,
        quote: match.sourceQuote,
        carrierStatus: match.statusText,
        confidence: match.confidence,
      },
      "agent:bol-tracking",
    );

    // Keep the cached row in step with what was just written, so a second match
    // for the same line in this batch hits the never-overwrite guard instead of
    // reading a stale empty `bol`.
    byId.set(line.id, { ...line, ...fields } as OrderLine);
    results.push({ lineId: match.lineId, status: "written" });
  }

  const written = results.filter((r) => r.status === "written").length;
  if (written > 0) {
    revalidatePath("/");
    revalidatePath("/orders");
    revalidatePath("/monthly");
    revalidatePath("/bol");
  }

  return NextResponse.json({
    ok: true,
    written,
    skipped: results.length - written,
    results,
  });
}
