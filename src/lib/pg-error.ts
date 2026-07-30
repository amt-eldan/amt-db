/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * True when the error (or anything it wraps) is a unique-constraint violation.
 * drizzle re-throws driver errors wrapped in its own `Failed query:` Error and
 * keeps the pg error — which carries `code` — under `cause`, so the chain has to
 * be walked rather than the top-level error inspected.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
