/**
 * The Bank of Israel representative rate (שער יציג), and the one place this app
 * converts a currency.
 *
 * The rule the rest of the code depends on: **a rate is a fact with a date, not a
 * setting.** Purchase orders are priced in dollars; the shekel figure the monthly
 * ledger sums is computed once, from the rate published for the day the goods were
 * delivered, and that rate is stored next to the number it produced
 * (order_lines.fx_rate / fx_rate_date). Nothing here is called at render time — a
 * report opened twice must not show two different profits.
 *
 * The parsers are pure and the network call is a thin wrapper around them, so the
 * awkward part (whatever shape the Bank of Israel actually returns) is testable
 * against a saved response.
 */

export interface FxObservation {
  /** ISO yyyy-mm-dd — the day the rate was published for. */
  date: string;
  /** ILS per 1 unit of the foreign currency. */
  rate: number;
}

/** The new series database (SDMX). Series keys look like RER_USD_ILS. */
export const BOI_SERIES_BASE =
  "https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0";

/** The small public endpoint. Current rate only — used when the series is unreachable. */
export const BOI_CURRENT_BASE = "https://boi.org.il/PublicApi/GetExchangeRate";

export function boiSeriesUrl(currency: string, from: string, to: string): string {
  const series = `RER_${currency.toUpperCase()}_ILS`;
  return `${BOI_SERIES_BASE}/${series}?format=csv&startPeriod=${from}&endPeriod=${to}`;
}

export function boiCurrentUrl(currency: string): string {
  return `${BOI_CURRENT_BASE}?key=${currency.toUpperCase()}`;
}

/**
 * SDMX-CSV → observations.
 *
 * Column *names* are read from the header rather than positions, because the
 * published SDMX-CSV flavours differ in how many key columns they put in front of
 * the observation (and the Bank of Israel may change theirs without telling us).
 * TIME_PERIOD and OBS_VALUE are the two names the standard does fix, so those are
 * what we look for; a row missing either is skipped rather than guessed at.
 */
export function parseBoiSeriesCsv(text: string): FxObservation[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const header = splitCsvRow(lines[0]).map((h) => h.trim().toUpperCase().replace(/^"|"$/g, ""));
  const timeIdx = header.findIndex((h) => h === "TIME_PERIOD" || h === "TIME");
  const valueIdx = header.findIndex((h) => h === "OBS_VALUE" || h === "VALUE");
  if (timeIdx === -1 || valueIdx === -1) return [];

  const out: FxObservation[] = [];
  for (const raw of lines.slice(1)) {
    const cells = splitCsvRow(raw);
    const date = normalizeIsoDate(cells[timeIdx]);
    const rate = Number(String(cells[valueIdx] ?? "").replace(/["\s,]/g, ""));
    if (!date || !Number.isFinite(rate) || rate <= 0) continue;
    out.push({ date, rate });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The single-rate JSON endpoint: `{ key, currentExchangeRate, currentChange, lastUpdate }`.
 * `lastUpdate` is a full timestamp; its date part is the day the rate belongs to.
 */
export function parseBoiCurrentRate(payload: unknown): FxObservation | null {
  if (typeof payload !== "object" || payload === null) return null;
  const o = payload as Record<string, unknown>;
  const rate = Number(o.currentExchangeRate);
  const date = normalizeIsoDate(typeof o.lastUpdate === "string" ? o.lastUpdate : null);
  if (!Number.isFinite(rate) || rate <= 0 || !date) return null;
  return { date, rate };
}

/**
 * The newest observation published on or before `date`.
 *
 * This is the whole reason the lookup is not a dictionary access: the
 * representative rate is published once per business day and not at all on
 * Fridays, Saturdays or holidays. A shipment delivered on a Saturday is converted
 * at Thursday's rate, and the row records that it was Thursday's — which is why
 * fx_rate_date is stored separately from delivered_at.
 *
 * Returns null when the series starts after the date asked for; a missing rate is
 * reported, never extrapolated.
 */
export function pickRateOnOrBefore(
  observations: FxObservation[],
  date: string,
): FxObservation | null {
  let best: FxObservation | null = null;
  for (const obs of observations) {
    if (obs.date > date) continue;
    if (!best || obs.date > best.date) best = obs;
  }
  return best;
}

/** Converts a foreign amount to shekels at a given rate, rounded to agorot. */
export function convertToIls(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

/**
 * A minimal CSV row splitter: quoted fields may contain commas, doubled quotes
 * are literal. Enough for SDMX-CSV, and it avoids a dependency for one call site.
 */
function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (quoted) {
      if (c === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

/** "2026-08-19", "2026-08-19T13:24:04Z" and "2026-08" all reduce to a date or null. */
function normalizeIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value.trim().replace(/^"|"$/g, ""));
  if (!m) return null;
  // A monthly observation has no day; treat it as the first of the month rather
  // than dropping it, so a monthly series still yields a usable "on or before".
  return `${m[1]}-${m[2]}-${m[3] ?? "01"}`;
}
