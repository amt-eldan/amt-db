/**
 * Turning a foreign purchase price — dollars, euros or pounds — into the shekel
 * figure the ledger sums.
 *
 * Its own module because every write path needs it: the email path
 * (writeBolMatches) when a supplier's shipping confirmation quotes a price, the
 * status path (writeShipmentUpdates) when a delivery date finally makes a rate
 * available, the purchase-order upload, and the sweep below. One copy, so the
 * doors cannot disagree about what a line's buy price means.
 */

import { and, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { orderLines, type OrderLine } from "@/db/schema";
import { isForeignCurrency } from "./currency";
import { convertToIls } from "./fx";
import { representativeRateOn } from "./fx-fetch";
import { applyLineFields } from "./line-fields";

/**
 * The conversion, and the only place it happens.
 *
 * Needs a foreign price, its currency, and a delivery date to date the rate by.
 * The rate is fetched for that date (the last one published on or before it,
 * since none is published on a closed day) and stored alongside the shekel figure
 * it produced, so the number can be checked later instead of re-derived at
 * whatever rate happens to be current. `currency` null means dollars — the only
 * currency there was before euros and pounds were read.
 *
 * **A hand-entered buy price is never overwritten.** `fx_rate_source` records who
 * last set the shekel figure; anything other than an automatic conversion means a
 * person (or a shekel-priced purchase order) decided it, and an unattended run
 * leaves that alone. A missing rate also leaves everything alone — the line keeps
 * a NULL rate, profit reads "ממתין", and the sweep tries again later. A guessed
 * rate would instead show up as a plausible profit.
 */
export async function convertBuyPriceToIls(
  line: OrderLine,
  amount: string | null,
  currency: string | null,
  deliveredAt: string | null,
): Promise<Record<string, unknown>> {
  if (!amount || !deliveredAt) return {};
  const code = currency ?? "USD";
  if (!isForeignCurrency(code)) return {};

  const humanSetTheBuyPrice =
    line.buyPrice !== null && line.buyPrice !== "" && line.fxRateSource !== "boi";
  if (humanSetTheBuyPrice) return {};

  // Already converted at the rate for this very day — nothing to redo.
  if (
    line.fxRate &&
    line.fxRateDate &&
    line.buyPriceForeign === amount &&
    (line.buyCurrency ?? "USD") === code
  ) {
    const already = convertToIls(Number(amount), Number(line.fxRate));
    if (line.buyPrice !== null && Number(line.buyPrice) === already) return {};
  }

  const value = Number(amount);
  if (!Number.isFinite(value)) return {};

  const lookup = await representativeRateOn(deliveredAt, code);
  if (!lookup) return {};

  return {
    buyPrice: String(convertToIls(value, Number(lookup.rate))),
    fxRate: lookup.rate,
    fxRateDate: lookup.rateDate,
    fxRateSource: lookup.source,
  };
}

/**
 * Converts the lines that are delivered, priced in a foreign currency, and still
 * have no shekel buy price.
 *
 * The write paths convert at the moment a delivery date arrives, but that moment
 * is often too early: the carrier confirms delivery in the morning and the Bank
 * of Israel publishes that day's rate in the afternoon. And a delivered line drops
 * off the status worklist, so no later run would ever come back for it. This is
 * what comes back. It is cheap when there is nothing to do (one indexed query),
 * so it runs after the status run and after the monthly and dashboard pages load.
 *
 * Bounded, and never throws: it runs where a failure must not break anything
 * else, and a BOI outage just means the same lines are tried next time.
 */
export async function convertPendingBuyPrices(limit = 50): Promise<number> {
  try {
    const pending = await db
      .select()
      .from(orderLines)
      .where(
        and(
          isNotNull(orderLines.buyPriceForeign),
          isNotNull(orderLines.deliveredAt),
          isNull(orderLines.buyPrice),
        ),
      )
      .limit(limit);

    let converted = 0;
    for (const line of pending) {
      const fields = await convertBuyPriceToIls(
        line,
        line.buyPriceForeign,
        line.buyCurrency,
        line.deliveredAt,
      );
      if (Object.keys(fields).length === 0) continue;
      await applyLineFields(line, fields, { source: "fx-sweep" }, "agent:fx");
      converted++;
    }
    return converted;
  } catch (error) {
    console.error("convertPendingBuyPrices failed", error);
    return 0;
  }
}
