import { and, asc, eq, gte, lt } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";
import { loginAttempts } from "@/db/schema";
import { throttleVerdict, windowStart, type ThrottleVerdict } from "./login-throttle";

/**
 * Database side of the login brute-force lock. The rules themselves live in
 * src/lib/login-throttle.ts and are unit-tested without a database.
 *
 * Attempt state has to be shared across serverless instances, so it lives in
 * Postgres rather than in process memory — an in-memory counter would reset on
 * every cold start and differ per instance.
 */

/** Caller's IP as seen through Vercel's proxy. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = h.get("x-real-ip")?.trim();
  return forwarded || real || "unknown";
}

/**
 * Whether this IP may try a password right now.
 *
 * Reads the in-window failures for the IP — capped at MAX_FAILURES, because a
 * locked-out attempt returns before recording another one — and lets the pure
 * rules decide.
 */
export async function checkLoginThrottle(ip: string, now: Date = new Date()): Promise<ThrottleVerdict> {
  const rows = await db
    .select({ createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), gte(loginAttempts.createdAt, windowStart(now))))
    .orderBy(asc(loginAttempts.createdAt));

  return throttleVerdict(rows.length, rows[0]?.createdAt ?? null, now);
}

export async function recordLoginFailure(ip: string, now: Date = new Date()): Promise<void> {
  await db.insert(loginAttempts).values({ ip });
  // Opportunistic cleanup: rows outside the window can never affect a verdict,
  // so dropping them here keeps the table from growing without bound.
  await db.delete(loginAttempts).where(lt(loginAttempts.createdAt, windowStart(now)));
}

/** A correct password clears the IP's record, so a typo streak isn't punished later. */
export async function clearLoginFailures(ip: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.ip, ip));
}
