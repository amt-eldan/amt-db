import { parseNumeric } from "./numeric";

const ilsFormatter = new Intl.NumberFormat("he-IL", {
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("he-IL", {
  maximumFractionDigits: 2,
});

export function formatILS(value: number | string | null | undefined): string {
  const n = parseNumeric(value);
  return n === null ? "—" : ilsFormatter.format(n);
}

export function formatNumber(value: number | string | null | undefined): string {
  const n = parseNumeric(value);
  return n === null ? "—" : numberFormatter.format(n);
}

/** ISO date (yyyy-mm-dd) → dd.mm.yyyy */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
}

/** dd.mm.yyyy (forgiving: d.m.yyyy too) → ISO yyyy-mm-dd, or null */
export function parseDotDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * A calendar month as a half-open ISO date range: [from, to).
 *
 * Used instead of `extract(year/month from …)` in SQL, which cannot use an index
 * on the date column. December rolls the year over.
 */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${year}-${pad(month)}-01`,
    to: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`,
  };
}

export const HEBREW_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
] as const;

/** "2026-07" → "יולי 2026" */
export function formatMonth(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-");
  const idx = parseInt(m, 10) - 1;
  return `${HEBREW_MONTHS[idx] ?? m} ${y}`;
}
