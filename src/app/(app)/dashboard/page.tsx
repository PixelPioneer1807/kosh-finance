import type { Metadata } from "next";
import { count, eq, and, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import { transactions, budgets as budgetsTable, recurringTransactions } from "@/server/db/schema";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { recentTransactions } from "@/server/services/transactions";
import { analyticsCtx, cumulativeSpending, periodSummary, spendingByCategory } from "@/server/services/analytics";
import { safeToSpend } from "@/server/services/forecast";
import { listBudgetsWithProgress } from "@/server/services/budgets";
import { upcomingOccurrences } from "@/server/services/recurring";
import { listGoalsWithProgress } from "@/server/services/goals";
import { netWorthHistory, netWorthSummary } from "@/server/services/networth";
import { computeInsights } from "@/server/services/insights";
import { aiConfigured } from "@/server/ai/groq";
import { addDaysISO, resolveRange } from "@/lib/dates";
import { DashboardView, type DashboardData } from "./dashboard-view";

export const metadata: Metadata = { title: "Dashboard" };

/** Runs a widget loader; a failing widget shows an error state instead of breaking the dashboard. */
async function safe<T>(id: string, fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    console.error(`[dashboard] widget "${id}" failed`, e);
    return { ok: false };
  }
}

export default async function DashboardPage() {
  const { user } = await requireUserPage();
  const userId = user.id;
  const prefs = await getPreferences(userId);
  const visible = new Set(prefs.dashboardWidgets.filter((w) => w.visible).map((w) => w.id));
  const range = resolveRange(prefs.defaultDateRange, prefs.today, { weekStartsOn: prefs.weekStartsOn, monthStartDay: prefs.monthStartDay });
  const ctx = await analyticsCtx(userId);
  const want = (id: string) => visible.has(id);
  const none = Promise.resolve(undefined);

  const [snapshot, safeSpend, insights, budgets, trend, categories, upcoming, recent, goals, netWorth, setup] = await Promise.all([
    want("snapshot") ? safe("snapshot", () => periodSummary(userId, range, { compare: true, ctx })) : none,
    want("safe_to_spend") ? safe("safe_to_spend", () => safeToSpend(userId)) : none,
    want("insights") ? safe("insights", () => computeInsights(userId)) : none,
    want("budgets") ? safe("budgets", () => listBudgetsWithProgress(userId)) : none,
    want("spending_trend") ? safe("spending_trend", () => cumulativeSpending(userId, { ctx })) : none,
    want("categories") ? safe("categories", () => spendingByCategory(userId, range, { parentLevel: true, ctx })) : none,
    want("upcoming") ? safe("upcoming", () => upcomingOccurrences(userId, addDaysISO(prefs.today, -14), addDaysISO(prefs.today, 14))) : none,
    want("recent") ? safe("recent", () => recentTransactions(userId, 7)) : none,
    want("goals") ? safe("goals", () => listGoalsWithProgress(userId)) : none,
    want("net_worth") ? safe("net_worth", async () => ({ summary: await netWorthSummary(userId), history: await netWorthHistory(userId, 12) })) : none,
    // Getting-started checklist for new users.
    Promise.all([
      db.select({ n: count() }).from(transactions).where(and(eq(transactions.userId, userId), isNull(transactions.deletedAt))),
      db.select({ n: count() }).from(budgetsTable).where(eq(budgetsTable.userId, userId)),
      db.select({ n: count() }).from(recurringTransactions).where(eq(recurringTransactions.userId, userId)),
    ]).then(([t, b, r]) => ({ transactions: t[0].n, budgets: b[0].n, recurring: r[0].n })),
  ]);

  const data: DashboardData = {
    order: prefs.dashboardWidgets.filter((w) => w.visible).map((w) => w.id),
    rangeLabel: range.preset,
    snapshot,
    safeSpend,
    insights,
    budgets,
    trend,
    categories,
    upcoming,
    recent,
    goals,
    netWorth,
    aiAvailable: prefs.aiEnabled && prefs.aiInsightsEnabled && aiConfigured(),
    setup,
  };
  return <DashboardView name={user.name} data={data} />;
}
