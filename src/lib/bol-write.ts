import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { orderLines } from "@/db/schema";
import { evaluateBolMatch } from "./bol-match";
import { applyLineFields } from "./line-fields";
import { normalizeCarrierStatus } from "./shipment-status";
import type { BolMatchInput } from "./validation";

export interface BolMatchResult {
  lineId: number;
  status: "written" | "skipped";
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
 * The rules, all of them enforced here:
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

  for (const match of matches) {
    const [existing] = await db.select().from(orderLines).where(eq(orderLines.id, match.lineId));

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

    await applyLineFields(line, fields, {
      agent: "bol-tracking",
      emailId: match.sourceEmailId,
      quote: match.sourceQuote,
      carrierStatus: match.statusText,
      confidence: match.confidence,
    });
    results.push({ lineId: match.lineId, status: "written" });
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
