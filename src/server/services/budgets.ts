/**
 * Budgets and budget alerts.
 *
 * Spending = expenses − refunds in the user's base currency (`base_amount`), honouring splits
 * (LEFT JOIN transaction_splits + COALESCE). Transfers and adjustments never count.
 * Overall budgets (category = null) skip categories marked `exclude_from_reports`.
 *
 * Projections are a simple linear forecast (spent ÷ elapsed days × period days). They are
 * labelled as a forecast in the UI and are only used for status/alerts once enough of the
 * period has elapsed for the pace to mean something.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { budgetAlertEvents, budgets, type Budget } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { optionalDate, optionalId, optionalText, positiveMoney } from "@/lib/validation";
import { add, cmp, divInt, formatMoney, isPositive, mul, normalize, ratio, sub } from "@/lib/money";
import { addDaysISO, daysBetween, monthRange, weekRange, yearRange, type DateRange, type ISODate } from "@/lib/dates";
import { expandCategoryIds, getCategory } from "./taxonomy";
import { convert, getNotificationPreferences, getPreferences, rateMap, type Prefs } from "./preferences";
import { notify } from "./notifications";

export const BUDGET_PERIODS = ["weekly", "monthly", "yearly", "custom"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export const DEFAULT_ALERT_THRESHOLDS = [50, 75, 90, 100];
/** Share of the budget at which a budget is shown as "warning" (close to the limit). */
export const WARNING_RATIO = 0.8;

export const budgetInput = z
  .object({
    name: optionalText(60),
    period: z.enum(BUDGET_PERIODS).default("monthly"),
    categoryId: optionalId,
    includeSubcategories: z.boolean().default(true),
    amount: positiveMoney,
    startDate: optionalDate,
    endDate: optionalDate,
    rollover: z.boolean().default(false),
    alertsEnabled: z.boolean().default(true),
    alertThresholds: z
      .array(z.coerce.number().int("Use whole percentages").min(1, "Thresholds start at 1%").max(200, "Thresholds go up to 200%"))
      .max(10, "Up to 10 thresholds")
      .default(DEFAULT_ALERT_THRESHOLDS)
      .transform((arr) => [...new Set(arr)].sort((a, b) => a - b)),
    alertOnProjected: z.boolean().default(true),
    /** Budgets are always kept in the base currency; when given it must match it. */
    currency: z.string().trim().length(3).toUpperCase().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.period === "custom") {
      if (!v.startDate) ctx.addIssue({ code: "custom", path: ["startDate"], message: "Choose when this budget starts" });
      if (!v.endDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Choose when this budget ends" });
      if (v.startDate && v.endDate && v.endDate < v.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be after the start date" });
      if (v.startDate && v.endDate && daysBetween(v.startDate, v.endDate) > 366 * 3)
        ctx.addIssue({ code: "custom", path: ["endDate"], message: "Custom budgets can span at most 3 years" });
    }
  });
export type BudgetInput = z.input<typeof budgetInput>;

type PeriodPrefs = Pick<Prefs, "weekStartsOn" | "monthStartDay">;

/** The budget window containing `refDate`, honouring the user's week start and month start day. */
export function currentPeriod(budget: Pick<Budget, "period" | "startDate" | "endDate">, prefs: PeriodPrefs, refDate: ISODate): DateRange {
  switch (budget.period) {
    case "weekly":
      return weekRange(refDate, prefs.weekStartsOn);
    case "monthly":
      return monthRange(refDate, prefs.monthStartDay);
    case "yearly":
      return yearRange(refDate);
    case "custom":
      return { from: budget.startDate ?? refDate, to: budget.endDate ?? budget.startDate ?? refDate };
  }
}

/** The window before `period` (null for custom budgets, which have a single window). */
export function previousPeriodOf(budget: Pick<Budget, "period" | "startDate" | "endDate">, prefs: PeriodPrefs, period: DateRange): DateRange | null {
  if (budget.period === "custom") return null;
  return currentPeriod(budget, prefs, addDaysISO(period.from, -1));
}

async function validateCategory(userId: string, categoryId: string | null) {
  if (!categoryId) return null;
  const cat = await getCategory(userId, categoryId);
  if (cat.kind !== "expense") throw new AppError("VALIDATION", "Budgets track spending — choose an expense category.", { categoryId: ["Choose an expense category"] });
  return cat;
}

async function buildRow(userId: string, input: z.output<typeof budgetInput>, existing?: Budget) {
  const cat = await validateCategory(userId, input.categoryId);
  const prefs = await getPreferences(userId);
  if (input.currency && input.currency !== prefs.currency)
    throw new AppError("VALIDATION", `Budgets use your base currency (${prefs.currency}).`, { currency: ["Must be your base currency"] });
  const custom = input.period === "custom";
  // For recurring periods `startDate` is an anchor: rollover never reaches before it.
  const anchor = custom
    ? input.startDate
    : existing && existing.period === input.period && existing.startDate
      ? existing.startDate
      : currentPeriod({ period: input.period, startDate: null, endDate: null }, prefs, prefs.today).from;
  return {
    userId,
    name: input.name ?? cat?.name ?? "Overall spending",
    period: input.period,
    categoryId: input.categoryId,
    includeSubcategories: input.includeSubcategories,
    amount: input.amount,
    currency: prefs.currency,
    startDate: anchor,
    endDate: custom ? input.endDate : null,
    rollover: custom ? false : input.rollover,
    alertsEnabled: input.alertsEnabled,
    alertThresholds: input.alertThresholds,
    alertOnProjected: input.alertOnProjected,
  };
}

export async function createBudget(userId: string, raw: BudgetInput) {
  const row = await buildRow(userId, budgetInput.parse(raw));
  const [created] = await db.insert(budgets).values(row).returning();
  return created;
}

export async function updateBudget(userId: string, budgetId: string, raw: BudgetInput) {
  const existing = await getBudget(userId, budgetId);
  const row = await buildRow(userId, budgetInput.parse(raw), existing);
  const [updated] = await db
    .update(budgets)
    .set(row)
    .where(and(eq(budgets.id, budgetId), eq(budgets.userId, userId)))
    .returning();
  return updated;
}

export async function setBudgetArchived(userId: string, budgetId: string, archived: boolean) {
  const [row] = await db
    .update(budgets)
    .set({ isArchived: archived })
    .where(and(eq(budgets.id, budgetId), eq(budgets.userId, userId)))
    .returning({ id: budgets.id });
  if (!row) throw notFound("Budget");
}

export async function deleteBudget(userId: string, budgetId: string) {
  const [row] = await db
    .delete(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.userId, userId)))
    .returning({ id: budgets.id });
  if (!row) throw notFound("Budget");
}

export async function getBudget(userId: string, budgetId: string) {
  const [row] = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Budget");
  return row;
}

export async function listBudgets(userId: string, opts: { includeArchived?: boolean } = {}) {
  return db
    .select()
    .from(budgets)
    .where(and(eq(budgets.userId, userId), opts.includeArchived ? undefined : eq(budgets.isArchived, false)))
    .orderBy(asc(budgets.createdAt));
}

/* ───────────── Spending maths ───────────── */

type Scope = { categoryIds: string[] | null };

async function scopeFor(userId: string, b: Pick<Budget, "categoryId" | "includeSubcategories">): Promise<Scope> {
  if (!b.categoryId) return { categoryIds: null };
  return { categoryIds: b.includeSubcategories ? await expandCategoryIds(userId, [b.categoryId]) : [b.categoryId] };
}

/** Net spending (expenses − refunds, base currency) per day in [from, to] for a budget's scope. */
export async function dailySpending(userId: string, range: DateRange, scope: Scope): Promise<Map<ISODate, string>> {
  const catExpr = sql`coalesce(s.category_id, t.category_id)`;
  const scopeSql = scope.categoryIds
    ? scope.categoryIds.length
      ? sql`AND ${catExpr} IN (${sql.join(scope.categoryIds.map((c) => sql`${c}::uuid`), sql`, `)})`
      : sql`AND false`
    : sql`AND (c.id IS NULL OR (c.exclude_from_reports = false AND (p.id IS NULL OR p.exclude_from_reports = false)))`;
  const rows = await db.execute<{ date: string; spent: string }>(sql`
    SELECT t.date::text AS date,
      coalesce(sum(CASE WHEN t.type = 'expense' THEN coalesce(s.base_amount, t.base_amount)
                        ELSE -coalesce(s.base_amount, t.base_amount) END), 0)::text AS spent
    FROM transactions t
    LEFT JOIN transaction_splits s ON s.transaction_id = t.id AND s.user_id = t.user_id
    LEFT JOIN categories c ON c.id = ${catExpr} AND c.user_id = t.user_id
    LEFT JOIN categories p ON p.id = c.parent_id AND p.user_id = t.user_id
    WHERE t.user_id = ${userId}
      AND t.deleted_at IS NULL
      AND t.type IN ('expense', 'refund')
      AND t.date BETWEEN ${range.from}::date AND ${range.to}::date
      ${scopeSql}
    GROUP BY t.date`);
  return new Map(rows.map((r) => [r.date, normalize(r.spent)]));
}

function sumRange(daily: Map<ISODate, string>, range: DateRange) {
  let total = "0";
  for (const [d, v] of daily) if (d >= range.from && d <= range.to) total = add(total, v);
  return normalize(total);
}

export type BudgetStatus = "ok" | "warning" | "over" | "projected_over";

export type BudgetProgress = {
  id: string;
  name: string;
  period: BudgetPeriod;
  categoryId: string | null;
  includeSubcategories: boolean;
  /** The configured amount (base currency). */
  amount: string;
  currency: string;
  rollover: boolean;
  /** Carried from the previous period (previous amount − previous spent). Can be negative. */
  rolloverAmount: string;
  /** amount + rolloverAmount: what can be spent this period. */
  available: string;
  startDate: string | null;
  endDate: string | null;
  alertsEnabled: boolean;
  alertThresholds: number[];
  alertOnProjected: boolean;
  periodRange: DateRange;
  totalDays: number;
  elapsedDays: number;
  daysLeft: number;
  spent: string;
  remaining: string;
  /** spent ÷ available as a ratio (1 = 100%). Display only. */
  pct: number;
  /** Linear forecast of spending by the end of the period. */
  projected: string;
  /** False early in a period, when a pace-based forecast would be noise. */
  projectionReliable: boolean;
  /** Where spending "should" be today if spread evenly (pace marker). */
  expectedByToday: string;
  /** remaining ÷ daysLeft (0 when nothing is left). */
  dailyAllowance: string;
  status: BudgetStatus;
};

function computeProgress(b: Budget, amount: string, period: DateRange, spent: string, rolloverAmount: string, refDate: ISODate): BudgetProgress {
  const totalDays = daysBetween(period.from, period.to) + 1;
  const elapsedDays = refDate < period.from ? 0 : refDate > period.to ? totalDays : daysBetween(period.from, refDate) + 1;
  const daysLeft = refDate < period.from ? totalDays : refDate > period.to ? 0 : daysBetween(refDate, period.to) + 1;
  const available = add(amount, rolloverAmount);
  const remaining = sub(available, spent);
  const pct = isPositive(available) ? ratio(spent, available) : isPositive(spent) ? 10 : 0;
  const projected = elapsedDays > 0 && elapsedDays < totalDays ? divInt(mul(spent, String(totalDays)), elapsedDays) : normalize(spent);
  const projectionReliable = elapsedDays >= Math.max(2, Math.ceil(totalDays * 0.2)) && elapsedDays < totalDays;
  const expectedByToday = divInt(mul(isPositive(available) ? available : "0", String(elapsedDays)), totalDays);
  const dailyAllowance = isPositive(remaining) && daysLeft > 0 ? divInt(remaining, daysLeft) : "0.0000";
  const over = cmp(spent, available) > 0;
  const status: BudgetStatus = over
    ? "over"
    : projectionReliable && cmp(projected, available) > 0
      ? "projected_over"
      : pct >= WARNING_RATIO
        ? "warning"
        : "ok";
  return {
    id: b.id,
    name: b.name,
    period: b.period,
    categoryId: b.categoryId,
    includeSubcategories: b.includeSubcategories,
    amount,
    currency: b.currency,
    rollover: b.rollover,
    rolloverAmount,
    available,
    startDate: b.startDate,
    endDate: b.endDate,
    alertsEnabled: b.alertsEnabled,
    alertThresholds: b.alertThresholds,
    alertOnProjected: b.alertOnProjected,
    periodRange: period,
    totalDays,
    elapsedDays,
    daysLeft,
    spent: normalize(spent),
    remaining,
    pct,
    projected,
    projectionReliable,
    expectedByToday,
    dailyAllowance,
    status,
  };
}

async function progressFor(userId: string, b: Budget, prefs: Prefs, rates: Map<string, string>, refDate: ISODate): Promise<BudgetProgress> {
  // Budgets are stored in the base currency; if the base currency changed since, convert.
  const amount = b.currency === prefs.currency ? normalize(b.amount) : (convert(b.amount, b.currency, rates) ?? normalize(b.amount));
  const period = currentPeriod(b, prefs, refDate);
  const prev = b.rollover ? previousPeriodOf(b, prefs, period) : null;
  const rolloverApplies = Boolean(prev && (!b.startDate || prev.from >= b.startDate));
  const scope = await scopeFor(userId, b);
  const daily = await dailySpending(userId, { from: rolloverApplies ? prev!.from : period.from, to: period.to }, scope);
  const spent = sumRange(daily, period);
  const rolloverAmount = rolloverApplies ? sub(amount, sumRange(daily, prev!)) : "0.0000";
  return computeProgress(b, amount, period, spent, rolloverAmount, refDate);
}

/** Progress for every active budget in the period containing `refDate` (default: today). */
export async function listBudgetsWithProgress(userId: string, refDate?: ISODate): Promise<BudgetProgress[]> {
  const prefs = await getPreferences(userId);
  const day = refDate ?? prefs.today;
  const [rows, rates] = await Promise.all([listBudgets(userId), rateMap(userId, prefs.currency)]);
  return Promise.all(rows.map((b) => progressFor(userId, b, prefs, rates, day)));
}

export async function getBudgetProgress(userId: string, budgetId: string, refDate?: ISODate) {
  const prefs = await getPreferences(userId);
  const b = await getBudget(userId, budgetId);
  return progressFor(userId, b, prefs, await rateMap(userId, prefs.currency), refDate ?? prefs.today);
}

/** Totals across overall/category budgets for a header summary. Overall budgets win when present. */
export function summarizeBudgets(list: BudgetProgress[]) {
  const monthly = list.filter((b) => b.period === "monthly");
  const overall = monthly.find((b) => !b.categoryId);
  const cats = monthly.filter((b) => b.categoryId);
  if (overall) return { basis: "overall" as const, budgeted: overall.available, spent: overall.spent, count: monthly.length, period: overall.periodRange };
  return {
    basis: "categories" as const,
    budgeted: add(...cats.map((b) => b.available)),
    spent: add(...cats.map((b) => b.spent)),
    count: cats.length,
    period: cats[0]?.periodRange ?? null,
  };
}

export type BudgetHistoryPoint = { from: ISODate; to: ISODate; spent: string; amount: string; current: boolean };

/** Spending in the last `periods` windows (oldest first; the last entry is the current period). */
export async function budgetHistory(userId: string, budgetId: string, periods = 6, refDate?: ISODate): Promise<BudgetHistoryPoint[]> {
  const n = Math.min(Math.max(Math.trunc(periods), 1), 24);
  const prefs = await getPreferences(userId);
  const b = await getBudget(userId, budgetId);
  const day = refDate ?? prefs.today;
  const rates = await rateMap(userId, prefs.currency);
  const amount = b.currency === prefs.currency ? normalize(b.amount) : (convert(b.amount, b.currency, rates) ?? normalize(b.amount));
  const windows: DateRange[] = [currentPeriod(b, prefs, day)];
  while (windows.length < n) {
    const prev = previousPeriodOf(b, prefs, windows[0]);
    if (!prev) break;
    windows.unshift(prev);
  }
  const daily = await dailySpending(userId, { from: windows[0].from, to: windows[windows.length - 1].to }, await scopeFor(userId, b));
  return windows.map((w, i) => ({ from: w.from, to: w.to, spent: sumRange(daily, w), amount, current: i === windows.length - 1 }));
}

/* ───────────── Alerts ───────────── */

const PERIOD_WORD: Record<BudgetPeriod, string> = { weekly: "this week", monthly: "this month", yearly: "this year", custom: "in this budget" };

/**
 * Record every newly crossed threshold (once per budget/period/threshold) and notify about the
 * highest one only, so a big purchase that jumps from 40% to 110% sends a single alert.
 * Threshold -1 means "projected to exceed" and is only notified when no % threshold is new.
 */
export async function generateBudgetAlerts(userId: string, refDate?: ISODate) {
  const prefs = await getPreferences(userId);
  const np = await getNotificationPreferences(userId);
  const list = (await listBudgetsWithProgress(userId, refDate)).filter((b) => b.alertsEnabled);
  let recorded = 0;
  let notified = 0;
  for (const b of list) {
    const pct100 = b.pct * 100;
    const crossed = b.alertThresholds.filter((t) => pct100 >= t);
    if (b.alertOnProjected && b.status === "projected_over") crossed.push(-1);
    if (!crossed.length) continue;
    const inserted = await db
      .insert(budgetAlertEvents)
      .values(crossed.map((threshold) => ({ userId, budgetId: b.id, periodStart: b.periodRange.from, threshold })))
      .onConflictDoNothing()
      .returning({ threshold: budgetAlertEvents.threshold });
    if (!inserted.length) continue;
    recorded += inserted.length;
    if (!np.budgetAlerts) continue;
    const fresh = inserted.map((r) => r.threshold);
    const top = Math.max(...fresh);
    const fmt = (v: string) => formatMoney(v, prefs.currency, { locale: prefs.locale });
    const when = PERIOD_WORD[b.period];
    let title: string;
    let body: string;
    if (top === -1) {
      title = `${b.name} is on pace to go over`;
      body = `Forecast at your current pace: about ${fmt(b.projected)} of ${fmt(b.available)} ${when}. ${fmt(b.remaining)} left for ${b.daysLeft} ${b.daysLeft === 1 ? "day" : "days"}.`;
    } else if (cmp(b.spent, b.available) > 0) {
      title = `${b.name} is over budget`;
      body = `You've spent ${fmt(b.spent)} of ${fmt(b.available)} ${when} — ${fmt(sub(b.spent, b.available))} over.`;
    } else {
      title = `${b.name}: ${Math.floor(pct100)}% used`;
      body = `You've spent ${fmt(b.spent)} of ${fmt(b.available)} ${when}. ${fmt(b.remaining)} left${b.daysLeft > 0 ? ` for ${b.daysLeft} ${b.daysLeft === 1 ? "day" : "days"}` : ""}.`;
    }
    const id = await notify(userId, { type: "budget", title, body, link: "/budgets", dedupeKey: `budget:${b.id}:${b.periodRange.from}:${top}` });
    if (id) notified++;
  }
  return { recorded, notified };
}

/** Alert events recorded for the current periods (to show "alerted at 75%" in the UI). */
export async function alertEventsFor(userId: string, items: { id: string; periodStart: ISODate }[]) {
  if (!items.length) return new Map<string, number[]>();
  const rows = await db
    .select({ budgetId: budgetAlertEvents.budgetId, periodStart: budgetAlertEvents.periodStart, threshold: budgetAlertEvents.threshold })
    .from(budgetAlertEvents)
    .where(and(eq(budgetAlertEvents.userId, userId), inArray(budgetAlertEvents.budgetId, items.map((i) => i.id))));
  const want = new Map(items.map((i) => [i.id, i.periodStart]));
  const out = new Map<string, number[]>();
  for (const r of rows) {
    if (want.get(r.budgetId) !== r.periodStart) continue;
    out.set(r.budgetId, [...(out.get(r.budgetId) ?? []), r.threshold].sort((a, b) => a - b));
  }
  return out;
}

