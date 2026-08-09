import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getBolCandidateLines } from "@/db/queries";
import { orderLines } from "@/db/schema";
import { evaluateBolMatch, resolveBolLine, type BolMatchedBy } from "./bol-match";
import { applyLineFields } from "./line-fields";
import { normalizeCarrierStatus } from "./shipment-status";
import type { BolMatchInput } from "./validation";

export interface BolMatchResult {
  /** null when no single line could be identified from the keys in the email. */
  lineId: number | null;
  status: "written" | "skipped";
  matchedBy?: BolMatchedBy;
  reason?: string;
}

export interface BolWriteSummary {
  ok: true;
  written: number;
  skipped: number;
  results: BolMatchResult[];
}

/**
 * Writes bill-of-lading matches found by the shipment-tracking agent onto their
 * lines, and reports what it did and did not write.
 *
 * This is the *only* place a tracking number is written automatically. Both
 * doors in — POST /api/bol/matches and the `bol_submit_matches` MCP tool — call
 * it with matches already validated by `bolMatchInput`, because filling `bol`
 * turns a line green ("הגיע"): two code paths writing that field by two sets of
 * rules is how an unattended run ends up marking a shipment as arrived when it
 * is not.
 *
 * A match either names its `lineId` (taken from the worklist) or quotes what the
 * email said — `pn`, `poNumber`, `orderNumber` — and `resolveBolLine` finds the
 * open line itself, so a tracking number that shows up without a worklist behind
 * it still lands.
 *
 * The rules, all of them enforced here:
 *  - one line or none: several lines matching the same P/N is reported, never guessed.
 *  - `evaluateBolMatch` decides: known line, still open, `bol` empty, confidence
 *    at or above the floor. Anything else is skipped with a reason.
 *  - a human's note in `delivery_update` is never overwritten — the carrier's
 *    wording only fills that field while it is still empty.
 *  - every write goes through `applyLineFields`, so the before/after diff and
 *    the source email land in `audit_log`.
 *
 * Callers own authentication. Revalidation happens here, once, and only when
 * something was actually written.
 */
export async function writeBolMatches(matches: BolMatchInput[]): Promise<BolWriteSummary> {
  const results: BolMatchResult[] = [];

  // Only fetched when at least one match arrived without a lineId, so the common
  // worklist round trip costs exactly what it did before. Read once for the whole
  // batch: a line filled earlier in this batch still looks empty here, and that is
  // fine — the write guard below re-reads the line itself, so two numbers aimed at
  // one line end up as one write and one reported conflict rather than an overwrite.
  const needsLookup = matches.some((m) => m.lineId === null);
  const candidates = needsLookup ? await getBolCandidateLines() : [];

  for (const match of matches) {
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

    await applyLineFields(line, fields, {
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
    });
    results.push({ lineId, status: "written", matchedBy });
  }

  const written = results.filter((r) => r.status === "written").length;
  if (written > 0) {
    revalidatePath("/");
    revalidatePath("/orders");
    revalidatePath("/monthly");
    revalidatePath("/bol");
  }

  return { ok: true, written, skipped: results.length - written, results };
}
