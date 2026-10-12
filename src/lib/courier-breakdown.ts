/**
 * Courier invoices read the way the courier prints them: one row per bill of
 * lading, one column per charge item, and what each waybill's share of the
 * invoice comes to.
 *
 * The invoice list answers "how much did we pay DHL this month". The question the
 * office actually asks is per shipment — what did *this* waybill cost, made of
 * what, and how much of the invoice does it carry — and that was only visible one
 * invoice at a time, inside the re-split sheet. This flattens every approved
 * invoice into that table.
 *
 * Pure, and computed from what is already stored: the reviewed shipment list on
 * each invoice (with the charges the document itemized), and for invoices approved
 * before that list was kept, their allocations.
 */

import type { CourierShipment } from "./courier-match";
import { normalizeTracking } from "./courier-match";

/** The invoice fields this reads — CourierInvoiceRow satisfies it. */
export interface BreakdownInvoice {
  id: number;
  courier: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  amount: string | null;
  currency: string;
  shipments: CourierShipment[];
}

/** The allocation fields this reads — CourierAllocationRow satisfies it. */
export interface BreakdownAllocation {
  invoiceId: number;
  lineId: number;
  amount: string;
  bol: string | null;
  orderNumber: string;
  customerName: string;
}

export interface BreakdownLine {
  lineId: number;
  orderNumber: string;
  customerName: string;
}

export interface BolBreakdownRow {
  key: string;
  bol: string | null;
  invoiceId: number;
  courier: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  currency: string;
  shipmentDate: string | null;
  reference: string | null;
  description: string | null;
  /** Amount per charge column (keyed by `BolBreakdown.columns[].key`). */
  charges: Record<string, number>;
  /** What the courier billed for this waybill. */
  amount: number | null;
  /** This waybill's part of everything the invoice billed per shipment, 0..1. */
  share: number | null;
  /**
   * The waybill's proportional charge of the whole invoice: its share times the
   * invoice total. Differs from `amount` when the invoice carries charges that
   * belong to no one shipment (an invoice-level fee, VAT on the total) — those are
   * spread over the waybills by their share instead of being left unexplained.
   */
  relative: number | null;
  /** The order lines the cost landed on. Empty while the waybill is unplaced. */
  lines: BreakdownLine[];
}

export interface BolBreakdown {
  rows: BolBreakdownRow[];
  /** Charge items in the order they first appear, as the invoices name them. */
  columns: { key: string; label: string }[];
  /** Shekel totals per column — foreign-currency invoices are counted, not summed. */
  totals: { charges: Record<string, number>; amount: number; relative: number };
  foreignRows: number;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? parseFloat(value.replace(/,/g, "")) : value;
  return Number.isFinite(n) ? n : null;
}

const cents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

/** "Fuel  Surcharge" and "fuel surcharge" are one column. */
function chargeKey(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

interface Accumulator extends Omit<BolBreakdownRow, "amount" | "share" | "relative" | "charges"> {
  amountCents: number | null;
  chargeCents: Map<string, number>;
}

/**
 * Splits `totalCents` in proportion to `weights`, so the parts add back up to the
 * total exactly — the last agorot go to the largest remainders rather than
 * vanishing in rounding.
 */
function proportional(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let left = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors;
}

export function buildBolBreakdown(
  invoices: BreakdownInvoice[],
  allocations: BreakdownAllocation[],
  lineInfo: Map<number, BreakdownLine>,
): BolBreakdown {
  const columns = new Map<string, string>();
  const rows: BolBreakdownRow[] = [];

  const allocationsByInvoice = new Map<number, BreakdownAllocation[]>();
  for (const a of allocations) {
    const list = allocationsByInvoice.get(a.invoiceId);
    if (list) list.push(a);
    else allocationsByInvoice.set(a.invoiceId, [a]);
  }

  for (const invoice of invoices) {
    const groups = new Map<string, Accumulator>();
    const header = {
      invoiceId: invoice.id,
      courier: invoice.courier,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      currency: invoice.currency,
    };

    const add = (
      groupKey: string,
      bol: string | null,
      amount: number | null,
      extra: Partial<Accumulator>,
      line: BreakdownLine | null,
      charges: { label: string; amount: string | null }[],
    ) => {
      let acc = groups.get(groupKey);
      if (!acc) {
        acc = {
          key: `${invoice.id}:${groupKey}`,
          bol,
          ...header,
          shipmentDate: null,
          reference: null,
          description: null,
          lines: [],
          amountCents: null,
          chargeCents: new Map(),
          ...extra,
        };
        groups.set(groupKey, acc);
      }
      if (amount !== null) acc.amountCents = (acc.amountCents ?? 0) + cents(amount);
      if (line && !acc.lines.some((l) => l.lineId === line.lineId)) acc.lines.push(line);
      for (const charge of charges) {
        const value = toNumber(charge.amount);
        if (value === null || !charge.label.trim()) continue;
        const k = chargeKey(charge.label);
        if (!columns.has(k)) columns.set(k, charge.label.trim());
        acc.chargeCents.set(k, (acc.chargeCents.get(k) ?? 0) + cents(value));
      }
    };

    if (invoice.shipments.length > 0) {
      invoice.shipments.forEach((s, i) => {
        // One waybill split across several lines is stored as several rows with
        // the same number — they are one shipment again here.
        const bolKey = normalizeTracking(s.bol);
        const groupKey = bolKey ? `bol:${bolKey}` : `row:${i}`;
        const line = s.lineId !== null ? (lineInfo.get(s.lineId) ?? null) : null;
        add(
          groupKey,
          s.bol?.trim() || null,
          toNumber(s.amount),
          {
            shipmentDate: s.shipmentDate,
            reference: s.reference,
            description: s.description,
          },
          line,
          s.charges,
        );
      });
    } else {
      // Approved before the itemization was kept: the allocations are what's left.
      (allocationsByInvoice.get(invoice.id) ?? []).forEach((a, i) => {
        const bolKey = normalizeTracking(a.bol);
        add(
          bolKey ? `bol:${bolKey}` : `alloc:${i}`,
          a.bol,
          toNumber(a.amount),
          {},
          { lineId: a.lineId, orderNumber: a.orderNumber, customerName: a.customerName },
          [],
        );
      });
    }

    const accs = [...groups.values()];
    const weights = accs.map((a) => Math.max(0, a.amountCents ?? 0));
    const billedCents = weights.reduce((x, y) => x + y, 0);
    const invoiceTotal = toNumber(invoice.amount);
    const spread =
      billedCents > 0
        ? proportional(invoiceTotal !== null ? cents(invoiceTotal) : billedCents, weights)
        : null;

    accs.forEach((acc, i) => {
      const { amountCents, chargeCents, ...rest } = acc;
      const charges: Record<string, number> = {};
      for (const [k, c] of chargeCents) charges[k] = fromCents(c);
      rows.push({
        ...rest,
        charges,
        amount: amountCents === null ? null : fromCents(amountCents),
        share: billedCents > 0 && amountCents !== null ? weights[i] / billedCents : null,
        relative: spread && amountCents !== null ? fromCents(spread[i]) : null,
      });
    });
  }

  return {
    rows,
    columns: [...columns.entries()].map(([key, label]) => ({ key, label })),
    ...breakdownTotals(rows),
  };
}

/**
 * The shekel totals of a set of rows — every row, or the ones a search left on
 * screen, so the footer always adds up what is shown. Foreign-currency rows are
 * counted and left out of the sums: nothing here converts a courier's currency.
 */
export function breakdownTotals(
  rows: BolBreakdownRow[],
): Pick<BolBreakdown, "totals" | "foreignRows"> {
  const totalCharges = new Map<string, number>();
  let amount = 0;
  let relative = 0;
  let foreignRows = 0;
  for (const row of rows) {
    if (row.currency !== "ILS") {
      foreignRows++;
      continue;
    }
    for (const [k, v] of Object.entries(row.charges)) {
      totalCharges.set(k, (totalCharges.get(k) ?? 0) + cents(v));
    }
    amount += cents(row.amount ?? 0);
    relative += cents(row.relative ?? 0);
  }
  return {
    totals: {
      charges: Object.fromEntries([...totalCharges].map(([k, c]) => [k, fromCents(c)])),
      amount: fromCents(amount),
      relative: fromCents(relative),
    },
    foreignRows,
  };
}
