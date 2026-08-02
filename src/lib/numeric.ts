/**
 * The one place a user-supplied number is turned into a number.
 *
 * There used to be three near-identical parsers (validation, extract-order,
 * profit) with different rules, so "₪1200" typed into a buy-price field parsed
 * fine in one path and silently became NULL in another. Everything numeric now
 * goes through here.
 */

/**
 * Currency/quantity text → a finite number, or null.
 *
 * Strips ₪, $, thousands separators and whitespace, then parseFloat. parseFloat
 * semantics are deliberate: a trailing unit ("50 יח'" → 50) is what the legacy
 * spreadsheet contained, and rejecting it would drop values that are accepted
 * today. Non-finite results (NaN, and Infinity from something like "1e999")
 * return null rather than poisoning a sum.
 */
export function parseNumeric(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = v.replace(/[₪$,\s]/g, "");
  if (cleaned === "") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Same parse, rendered back as a string for Drizzle's `numeric` columns (which
 * round-trip as strings). null stays null.
 */
export function parseNumericString(v: string | number | null | undefined): string | null {
  const n = parseNumeric(v);
  return n === null ? null : String(n);
}
