/**
 * Finding a bill-of-lading number in the text of an email, and saying how much
 * that finding is worth.
 *
 * This is the part of the sync button that can do real damage, so it is pure and
 * heavily bounded. A wrong tracking number written onto a line is worse than no
 * number at all: it points a customer's shipment at another supplier's parcel,
 * and nothing downstream can tell that it is wrong — the row turns blue, the
 * carrier page says "not found", and someone has to work out why.
 *
 * Two rules keep that from happening.
 *
 * **A number needs a label.** Carrier and supplier mail always says what the
 * number is ("Tracking Number:", "AWB", "שטר מטען"). A bare 12-digit string in a
 * mail is far more likely to be an invoice number, a quantity, or a phone number,
 * so shape alone earns a confidence below the auto-write floor: it is reported
 * for a human, never written.
 *
 * **The line's own identifiers are excluded.** A purchase-order number is very
 * often ten digits, which is exactly a DHL Express tracking number. Handing the
 * PO back as the tracking number would be a self-fulfilling match — the right
 * line, the wrong field. Callers pass what they already know about the line and
 * those values can never be returned.
 *
 * The confidence values line up with MIN_AUTO_CONFIDENCE in ./bol-match, which is
 * what decides whether a match is written or reported.
 */

import { normalizeTracking } from "./courier-match";

export type DetectedCarrier = "UPS" | "FedEx" | "DHL" | null;

export interface TrackingCandidate {
  /** The number as it should be stored — normalized, no separators. */
  bol: string;
  /** The carrier the number's shape implies, or null when it implies none. */
  carrier: DetectedCarrier;
  /** 0..1, comparable with MIN_AUTO_CONFIDENCE. */
  confidence: number;
  /** The label that vouched for it, when one did. */
  label: string | null;
  /** A short window of the mail around the number, for the audit trail. */
  quote: string;
}

/**
 * Number shapes, most specific first.
 *
 * Order matters: a UPS number starts with 1Z and is unmistakable, while "ten
 * digits" is shared by DHL Express, a FedEx door tag, and half the invoice
 * numbers in the world. So 1Z is claimed first, and the ambiguous shapes are
 * matched last and are worth less.
 */
const CARRIER_SHAPES: { carrier: DetectedCarrier; pattern: RegExp; strong: boolean }[] = [
  // UPS: 1Z + 16 alphanumerics. Unique enough to stand on its own. The optional
  // separator is because carriers print their own numbers in groups ("1Z 999 AA1
  // 0123 4567 84"), and normalizeTracking strips them back out again.
  { carrier: "UPS", pattern: /\b1Z(?:[ -]?[0-9A-Z]){16}(?![0-9A-Z])/gi, strong: true },
  // DHL eCommerce / Parcel: a fixed prefix, then digits.
  { carrier: "DHL", pattern: /\b(?:JJD|JVGL)[0-9A-Z]{8,20}\b/gi, strong: true },
  // FedEx in its printed form: three groups of four. Distinctive enough to be
  // worth matching on its own, but still a shape an invoice can wear.
  { carrier: "FedEx", pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, strong: false },
  // FedEx: 12, 15, 20 or 34 digits. Common shapes, so never strong on their own.
  { carrier: "FedEx", pattern: /\b\d{12}\b/g, strong: false },
  { carrier: "FedEx", pattern: /\b\d{15}\b/g, strong: false },
  { carrier: "FedEx", pattern: /\b\d{20}\b/g, strong: false },
  { carrier: "FedEx", pattern: /\b\d{34}\b/g, strong: false },
  // DHL Express: exactly 10 digits. The single most collision-prone shape here.
  { carrier: "DHL", pattern: /\b\d{10}\b/g, strong: false },
];

/**
 * Words that mean "the number after me is a tracking number".
 *
 * English and Hebrew, because the mailbox gets both, and abbreviations because
 * carriers use them in subject lines where space is short.
 *
 * The plain shipment nouns at the end are here because that is how carrier
 * subject lines are actually written — "FedEx Shipment 7712… Delivered" never
 * uses the words "tracking number", and requiring them would have missed the
 * mails this button exists to read.
 *
 * Bare carrier names are deliberately **not** labels. "we ship via DHL" in a
 * signature sits within a few words of every number in the mail below it, and a
 * label is supposed to say what a number *is*, not who sent the mail. The carrier
 * is established from the number's own shape instead.
 */
const LABELS = [
  "tracking number",
  "tracking no",
  "tracking #",
  "tracking id",
  "trackingnumber",
  "tracking",
  "track your",
  "air waybill",
  "airwaybill",
  "waybill",
  "awb",
  "pro number",
  "consignment",
  "shipment",
  "package",
  "parcel",
  "שטר מטען",
  "מספר מעקב",
  "מספר מטען",
  "דרך אווירית",
  "משלוח",
  "חבילה",
];

/**
 * How far before a number a label still counts, in characters.
 *
 * Wide enough to cross a table cell boundary or a line break ("Tracking
 * Number:\n\n  1Z999..."), narrow enough that a label in one paragraph does not
 * vouch for a number in the next. HTML has already been flattened to text with
 * its line breaks preserved (see gmail-parse.htmlToText), which is what makes a
 * character window meaningful here at all.
 */
const LABEL_WINDOW = 60;

/** Anything that must never be returned as a tracking number for this line. */
export interface TrackingDenyList {
  poNumber?: string | null;
  orderNumber?: string | null;
  pn?: string | null;
  sku?: string | null;
}

function denySet(deny: TrackingDenyList | undefined): Set<string> {
  const set = new Set<string>();
  for (const value of [deny?.poNumber, deny?.orderNumber, deny?.pn, deny?.sku]) {
    const normalized = normalizeTracking(value);
    if (normalized) set.add(normalized);
  }
  return set;
}

/** A repeated single digit: column padding or a placeholder, never a shipment. */
function isPlaceholder(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

/**
 * A long run of digits that opens with a real calendar date — how a message id or
 * a log timestamp in a mail footer ("20260826T…") ends up shaped like a tracking
 * number.
 *
 * Deliberately narrow. Requiring twelve digits and a valid month and day keeps it
 * away from DHL Express's ten, where rejecting everything beginning 19 or 20
 * would have thrown out perfectly good numbers. And it only ever applies to an
 * unlabelled candidate: if the mail says "Tracking Number:", the mail is a better
 * witness than the shape.
 */
function looksLikeTimestamp(value: string): boolean {
  if (!/^\d{12,}$/.test(value)) return false;
  if (!/^(19|20)\d{2}/.test(value)) return false;
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** The label immediately before `index`, if there is one. */
function labelBefore(haystack: string, index: number): string | null {
  const start = Math.max(0, index - LABEL_WINDOW);
  const window = haystack.slice(start, index).toLowerCase();
  // The nearest label wins, so a mail listing two shipments does not let the
  // first one's label vouch for the second one's number.
  let best: { label: string; at: number } | null = null;
  for (const label of LABELS) {
    const at = window.lastIndexOf(label);
    if (at === -1) continue;
    if (!best || at > best.at) best = { label, at };
  }
  return best?.label ?? null;
}

/** A short, single-line excerpt around the number, for audit_log. */
function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + length + 50);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Confidence, from the two things that were actually established: whether a label
 * vouched for the number, and whether its shape is one only a carrier uses.
 *
 * The floor for an automatic write is MIN_AUTO_CONFIDENCE (0.5), so the
 * unlabelled cases sit deliberately below it: found, reported, not written.
 */
function scoreOf(hasLabel: boolean, strongShape: boolean): number {
  if (hasLabel && strongShape) return 0.95;
  if (hasLabel) return 0.75;
  if (strongShape) return 0.45;
  return 0.25;
}

/**
 * Every tracking number the text plausibly contains, best first.
 *
 * A mail can legitimately carry several (a split shipment, or a digest listing
 * three orders). They are all returned with their scores and the caller decides:
 * one clear winner is written, and a tie is a thing for a human to look at, in
 * keeping with the no-guessing rule the rest of the matching follows.
 */
export function findTrackingCandidates(
  text: string,
  deny?: TrackingDenyList,
): TrackingCandidate[] {
  if (!text) return [];
  const forbidden = denySet(deny);
  const bestByBol = new Map<string, TrackingCandidate>();

  for (const shape of CARRIER_SHAPES) {
    // Each pattern is global and reused across calls, so its lastIndex has to be
    // reset or the second call starts where the first one stopped.
    shape.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = shape.pattern.exec(text)) !== null) {
      const raw = match[0];
      const bol = normalizeTracking(raw);
      if (!bol || forbidden.has(bol) || isPlaceholder(bol)) continue;

      const label = labelBefore(text, match.index);
      if (label === null && looksLikeTimestamp(bol)) continue;
      const candidate: TrackingCandidate = {
        bol,
        carrier: shape.carrier,
        confidence: scoreOf(label !== null, shape.strong),
        label,
        quote: quoteAround(text, match.index, raw.length),
      };

      // The same number can match more than one shape (12 digits is also part of
      // a longer run) and can appear several times in one mail. Keep the reading
      // that scored highest — the one whose label was closest.
      const existing = bestByBol.get(bol);
      if (!existing || candidate.confidence > existing.confidence) {
        bestByBol.set(bol, candidate);
      }
    }
  }

  return [...bestByBol.values()].sort(
    (a, b) => b.confidence - a.confidence || a.bol.localeCompare(b.bol),
  );
}

/**
 * The one candidate worth writing, or null.
 *
 * Null on an empty result, and also on a tie: two numbers with the same top score
 * in one mail is exactly the ambiguity that must not be resolved by picking one.
 * A number that scored below the write floor is still returned — the caller
 * reports it, and `evaluateBolMatch` is what refuses to write it, so there is one
 * place that decides and it is the same one the agent path goes through.
 */
export function bestTrackingCandidate(candidates: TrackingCandidate[]): TrackingCandidate | null {
  if (candidates.length === 0) return null;
  const [first, second] = candidates;
  if (second && second.confidence === first.confidence) return null;
  return first;
}
