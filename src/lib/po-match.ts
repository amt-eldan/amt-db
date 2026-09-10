/**
 * Which order line a line off **our** purchase order belongs to, and whether its
 * unit cost may be written there.
 *
 * The document being matched is the one we send a supplier — DigiKey, Mouser, a
 * manufacturer — and the only thing on it worth keeping is the unit **buy**
 * price. The lines it should land on already exist: they were created from the
 * customer's order, which is a different document with a different price on it
 * (see DOCUMENT_KINDS in ./extract-order for why that distinction is enforced
 * rather than assumed).
 *
 * So this never creates a line. It attaches cost data to lines that are already
 * there, and the risk it manages is attaching it to the wrong one — a wrong buy
 * price is a wrong profit on every screen, and unlike a wrong tracking number
 * nobody will ever get a "not found" page telling them so.
 *
 * Pure, and separate from the code that touches the database, so the rules are
 * unit-testable on their own — the same split ./bol-match follows, and the same
 * doctrine: every supplied key narrows, ambiguity is reported and never resolved
 * by picking one, and nothing a human entered is overwritten.
 */

import { normalizeTracking } from "./courier-match";

/** An existing order line a purchase-order line might belong to. */
export interface PoCandidateLine {
  lineId: number;
  orderNumber: string;
  customerName: string;
  pn: string | null;
  sku: string | null;
  qty: string | null;
  poNumber: string | null;
  supplier: string | null;
  buyPrice: string | null;
  buyPriceUsd: string | null;
  fxRateSource: string | null;
  isOpen: boolean;
}

/** One line read off our purchase order. */
export interface PoLine {
  pn: string | null;
  sku: string | null;
  qty: number | null;
  /** Unit cost as the document quotes it, in the document's currency. */
  unitCost: number | null;
  notes: string | null;
}

export type PoMatchedBy = "pn" | "sku";

export type PoResolution =
  | { lineId: number; matchedBy: PoMatchedBy; tieBrokenBy?: "qty" }
  | { lineId: null; reason: string };

/** Identifiers survive retyping — one normalization rule for the whole app. */
function key(value: string | null | undefined): string {
  return normalizeTracking(value);
}

function ids(lines: PoCandidateLine[]): string {
  return lines.map((l) => l.lineId).join(", ");
}

/** True when a line's shekel buy price was decided by a person, not by conversion. */
export function buyPriceIsHumanOwned(
  line: Pick<PoCandidateLine, "buyPrice" | "fxRateSource">,
): boolean {
  return line.buyPrice !== null && line.buyPrice !== "" && line.fxRateSource !== "boi";
}

/**
 * Finds the one open line a purchase-order line belongs to.
 *
 * The manufacturer part number is the only identifier the two documents reliably
 * share — the customer's order and ours both name the part, but our PO knows
 * nothing about the customer's order number. So `pn` leads, with the catalog
 * number as a fallback for a supplier who quotes that instead.
 *
 * A P/N repeats across orders, which is exactly why this cannot stop at "found a
 * match". Three narrowings run in order, and if the set is still larger than one
 * the answer is nothing:
 *
 *  1. **Open lines only.** A closed line's cost is history; rewriting it would
 *     move a profit figure in a month that has already been reported.
 *  2. **Lines not already tied to a purchase order.** One PO per line is the
 *     normal case, so a line still waiting for one is the better candidate —
 *     the same reasoning that makes ./bol-match prefer a line with no BOL.
 *  3. **Quantity.** Our PO orders the quantity the customer ordered, so an exact
 *     qty match is a real discriminator here in a way it never was for a
 *     tracking number. Used only to break a tie, never to create one.
 */
export function resolvePoLine(poLine: PoLine, candidates: PoCandidateLine[]): PoResolution {
  const wantedPn = key(poLine.pn);
  const wantedSku = key(poLine.sku);
  if (!wantedPn && !wantedSku) {
    return { lineId: null, reason: 'לשורה אין מק"ט יצרן ולא מספר קטלוגי — אין לפי מה להתאים' };
  }

  const matchedBy: PoMatchedBy = wantedPn ? "pn" : "sku";
  const described = wantedPn ? `P/N ${poLine.pn}` : `מק"ט ${poLine.sku}`;

  // A candidate matches on either identifier, in either position: a supplier's
  // "P/N" is sometimes our catalog number and the other way round.
  const wanted = [wantedPn, wantedSku].filter(Boolean);
  const matched = candidates.filter((line) =>
    wanted.some((w) => key(line.pn) === w || key(line.sku) === w),
  );
  if (matched.length === 0) {
    return { lineId: null, reason: `אין שורה שמתאימה ל-${described}` };
  }

  const open = matched.filter((line) => line.isOpen);
  if (open.length === 0) {
    return { lineId: null, reason: `רק שורות סגורות מתאימות ל-${described}` };
  }
  if (open.length === 1) return { lineId: open[0].lineId, matchedBy };

  const waiting = open.filter((line) => !line.poNumber || line.poNumber.trim() === "");
  const pool = waiting.length > 0 ? waiting : open;
  if (pool.length === 1) return { lineId: pool[0].lineId, matchedBy };

  if (poLine.qty !== null) {
    const sameQty = pool.filter((line) => Number(line.qty) === poLine.qty);
    if (sameQty.length === 1) {
      return { lineId: sameQty[0].lineId, matchedBy, tieBrokenBy: "qty" };
    }
  }

  return {
    lineId: null,
    reason: `${pool.length} שורות פתוחות מתאימות ל-${described} (שורות ${ids(pool)}) — נדרשת בחירה ידנית`,
  };
}

export type PoWriteVerdict = { write: true; warnings: string[] } | { write: false; reason: string };

/**
 * Whether this purchase-order line's cost may be written onto that order line.
 *
 * Two things are refused outright rather than warned about, because both mean the
 * match itself is in doubt and a cost written on the wrong line is invisible:
 * a line already carrying a **different** purchase-order number, and a cost that
 * is not a positive finite number.
 *
 * A shekel buy price a person entered is a different case: the dollar figure off
 * the document is still worth recording next to it, so the write proceeds and the
 * report says the shekel figure was left alone. `convertBuyPriceToIls` enforces
 * that independently — this only explains it.
 */
export type PoWriteTarget = Pick<
  PoCandidateLine,
  "isOpen" | "poNumber" | "qty" | "buyPrice" | "fxRateSource"
>;

export function evaluatePoWrite(
  poNumber: string,
  poLine: PoLine,
  line: PoWriteTarget | undefined,
): PoWriteVerdict {
  if (!line) return { write: false, reason: "השורה לא נמצאה" };
  if (!line.isOpen) return { write: false, reason: "השורה סגורה" };

  const existing = (line.poNumber ?? "").trim();
  if (existing && key(existing) !== key(poNumber)) {
    return {
      write: false,
      reason: `לשורה משויכת כבר הזמנת רכש אחרת (${existing}) — נדרשת בדיקה ידנית`,
    };
  }

  const cost = poLine.unitCost;
  if (cost === null || !Number.isFinite(cost) || cost <= 0) {
    return { write: false, reason: "לא נקרא מחיר קנייה ליחידה תקין" };
  }

  const warnings: string[] = [];
  if (buyPriceIsHumanOwned(line)) {
    warnings.push(
      `מחיר הקנייה בשקלים (${line.buyPrice}) הוזן ידנית ולא יידרס — יירשם רק המחיר בדולרים`,
    );
  }
  if (poLine.qty !== null && line.qty !== null && Number(line.qty) !== poLine.qty) {
    warnings.push(`הכמות בהזמנת הרכש (${poLine.qty}) שונה מהכמות בשורה (${line.qty})`);
  }

  return { write: true, warnings };
}
