import { NextResponse } from "next/server";
import { secretEquals } from "./auth";

/**
 * Bearer-token auth for the machine endpoints (/api/staged, /api/bol/*), which
 * the proxy exempts from the session cookie.
 *
 * One helper instead of the check copy-pasted into every route, so a new
 * endpoint cannot get it subtly wrong — and so the comparison is constant-time
 * in one place.
 *
 * Returns a ready 401 response when the caller is not authorised, or null when
 * it is:
 *
 *     const denied = requireBearer(request, process.env.BOL_AGENT_TOKEN);
 *     if (denied) return denied;
 */
export function requireBearer(request: Request, expected: string | undefined): NextResponse | null {
  const unauthorized = NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // A missing/blank server-side token must never authorise anyone — otherwise a
  // forgotten environment variable would open the endpoint up.
  if (!expected) return unauthorized;

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!match) return unauthorized;

  return secretEquals(match[1], expected) ? null : unauthorized;
}
