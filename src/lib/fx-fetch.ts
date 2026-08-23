/**
 * Getting a representative rate: the cache first, the Bank of Israel second,
 * and nothing at all rather than a guess.
 *
 * Split from src/lib/fx.ts on purpose — fx.ts is pure and unit-tested, this file
 * is the part that touches the network and the database. Failure here is always
 * silent-but-visible: the caller gets null, the line keeps a NULL rate, and the
 * run reports it. A wrong exchange rate is worse than a missing one, because a
 * missing one shows up as "ממתין" and a wrong one shows up as a profit figure.
 */

import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { fxRates } from "@/db/schema";
import {
  boiCurrentUrl,
  boiSeriesUrl,
  parseBoiCurrentRate,
  parseBoiSeriesCsv,
  pickRateOnOrBefore,
  type FxObservation,
} from "./fx";

export interface FxLookup {
  rate: string; // kept as a string, like every numeric column in this schema
  rateDate: string; // ISO yyyy-mm-dd — the day the rate was published for
  source: string; // 'boi' | 'manual'
}

/** How far back to ask the series for. Covers any run of closed days. */
const LOOKBACK_DAYS = 21;

/** No silent retries anywhere in this codebase; a slow upstream fails the run. */
const TIMEOUT_MS = 15_000;

/**
 * The representative rate to use for a delivery on `date`.
 *
 * Reads the cache first — a month of deliveries mostly lands on days we already
 * know — and only then asks upstream. Everything fetched is written back, so the
 * second line delivered on the same day costs nothing.
 */
export async function representativeRateOn(
  date: string,
  currency = "USD",
): Promise<FxLookup | null> {
  const cached = await cachedRateOnOrBefore(date, currency);
  if (cached) return cached;

  const fetched = await fetchBoiSeries(date, currency);
  if (fetched.length > 0) {
    await cacheObservations(fetched, currency, "boi");
    const pick = pickRateOnOrBefore(fetched, date);
    if (pick) return { rate: String(pick.rate), rateDate: pick.date, source: "boi" };
  }

  // Last resort: the current-rate endpoint. Only usable when it happens to be on
  // or before the date asked for — converting a July delivery at today's rate
  // would be exactly the silent error this module exists to prevent.
  const current = await fetchBoiCurrent(currency);
  if (current) {
    await cacheObservations([current], currency, "boi");
    if (current.date <= date) {
      return { rate: String(current.rate), rateDate: current.date, source: "boi" };
    }
  }

  return null;
}

/** The newest cached rate at or before `date`. */
export async function cachedRateOnOrBefore(
  date: string,
  currency = "USD",
): Promise<FxLookup | null> {
  const rows = await db
    .select({ rate: fxRates.rate, rateDate: fxRates.rateDate, source: fxRates.source })
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.rateDate, date)))
    .orderBy(desc(fxRates.rateDate))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Stores observations, keeping whatever is already there.
 *
 * `doNothing` rather than an upsert: a rate for a day that is already known must
 * not change under us, because lines have already been converted with it. A
 * correction is a deliberate act, not a side effect of a nightly fetch.
 */
async function cacheObservations(
  observations: FxObservation[],
  currency: string,
  source: string,
): Promise<void> {
  if (observations.length === 0) return;
  await db
    .insert(fxRates)
    .values(
      observations.map((o) => ({
        currency,
        rateDate: o.date,
        rate: String(o.rate),
        source,
      })),
    )
    .onConflictDoNothing();
}

async function fetchBoiSeries(date: string, currency: string): Promise<FxObservation[]> {
  const from = shiftDays(date, -LOOKBACK_DAYS);
  const text = await getText(boiSeriesUrl(currency, from, date));
  if (text === null) return [];
  return parseBoiSeriesCsv(text);
}

async function fetchBoiCurrent(currency: string): Promise<FxObservation | null> {
  const text = await getText(boiCurrentUrl(currency));
  if (text === null) return null;
  try {
    return parseBoiCurrentRate(JSON.parse(text));
  } catch {
    return null;
  }
}

/** One GET, one timeout, no retry. Returns null on anything that is not a 2xx body. */
async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "text/csv, application/json, */*" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function shiftDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
