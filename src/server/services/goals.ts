/**
 * Savings goals and their contributions.
 *
 * Model
 * - A goal's current amount = `starting_amount` + Σ contributions (withdrawals are negative).
 * - A contribution can optionally move real money: it then creates a `transfer` transaction
 *   (in the same DB transaction) and stores its id, so account balances and net worth follow.
 * - Completion: an active goal is auto-marked `completed` the first time current ≥ target
 *   (`completed_at` is set once). Reactivating a goal that is still at/over target keeps
 *   `completed_at`, which tells the auto-complete "the user chose to keep going" so it doesn't
 *   immediately re-complete. Raising the target above the current amount clears it again.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type DbOrTx, type Tx } from "@/server/db";
import { accounts, goalContributions, goals, transactions, type Goal } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { add, cmp, isPositive, mul, neg, normalize, ratio, sub, formatMoney } from "@/lib/money";
import { addDaysISO, daysBetween, formatDate, todayIn, type ISODate } from "@/lib/dates";
import { occurrencesBetween } from "@/lib/recurrence";
import { currencyCode, hexColor, id, isoDate, name, nonNegativeMoney, optionalDate, optionalId, optionalMoney, optionalText, positiveMoney } from "@/lib/validation";
import {
  GOAL_FREQUENCIES,
  GOAL_FREQUENCY_LABELS,
  GOAL_KIND_IDS,
  GOAL_PERIOD_DAYS,
  ceilDivCents,
  goalKindMeta,
  type GoalFrequency,
  type GoalKind,
  type GoalTrack,
} from "@/lib/goals";
import { getAccount, isLiabilityType } from "./accounts";
import { assertOwned } from "./ownership";
import { getNotificationPreferences, getPreferences } from "./preferences";
import { createTransaction } from "./transactions";
import { notify } from "./notifications";

/* ───────────── Validation ───────────── */

const frequencyField = z
  .union([z.literal(""), z.null(), z.enum(GOAL_FREQUENCIES)])
  .optional()
  .transform((v) => (v ? v : null));

export const goalInput = z.object({
  name: name("Goal name", 60),
  kind: z.enum(GOAL_KIND_IDS).default("custom"),
  icon: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/, "Invalid icon")
    .nullish()
    .transform((v) => v ?? null),
  color: hexColor.nullish().transform((v) => v ?? null),
  targetAmount: positiveMoney,
  startingAmount: nonNegativeMoney.default("0"),
  /** Defaults to the user's base currency. */
  currency: z
    .union([z.literal(""), z.null(), currencyCode])
    .optional()
    .transform((v) => v || null),
  deadline: optionalDate,
  contributionFrequency: frequencyField,
  /** Planned amount per period (optional; required-per-period is computed from the deadline anyway). */
  targetContribution: optionalMoney.transform((v) => (v && isPositive(v) ? v : null)),
  linkedAccountId: optionalId,
  notes: optionalText(500),
});
export type GoalInput = z.input<typeof goalInput>;

export const contributionInput = z.object({
  goalId: id,
  direction: z.enum(["contribute", "withdraw"]).default("contribute"),
  /** Positive magnitude in the goal's currency; the sign comes from `direction`. */
  amount: positiveMoney,
  date: isoDate,
  note: optionalText(200),
  /**
   * Move real money: the account on the other side of the transfer (money comes *from* it when
   * contributing, goes *to* it when withdrawing). Omit to just record progress.
   */
  accountId: optionalId,
  /** The account that holds the goal's money; defaults to the goal's linked account. */
  goalAccountId: optionalId,
});
export type ContributionInput = z.input<typeof contributionInput>;

export const GOAL_STATUS_ACTIONS = ["complete", "archive", "reactivate"] as const;
export type GoalStatusAction = (typeof GOAL_STATUS_ACTIONS)[number];

/* ───────────── Helpers ───────────── */

async function validateLinkedAccount(userId: string, accountId: string | null, currency: string, dbx: DbOrTx = db) {
  if (!accountId) return;
  await assertOwned(userId, { account: accountId }, dbx);
  const acc = await getAccount(userId, accountId, dbx);
  if (isLiabilityType(acc.type))
    throw new AppError("VALIDATION", "Link the goal to an account that holds money, not a credit card or loan.", { linkedAccountId: ["Choose an asset account"] });
  if (acc.currency !== currency)
    throw new AppError("VALIDATION", `The linked account is in ${acc.currency}; the goal is in ${currency}. Pick an account in the same currency.`, {
      linkedAccountId: ["Currency doesn't match the goal"],
    });
}

async function contributedTotal(userId: string, goalId: string, dbx: DbOrTx = db) {
  const [r] = await dbx
    .select({ total: sql<string>`coalesce(sum(${goalContributions.amount}), 0)::text` })
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, goalId)));
  return normalize(r?.total ?? "0");
}

export async function getGoal(userId: string, goalId: string, dbx: DbOrTx = db): Promise<Goal> {
  const [row] = await dbx
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Goal");
  return row;
}

/** Auto-complete an active goal the first time it reaches its target. Returns true if it just completed. */
async function syncCompletion(userId: string, goal: Goal, current: string, dbx: DbOrTx = db): Promise<boolean> {
  if (goal.status !== "active" || goal.completedAt || cmp(current, goal.targetAmount) < 0) return false;
  const rows = await dbx
    .update(goals)
    .set({ status: "completed", completedAt: new Date() })
    .where(and(eq(goals.id, goal.id), eq(goals.userId, userId), eq(goals.status, "active"), isNull(goals.completedAt)))
    .returning({ id: goals.id });
  return rows.length > 0;
}

/* ───────────── CRUD ───────────── */

export async function createGoal(userId: string, raw: GoalInput) {
  const input = goalInput.parse(raw);
  const prefs = await getPreferences(userId);
  const currency = input.currency ?? prefs.currency;
  if (input.deadline && input.deadline <= prefs.today)
    throw new AppError("VALIDATION", "Choose a deadline in the future.", { deadline: ["Must be after today"] });
  await validateLinkedAccount(userId, input.linkedAccountId, currency);
  const meta = goalKindMeta(input.kind);
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${goals.sortOrder}), -1)::int` })
    .from(goals)
    .where(eq(goals.userId, userId));
  const [row] = await db
    .insert(goals)
    .values({
      userId,
      name: input.name,
      kind: input.kind,
      icon: input.icon ?? meta.icon,
      color: input.color ?? meta.color,
      targetAmount: input.targetAmount,
      startingAmount: input.startingAmount,
      currency,
      deadline: input.deadline,
      contributionFrequency: input.contributionFrequency,
      targetContribution: input.targetContribution,
      linkedAccountId: input.linkedAccountId,
      notes: input.notes,
      sortOrder: max + 1,
    })
    .returning();
  await syncCompletion(userId, row, row.startingAmount);
  return row;
}

export async function updateGoal(userId: string, goalId: string, raw: GoalInput) {
  const input = goalInput.parse(raw);
  const prefs = await getPreferences(userId);
  return db.transaction(async (tx) => {
    const existing = await getGoal(userId, goalId, tx);
    const currency = input.currency ?? existing.currency;
    const contributed = await contributedTotal(userId, goalId, tx);
    if (currency !== existing.currency) {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(goalContributions)
        .where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, goalId)));
      if (n > 0) throw new AppError("VALIDATION", "You can't change the currency of a goal that already has contributions.", { currency: ["Has contributions"] });
    }
    if (input.deadline && input.deadline !== existing.deadline && input.deadline <= prefs.today)
      throw new AppError("VALIDATION", "Choose a deadline in the future.", { deadline: ["Must be after today"] });
    await validateLinkedAccount(userId, input.linkedAccountId, currency, tx);
    const meta = goalKindMeta(input.kind);
    const current = add(input.startingAmount, contributed);
    // Raising the target above what's saved re-arms auto-completion.
    const completedAt = existing.status === "active" && cmp(current, input.targetAmount) < 0 ? null : existing.completedAt;
    const [row] = await tx
      .update(goals)
      .set({
        name: input.name,
        kind: input.kind,
        icon: input.icon ?? meta.icon,
        color: input.color ?? meta.color,
        targetAmount: input.targetAmount,
        startingAmount: input.startingAmount,
        currency,
        deadline: input.deadline,
        contributionFrequency: input.contributionFrequency,
        targetContribution: input.targetContribution,
        linkedAccountId: input.linkedAccountId,
        notes: input.notes,
        completedAt,
      })
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
      .returning();
    await syncCompletion(userId, row, current, tx);
    return row;
  });
}

export async function setGoalStatus(userId: string, goalId: string, action: GoalStatusAction) {
  return db.transaction(async (tx) => {
    const goal = await getGoal(userId, goalId, tx);
    let patch: Partial<typeof goals.$inferInsert>;
    if (action === "complete") patch = { status: "completed", completedAt: goal.completedAt ?? new Date() };
    else if (action === "archive") patch = { status: "archived" };
    else {
      const current = add(goal.startingAmount, await contributedTotal(userId, goalId, tx));
      const reached = cmp(current, goal.targetAmount) >= 0;
      patch = { status: "active", completedAt: reached ? (goal.completedAt ?? new Date()) : null };
    }
    const [row] = await tx
      .update(goals)
      .set(patch)
      .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
      .returning();
    return row;
  });
}

/** Deletes the goal and its contribution records. Transfers already made stay in the ledger (the money really moved). */
export async function deleteGoal(userId: string, goalId: string) {
  const [row] = await db
    .delete(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
    .returning({ id: goals.id });
  if (!row) throw notFound("Goal");
}

/* ───────────── Contributions ───────────── */

export async function addContribution(userId: string, raw: ContributionInput) {
  const input = contributionInput.parse(raw);
  const prefs = await getPreferences(userId);
  if (input.date > prefs.today) throw new AppError("VALIDATION", "Contributions can't be dated in the future.", { date: ["Must be today or earlier"] });

  return db.transaction(async (tx: Tx) => {
    // Lock the goal row so concurrent withdrawals can't overdraw it.
    const [goal] = await tx
      .select()
      .from(goals)
      .where(and(eq(goals.id, input.goalId), eq(goals.userId, userId)))
      .for("update")
      .limit(1);
    if (!goal) throw notFound("Goal");
    if (goal.status === "archived") throw new AppError("VALIDATION", "Reactivate this goal before adding to it.");

    const current = add(goal.startingAmount, await contributedTotal(userId, goal.id, tx));
    const withdrawing = input.direction === "withdraw";
    if (withdrawing && cmp(input.amount, current) > 0)
      throw new AppError("VALIDATION", `You can withdraw at most ${formatMoney(current, goal.currency, { locale: prefs.locale })} from this goal.`, {
        amount: ["More than the goal holds"],
      });
    const signed = withdrawing ? neg(input.amount) : input.amount;

    let transactionId: string | null = null;
    if (input.accountId) {
      const goalAccountId = input.goalAccountId ?? goal.linkedAccountId;
      if (!goalAccountId)
        throw new AppError("VALIDATION", "Choose the account that holds this goal's money, or link one to the goal.", { goalAccountId: ["Required to move money"] });
      if (goalAccountId === input.accountId) throw new AppError("VALIDATION", "Pick two different accounts.", { accountId: ["Same as the goal's account"] });
      const [other, goalAccount] = [await getAccount(userId, input.accountId, tx), await getAccount(userId, goalAccountId, tx)];
      for (const acc of [other, goalAccount]) {
        if (acc.currency !== goal.currency)
          throw new AppError("VALIDATION", `${acc.name} is in ${acc.currency}, but this goal is in ${goal.currency}. Record a transfer from Transactions instead.`, {
            accountId: ["Currency doesn't match the goal"],
          });
      }
      const from = withdrawing ? goalAccount : other;
      const to = withdrawing ? other : goalAccount;
      const txn = await createTransaction(
        userId,
        {
          type: "transfer",
          accountId: from.id,
          toAccountId: to.id,
          amount: input.amount,
          date: input.date,
          notes: `${withdrawing ? "Withdrawal from" : "Saved towards"} goal: ${goal.name}${input.note ? ` — ${input.note}` : ""}`.slice(0, 1000),
        },
        {},
        tx,
      );
      transactionId = txn.id;
    }

    const [row] = await tx
      .insert(goalContributions)
      .values({ userId, goalId: goal.id, amount: signed, date: input.date, note: input.note, transactionId })
      .returning();
    const completed = await syncCompletion(userId, goal, add(current, signed), tx);
    return { contribution: row, completed };
  });
}

export type ContributionRow = {
  id: string;
  goalId: string;
  amount: string;
  date: string;
  note: string | null;
  transactionId: string | null;
  /** Present when the contribution moved money between accounts (and the transfer still exists). */
  transfer: { fromAccountName: string; toAccountName: string } | null;
};

export async function listContributions(userId: string, goalId: string, opts: { limit?: number } = {}): Promise<ContributionRow[]> {
  await getGoal(userId, goalId);
  const fromAcc = alias(accounts, "from_acc");
  const toAcc = alias(accounts, "to_acc");
  const rows = await db
    .select({
      id: goalContributions.id,
      goalId: goalContributions.goalId,
      amount: goalContributions.amount,
      date: goalContributions.date,
      note: goalContributions.note,
      transactionId: goalContributions.transactionId,
      fromAccountName: fromAcc.name,
      toAccountName: toAcc.name,
    })
    .from(goalContributions)
    .leftJoin(
      transactions,
      and(eq(transactions.id, goalContributions.transactionId), eq(transactions.userId, userId), isNull(transactions.deletedAt)),
    )
    .leftJoin(fromAcc, eq(fromAcc.id, transactions.accountId))
    .leftJoin(toAcc, eq(toAcc.id, transactions.toAccountId))
    .where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, goalId)))
    .orderBy(desc(goalContributions.date), desc(goalContributions.createdAt))
    .limit(Math.min(opts.limit ?? 200, 500));
  return rows.map((r) => ({
    id: r.id,
    goalId: r.goalId,
    amount: normalize(r.amount),
    date: r.date,
    note: r.note,
    transactionId: r.transactionId,
    transfer: r.fromAccountName && r.toAccountName ? { fromAccountName: r.fromAccountName, toAccountName: r.toAccountName } : null,
  }));
}

/**
 * Removes a contribution. When it created a transfer, that transfer is soft-deleted too
 * (restorable from Transactions) unless `keepTransfer` is set.
 */
export async function deleteContribution(userId: string, contributionId: string, opts: { keepTransfer?: boolean } = {}) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(goalContributions)
      .where(and(eq(goalContributions.id, contributionId), eq(goalContributions.userId, userId)))
      .returning();
    if (!row) throw notFound("Contribution");
    if (row.transactionId && !opts.keepTransfer) {
      await tx
        .update(transactions)
        .set({ deletedAt: new Date() })
        .where(and(eq(transactions.id, row.transactionId), eq(transactions.userId, userId), isNull(transactions.deletedAt)));
    }
  });
}

/* ───────────── Progress ───────────── */

export type GoalProgress = {
  id: string;
  name: string;
  kind: GoalKind;
  icon: string;
  color: string;
  currency: string;
  status: "active" | "completed" | "archived";
  targetAmount: string;
  startingAmount: string;
  /** Σ contributions (net of withdrawals). */
  contributed: string;
  /** starting + contributed. */
  current: string;
  /** max(0, target − current). */
  remaining: string;
  /** current ÷ target (can exceed 1). */
  progress: number;
  deadline: ISODate | null;
  /** Days from today to the deadline (negative when past). */
  daysToDeadline: number | null;
  contributionFrequency: GoalFrequency | null;
  targetContribution: string | null;
  /** The frequency used for "per period" figures (the goal's, or monthly by default). */
  periodFrequency: GoalFrequency;
  /** Contribution periods left from today to the deadline (the current period counts). */
  periodsLeft: number | null;
  /** What to save each period to reach the target by the deadline (ceil to cents). */
  requiredPerPeriod: string | null;
  /** Net contributions in the pace window (last ≤90 days), and that window's length. */
  recentContributed: string;
  paceWindowDays: number;
  /** Average net saving per period over the pace window; null when not positive. */
  pacePerPeriod: string | null;
  /** PROJECTION: when the target would be reached at the recent pace. Null without a positive pace. */
  projectedCompletionDate: ISODate | null;
  track: GoalTrack;
  onTrack: boolean;
  linkedAccountId: string | null;
  linkedAccountName: string | null;
  lastContributionDate: ISODate | null;
  contributionCount: number;
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
};

const PACE_MAX_DAYS = 90;
const PACE_MIN_DAYS = 30;

/** Pure progress maths for one goal — exported for unit tests. */
export function computeProgress(
  goal: Pick<Goal, "targetAmount" | "startingAmount" | "deadline" | "contributionFrequency" | "targetContribution" | "status"> & { createdDate: ISODate },
  agg: { contributed: string; recent: string; firstDate: ISODate | null },
  today: ISODate,
) {
  const current = add(goal.startingAmount, agg.contributed);
  const remainingRaw = sub(goal.targetAmount, current);
  const remaining = isPositive(remainingRaw) ? remainingRaw : "0.0000";
  const reached = !isPositive(remaining);
  const freq = (GOAL_FREQUENCIES as readonly string[]).includes(goal.contributionFrequency ?? "") ? (goal.contributionFrequency as GoalFrequency) : null;
  const periodFrequency: GoalFrequency = freq ?? "monthly";

  // Periods left: occurrences of the cadence starting today, up to the deadline.
  let periodsLeft: number | null = null;
  let requiredPerPeriod: string | null = null;
  const daysToDeadline = goal.deadline ? daysBetween(today, goal.deadline) : null;
  if (goal.deadline && !reached) {
    if (goal.deadline < today) {
      periodsLeft = 0;
      requiredPerPeriod = remaining;
    } else {
      periodsLeft = Math.max(1, occurrencesBetween({ frequency: periodFrequency, startDate: today }, today, goal.deadline).length);
      requiredPerPeriod = ceilDivCents(remaining, periodsLeft);
    }
  }

  // Pace window: the last 90 days, but never before the goal (or its first contribution) existed,
  // and at least 30 days so one early deposit doesn't project an absurd finish date.
  const earliest = agg.firstDate && agg.firstDate < goal.createdDate ? agg.firstDate : goal.createdDate;
  const since = Math.max(0, daysBetween(earliest, today)) + 1;
  const paceWindowDays = Math.min(PACE_MAX_DAYS, Math.max(PACE_MIN_DAYS, since));
  const positivePace = isPositive(agg.recent);
  const pacePerPeriod = positivePace ? mul(agg.recent, (GOAL_PERIOD_DAYS[periodFrequency] / paceWindowDays).toFixed(10)) : null;
  let projectedCompletionDate: ISODate | null = null;
  if (reached) projectedCompletionDate = null;
  else if (positivePace) {
    const days = Math.ceil(ratio(remaining, agg.recent) * paceWindowDays);
    if (Number.isFinite(days) && days <= 365 * 100) projectedCompletionDate = addDaysISO(today, Math.max(1, days));
  }

  let track: GoalTrack;
  if (reached || goal.status === "completed") track = "completed";
  else if (goal.deadline && goal.deadline < today) track = "overdue";
  else if (goal.deadline) track = !projectedCompletionDate ? "no_pace" : projectedCompletionDate <= goal.deadline ? "on_track" : "behind";
  else if (goal.targetContribution && freq) track = pacePerPeriod && cmp(pacePerPeriod, goal.targetContribution) >= 0 ? "on_track" : positivePace ? "behind" : "no_pace";
  else track = positivePace ? "no_deadline" : "no_pace";

  return {
    current,
    remaining,
    progress: ratio(current, goal.targetAmount),
    periodFrequency,
    periodsLeft,
    requiredPerPeriod,
    daysToDeadline,
    paceWindowDays,
    pacePerPeriod,
    projectedCompletionDate,
    track,
    onTrack: track === "completed" || track === "on_track",
  };
}

/**
 * All goals with computed progress, ordered active → completed → archived.
 * Side effect: auto-completes active goals that have reached their target (once).
 */
export async function listGoalsWithProgress(userId: string, opts: { status?: GoalProgress["status"][] } = {}): Promise<GoalProgress[]> {
  const prefs = await getPreferences(userId);
  const today = prefs.today;
  const rows = await db
    .select({ goal: goals, accountName: accounts.name })
    .from(goals)
    .leftJoin(accounts, and(eq(accounts.id, goals.linkedAccountId), eq(accounts.userId, userId)))
    .where(and(eq(goals.userId, userId), opts.status?.length ? inArray(goals.status, opts.status) : undefined))
    .orderBy(asc(goals.sortOrder), asc(goals.createdAt));
  if (!rows.length) return [];

  const paceFrom = addDaysISO(today, -(PACE_MAX_DAYS - 1));
  const aggs = await db.execute<{ goal_id: string; total: string; recent: string; first_date: string | null; last_date: string | null; n: number }>(sql`
    SELECT goal_id,
           sum(amount)::text AS total,
           coalesce(sum(amount) FILTER (WHERE date >= ${paceFrom} AND date <= ${today}), 0)::text AS recent,
           min(date)::text AS first_date,
           (max(date) FILTER (WHERE amount > 0))::text AS last_date,
           count(*)::int AS n
      FROM goal_contributions
     WHERE user_id = ${userId}
     GROUP BY goal_id`);
  const byGoal = new Map(aggs.map((a) => [a.goal_id, a]));

  const out: GoalProgress[] = [];
  for (const { goal, accountName } of rows) {
    const a = byGoal.get(goal.id);
    const contributed = normalize(a?.total ?? "0");
    const createdDate = todayIn(prefs.timezone, goal.createdAt);
    let status = goal.status;
    let completedAt = goal.completedAt;
    const p = computeProgress({ ...goal, createdDate }, { contributed, recent: a?.recent ?? "0", firstDate: a?.first_date ?? null }, today);
    if (await syncCompletion(userId, goal, p.current)) {
      status = "completed";
      completedAt = new Date();
    }
    const meta = goalKindMeta(goal.kind);
    const progress = status === "completed" ? { ...p, track: "completed" as const, onTrack: true } : p;
    out.push({
      id: goal.id,
      name: goal.name,
      kind: meta.id,
      icon: goal.icon ?? meta.icon,
      color: goal.color ?? meta.color,
      currency: goal.currency,
      status,
      targetAmount: normalize(goal.targetAmount),
      startingAmount: normalize(goal.startingAmount),
      contributed,
      current: progress.current,
      remaining: progress.remaining,
      progress: progress.progress,
      deadline: goal.deadline,
      daysToDeadline: progress.daysToDeadline,
      contributionFrequency: (goal.contributionFrequency as GoalFrequency | null) ?? null,
      targetContribution: goal.targetContribution ? normalize(goal.targetContribution) : null,
      periodFrequency: progress.periodFrequency,
      periodsLeft: progress.periodsLeft,
      requiredPerPeriod: progress.requiredPerPeriod,
      recentContributed: normalize(a?.recent ?? "0"),
      paceWindowDays: progress.paceWindowDays,
      pacePerPeriod: progress.pacePerPeriod,
      projectedCompletionDate: progress.projectedCompletionDate,
      track: progress.track,
      onTrack: progress.onTrack,
      linkedAccountId: goal.linkedAccountId,
      linkedAccountName: accountName ?? null,
      lastContributionDate: a?.last_date ?? null,
      contributionCount: a?.n ?? 0,
      notes: goal.notes,
      completedAt: completedAt ? completedAt.toISOString() : null,
      createdAt: goal.createdAt.toISOString(),
    });
  }
  const rank = { active: 0, completed: 1, archived: 2 } as const;
  return out.sort((x, y) => rank[x.status] - rank[y.status]);
}

/* ───────────── Reminders ───────────── */

/**
 * In-app reminders (for the daily cron):
 * - "missed contribution": the last full contribution period (anchored to the goal's creation
 *   date) passed without any positive contribution. Deduped per goal + period start.
 * - "goal reached": once per goal, when completed within the last 30 days.
 * Respects notification_preferences.goal_reminders. Returns the number of new notifications.
 */
export async function generateGoalReminders(userId: string): Promise<number> {
  const np = await getNotificationPreferences(userId);
  if (!np?.goalReminders) return 0;
  const prefs = await getPreferences(userId);
  const today = prefs.today;
  const list = await listGoalsWithProgress(userId, { status: ["active", "completed"] });
  let created = 0;

  for (const g of list) {
    const fmt = (v: string) => formatMoney(v, g.currency, { locale: prefs.locale, trimZeros: true });
    if (g.status === "completed") {
      const recent = g.completedAt && Date.now() - new Date(g.completedAt).getTime() <= 30 * 86_400_000;
      if (recent && cmp(g.current, g.targetAmount) >= 0) {
        const id = await notify(userId, {
          type: "goal",
          title: `Goal reached: ${g.name}`,
          body: `You've saved ${fmt(g.current)} of your ${fmt(g.targetAmount)} target. Nicely done.`,
          link: `/goals?open=${g.id}`,
          dedupeKey: `goal:${g.id}:reached`,
        });
        if (id) created++;
      }
      continue;
    }
    if (!g.contributionFrequency) continue;
    const createdDate = todayIn(prefs.timezone, new Date(g.createdAt));
    const windowFrom = addDaysISO(today, -800) > createdDate ? addDaysISO(today, -800) : createdDate;
    const starts = occurrencesBetween({ frequency: g.contributionFrequency, startDate: createdDate }, windowFrom, today);
    if (starts.length < 2) continue; // no full period has elapsed yet
    const periodStart = starts[starts.length - 2];
    const periodEnd = addDaysISO(starts[starts.length - 1], -1);
    if (g.deadline && g.deadline < periodStart) continue;
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(goalContributions)
      .where(
        and(
          eq(goalContributions.userId, userId),
          eq(goalContributions.goalId, g.id),
          sql`${goalContributions.amount} > 0`,
          sql`${goalContributions.date} BETWEEN ${periodStart} AND ${periodEnd}`,
        ),
      );
    if (n > 0) continue;
    const per = GOAL_FREQUENCY_LABELS[g.contributionFrequency].noun;
    const ask = g.targetContribution ?? g.requiredPerPeriod;
    const id = await notify(userId, {
      type: "goal",
      title: `No contribution to ${g.name} last ${per}`,
      body: `Nothing was added between ${formatDate(periodStart, "d MMM")} and ${formatDate(periodEnd, "d MMM")}.${
        ask ? ` Adding ${fmt(ask)} keeps you on plan.` : ""
      } ${fmt(g.remaining)} to go.`,
      link: `/goals?open=${g.id}`,
      dedupeKey: `goal:${g.id}:missed:${periodStart}`,
    });
    if (id) created++;
  }
  return created;
}
