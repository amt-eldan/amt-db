/**
 * Brute-force rules for the shared-password login.
 *
 * One password guards the whole order book and /login is public, so unlimited
 * guessing is the weakest point in the system. Kept pure — and separate from the
 * code that touches the database (src/lib/login-attempts.ts) — so the rules are
 * unit-testable on their own, same as src/lib/bol-match.ts.
 */

/** Failed attempts from one IP that trip the lock. */
export const MAX_FAILURES = 8;

/** Sliding window, in minutes, for counting failures and for the lock itself. */
export const WINDOW_MINUTES = 15;

const WINDOW_MS = WINDOW_MINUTES * 60_000;

export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterMinutes: number };

/** Start of the counting window — failures older than this are ignored. */
export function windowStart(now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS);
}

/**
 * Decides whether an IP may attempt a password right now.
 *
 * The window slides: once MAX_FAILURES is reached the IP stays locked until its
 * oldest in-window failure ages out, so the lock lifts by itself and no cleanup
 * job is needed to unlock anyone.
 */
export function throttleVerdict(
  failuresInWindow: number,
  oldestFailureAt: Date | null,
  now: Date,
): ThrottleVerdict {
  if (failuresInWindow < MAX_FAILURES || !oldestFailureAt) return { allowed: true };

  const remainingMs = oldestFailureAt.getTime() + WINDOW_MS - now.getTime();
  if (remainingMs <= 0) return { allowed: true };

  // Round up, and never report "0 minutes" — the caller puts this in a message.
  return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(remainingMs / 60_000)) };
}

/** Hebrew lockout message for the login form. */
export function lockoutMessage(retryAfterMinutes: number): string {
  return `יותר מדי ניסיונות התחברות. נסה שוב בעוד ${retryAfterMinutes} דקות.`;
}
