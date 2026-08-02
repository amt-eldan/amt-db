"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, createSessionValue, SESSION_COOKIE } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  checkLoginThrottle,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/login-attempts";
import { lockoutMessage } from "@/lib/login-throttle";

export async function login(
  _prevState: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const password = String(formData.get("password") ?? "");
  const ip = await clientIp();

  // Rate-limit before comparing: one shared password guards everything here, so
  // unlimited guessing is the weakest point in the system.
  const verdict = await checkLoginThrottle(ip);
  if (!verdict.allowed) {
    // No new failure is recorded for a locked-out attempt — otherwise retrying
    // would keep pushing the unlock time out forever.
    await audit("auth", null, "login_locked", { ip }, "anon");
    return { error: lockoutMessage(verdict.retryAfterMinutes) };
  }

  if (!checkPassword(password)) {
    await recordLoginFailure(ip);
    // The attempted password is deliberately never logged.
    await audit("auth", null, "login_failed", { ip }, "anon");
    return { error: "סיסמה שגויה" };
  }

  await clearLoginFailures(ip);
  const session = await createSessionValue();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: session.maxAgeSeconds,
    path: "/",
  });
  redirect("/");
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/login");
}
