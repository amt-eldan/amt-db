import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getBolCandidateLines } from "@/db/queries";
import { orderLines } from "@/db/schema";
import { evaluateBolMatch, resolveBolLine, type BolMatchedBy } from "@/lib/bol-match";
import { applyLineFields } from "@/lib/line-fields";
import { normalizeCarrierStatus } from "@/lib/shipment-status";
import { bolMatchInput } from "@/lib/validation";

type MatchResult = {
  /** null when no single line could be identified from the keys in the email. */
  lineId: number | null;
  status: "written" | "skipped";
  matchedBy?: BolMatchedBy;
  reason?: string;
};

/**
 * Bill-of-lading matches found by the external tracking agent.
 * POST /api/bol/matches  with  Authorization: Bearer <BOL_AGENT_TOKEN>
 * Body: one match or an array of them (see `bolMatchInput`).
 *
 * Writes each confident match straight onto order_lines.bol. A match either
 * names its `lineId` (taken from the worklist) or quotes what the email said —
 * `pn`, `poNumber`, `orderNumber` — and the server finds the open line itself,
 * so a tracking number that shows up without a worklist behind it still lands.
 *
 * Guards, because this write is unattended:
 *  - one line or none: several lines matching the same P/N is reported, never guessed,
 *  - never overwrites a BOL that is already set (human or earlier run),
 *  - only touches open lines,
 *  - skips low-confidence matches rather than guessing,
 *  - records the source email + quote in audit_log for every write.
 */
export async function POST(request: NextRequest) {
  const token = process.env.BOL_AGENT_TOKEN;
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
  const parsed = items.map((item) => bolMatchInput.safeParse(item));
  const firstError = parsed.find((p) => !p.success);
  if (firstError && !firstError.success) {
    return NextResponse.json(
      { error: "validation failed", details: firstError.error.issues },
      { status: 422 },
    );
  }

  // Only fetched when at least one match arrived without a lineId, so the common
  // worklist round trip costs exactly what it did before. Read once for the whole
  // batch: a line filled earlier in this batch still looks empty here, and that is
  // fine — the write guard below re-reads the line itself, so two numbers aimed at
  // one line end up as one write and one reported conflict rather than an overwrite.
  const needsLookup = parsed.some((p) => p.data!.lineId === null);
  const candidates = needsLookup ? await getBolCandidateLines() : [];

  const results: MatchResult[] = [];
  for (const p of parsed) {
    const match = p.data!;

    let lineId = match.lineId;
    let matchedBy: BolMatchedBy = "lineId";
    if (lineId === null) {
      const resolution = resolveBolLine(match, candidates);
      if (resolution.lineId === null) {
        results.push({ lineId: null, status: "skipped", reason: resolution.reason });
        continue;
      }
      lineId = resolution.lineId;
      matchedBy = resolution.matchedBy;
    }

    const [existing] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));

    const verdict = evaluateBolMatch(existing, match);
    if (!verdict.write) {
      results.push({ lineId, status: "skipped", matchedBy, reason: verdict.reason });
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
        // Which key found the line — part of what makes an unattended write
        // reviewable, next to the email it came from.
        matchedBy,
        searchKeys:
          matchedBy === "lineId"
            ? null
            : { pn: match.pn, poNumber: match.poNumber, orderNumber: match.orderNumber },
      },
    );
    results.push({ lineId, status: "written", matchedBy });
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
