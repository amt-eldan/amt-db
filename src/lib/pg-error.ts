/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/** duplicate_table / duplicate_column / duplicate_object. */
const ALREADY_EXISTS = ["42P07", "42701", "42710"];

/**
 * The Postgres error code behind an error, or null.
 *
 * drizzle re-throws driver errors wrapped in its own `Failed query:` Error and
 * keeps the pg error — which carries `code` — under `cause`, so the chain has to
 * be walked rather than the top-level error inspected.
 */
export function pgErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True when the error (or anything it wraps) is a unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === UNIQUE_VIOLATION;
}

/**
 * True when a statement failed because what it creates is already there — the
 * signature of a schema that was changed without the migration being recorded.
 */
export function isAlreadyExists(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code !== null && ALREADY_EXISTS.includes(code);
}
