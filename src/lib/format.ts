const ilsFormatter = new Intl.NumberFormat("he-IL", {
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("he-IL", {
  maximumFractionDigits: 2,
});

export function formatILS(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(n)) return "—";
  return ilsFormatter.format(n);
}

export function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(n)) return "—";
  return numberFormatter.format(n);
}

/**
 * "1 שורות" is wrong in Hebrew, so one gets its own wording:
 * countLabel(1, "שורה אחת", "שורות") → "שורה אחת"; countLabel(4, …) → "4 שורות".
 */
export function countLabel(count: number, one: string, many: string): string {
  return count === 1 ? one : `${formatNumber(count)} ${many}`;
}

/** ISO date (yyyy-mm-dd) → dd.mm.yyyy */
const timestampFormatter = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * A timestamptz → dd.mm.yyyy HH:MM. For "when did we last hear about this
 * shipment", where the date alone loses the useful part on a busy day.
 */
export function formatTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : timestampFormatter.format(d);
}

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
