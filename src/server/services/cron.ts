/**
 * Scheduled work, invoked by /api/cron/tick. Users are processed in small concurrent batches,
 * least-recently-processed first (via the reminders throttle row), within a time budget — so a
 * large user base is covered across consecutive ticks instead of timing out.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { auditLogs, financialSnapshots } from "@/server/db/schema";
import { purgeExpiredSessions } from "@/server/auth/sessions";
import { maybeRunRemindersForUser } from "./reminders";
import { recordSnapshot } from "./networth";
import { getPreferences } from "./preferences";

export type CronResult = {
  users: number;
  skipped: number;
  notifications: number;
  pushed: number;
  posted: number;
  snapshots: number;
  errors: number;
  housekeeping: Awaited<ReturnType<typeof housekeeping>>;
  durationMs: number;
};

const BATCH = 50;
const CONCURRENCY = 5;
const MAX_USERS_PER_TICK = 5000;

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/** Daily net-worth snapshot: recorded once per user per local day (later ticks skip it). */
async function recordUserSnapshot(userId: string): Promise<boolean> {
  const { today } = await getPreferences(userId);
  const [exists] = await db
    .select({ id: financialSnapshots.id })
    .from(financialSnapshots)
    .where(and(eq(financialSnapshots.userId, userId), eq(financialSnapshots.date, today)))
    .limit(1);
  if (exists) return false;
  return Boolean(await recordSnapshot(userId));
}

export async function runCronTick(opts: { now?: Date; timeBudgetMs?: number } = {}): Promise<CronResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const budget = opts.timeBudgetMs ?? 45_000;
  const out: Omit<CronResult, "housekeeping" | "durationMs"> = { users: 0, skipped: 0, notifications: 0, pushed: 0, posted: 0, snapshots: 0, errors: 0 };

  // Least-recently processed first; never-processed users (no throttle row) come first.
  // The order is read once up front because processing a user moves them to the back.
  const queue = await db.execute<{ id: string }>(sql`
    SELECT u.id FROM users u
    LEFT JOIN rate_limits r ON r.key = 'reminders:' || u.id::text
    WHERE u.status = 'active'
    ORDER BY r.window_start ASC NULLS FIRST, u.id ASC
    LIMIT ${MAX_USERS_PER_TICK}`);
  const ids = [...queue].map((r) => r.id);
  for (let start = 0; start < ids.length; start += BATCH) {
    if (Date.now() - started > budget) break;
    await pool(ids.slice(start, start + BATCH), CONCURRENCY, async (id) => {
      if (Date.now() - started > budget) return;
      const r = await maybeRunRemindersForUser(id, now);
      if (r.ran) {
        out.users++;
        out.notifications += r.created;
        out.pushed += r.pushed;
        out.posted += r.posted;
        out.errors += r.errors;
      } else out.skipped++;
      try {
        if (await recordUserSnapshot(id)) out.snapshots++;
      } catch (e) {
        out.errors++;
        console.error("[cron] snapshot failed", e instanceof Error ? e.message : e);
      }
    });
  }

  const hk = await housekeeping();
  const durationMs = Date.now() - started;
  await db.insert(auditLogs).values({ action: "cron.tick", meta: { ...out, ...hk, durationMs } });
  return { ...out, housekeeping: hk, durationMs };
}

/** Global cleanup. Each statement is bounded and idempotent. */
export async function housekeeping() {
  const count = (r: unknown) => (r as { count?: number }).count ?? 0;
  await purgeExpiredSessions();
  const rateLimits = await db.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`);
  const purgedTransactions = await db.execute(sql`DELETE FROM transactions WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'`);
  const expiredAiActions = await db.execute(
    sql`UPDATE ai_actions SET status = 'expired', resolved_at = now() WHERE status = 'pending' AND expires_at < now()`,
  );
  const resetTokens = await db.execute(sql`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days'`);
  const oldNotifications = await db.execute(sql`DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '180 days'`);
  const oldCronLogs = await db.execute(sql`DELETE FROM audit_logs WHERE action = 'cron.tick' AND created_at < now() - interval '14 days'`);
  return {
    rateLimits: count(rateLimits),
    purgedTransactions: count(purgedTransactions),
    expiredAiActions: count(expiredAiActions),
    resetTokens: count(resetTokens),
    oldNotifications: count(oldNotifications),
    oldCronLogs: count(oldCronLogs),
  };
}

/** Most recent cron run (recorded in audit_logs). */
export async function lastCronRun() {
  const [row] = await db
    .select({ at: auditLogs.createdAt, meta: auditLogs.meta })
    .from(auditLogs)
    .where(eq(auditLogs.action, "cron.tick"))
    .orderBy(sql`${auditLogs.createdAt} DESC`)
    .limit(1);
  return row ?? null;
}

