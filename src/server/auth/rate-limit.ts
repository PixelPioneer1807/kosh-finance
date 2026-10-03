import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

/**
 * Fixed-window counter stored in Postgres so limits hold across serverless instances.
 * The upsert is atomic: concurrent requests can't both slip under the limit.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const rows = await db.execute<{ count: number; window_start: string }>(sql`
    INSERT INTO rate_limits (key, count, window_start) VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) THEN now() ELSE rate_limits.window_start END
    RETURNING count, window_start`);
  const row = rows[0];
  const count = Number(row.count);
  const elapsed = (Date.now() - new Date(row.window_start).getTime()) / 1000;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - elapsed)),
  };
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number, message?: string) {
  const r = await rateLimit(key, limit, windowSeconds);
  if (!r.allowed) {
    const mins = Math.ceil(r.retryAfterSeconds / 60);
    throw new AppError("RATE_LIMITED", message ?? `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  return r;
}

export async function resetRateLimit(key: string) {
  await db.execute(sql`DELETE FROM rate_limits WHERE key = ${key}`);
}
