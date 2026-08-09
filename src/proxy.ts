import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionValue } from "@/lib/auth";

/**
 * The metadata paths an MCP client probes to find a sign-in service, including
 * the RFC 8414 / RFC 9728 variants that carry the resource path as a suffix
 * (`/.well-known/oauth-protected-resource/api/mcp/<token>`).
 */
const OAUTH_DISCOVERY =
  /^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource|openid-configuration)(\/|$)/;

/** Exported for the unit test — the connector breaks silently when this is wrong. */
export function isOAuthDiscoveryPath(pathname: string): boolean {
  return OAUTH_DISCOVERY.test(pathname);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // This server has no sign-in service — the MCP token is in the URL — and the
  // honest answer to the probe is "nothing here". It has to be said explicitly:
  // the catch-all below would otherwise redirect the probe to /login, and the
  // client would get 200 and an HTML page where OAuth metadata should be. That
  // is what a connector reports as "couldn't register with the sign-in service"
  // — it found a sign-in service that does not exist.
  if (isOAuthDiscoveryPath(pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  // /api/staged and /api/bol authenticate with their own bearer tokens, and
  // /api/mcp with the token in its path (it is called by Anthropic's
  // infrastructure, which carries no session cookie); /login is public.
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/staged") ||
    pathname.startsWith("/api/bol") ||
    pathname.startsWith("/api/mcp")
  ) {
    return NextResponse.next();
  }

  const ok = await verifySessionValue(request.cookies.get(SESSION_COOKIE)?.value);
  if (!ok) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"],
};
