import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AppError, HTTP_STATUS, isAppError } from "@/server/errors";
import { requireUser, getRequestMeta } from "@/server/auth/current";
import type { ValidSession } from "@/server/auth/sessions";

export type ActionResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; fieldErrors?: Record<string, string[]> };

export function zodFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Convert any thrown error to a user-safe result. Unknown errors are logged, never echoed. */
export function toFailure(e: unknown): Extract<ActionResult, { ok: false }> {
  if (isAppError(e)) return { ok: false, error: e.message, code: e.code, fieldErrors: e.fieldErrors };
  if (e instanceof z.ZodError) {
    const fe = zodFieldErrors(e);
    const first = e.issues[0];
    return { ok: false, error: first ? `${first.path.join(".") || "Input"}: ${first.message}` : "Invalid input", code: "VALIDATION", fieldErrors: fe };
  }
  // Postgres unique violation → friendly conflict.
  const pg = e as { code?: string; cause?: { code?: string } };
  if (pg?.code === "23505" || pg?.cause?.code === "23505") return { ok: false, error: "That already exists.", code: "CONFLICT" };
  console.error("[action] unexpected error", e);
  return { ok: false, error: "Something went wrong. Your change was not saved — please try again.", code: "INTERNAL" };
}

type Ctx = { session: ValidSession; userId: string };

/**
 * Wrap a server action: authenticates, validates input with Zod, and normalises errors.
 * The handler receives the authenticated userId — callers can never supply one.
 */
export function userAction<S extends z.ZodType, R>(schema: S, handler: (input: z.output<S>, ctx: Ctx) => Promise<R>) {
  return async (input: z.input<S>): Promise<ActionResult<R>> => {
    try {
      const session = await requireUser();
      const parsed = schema.parse(input);
      const data = await handler(parsed, { session, userId: session.user.id });
      return { ok: true, data };
    } catch (e) {
      return toFailure(e);
    }
  };
}

/** Same-origin check for mutating route handlers (server actions do this automatically). */
export async function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) throw new AppError("FORBIDDEN", "Cross-site request blocked.");
  try {
    if (new URL(origin).host !== host) throw new Error();
  } catch {
    throw new AppError("FORBIDDEN", "Cross-site request blocked.");
  }
}

export function jsonError(e: unknown) {
  const f = toFailure(e);
  const status = isAppError(e) ? HTTP_STATUS[e.code] : f.code === "VALIDATION" ? 400 : f.code === "CONFLICT" ? 409 : 500;
  return NextResponse.json({ error: f.error, code: f.code, fieldErrors: f.fieldErrors }, { status });
}

/** Wrap a route handler that requires an authenticated user. Mutating methods get an Origin check. */
export function userRoute<P = unknown>(
  handler: (req: Request, ctx: Ctx & { params: P; meta: Awaited<ReturnType<typeof getRequestMeta>> }) => Promise<Response>,
) {
  return async (req: Request, routeCtx: { params: Promise<P> }) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) await assertSameOrigin(req);
      const session = await requireUser();
      const meta = await getRequestMeta();
      const params = (await routeCtx?.params) as P;
      return await handler(req, { session, userId: session.user.id, params, meta });
    } catch (e) {
      return jsonError(e);
    }
  };
}

export { AppError };
