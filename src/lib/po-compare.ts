/**
 * Does what the office typed match what we actually ordered from the supplier?
 *
 * The purchase-order upload records the document's own figures on the line —
 * `po_unit_cost`, `po_currency`, `po_qty` — and never lets anything else write
 * them. The office goes on typing quantities and buy prices by hand, as it always
 * has. This compares the two, so a quantity typed as 100 against an order for 1000,
 * or a price typed in dollars against a euro order, shows up on the monthly screen
 * instead of quietly becoming a wrong profit.
 *
 * Pure, and deliberately conservative about what counts as comparable: two prices
 * in different currencies are only compared when the line itself carries the rate
 * that links them, and anything that cannot be compared says so rather than
 * claiming a match.
 */

import { CURRENCY_SYMBOLS, isPurchaseCurrency } from "./currency";
import { parseNumeric } from "./numeric";

/** The line fields this reads — LineRow satisfies it. */
export interface PoCompareLine {
  qty: string | null;
  buyPrice: string | null;
  buyPriceForeign: string | null;
  buyCurrency: string | null;
  fxRate: string | null;
  fxRateSource: string | null;
  poUnitCost: string | null;
  poCurrency: string | null;
  poQty: string | null;
}

export type PoCheck =
  /** Both sides known and equal (within rounding). */
  | "match"
  /** Both sides known and different. */
  | "mismatch"
  /** The purchase order has a figure and nothing was entered against it yet. */
  | "missing"
  /** Both sides exist but cannot be put on the same scale (no linking rate). */
  | "incomparable"
  /** No purchase-order figure to compare with. */
  | "none";

export interface PoComparison {
  qty: { check: PoCheck; po: number | null; entered: number | null };
  price: {
    check: PoCheck;
    po: number | null;
    poCurrency: string | null;
    /** The entered figure — in `enteredCurrency`, which is the order's unless they disagree. */
    entered: number | null;
    enteredCurrency: string | null;
    /**
     * How the entered figure was read: as typed; a shekel price through the line's
     * own rate; or through the latest published rate, when the line has none yet.
     */
    via: "foreign" | "ils" | "ils-at-rate" | "ils-at-reference" | null;
  };
  /** True when either side disagrees — what the monthly filter and badge look at. */
  mismatch: boolean;
}

/**
 * Prices are compared to half a percent: a document printed to four decimals and a
 * person typing two must not read as a disagreement. Through an exchange rate the
 * slack is wider, because the rate on the line is the delivery day's and the
 * office may have used another day's.
 */
const PRICE_TOLERANCE = 0.005;
const PRICE_TOLERANCE_AT_RATE = 0.02;
/**
 * Through the latest published rate rather than the line's own, the slack is wider
 * still: that rate is from today, not from the day the price was set, and a
 * currency moves a few percent in a month. What this is for — a decimal in the
 * wrong place, euros typed as dollars — is far outside it.
 */
const PRICE_TOLERANCE_AT_REFERENCE = 0.05;

/** Latest representative rate per currency (ILS per unit), for lines with none of their own. */
export type ReferenceRates = Partial<Record<string, number>>;

function close(a: number, b: number, relative: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(1e-6, scale * relative);
}

function compareQty(line: PoCompareLine): PoComparison["qty"] {
  const po = parseNumeric(line.poQty);
  const entered = parseNumeric(line.qty);
  if (po === null) return { check: "none", po, entered };
  if (entered === null) return { check: "missing", po, entered };
  return { check: Math.abs(po - entered) < 1e-9 ? "match" : "mismatch", po, entered };
}

function comparePrice(line: PoCompareLine, referenceRates?: ReferenceRates): PoComparison["price"] {
  const po = parseNumeric(line.poUnitCost);
  const poCurrency = isPurchaseCurrency(line.poCurrency) ? line.poCurrency : null;
  const none = { po, poCurrency, entered: null, enteredCurrency: null, via: null } as const;
  if (po === null || poCurrency === null) return { ...none, check: "none" };

  const ils = parseNumeric(line.buyPrice);
  const foreign = parseNumeric(line.buyPriceForeign);
  const foreignCurrency = foreign === null ? null : (line.buyCurrency ?? "USD");
  const rate = parseNumeric(line.fxRate);

  if (poCurrency === "ILS") {
    if (ils === null) return { ...none, check: "missing" };
    return {
      po,
      poCurrency,
      entered: ils,
      enteredCurrency: "ILS",
      via: "ils",
      check: close(ils, po, PRICE_TOLERANCE) ? "match" : "mismatch",
    };
  }

  // A shekel price someone typed is the entry that matters most — it is what
  // profit is computed from. "Someone" is anything the app did not produce: not a
  // conversion ('boi') and not a shekel purchase order ('document') — which takes
  // in prices typed before fx_rate_source existed, too. It is put next to a
  // foreign order price through the line's own rate when the line has one in that
  // currency, and otherwise through the latest published rate: a line typed in
  // shekels before delivery has no rate of its own, and is exactly the line whose
  // typo nobody would otherwise see.
  const humanShekels =
    ils !== null && line.fxRateSource !== "boi" && line.fxRateSource !== "document";
  if (humanShekels) {
    const ownRate =
      rate !== null && rate > 0 && (line.buyCurrency ?? "USD") === poCurrency ? rate : null;
    const reference = referenceRates?.[poCurrency] ?? null;
    const useRate = ownRate ?? (reference !== null && reference > 0 ? reference : null);
    if (useRate === null) return { ...none, check: "incomparable" };
    const entered = ils! / useRate;
    const tolerance = ownRate !== null ? PRICE_TOLERANCE_AT_RATE : PRICE_TOLERANCE_AT_REFERENCE;
    return {
      po,
      poCurrency,
      entered,
      enteredCurrency: poCurrency,
      via: ownRate !== null ? "ils-at-rate" : "ils-at-reference",
      check: close(entered, po, tolerance) ? "match" : "mismatch",
    };
  }

  if (foreign !== null) {
    // A price recorded in another currency than the order's is a disagreement in
    // itself — one of the two has the wrong currency.
    if (foreignCurrency !== poCurrency) {
      return {
        po,
        poCurrency,
        entered: foreign,
        enteredCurrency: foreignCurrency,
        via: "foreign",
        check: "mismatch",
      };
    }
    return {
      po,
      poCurrency,
      entered: foreign,
      enteredCurrency: foreignCurrency,
      via: "foreign",
      check: close(foreign, po, PRICE_TOLERANCE) ? "match" : "mismatch",
    };
  }

  return { ...none, check: ils === null ? "missing" : "incomparable" };
}

export function comparePurchaseOrder(
  line: PoCompareLine,
  referenceRates?: ReferenceRates,
): PoComparison {
  const qty = compareQty(line);
  const price = comparePrice(line, referenceRates);
  return { qty, price, mismatch: qty.check === "mismatch" || price.check === "mismatch" };
}

/** "€12.50" — the order's price the way a person reads it. */
export function poPriceLabel(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  const symbol = isPurchaseCurrency(currency) ? CURRENCY_SYMBOLS[currency] : (currency ?? "");
  const rounded = Math.round(value * 10_000) / 10_000;
  return `${symbol}${rounded}`;
}
