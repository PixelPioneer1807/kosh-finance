import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/server/errors";
import { validateSessionToken, type ValidSession } from "./sessions";

const isProd = process.env.NODE_ENV === "production";
/** `__Host-` prefix pins the cookie to this exact origin over HTTPS (not usable on http://localhost). */
export const SESSION_COOKIE = isProd ? "__Host-kosh_session" : "kosh_session";

export const getSession = cache(async (): Promise<ValidSession | null> => {
  const store = await cookies();
  return validateSessionToken(store.get(SESSION_COOKIE)?.value);
});

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: 0 });
}

export async function getSessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** For pages/layouts: redirect to login when signed out. */
export async function requireUserPage(opts: { allowOnboarding?: boolean } = {}) {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!opts.allowOnboarding && !s.user.onboardingCompletedAt) redirect("/onboarding");
  return s;
}

export async function requireAdminPage() {
  const s = await requireUserPage({ allowOnboarding: true });
  if (s.user.role !== "admin") redirect("/dashboard");
  return s;
}

/** For server actions / route handlers: throw instead of redirecting. */
export async function requireUser() {
  const s = await getSession();
  if (!s) throw new AppError("UNAUTHORIZED", "Your session has expired. Please sign in again.");
  return s;
}

export async function requireAdmin() {
  const s = await requireUser();
  if (s.user.role !== "admin") throw new AppError("FORBIDDEN", "Admins only.");
  return s;
}

export async function getRequestMeta() {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : h.get("x-real-ip"))?.trim() || "unknown";
  return { ip, userAgent: h.get("user-agent") ?? null, origin: h.get("origin"), host: h.get("host") };
}
