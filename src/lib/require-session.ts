import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionValue } from "./auth";

/**
 * Server-side session check for Server Actions (defense in depth on top of
 * the middleware). Throws when there is no valid session.
 */
export async function requireSession(): Promise<void> {
  const cookieStore = await cookies();
  const ok = await verifySessionValue(cookieStore.get(SESSION_COOKIE)?.value);
  if (!ok) throw new Error("Unauthorized");
}
