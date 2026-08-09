/**
 * Single shared-password auth, isolated in this module so it can be swapped
 * for real multi-user auth later (replace these functions + the login page).
 *
 * Session = signed httpOnly cookie: "<expiresAtMs>.<hmacSha256>".
 * Uses Web Crypto so it runs in both Node and Edge (middleware) runtimes.
 */

export const SESSION_COOKIE = "amt_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.APP_PASSWORD;
  if (!secret) throw new Error("APP_PASSWORD is not set");
  return `amt-session:${secret}`;
}

/**
 * Length-checked constant-time string compare, for secrets.
 *
 * Hand-rolled on Web Crypto primitives rather than node:crypto.timingSafeEqual
 * because this module also runs in the proxy (Edge) runtime. Unequal lengths
 * return early — that leaks length, which for a fixed-width HMAC signature is
 * nothing, and for the shared password is not worth padding around.
 */
export function secretEquals(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function checkPassword(password: string): boolean {
  const expected = process.env.APP_PASSWORD;
  return !!expected && secretEquals(password, expected);
}

/** Returns the cookie value for a fresh session. */
export async function createSessionValue(): Promise<{ value: string; maxAgeSeconds: number }> {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  return {
    value: `${payload}.${await hmac(payload)}`,
    maxAgeSeconds: SESSION_TTL_MS / 1000,
  };
}

export async function verifySessionValue(cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf(".");
  if (dot < 0) return false;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expiresAt = parseInt(payload, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = await hmac(payload);
  return secretEquals(sig, expected);
}
