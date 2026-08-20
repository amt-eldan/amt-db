/**
 * Turning a dollar purchase price into the shekel figure the ledger sums.
 *
 * Its own module because both write paths need it: the email path
 * (writeBolMatches) when a supplier's shipping confirmation quotes a price, and
 * the status path (writeShipmentUpdates) when a delivery date finally makes a
 * rate available. One copy, so the two doors cannot disagree about what a line's
 * buy price means.
 */

import { convertToIls } from "./fx";
import { representativeRateOn } from "./fx-fetch";
import type { OrderLine } from "@/db/schema";

/**
 * The conversion, and the only place it happens.
 *
 * Needs both halves: a dollar price and a delivery date to date the rate by. The
 * rate is fetched for that date (the last one published on or before it, since
 * none is published on a closed day) and stored alongside the shekel figure it
 * produced, so the number can be checked later instead of re-derived at whatever
 * rate happens to be current.
 *
 * **A hand-entered buy price is never overwritten.** `fx_rate_source` records who
 * last set the shekel figure; anything other than an automatic conversion means a
 * person decided it, and an unattended run leaves that alone. A missing rate also
 * leaves everything alone — the line keeps a NULL rate, profit reads "ממתין", and
 * the run reports it. A guessed rate would instead show up as a plausible profit.
 */
export async function convertBuyPriceToIls(
  line: OrderLine,
  buyPriceUsd: string | null,
  deliveredAt: string | null,
): Promise<Record<string, unknown>> {
  if (!buyPriceUsd || !deliveredAt) return {};

  const humanSetTheBuyPrice =
    line.buyPrice !== null && line.buyPrice !== "" && line.fxRateSource !== "boi";
  if (humanSetTheBuyPrice) return {};

  // Already converted at the rate for this very day — nothing to redo.
  if (line.fxRate && line.fxRateDate && line.buyPriceUsd === buyPriceUsd) {
    const already = convertToIls(Number(buyPriceUsd), Number(line.fxRate));
    if (line.buyPrice !== null && Number(line.buyPrice) === already) return {};
  }

  const lookup = await representativeRateOn(deliveredAt, "USD");
  if (!lookup) return {};

  const amount = Number(buyPriceUsd);
  if (!Number.isFinite(amount)) return {};

  return {
    buyPrice: String(convertToIls(amount, Number(lookup.rate))),
    fxRate: lookup.rate,
    fxRateDate: lookup.rateDate,
    fxRateSource: lookup.source,
  };
}
