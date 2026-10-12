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
    /** How the entered figure was read: as typed, or converted through the line's rate. */
    via: "foreign" | "ils" | "ils-at-rate" | null;
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

function comparePrice(line: PoCompareLine): PoComparison["price"] {
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
  // profit is computed from. It can only be put next to a foreign order price
  // through a rate in that same currency, which the line carries once it has been
  // converted (or once a rate was looked up for it).
  if (line.fxRateSource === "manual" && ils !== null) {
    const rateIsForPoCurrency = (line.buyCurrency ?? "USD") === poCurrency;
    if (rate === null || rate <= 0 || !rateIsForPoCurrency) {
      return { ...none, check: "incomparable" };
    }
    const entered = ils / rate;
    return {
      po,
      poCurrency,
      entered,
      enteredCurrency: poCurrency,
      via: "ils-at-rate",
      check: close(entered, po, PRICE_TOLERANCE_AT_RATE) ? "match" : "mismatch",
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

export function comparePurchaseOrder(line: PoCompareLine): PoComparison {
  const qty = compareQty(line);
  const price = comparePrice(line);
  return { qty, price, mismatch: qty.check === "mismatch" || price.check === "mismatch" };
}

/** "€12.50" — the order's price the way a person reads it. */
export function poPriceLabel(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  const symbol = isPurchaseCurrency(currency) ? CURRENCY_SYMBOLS[currency] : (currency ?? "");
  const rounded = Math.round(value * 10_000) / 10_000;
  return `${symbol}${rounded}`;
}
