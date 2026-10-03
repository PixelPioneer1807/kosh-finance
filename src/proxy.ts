import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic routing only: redirects signed-out visitors away from app pages and adds
 * security headers. Real authorisation happens server-side in every page, action and
 * route handler (see src/server/auth/current.ts) — never rely on this alone.
 */
const PUBLIC = ["/login", "/register", "/forgot-password", "/reset-password", "/offline"];
const COOKIE = process.env.NODE_ENV === "production" ? "__Host-kosh_session" : "kosh_session";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(COOKIE)?.value);
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!hasSession && !isPublic && pathname !== "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/dashboard" ? "" : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Skip API routes (they authenticate themselves and return JSON), static assets and PWA files.
  matcher: ["/((?!api|_next/static|_next/image|icons|sw.js|manifest.webmanifest|favicon.ico|robots.txt).*)"],
};
