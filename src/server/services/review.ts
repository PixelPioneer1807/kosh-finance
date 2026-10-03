/**
 * Monthly review — computed facts about one budget month. No advice, no AI: every sentence is
 * derived from the numbers returned alongside it.
 */
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { add, cmp, divInt, formatMoney, isPositive, isZero, normalize, ratio, sub } from "@/lib/money";
import { addDaysISO, addMonthsISO, eachDay, formatDate, minISO, monthRange, type DateRange, type ISODate } from "@/lib/dates";
import { AppError } from "@/server/errors";
import {
  analyticsCtx,
  budgetPerformance,
  delta,
  largestTransactions,
  merchantStats,
  periodSummary,
  spendingByCategory,
  timeSeries,
  type BudgetPerformance,
  type CategoryAmount,
  type Delta,
  type LargeTxn,
  type MerchantStat,
  type PeriodSummary,
} from "./analytics";
import { rateMap, convert } from "./preferences";

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export type ReviewFact = { id: string; tone: "positive" | "negative" | "neutral"; text: string };

export type MonthlyReview = {
  month: string;
  range: DateRange;
  /** False while the month is still in progress (figures are month-to-date). */
  complete: boolean;
  currency: string;
  summary: PeriodSummary;
  threeMonthAverage: { income: string; spending: string; net: string; savingsRate: number | null; months: number };
  vsAverage: { income: Delta; spending: Delta; net: Delta };
  categories: CategoryAmount[];
  largestTransactions: LargeTxn[];
  budgets: { items: BudgetPerformance[]; over: number; near: number; under: number };
  recurring: { total: string; byKind: { kind: string; amount: string; count: number }[]; items: { recurringId: string; name: string; kind: string; amount: string; count: number }[] };
  goals: { total: string; items: { goalId: string; name: string; amount: string; currency: string; baseAmount: string | null }[] };
  notableChanges: { categoryId: string | null; name: string; icon: string; color: string; amount: string; previous: string; change: string; pct: number | null; direction: "up" | "down" }[];
  noSpendDays: { count: number; days: ISODate[]; ofDays: number };
  topMerchants: MerchantStat[];
  facts: ReviewFact[];
};

/** Budget-month window for "YYYY-MM" (honours the user's month start day). */
export function reviewRange(month: string, monthStartDay: number): DateRange {
  if (!MONTH_RE.test(month)) throw new AppError("VALIDATION", "Choose a month as YYYY-MM.");
  const day = String(Math.min(Math.max(monthStartDay, 1), 28)).padStart(2, "0");
  return monthRange(`${month}-${day}`, monthStartDay);
}

export async function monthlyReview(userId: string, month: string): Promise<MonthlyReview> {
  const ctx = await analyticsCtx(userId);
  const range = reviewRange(month, ctx.monthStartDay);
  const complete = range.to < ctx.today;
  const avgWindow: DateRange = { from: reviewRange(addMonthsISO(`${month}-01`, -3).slice(0, 7), ctx.monthStartDay).from, to: addDaysISO(range.from, -1) };

  const [summary, cats, largest, budgets, avgSeries, recurring, goals, merchants, spendDays, rates] = await Promise.all([
    periodSummary(userId, range, { ctx }),
    spendingByCategory(userId, range, { ctx }),
    largestTransactions(userId, range, { limit: 5, ctx }),
    budgetPerformance(userId, range.from, { ctx }),
    timeSeries(userId, avgWindow, "month", { ctx }),
    recurringInMonth(userId, range),
    db.execute<{ goal_id: string; name: string; currency: string; amount: string }>(sql`
      SELECT g.id AS goal_id, g.name, g.currency, SUM(gc.amount)::text AS amount
        FROM goal_contributions gc JOIN goals g ON g.id = gc.goal_id AND g.user_id = ${userId}
       WHERE gc.user_id = ${userId} AND gc.date >= ${range.from} AND gc.date <= ${range.to}
       GROUP BY g.id, g.name, g.currency ORDER BY SUM(gc.amount) DESC`),
    merchantStats(userId, range, { limit: 5, ctx }),
    db.execute<{ d: string }>(sql`
      SELECT DISTINCT t.date::text AS d FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = ${userId}
        LEFT JOIN categories pc ON pc.id = c.parent_id AND pc.user_id = ${userId}
       WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.type = 'expense'
         AND t.date >= ${range.from} AND t.date <= ${range.to}
         AND NOT (COALESCE(c.exclude_from_reports, false) OR COALESCE(pc.exclude_from_reports, false))`),
    rateMap(userId, ctx.currency),
  ]);

  // Only months with any activity count towards the average (a brand-new user has fewer).
  const active = avgSeries.filter((p) => !isZero(p.income) || !isZero(p.spending));
  const n = active.length;
  const avgIncome = n ? divInt(add(...active.map((p) => p.income)), n) : "0.0000";
  const avgSpending = n ? divInt(add(...active.map((p) => p.spending)), n) : "0.0000";
  const avgNet = sub(avgIncome, avgSpending);

  const spent = new Set(spendDays.map((r) => r.d));
  const lastDay = minISO(range.to, ctx.today);
  const elapsed = range.from <= lastDay ? eachDay({ from: range.from, to: lastDay }) : [];
  const noSpend = elapsed.filter((d) => !spent.has(d));

  const goalItems = goals.map((g) => ({ goalId: g.goal_id, name: g.name, amount: normalize(g.amount), currency: g.currency, baseAmount: convert(g.amount, g.currency, rates) }));
  const goalTotal = add(...goalItems.map((g) => g.baseAmount ?? "0"));

  const notable = cats.items
    .filter((c) => !isZero(c.previous) || !isZero(c.amount))
    .map((c) => ({ categoryId: c.categoryId, name: c.name, icon: c.icon, color: c.color, amount: c.amount, previous: c.previous, change: c.delta.change, pct: c.delta.pct }))
    // Notable = moved at least 20% and by at least 5% of the month's spending (ignores tiny categories).
    .filter((c) => (c.pct === null ? isPositive(c.amount) : Math.abs(c.pct) >= 0.2) && Math.abs(ratio(c.change, cmp(summary.spending, "0") > 0 ? summary.spending : "1")) >= 0.05)
    .map((c) => ({ ...c, direction: (isPositive(c.change) ? "up" : "down") as "up" | "down" }))
    .sort((a, b) => cmp(b.change.replace("-", ""), a.change.replace("-", "")))
    .slice(0, 6);

  const fmt = (v: string) => formatMoney(v, ctx.currency, { locale: ctx.locale });
  const pct = (v: number) => `${Math.round(Math.abs(v) * 100)}%`;
  const facts: ReviewFact[] = [];
  const monthLabel = ctx.monthStartDay > 1 ? `the month from ${formatDate(range.from, "d MMM")}` : formatDate(range.from, "MMMM yyyy");
  const prefix = complete ? `In ${monthLabel}` : `So far in ${monthLabel}`;
  facts.push({ id: "totals", tone: "neutral", text: `${prefix} you earned ${fmt(summary.income)} and spent ${fmt(summary.spending)}.` });
  if (!isZero(summary.income)) {
    facts.push({
      id: "savings",
      tone: isPositive(summary.net) ? "positive" : "negative",
      text: isPositive(summary.net) || isZero(summary.net)
        ? `You kept ${fmt(summary.net)}, a savings rate of ${pct(summary.savingsRate ?? 0)}.`
        : `Spending exceeded income by ${fmt(summary.net.replace("-", ""))}.`,
    });
  }
  if (summary.previous && summary.deltas?.spending.pct !== null && summary.deltas) {
    const d = summary.deltas.spending;
    facts.push({
      id: "vs-prev",
      tone: isPositive(d.change) ? "negative" : "positive",
      text: isZero(d.change)
        ? "Spending was the same as the previous month."
        : `Spending was ${pct(d.pct ?? 0)} ${isPositive(d.change) ? "higher" : "lower"} than the previous month (${fmt(summary.previous.spending)}).`,
    });
  }
  if (n > 0 && !isZero(avgSpending)) {
    const d = delta(summary.spending, avgSpending);
    facts.push({
      id: "vs-avg",
      tone: isPositive(d.change) ? "negative" : "positive",
      text: `Compared with your ${n}-month average of ${fmt(avgSpending)}, spending was ${pct(d.pct ?? 0)} ${isPositive(d.change) ? "higher" : "lower"}.`,
    });
  }
  const top = cats.items[0];
  if (top && isPositive(top.amount)) facts.push({ id: "top-cat", tone: "neutral", text: `${top.name} was your largest category at ${fmt(top.amount)} (${pct(top.share)} of spending).` });
  for (const c of notable.slice(0, 3))
    facts.push({
      id: `change-${c.categoryId ?? "none"}`,
      tone: c.direction === "up" ? "negative" : "positive",
      text: c.pct === null ? `${c.name}: ${fmt(c.amount)}, new this month.` : `${c.name} went ${c.direction} ${pct(c.pct)} to ${fmt(c.amount)} (from ${fmt(c.previous)}).`,
    });
  const over = budgets.items.filter((b) => b.status === "over");
  if (budgets.items.length)
    facts.push({
      id: "budgets",
      tone: over.length ? "negative" : "positive",
      text: over.length
        ? `${over.length} of ${budgets.items.length} budgets went over: ${over.map((b) => b.name).join(", ")}.`
        : `All ${budgets.items.length} budgets stayed within their limits.`,
    });
  if (!isZero(recurring.total)) facts.push({ id: "recurring", tone: "neutral", text: `Recurring bills, subscriptions and expenses came to ${fmt(recurring.total)}.` });
  if (!isZero(goalTotal)) facts.push({ id: "goals", tone: "positive", text: `You put ${fmt(goalTotal)} towards your goals.` });
  if (elapsed.length) facts.push({ id: "no-spend", tone: "neutral", text: `${noSpend.length} of ${elapsed.length} days had no spending.` });
  const topM = merchants.rows[0];
  if (topM) facts.push({ id: "top-merchant", tone: "neutral", text: `You spent the most at ${topM.name}: ${fmt(topM.total)} over ${topM.count} ${topM.count === 1 ? "purchase" : "purchases"}.` });

  return {
    month,
    range,
    complete,
    currency: ctx.currency,
    summary,
    threeMonthAverage: { income: avgIncome, spending: avgSpending, net: avgNet, savingsRate: cmp(avgIncome, "0") > 0 ? ratio(avgNet, avgIncome) : null, months: n },
    vsAverage: { income: delta(summary.income, avgIncome), spending: delta(summary.spending, avgSpending), net: delta(summary.net, avgNet) },
    categories: cats.items,
    largestTransactions: largest,
    budgets: {
      items: budgets.items,
      over: over.length,
      near: budgets.items.filter((b) => b.status === "near").length,
      under: budgets.items.filter((b) => b.status === "under").length,
    },
    recurring,
    goals: { total: goalTotal, items: goalItems },
    notableChanges: notable,
    noSpendDays: { count: noSpend.length, days: noSpend, ofDays: elapsed.length },
    topMerchants: merchants.rows,
    facts,
  };
}

/** Actual spending in the range on transactions posted from recurring items, by item. */
async function recurringInMonth(userId: string, range: DateRange) {
  const rows = await db.execute<{ id: string; name: string; kind: string; amount: string; cnt: number }>(sql`
    SELECT rt.id, rt.name, rt.kind::text AS kind,
           SUM(CASE WHEN t.type = 'expense' THEN t.base_amount ELSE -t.base_amount END)::text AS amount,
           COUNT(*) FILTER (WHERE t.type = 'expense')::int AS cnt
      FROM transactions t JOIN recurring_transactions rt ON rt.id = t.recurring_id AND rt.user_id = ${userId}
     WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.type IN ('expense', 'refund')
       AND t.date >= ${range.from} AND t.date <= ${range.to}
     GROUP BY rt.id, rt.name, rt.kind
     ORDER BY 4 DESC`);
  const items = rows.map((r) => ({ recurringId: r.id, name: r.name, kind: r.kind, amount: normalize(r.amount), count: Number(r.cnt) }));
  const kinds = new Map<string, { amount: string; count: number }>();
  for (const i of items) {
    const k = kinds.get(i.kind) ?? { amount: "0", count: 0 };
    kinds.set(i.kind, { amount: add(k.amount, i.amount), count: k.count + i.count });
  }
  return {
    total: add(...items.map((i) => i.amount)),
    byKind: [...kinds.entries()].map(([kind, v]) => ({ kind, amount: normalize(v.amount), count: v.count })).sort((a, b) => cmp(b.amount, a.amount)),
    items,
  };
}

/** Months (YYYY-MM, newest first) that have any transactions — for the month picker. */
export async function reviewableMonths(userId: string, limit = 36): Promise<string[]> {
  const ctx = await analyticsCtx(userId);
  const [row] = await db.execute<{ first: string | null }>(sql`
    SELECT min(date)::text AS first FROM transactions WHERE user_id = ${userId} AND deleted_at IS NULL`);
  const current = monthRange(ctx.today, ctx.monthStartDay).from.slice(0, 7);
  const first = row?.first ? monthRange(row.first, ctx.monthStartDay).from.slice(0, 7) : current;
  const out: string[] = [];
  let m = current;
  while (m >= first && out.length < limit) {
    out.push(m);
    m = addMonthsISO(`${m}-01`, -1).slice(0, 7);
  }
  return out;
}
