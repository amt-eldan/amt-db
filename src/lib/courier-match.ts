/**
 * Matching a courier invoice to the lines it shipped, and turning the reviewed
 * result into allocations. All pure — the approval action and the review UI both
 * run the same functions, so what the reviewer sees is what gets written.
 *
 * The tracking number is what makes this possible: the courier prints it on the
 * invoice and the tracking agent already wrote it onto the line (`order_lines.bol`),
 * so the two documents have a shared key.
 *
 * Except that in practice it usually has not. `order_lines.bol` is populated on a
 * small minority of lines, so a document that only quotes a tracking number — a
 * DHL import-tax invoice, say, which quotes an AWB and a customs declaration and
 * no asmachta of ours at all — matched nothing and left the whole table for a human
 * to fill in by hand. Hence the supplier key: same supplier, plausible time frame,
 * and exactly one open line without a shipping cost that could be it.
 *
 * That key infers rather than identifies, so it is quarantined. It is tagged
 * `matchedBy: "supplier"`, the tag is persisted with the staged row, the UI shows
 * it as a guess, and `allocationsFromShipments` refuses to turn it into money.
 * Accepting a guess in the review table rewrites it to `"manual"` — the same thing
 * that has always happened when a human picks a line — and only then can it be
 * written. Nothing is written on a guess.
 */

/**
 * What kind of component a charge is. Only `vat` and `discount` change any
 * arithmetic (VAT is reported separately, a discount is expected to be negative);
 * the rest exist so the reviewer can read the breakdown at a glance.
 */
export type CourierChargeKind = "service" | "tax" | "fee" | "vat" | "discount" | "other";

/** One component of a shipment's cost, as the invoice itemizes it. */
export interface CourierCharge {
  label: string; // 'אגרת מחשב למכס', 'מע"מ', 'Fuel Surcharge'
  amount: string | null; // numeric string (validated), ILS
  kind: CourierChargeKind;
}

/** One charge on a courier invoice: one shipment, one tracking number. */
export interface CourierShipment {
  bol: string | null;
  reference: string | null; // our PO / order number as the courier quotes it
  /**
   * Customs declaration number ("מספר רשימון") — the customs authority's id for
   * the import, not an asmachta of ours. Extracted so it has somewhere to live
   * other than `reference`, where it would be a key guaranteed not to match and
   * liable to collide with a real order number. Never used for matching.
   */
  customsDeclaration: string | null;
  /** The sender as the invoice prints it ("פרטי השולח") — a matching signal. */
  shipper: string | null;
  /** yyyy-mm-dd. Kept structured (not only inside `description`) for the supplier key. */
  shipmentDate: string | null;
  description: string | null;
  amount: string | null; // numeric string (validated), ILS
  /** What the invoice says `amount` is made of — empty when it did not say. */
  charges: CourierCharge[];
  lineId: number | null; // filled by the matcher or by the reviewer
  /**
   * Which key placed this shipment, carried with the row rather than recomputed.
   * The staged payload stores it because a `supplier` match is a guess, and the
   * reviewer has to still be able to see that tomorrow — after the matcher that
   * made the guess is long out of scope.
   */
  matchedBy: MatchedBy;
}

export type MatchedBy = "bol" | "po" | "order" | "supplier" | "manual" | null;

/**
 * `supplier` is the one key that does not identify a shipment — it infers one
 * from "same supplier, right time frame, nothing else claims it". It is offered
 * for a human to accept, never written as if it were a tracking number.
 */
export function isLowConfidence(matchedBy: MatchedBy): boolean {
  return matchedBy === "supplier";
}

export interface MatchedShipment extends CourierShipment {
  matchedBy: MatchedBy;
  /** How many lines shared this shipment's cost (1 unless one BOL covered several). */
  splitCount: number;
}

/** The line fields matching needs — not the whole LineRow. */
export interface CourierLineOption {
  lineId: number;
  orderNumber: string;
  customerName: string;
  pn: string | null;
  poNumber: string | null;
  supplier: string | null;
  bol: string | null;
  shippingCost: string | null;
  orderDate: string | null;
  isOpen: boolean;
}

export interface CourierAllocationDraft {
  lineId: number;
  amount: string;
  bol: string | null;
  description: string | null;
}

/**
 * Tracking numbers survive being retyped: spaces, dashes and case are noise
 * ("1Z 999-AA1" and "1z999aa1" are the same shipment), so comparison happens on
 * the stripped form only.
 */
export function normalizeTracking(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Company-form noise. `ATIC (HK)TECHNOLOGY CO,LTD` and `ATIC Technology` are one
 * supplier; the suffixes carry no identity and appear inconsistently, so they are
 * removed before comparison rather than weighed.
 */
const LEGAL_FORMS = new Set([
  "LTD", "LIMITED", "CO", "COMPANY", "CORP", "CORPORATION", "INC", "INCORPORATED",
  "LLC", "LLP", "PLC", "GMBH", "AG", "KG", "BV", "NV", "SA", "SAS", "SARL", "SRL",
  "SPA", "AB", "OY", "AS", "PTE", "PTY", "PL", "KK", "SDN", "BHD", "GROUP", "HOLDINGS",
]);

/**
 * Tokens that locate a supplier without identifying it. They stay in the token set
 * (so `TAOGLAS IRELAND` still contains `TAOGLAS`) but cannot carry a match on
 * their own — otherwise every Chinese supplier would match every other one.
 */
const GEO_TOKENS = new Set([
  "HK", "HONGKONG", "KONG", "HONG", "CHINA", "CN", "PRC", "SHENZHEN", "SHANGHAI",
  "TAIWAN", "KOREA", "JAPAN", "SINGAPORE", "MALAYSIA", "THAILAND", "VIETNAM",
  "INDIA", "ASIA", "SOUTHEAST", "PACIFIC", "EUROPE", "EU", "IRELAND", "GERMANY",
  "FRANCE", "ITALY", "SPAIN", "NETHERLANDS", "BELGIUM", "SWEDEN", "SWITZERLAND",
  "UK", "GB", "ENGLAND", "USA", "US", "AMERICA", "CANADA", "MEXICO", "ISRAEL",
  "INTERNATIONAL", "GLOBAL", "WORLDWIDE", "EAST", "WEST", "NORTH", "SOUTH",
]);

/**
 * A supplier name reduced to the tokens that identify it: upper-cased, stripped of
 * punctuation and legal forms, split on whitespace. `ATIC (HK)TECHNOLOGY CO,LTD`
 * becomes `["ATIC", "HK", "TECHNOLOGY"]`.
 *
 * Exported for the test — the whole supplier key rests on this reduction, and it
 * is the part most likely to need tuning as new spellings arrive.
 */
export function normalizeSupplier(value: string | null | undefined): string[] {
  return (value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^A-Z0-9]+/g, " ") // punctuation is noise: `CO,LTD` → `CO LTD`
    .split(" ")
    .filter((t) => t !== "" && !LEGAL_FORMS.has(t));
}

/**
 * Do these two names denote the same supplier? Deliberately strict, because a
 * false positive here attaches real money to the wrong order line.
 *
 * The rule: one side's tokens must be wholly contained in the other's, and the
 * shared tokens must include at least one that actually identifies a company (four
 * or more characters, not a country or a word like "GLOBAL"). So
 * `TEXAS INSTRUMENTS SOUTHEAST ASIA` matches `Texas Instruments`, while
 * `ASIA ELECTRONICS` does not match `ASIA` — nothing distinctive is shared.
 *
 * Containment, not fuzzy distance: a typo tolerance would buy a few more matches
 * and a class of silent wrong ones, and the reviewer can always pick the line.
 */
export function suppliersMatch(
  invoiceShipper: string | null | undefined,
  lineSupplier: string | null | undefined,
): boolean {
  const a = normalizeSupplier(invoiceShipper);
  const b = normalizeSupplier(lineSupplier);
  if (a.length === 0 || b.length === 0) return false;

  const setA = new Set(a);
  const setB = new Set(b);
  const contained = a.every((t) => setB.has(t)) || b.every((t) => setA.has(t));
  if (!contained) return false;

  return a.some((t) => setB.has(t) && t.length >= 4 && !GEO_TOKENS.has(t));
}

/**
 * How long after an order was placed a courier charge can still plausibly be its
 * shipment. Wide on purpose: components from Asia routinely ship months after the
 * order, and a window that is too tight silently drops real matches. The safety
 * net is not this number — it is that an ambiguous window (two candidate lines)
 * refuses to guess at all.
 */
export const SUPPLIER_WINDOW_DAYS = 120;

/** Whole days from `from` to `to`, or null when either date is unreadable. */
function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? parseFloat(value.replace(/,/g, "")) : value;
  return Number.isFinite(n) ? n : null;
}

/** Money adds up in agorot: 0.1 + 0.2 must not become 0.30000000000000004. */
function sumMoney(values: number[]): number {
  return values.reduce((acc, v) => acc + Math.round(v * 100), 0) / 100;
}

/**
 * Split an amount across n lines so the parts add back up to the whole: the
 * remaining agorot go to the first lines rather than vanishing in rounding.
 */
export function splitAmount(total: number, parts: number): string[] {
  if (parts <= 0) return [];
  const cents = Math.round(total * 100);
  const base = Math.trunc(cents / parts);
  let remainder = cents - base * parts;
  const step = remainder >= 0 ? 1 : -1;
  return Array.from({ length: parts }, () => {
    let value = base;
    if (remainder !== 0) {
      value += step;
      remainder -= step;
    }
    return (value / 100).toFixed(2);
  });
}

/** How the itemized charges add up. Null sums mean "the document did not say". */
export interface ChargeTotals {
  /** Sum of the components that carry an amount, or null when none do. */
  sum: number | null;
  /** How much of that sum is VAT (0 when the breakdown lists none). */
  vat: number;
  /** Components whose amount could not be read. */
  missing: number;
  /** sum − the shipment's own total, or null when either side is unknown. */
  difference: number | null;
}

/**
 * Read one shipment's breakdown. Kept here rather than in the UI so the review
 * table, the extraction's warnings and the tests all reconcile the same way.
 *
 * `tolerance` absorbs the agora-level slack that splitting a shipment across
 * several lines leaves behind: each component is rounded on its own, so a
 * breakdown of n rows can miss its total by up to n agorot without anything being
 * wrong. Callers that reconcile an unsplit shipment pass nothing and get an exact
 * comparison.
 */
export function chargeTotals(shipment: CourierShipment, tolerance = 0): ChargeTotals {
  const amounts: number[] = [];
  const vatAmounts: number[] = [];
  let missing = 0;
  for (const charge of shipment.charges) {
    const amount = toNumber(charge.amount);
    if (amount === null) {
      missing++;
      continue;
    }
    amounts.push(amount);
    if (charge.kind === "vat") vatAmounts.push(amount);
  }

  const sum = amounts.length === 0 ? null : sumMoney(amounts);
  const total = toNumber(shipment.amount);
  const gap = sum === null || total === null ? null : sumMoney([sum, -total]);
  return {
    sum,
    vat: sumMoney(vatAmounts),
    missing,
    difference: gap !== null && Math.abs(gap) <= tolerance ? 0 : gap,
  };
}

/** The slack `chargeTotals` should allow for a breakdown of this many rows. */
export function chargeTolerance(charges: CourierCharge[]): number {
  return charges.length * 0.01;
}

/**
 * What this shipment costs: the total the courier printed, or — when it printed
 * only the components — what they add up to. A reviewer who types the breakdown
 * and leaves the total blank gets the cost allocated all the same, instead of the
 * row being silently dropped for having no amount.
 */
export function shipmentTotal(shipment: CourierShipment): number | null {
  return toNumber(shipment.amount) ?? chargeTotals(shipment).sum;
}

/**
 * Split a breakdown the same way its total is split, so every part keeps a
 * breakdown that explains its own amount rather than repeating the whole bill.
 * A component with no amount stays without one.
 */
function splitCharges(charges: CourierCharge[], parts: number): CourierCharge[][] {
  const perCharge = charges.map((charge) => {
    const amount = toNumber(charge.amount);
    return amount === null ? null : splitAmount(amount, parts);
  });
  return Array.from({ length: parts }, (_, i) =>
    charges.map((charge, j) => {
      const split = perCharge[j];
      return split ? { ...charge, amount: split[i] } : { ...charge };
    }),
  );
}

/**
 * The lines a supplier guess is allowed to claim: open, and with no shipping cost
 * recorded yet. A closed line is settled, and a line that already has a cost either
 * belongs to another invoice or has been reviewed once already — in both cases
 * quietly re-pointing money at it is the worst outcome available.
 */
function supplierCandidates(lines: CourierLineOption[]): CourierLineOption[] {
  return lines.filter((l) => l.isOpen && l.shippingCost === null);
}

/**
 * The one open, uncosted line from this supplier whose order date sits inside the
 * window ending at the shipment — or null when nothing fits, and equally null when
 * more than one thing fits. Two candidates is not a 50% match, it is an unanswered
 * question, and the reviewer can answer it faster than they can undo a wrong guess.
 */
function resolveBySupplier(
  shipment: CourierShipment,
  candidates: CourierLineOption[],
): CourierLineOption | null {
  if (!shipment.shipper || !shipment.shipmentDate) return null;

  const hits = candidates.filter((line) => {
    if (!suppliersMatch(shipment.shipper, line.supplier)) return false;
    const age = daysBetween(line.orderDate, shipment.shipmentDate);
    // A shipment cannot precede its own order; beyond the window it is a different one.
    return age !== null && age >= 0 && age <= SUPPLIER_WINDOW_DAYS;
  });

  return hits.length === 1 ? hits[0] : null;
}

/**
 * Propose a line for every shipment on the invoice: by tracking number first, then
 * by the quoted PO/order number, and only then — when the document gave us no
 * asmachta at all — by supplier and date window. A shipment that covers several
 * lines (one BOL, several items) becomes one row per line with the cost split
 * between them; a shipment that matches nothing is returned untouched for the
 * reviewer to place.
 *
 * A shipment that already carries a lineId is passed through — re-running the
 * matcher never overrides a human's choice.
 *
 * The supplier key never splits. Splitting a cost across lines is a claim that one
 * shipment covered all of them, which a tracking number supports and a coincidence
 * of supplier and date does not.
 */
export function matchShipmentsToLines(
  shipments: CourierShipment[],
  lines: CourierLineOption[],
): MatchedShipment[] {
  const byBol = new Map<string, CourierLineOption[]>();
  const byPo = new Map<string, CourierLineOption[]>();
  const byOrder = new Map<string, CourierLineOption[]>();
  const push = (map: Map<string, CourierLineOption[]>, key: string, line: CourierLineOption) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(line);
    else map.set(key, [line]);
  };
  for (const line of [...lines].sort((a, b) => a.lineId - b.lineId)) {
    push(byBol, normalizeTracking(line.bol), line);
    push(byPo, normalizeTracking(line.poNumber), line);
    push(byOrder, normalizeTracking(line.orderNumber), line);
  }

  const result: MatchedShipment[] = [];
  for (const shipment of shipments) {
    if (shipment.lineId !== null) {
      // A guess stays a guess across re-runs. Re-running the matcher over a staged
      // payload must not relabel `supplier` as `manual` — that would launder the
      // guess into a human decision nobody made, and unblock writing its cost.
      const carried = isLowConfidence(shipment.matchedBy) ? shipment.matchedBy : "manual";
      result.push({ ...shipment, matchedBy: carried, splitCount: 1 });
      continue;
    }

    const bolKey = normalizeTracking(shipment.bol);
    const refKey = normalizeTracking(shipment.reference);
    let matches: CourierLineOption[] | undefined;
    let matchedBy: MatchedBy = null;
    if (bolKey && byBol.has(bolKey)) {
      matches = byBol.get(bolKey);
      matchedBy = "bol";
    } else if (refKey && byPo.has(refKey)) {
      matches = byPo.get(refKey);
      matchedBy = "po";
    } else if (refKey && byOrder.has(refKey)) {
      matches = byOrder.get(refKey);
      matchedBy = "order";
    }

    if (!matches || matches.length === 0) {
      // Last resort, and the only inferring one: offered as a guess, not a placement.
      const guess = resolveBySupplier(shipment, supplierCandidates(lines));
      if (guess) {
        result.push({
          ...shipment,
          lineId: guess.lineId,
          matchedBy: "supplier",
          splitCount: 1,
        });
        continue;
      }
      result.push({ ...shipment, matchedBy: null, splitCount: 1 });
      continue;
    }

    const amount = shipmentTotal(shipment);
    const parts = amount === null ? null : splitAmount(amount, matches.length);
    const chargeParts = splitCharges(shipment.charges, matches.length);
    matches.forEach((line, i) => {
      result.push({
        ...shipment,
        lineId: line.lineId,
        amount: parts ? parts[i] : null,
        charges: chargeParts[i],
        matchedBy,
        splitCount: matches.length,
      });
    });
  }
  return result;
}

/**
 * The rows that will be written, from the rows on screen. Shipments with no line
 * or no amount are dropped (they are not costs anyone can attribute), and two
 * shipments on the same line become one allocation — the table stores one row per
 * (invoice, line) so that a line's shipping cost is always the sum of its
 * allocations.
 *
 * Shipments still tagged `supplier` are dropped too, and this is the load-bearing
 * guarantee behind the whole guessing key: an unaccepted guess cannot become a
 * shipping cost no matter which caller runs this or what the UI did. Accepting it
 * in the review table rewrites the tag to `manual`, and then it allocates like
 * anything else. Everything above this line proposes; only this function pays out.
 */
export function allocationsFromShipments(shipments: CourierShipment[]): CourierAllocationDraft[] {
  const byLine = new Map<number, { amounts: number[]; bols: string[]; notes: string[] }>();
  for (const shipment of shipments) {
    const amount = shipmentTotal(shipment);
    if (shipment.lineId === null || amount === null) continue;
    if (isLowConfidence(shipment.matchedBy)) continue;
    const entry = byLine.get(shipment.lineId) ?? { amounts: [], bols: [], notes: [] };
    entry.amounts.push(amount);
    const bol = shipment.bol?.trim();
    if (bol && !entry.bols.includes(bol)) entry.bols.push(bol);
    const note = shipment.description?.trim();
    if (note && !entry.notes.includes(note)) entry.notes.push(note);
    byLine.set(shipment.lineId, entry);
  }

  return [...byLine.entries()].map(([lineId, entry]) => ({
    lineId,
    amount: sumMoney(entry.amounts).toFixed(2),
    bol: entry.bols.join(", ") || null,
    description: entry.notes.join(" · ").slice(0, 500) || null,
  }));
}

export interface AllocationTotals {
  /** Sum of what will be written onto lines. */
  allocated: number;
  /** Shipment rows still without a line. */
  unmatched: number;
  /** Lines that will get a shipping cost. */
  lines: number;
  /** allocated − invoice total, or null when the invoice has no total. */
  difference: number | null;
  /** VAT the itemized breakdowns account for, across every shipment. */
  vat: number;
  /** Shipments whose breakdown does not add up to their own total. */
  unreconciled: number;
  /**
   * Shipments placed by the supplier guess and not yet accepted. Their money is
   * *not* in `allocated`, which is why the card has to say so — otherwise the
   * totals read as a shortfall against the invoice with no visible cause.
   */
  pendingGuesses: number;
}

/** What the review card shows above the table: does the split add up to the bill? */
export function allocationTotals(
  shipments: CourierShipment[],
  invoiceAmount: string | null,
): AllocationTotals {
  const allocations = allocationsFromShipments(shipments);
  const allocated = sumMoney(allocations.map((a) => Number(a.amount)));
  const total = toNumber(invoiceAmount);
  const breakdowns = shipments.map((s) => chargeTotals(s, chargeTolerance(s.charges)));
  return {
    allocated,
    unmatched: shipments.filter((s) => s.lineId === null).length,
    lines: allocations.length,
    difference: total === null ? null : sumMoney([allocated, -total]),
    vat: sumMoney(breakdowns.map((b) => b.vat)),
    unreconciled: breakdowns.filter((b) => b.difference !== null && b.difference !== 0).length,
    pendingGuesses: shipments.filter(
      (s) => s.lineId !== null && isLowConfidence(s.matchedBy),
    ).length,
  };
}

/** Accepting the matcher's guess: the reviewer looked, and it becomes their choice. */
export function acceptGuess(shipment: CourierShipment): CourierShipment {
  return isLowConfidence(shipment.matchedBy) ? { ...shipment, matchedBy: "manual" } : shipment;
}
