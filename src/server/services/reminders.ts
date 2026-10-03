/**
 * Reminder engine. `runUserReminders` is idempotent: every notification it creates carries a
 * dedupe key (e.g. `daily:2026-10-03`, `payments:2026-10-03`), so running it from cron, from the
 * lazy in-app trigger, or both, never produces duplicates.
 *
 * Everything is evaluated in the user's timezone. Preference toggles decide what is generated;
 * quiet hours and the daily push cap only affect *push* delivery (see push.ts) — in-app
 * notifications are always recorded.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { transactions, users } from "@/server/db/schema";
import { rateLimit } from "@/server/auth/rate-limit";
import { addDaysISO, daysBetween, timeIn, todayIn, type ISODate } from "@/lib/dates";
import { notify, type NotifyInput } from "./notifications";
import { getNotificationPreferences, getPreferences } from "./preferences";
import { listRecurring, processDueRecurring, upcomingOccurrences, type Occurrence } from "./recurring";
import { pushPendingForUser } from "./push";
import { generateBudgetAlerts } from "./budgets";
import { generateGoalReminders } from "./goals";
import { generateCreditCardReminders } from "./credit";

export type ReminderRunResult = { created: number; posted: number; errors: number };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function dueLabel(days: number, date: ISODate) {
  if (days < 0) return `was due ${date}`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** Has the user logged anything today (dated today, or entered today in their timezone)? */
async function loggedToday(userId: string, today: ISODate, tz: string) {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM transactions
      WHERE user_id = ${userId} AND deleted_at IS NULL
        AND (date = ${today}::date OR (created_at AT TIME ZONE ${tz})::date = ${today}::date)
    ) AS ok`);
  return Boolean(rows[0]?.ok);
}

/** Local date of the most recent entry, or of sign-up when nothing was ever logged. */
async function lastEntryDate(userId: string, tz: string): Promise<ISODate | null> {
  const [row] = await db
    .select({ d: sql<string | null>`max((${transactions.createdAt} AT TIME ZONE ${tz})::date)::text` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), isNull(transactions.deletedAt)));
  if (row?.d) return row.d;
  const [u] = await db.select({ d: sql<string>`((${users.createdAt} AT TIME ZONE ${tz})::date)::text` }).from(users).where(eq(users.id, userId));
  return u?.d ?? null;
}

/**
 * Generate every reminder due for this user at `now`. Each step is isolated: one failing
 * module never blocks the others.
 */
export async function runUserReminders(userId: string, now: Date = new Date()): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { created: 0, posted: 0, errors: 0 };
  const [prefs, np] = await Promise.all([getPreferences(userId), getNotificationPreferences(userId)]);
  const tz = prefs.timezone;
  const today = todayIn(tz, now);
  const localTime = timeIn(tz, now);

  const emit = async (n: NotifyInput) => {
    if (await notify(userId, n)) result.created++;
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      result.errors++;
      console.error(`[reminders] ${name} failed`, e instanceof Error ? e.message : e);
    }
  };

  // 1. Auto-post due recurring items first, so they don't show up as "due" below.
  await step("auto-post", async () => {
    result.posted += (await processDueRecurring(userId, today)).posted;
  });

  // 2. Missing entries (one reminder per gap, not one per day).
  let missingDue = false;
  await step("missing-entries", async () => {
    if (np.missingEntriesDays <= 0) return;
    const last = await lastEntryDate(userId, tz);
    if (!last) return;
    const gap = daysBetween(last, today);
    if (gap < np.missingEntriesDays) return;
    missingDue = true;
    await emit({
      type: "missing_entries",
      title: "Catch up on your spending",
      body: `Nothing has been logged for ${gap} days. A quick catch-up keeps your budgets accurate.`,
      link: "/transactions",
      dedupeKey: `missing:${last}`,
    });
  });

  // 3. Daily tracking reminder at the chosen local time — skipped if they've logged today
  //    or a missing-entries reminder already covers it.
  await step("daily", async () => {
    if (!np.dailyReminderEnabled || missingDue) return;
    const at = HHMM.test(np.dailyReminderTime) ? np.dailyReminderTime : "20:30";
    if (localTime < at) return;
    if (await loggedToday(userId, today, tz)) return;
    await emit({
      type: "daily_reminder",
      title: "Have you tracked today's expenses?",
      body: "Take a few seconds to log what you spent today.",
      link: "/dashboard?add=expense",
      dedupeKey: `daily:${today}`,
    });
  });

  // 4. Upcoming bills, subscriptions, recurring expenses and expected income.
  const wantsPayments = np.billReminders || np.subscriptionReminders;
  if (wantsPayments || np.incomeReminders) {
    await step("recurring", async () => {
      const items = await listRecurring(userId);
      const byId = new Map(items.map((i) => [i.id, i]));
      const occ = await upcomingOccurrences(userId, today, addDaysISO(today, 31));

      const payments: (Occurrence & { days: number })[] = [];
      const income: (Occurrence & { days: number })[] = [];
      const seen = new Set<string>();
      for (const o of occ) {
        const item = byId.get(o.recurringId);
        if (!item) continue;
        const days = daysBetween(today, o.date);
        if (o.kind === "income") {
          if (np.incomeReminders && days <= 0 && !o.autoPost) income.push({ ...o, days });
          continue;
        }
        if (o.kind === "transfer") continue;
        const enabled = o.kind === "subscription" ? np.subscriptionReminders : np.billReminders;
        if (!enabled || days > item.remindDaysBefore) continue;
        if (days < 0 && o.autoPost) continue;
        // One line per item: its earliest open occurrence.
        if (seen.has(o.recurringId)) continue;
        seen.add(o.recurringId);
        payments.push({ ...o, days });
      }

      // Digest: at most one payments notification per day.
      if (payments.length === 1) {
        const p = payments[0];
        const verb = p.kind === "subscription" ? "renews" : "is due";
        await emit({
          type: p.kind === "subscription" ? "subscription" : "bill",
          title: p.days < 0 ? `${p.name} is overdue` : `${p.name} ${verb} ${dueLabel(p.days, p.date)}`,
          body: p.autoPost ? "It will be recorded automatically." : "Mark it paid once it's done so your balances stay right.",
          link: "/recurring",
          dedupeKey: `payments:${today}`,
        });
      } else if (payments.length > 1) {
        const overdue = payments.filter((p) => p.days < 0).length;
        await emit({
          type: "bill",
          title: overdue ? `${payments.length} payments need attention` : `${payments.length} payments due soon`,
          body: payments
            .slice(0, 6)
            .map((p) => `${p.name} ${p.days < 0 ? "(overdue)" : dueLabel(p.days, p.date)}`)
            .join(" · ") + (payments.length > 6 ? ` · +${payments.length - 6} more` : ""),
          link: "/recurring",
          dedupeKey: `payments:${today}`,
        });
      }

      for (const o of income) {
        const item = byId.get(o.recurringId)!;
        const who = item.employer || o.name;
        await emit({
          type: "income",
          title: o.days === 0 ? `${who} expected today` : `${who} was expected on ${o.date}`,
          body: "Mark it as received once it lands in your account.",
          link: "/recurring",
          dedupeKey: `income:${o.recurringId}:${o.date}`,
        });
      }

      // Subscription trials ending soon (once per trial).
      if (np.subscriptionReminders) {
        for (const s of items) {
          if (s.kind !== "subscription" || s.status !== "active" || !s.trialEndsAt) continue;
          const days = daysBetween(today, s.trialEndsAt);
          if (days < 0 || days > Math.max(s.remindDaysBefore, 2)) continue;
          await emit({
            type: "subscription",
            title: `${s.name} trial ends ${dueLabel(days, s.trialEndsAt)}`,
            body: "Cancel before it ends if you don't want to be charged.",
            link: "/recurring",
            dedupeKey: `trial:${s.id}:${s.trialEndsAt}`,
          });
        }
      }
    });
  }

  // 5. Other modules' generators (they create their own deduped notifications).
  await runModuleGenerators(userId, today, step, (n) => (result.created += n));

  return result;
}

type Step = (name: string, fn: () => Promise<void>) => Promise<void>;

/**
 * Budget, goal and credit-card generators live in their own modules and create their own deduped
 * notifications; each checks its own preference toggle. Budget alerts are always evaluated (they
 * record threshold events even when alerts are off, so re-enabling never replays old alerts).
 */
async function runModuleGenerators(userId: string, today: ISODate, step: Step, add: (n: number) => void) {
  await step("budgets", async () => add((await generateBudgetAlerts(userId, today)).notified));
  await step("goals", async () => add(await generateGoalReminders(userId)));
  await step("credit-cards", async () => add(await generateCreditCardReminders(userId)));
}

/* ───────────── Lazy trigger ───────────── */

export const LAZY_INTERVAL_SECONDS = 15 * 60;

/**
 * Run reminders + push for a user at most once per 15 minutes (throttled through the shared
 * rate_limits table, so it holds across serverless instances). Safe to call on every page load —
 * it never throws. Call it from the app layout via `after()` so it doesn't delay rendering.
 */
export async function maybeRunRemindersForUser(userId: string, now: Date = new Date()) {
  try {
    const gate = await rateLimit(`reminders:${userId}`, 1, LAZY_INTERVAL_SECONDS);
    if (!gate.allowed) return { ran: false as const };
    const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.status !== "active") return { ran: false as const };
    const r = await runUserReminders(userId, now);
    const p = await pushPendingForUser(userId, now);
    return { ran: true as const, ...r, pushed: p.pushed };
  } catch (e) {
    console.error("[reminders] lazy run failed", e instanceof Error ? e.message : e);
    return { ran: false as const };
  }
}
