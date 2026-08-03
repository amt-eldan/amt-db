/**
 * Which line a bill-of-lading number belongs to, and whether it may be written
 * there — the rules behind POST /api/bol/matches, where the shipment-tracking
 * agent posts the tracking numbers it found in the mailbox.
 *
 * Two steps, both unattended, both irreversible from the agent's side: find the
 * line (resolveBolLine, when the email quotes a P/N instead of our lineId) and
 * decide whether to write on it (evaluateBolMatch). Kept pure — and separate
 * from the code that touches the database — so the rules are unit-testable on
 * their own.
 */

import { normalizeTracking } from "./courier-match";

/** The part of a line these rules look at. */
export interface BolTarget {
  bol: string | null;
  isOpen: boolean;
}

/** A line the tracking number can be attached to, with every key it may be found by. */
export interface BolCandidateLine extends BolTarget {
  lineId: number;
  orderNumber: string;
  pn: string | null;
  sku: string | null;
  poNumber: string | null;
  supplier: string | null;
}

/** The keys quoted in the email, used when the caller has no lineId to give. */
export interface BolSearchKeys {
  pn?: string | null;
  poNumber?: string | null;
  orderNumber?: string | null;
  supplier?: string | null;
}

/** Which key carried the match, for the response and the audit trail. */
export type BolMatchedBy = "lineId" | "poNumber" | "pn" | "orderNumber";

export type BolResolution =
  | { lineId: number; matchedBy: BolMatchedBy }
  | { lineId: null; reason: string };

/** A proposed match, after Zod validation (confidence is a 0..1 string). */
export interface BolProposal {
  bol: string;
  confidence: string | null;
}

/**
 * Minimum confidence that may be written automatically. An ambiguous match is
 * skipped and reported back for the daily summary instead of landing silently;
 * Eldan then fills it by hand. A match that omits confidence is trusted (the
 * agent asserts it).
 */
export const MIN_AUTO_CONFIDENCE = 0.5;

export type BolMatchVerdict = { write: true } | { write: false; reason: string };

/** True when a line has no usable bill of lading yet (NULL or whitespace). */
export function isBolEmpty(line: Pick<BolTarget, "bol">): boolean {
  return !line.bol || line.bol.trim() === "";
}

/** Decides whether a proposed bill of lading may be written to a line. */
export function evaluateBolMatch(
  existing: BolTarget | undefined,
  match: BolProposal,
): BolMatchVerdict {
  if (!existing) return { write: false, reason: "line not found" };
  if (!existing.isOpen) return { write: false, reason: "line is closed" };

  // Never overwrite. The same value means an earlier run already handled it; a
  // different value is a real conflict for a human, so report which it was.
  if (!isBolEmpty(existing)) {
    return {
      write: false,
      reason:
        existing.bol!.trim() === match.bol
          ? "bol already set (same value)"
          : "bol already set to a different value — needs manual review",
    };
  }

  if (match.confidence !== null && Number(match.confidence) < MIN_AUTO_CONFIDENCE) {
    return {
      write: false,
      reason: `confidence ${match.confidence} below ${MIN_AUTO_CONFIDENCE} — needs manual review`,
    };
  }

  return { write: true };
}

/**
 * Identifiers survive being retyped — the same normalization the courier matcher
 * uses on tracking numbers, so "CH-USB-2" in an email and "ch usb 2" on the line
 * are one part number, and identifier comparison follows a single rule app-wide.
 */
function key(value: string | null | undefined): string {
  return normalizeTracking(value);
}

/** The keys, in the order of how strongly they identify a line. */
const SEARCH_KEYS = [
  { field: "poNumber", matchedBy: "poNumber" as BolMatchedBy },
  { field: "pn", matchedBy: "pn" as BolMatchedBy },
  { field: "orderNumber", matchedBy: "orderNumber" as BolMatchedBy },
] as const;

/** A line matches the P/N from the email by its own pn or by its catalog number. */
function matchesPn(line: BolCandidateLine, wanted: string): boolean {
  return key(line.pn) === wanted || key(line.sku) === wanted;
}

function matchesKey(line: BolCandidateLine, field: string, wanted: string): boolean {
  if (field === "pn") return matchesPn(line, wanted);
  if (field === "poNumber") return key(line.poNumber) === wanted;
  return key(line.orderNumber) === wanted;
}

/** Line numbers in a skip reason, so a human knows where to look. */
function ids(lines: BolCandidateLine[]): string {
  return lines.map((line) => line.lineId).join(", ");
}

/**
 * Finds the one line a tracking number belongs to when the caller has no lineId
 * — the email arrived on its own, quoting a P/N (or a PO / order number) rather
 * than our internal id.
 *
 * Every key that was supplied must match: keys narrow, they do not compete, so
 * "P/N X on order Y" is stricter than "P/N X" and never looser. `supplier` is
 * confirmation only (the sender's spelling rarely equals ours) and is used just
 * to break a tie.
 *
 * The result is a single line or nothing. A P/N repeats across orders, so an
 * ambiguous set is **not** resolved by picking one: it is reported, and Eldan
 * fills that number by hand. This is the same no-guessing rule the courier
 * matcher follows, and it matters more here — a wrong BOL puts one supplier's
 * shipment on another customer's line.
 *
 * Lines that already carry a bill of lading are set aside first, so a second
 * item for the same P/N goes to the line still waiting for a number instead of
 * colliding with the one already filled. When the only matching line is already
 * taken it is still returned, so evaluateBolMatch can state whether this is a
 * repeat of the same number or a real conflict.
 */
export function resolveBolLine(
  keys: BolSearchKeys,
  candidates: BolCandidateLine[],
): BolResolution {
  const supplied = SEARCH_KEYS.map((k) => ({ ...k, value: key(keys[k.field]) })).filter(
    (k) => k.value !== "",
  );
  if (supplied.length === 0) {
    return { lineId: null, reason: "no lineId and no search keys (pn / poNumber / orderNumber)" };
  }

  const described = supplied.map((k) => `${k.field}=${keys[k.field]}`).join(" + ");
  const matched = candidates.filter((line) =>
    supplied.every((k) => matchesKey(line, k.field, k.value)),
  );
  if (matched.length === 0) {
    return { lineId: null, reason: `no line matches ${described}` };
  }

  const matchedBy = supplied[0].matchedBy;
  const open = matched.filter((line) => line.isOpen);
  if (open.length === 0) {
    return { lineId: null, reason: `only closed lines match ${described}` };
  }

  const waiting = open.filter((line) => isBolEmpty(line));
  if (waiting.length === 0) {
    // Nothing left to fill. A single line is handed back anyway, so
    // evaluateBolMatch can say whether this is a repeat of the same number or a
    // real conflict; with several there is no one line to speak for.
    if (open.length === 1) return { lineId: open[0].lineId, matchedBy };
    return {
      lineId: null,
      reason: `all ${open.length} open lines matching ${described} already have a bill of lading (lines ${ids(open)})`,
    };
  }
  if (waiting.length === 1) return { lineId: waiting[0].lineId, matchedBy };

  const wantedSupplier = key(keys.supplier);
  const bySupplier = wantedSupplier
    ? waiting.filter((line) => key(line.supplier) === wantedSupplier)
    : [];
  if (bySupplier.length === 1) return { lineId: bySupplier[0].lineId, matchedBy };

  return {
    lineId: null,
    reason: `${waiting.length} open lines match ${described} (lines ${ids(waiting)}) — needs manual review`,
  };
}
