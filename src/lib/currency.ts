/**
 * The currencies a purchase is priced in, and the one way they are spelled.
 *
 * Purchase orders used to be assumed dollars. They are not: some suppliers quote
 * euros or pounds, and a few are Israeli and quote shekels. An order in a currency
 * the code did not know was refused outright, which is how a euro purchase order
 * ended up with no buy price and no quantity on any of its lines.
 *
 * Shekels are the ledger's own currency and are never converted. Every other code
 * here has a Bank of Israel representative-rate series (RER_<code>_ILS), which is
 * what makes it convertible at all — adding a currency means checking that series
 * exists, nothing more.
 */

import type { OrderLine } from "@/db/schema";

export const FOREIGN_CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type ForeignCurrency = (typeof FOREIGN_CURRENCIES)[number];

export const PURCHASE_CURRENCIES = [...FOREIGN_CURRENCIES, "ILS"] as const;
export type PurchaseCurrency = (typeof PURCHASE_CURRENCIES)[number];

export const CURRENCY_SYMBOLS: Record<PurchaseCurrency, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  ILS: "₪",
};

export const CURRENCY_LABELS: Record<PurchaseCurrency, string> = {
  USD: "דולר",
  EUR: "יורו",
  GBP: "ליש\"ט",
  ILS: "שקל",
};

export function isForeignCurrency(value: unknown): value is ForeignCurrency {
  return typeof value === "string" && (FOREIGN_CURRENCIES as readonly string[]).includes(value);
}

export function isPurchaseCurrency(value: unknown): value is PurchaseCurrency {
  return typeof value === "string" && (PURCHASE_CURRENCIES as readonly string[]).includes(value);
}

/**
 * A currency as it turns up on paper — code, symbol, English or Hebrew word —
 * reduced to its code, or null for anything that is not one of ours. Null is an
 * answer: a price in an unknown currency is reported, never guessed at.
 */
export function normalizeCurrency(raw: string | null | undefined): PurchaseCurrency | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
  if (/^(usd|us\$|\$|us dollars?|dollars?|דולר|דולרים|דולר ארה"ב)$/.test(t)) return "USD";
  if (/^(eur|€|euros?|יורו)$/.test(t)) return "EUR";
  if (/^(gbp|£|pounds?|pounds? sterling|sterling|stg|ליש"ט|לישט|לירה שטרלינג|ליש״ט|פאונד|פאונדים)$/.test(t)) {
    return "GBP";
  }
  if (/^(ils|nis|₪|shekels?|new israeli shekels?|שקל|שקלים|ש"ח|ש״ח|שח)$/.test(t)) return "ILS";
  return null;
}

/**
 * What a dollar price reported by the tracking agent does to a line: the fields to
 * write, and the price and currency to convert.
 *
 * The agent's contract is still `buyPriceUsd` — a price a supplier's mail happened
 * to quote, in dollars. Our own purchase order is the better witness, so once it
 * has priced the line (`po_unit_cost` is set, in whatever currency) an agent's
 * figure is ignored rather than written over it: a stray dollar amount from a
 * shipping mail must not replace a euro price read off the order itself. Without
 * a purchase order the agent's price is recorded as before, in dollars.
 */
export function agentBuyPrice(
  line: Pick<OrderLine, "poUnitCost" | "buyPriceForeign" | "buyCurrency">,
  buyPriceUsd: string | null | undefined,
): { fields: Record<string, unknown>; amount: string | null; currency: string | null } {
  const purchaseOrderOwnsPrice = line.poUnitCost != null && line.poUnitCost !== "";
  if (!buyPriceUsd || purchaseOrderOwnsPrice) {
    return { fields: {}, amount: line.buyPriceForeign, currency: line.buyCurrency };
  }
  const fields: Record<string, unknown> = {};
  if (buyPriceUsd !== line.buyPriceForeign || line.buyCurrency !== "USD") {
    fields.buyPriceForeign = buyPriceUsd;
    fields.buyCurrency = "USD";
  }
  return { fields, amount: buyPriceUsd, currency: "USD" };
}
