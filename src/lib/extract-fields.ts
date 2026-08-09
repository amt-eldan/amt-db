/**
 * The primitives every PDF extractor needs to turn a model's raw tool input into
 * fields worth storing. Nothing here calls the API, so all of it stays pure and
 * testable — and shared, so the order, supplier-invoice and courier-invoice
 * extractors read a date or an amount the same way instead of three ways.
 */
import { parseDotDate } from "./format";
import { parseNumeric } from "./numeric";

export function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** string → trimmed value, or null for empty / non-string. */
export function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * The model's loosely-typed number → `number | null`.
 *
 * Delegates to parseNumeric rather than re-implementing the strip-and-parse: a
 * second copy of those rules is how "₪1,200" came to mean different things in
 * different code paths in the first place. This wrapper only narrows `unknown`,
 * since the model may hand back anything.
 */
export function num(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  return parseNumeric(v);
}

/** Real calendar date behind a yyyy-mm-dd string (rejects 2026-02-31 etc.). */
export function isRealCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * ISO (yyyy-mm-dd, real date) as-is; otherwise try parseDotDate; otherwise null
 * and a warning that the original was dropped. A missing value returns null
 * silently — "no date at all" is the caller's business.
 */
export function isoDate(v: unknown, label: string, warnings: string[]): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && isRealCalendarDate(s)) return s;
  const parsed = parseDotDate(s);
  if (parsed && isRealCalendarDate(parsed)) return parsed;
  warnings.push(`${label}: התאריך "${s}" לא זוהה כתאריך תקין והושמט`);
  return null;
}

/** en-US thousands + 2 decimals, e.g. 3355.8 → "3,355.80". */
export function fmtAmount(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
