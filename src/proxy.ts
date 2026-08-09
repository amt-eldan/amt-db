import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionValue } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
