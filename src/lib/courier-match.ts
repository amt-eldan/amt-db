/**
 * Matching a courier invoice to the lines it shipped, and turning the reviewed
 * result into allocations. All pure — the approval action and the review UI both
 * run the same functions, so what the reviewer sees is what gets written.
 *
 * The tracking number is what makes this possible: the courier prints it on the
 * invoice and the tracking agent already wrote it onto the line (`order_lines.bol`),
 * so the two documents have a shared key. Nothing is written on a guess — an
 * unmatched shipment stays unmatched until a human picks the line.
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
  description: string | null;
  amount: string | null; // numeric string (validated), ILS
  /** What the invoice says `amount` is made of — empty when it did not say. */
  charges: CourierCharge[];
  lineId: number | null; // filled by the matcher or by the reviewer
}

export type MatchedBy = "bol" | "po" | "order" | "manual" | null;

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
 * Propose a line for every shipment on the invoice, by tracking number first and
 * by the quoted PO/order number only as a fallback. A shipment that covers
 * several lines (one BOL, several items) becomes one row per line with the cost
 * split between them; a shipment that matches nothing is returned untouched for
 * the reviewer to place.
 *
 * A shipment that already carries a lineId is passed through — re-running the
 * matcher never overrides a human's choice.
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
      result.push({ ...shipment, matchedBy: "manual", splitCount: 1 });
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
 */
export function allocationsFromShipments(shipments: CourierShipment[]): CourierAllocationDraft[] {
  const byLine = new Map<number, { amounts: number[]; bols: string[]; notes: string[] }>();
  for (const shipment of shipments) {
    const amount = shipmentTotal(shipment);
    if (shipment.lineId === null || amount === null) continue;
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
  };
}
