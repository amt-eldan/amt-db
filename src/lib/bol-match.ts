/**
 * Guardrails for bill-of-lading numbers written automatically by the external
 * shipment-tracking agent (POST /api/bol/matches).
 *
 * Filling `bol` turns a line green ("הגיע") via lineStatus, so an unattended
 * write can mark a shipment as arrived. Kept pure — and separate from the code
 * that touches the database — so the rules are unit-testable on their own.
 */

/** The part of a line these rules look at. */
export interface BolTarget {
  bol: string | null;
  isOpen: boolean;
}

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
