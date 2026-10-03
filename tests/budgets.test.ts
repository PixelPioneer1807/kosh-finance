import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { budgetAlertEvents, budgets } from "@/server/db/schema";
import {
  budgetHistory,
  createBudget,
  currentPeriod,
  deleteBudget,
  generateBudgetAlerts,
  getBudget,
  getBudgetProgress,
  listBudgetsWithProgress,
  setBudgetArchived,
  updateBudget,
} from "@/server/services/budgets";
import { createTransaction, deleteTransaction, refundTransaction } from "@/server/services/transactions";
import { updateCategory } from "@/server/services/taxonomy";
import { listNotifications } from "@/server/services/notifications";
import { updateNotificationPreferences, updatePreferences } from "@/server/services/preferences";
import { category, makeAccount, makeUser } from "./helpers";

const expense = (userId: string, accountId: string, amount: string, date: string, categoryId: string | null = null) =>
  createTransaction(userId, { type: "expense", accountId, amount, date, categoryId });

describe("budget periods", () => {
  it("honours week start and month start day", () => {
    const prefs = { weekStartsOn: 1 as const, monthStartDay: 1 };
    expect(currentPeriod({ period: "monthly", startDate: null, endDate: null }, prefs, "2026-03-10")).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(currentPeriod({ period: "monthly", startDate: null, endDate: null }, { ...prefs, monthStartDay: 25 }, "2026-03-10")).toEqual({ from: "2026-02-25", to: "2026-03-24" });
    expect(currentPeriod({ period: "weekly", startDate: null, endDate: null }, prefs, "2026-03-11")).toEqual({ from: "2026-03-09", to: "2026-03-15" });
    expect(currentPeriod({ period: "weekly", startDate: null, endDate: null }, { ...prefs, weekStartsOn: 0 }, "2026-03-11")).toEqual({ from: "2026-03-08", to: "2026-03-14" });
    expect(currentPeriod({ period: "yearly", startDate: null, endDate: null }, prefs, "2026-03-11")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(currentPeriod({ period: "custom", startDate: "2026-06-01", endDate: "2026-06-20" }, prefs, "2026-03-11")).toEqual({ from: "2026-06-01", to: "2026-06-20" });
  });
});

describe("budgets", () => {
  it("counts expenses − refunds with splits and subcategories; ignores transfers, deleted and other periods", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "5000" });
    const savings = await makeAccount(u.id, { name: "Savings", type: "savings", openingBalance: "0" });
    const food = await category(u.id, "Food & Dining");
    const groceries = await category(u.id, "Groceries");
    const restaurants = await category(u.id, "Restaurants");
    const housing = await category(u.id, "Housing");

    const g = await expense(u.id, acc.id, "100", "2026-03-03", groceries.id);
    await expense(u.id, acc.id, "50", "2026-03-04", restaurants.id);
    await expense(u.id, acc.id, "10", "2026-03-05", food.id);
    await createTransaction(u.id, {
      type: "expense",
      accountId: acc.id,
      amount: "80",
      date: "2026-03-06",
      splits: [
        { categoryId: groceries.id, amount: "30" },
        { categoryId: housing.id, amount: "50" },
      ],
    });
    await refundTransaction(u.id, g.id, { amount: "20", date: "2026-03-07" });
    await createTransaction(u.id, { type: "transfer", accountId: acc.id, toAccountId: savings.id, amount: "500", date: "2026-03-08" });
    await expense(u.id, acc.id, "999", "2026-02-27", groceries.id); // previous month
    const del = await expense(u.id, acc.id, "77", "2026-03-09", groceries.id);
    await deleteTransaction(u.id, del.id);

    const withSubs = await createBudget(u.id, { categoryId: food.id, amount: "500" });
    expect(withSubs.name).toBe("Food & Dining");
    expect(withSubs.currency).toBe("USD");
    expect(withSubs.alertThresholds).toEqual([50, 75, 90, 100]);
    const directOnly = await createBudget(u.id, { name: "Food (direct)", categoryId: food.id, includeSubcategories: false, amount: "500" });
    const groceriesOnly = await createBudget(u.id, { categoryId: groceries.id, amount: "500" });

    const list = await listBudgetsWithProgress(u.id, "2026-03-15");
    const byId = new Map(list.map((b) => [b.id, b]));
    expect(byId.get(withSubs.id)!.spent).toBe("170.0000"); // 100 + 50 + 10 + 30 (split) − 20 (refund)
    expect(byId.get(directOnly.id)!.spent).toBe("10.0000");
    expect(byId.get(groceriesOnly.id)!.spent).toBe("110.0000");
    expect(byId.get(withSubs.id)!.periodRange).toEqual({ from: "2026-03-01", to: "2026-03-31" });
  });

  it("overall budgets include uncategorised spending but skip excluded categories, transfers and adjustments", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "5000" });
    const card = await makeAccount(u.id, { name: "Card", type: "credit_card", openingBalance: "0" });
    const fees = await category(u.id, "Fees & charges");
    const travel = await category(u.id, "Travel");
    await updateCategory(u.id, travel.id, { excludeFromReports: true });
    await expense(u.id, acc.id, "40", "2026-03-02", fees.id);
    await expense(u.id, acc.id, "25", "2026-03-02", null);
    await expense(u.id, acc.id, "300", "2026-03-03", travel.id);
    await createTransaction(u.id, { type: "transfer", accountId: acc.id, toAccountId: card.id, amount: "200", date: "2026-03-04" });
    await createTransaction(u.id, { type: "adjustment", accountId: acc.id, amount: "-50", date: "2026-03-04" });
    const overall = await createBudget(u.id, { categoryId: null, amount: "1000" });
    expect(overall.name).toBe("Overall spending");
    const p = await getBudgetProgress(u.id, overall.id, "2026-03-20");
    expect(p.spent).toBe("65.0000");
    // Explicitly budgeting the excluded category still counts it.
    const t = await createBudget(u.id, { categoryId: travel.id, amount: "500" });
    expect((await getBudgetProgress(u.id, t.id, "2026-03-20")).spent).toBe("300.0000");
  });

  it("projects spend linearly, computes daily allowance and status", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "5000" });
    const food = await category(u.id, "Groceries");
    const b = await createBudget(u.id, { categoryId: food.id, amount: "300" });
    await expense(u.id, acc.id, "150", "2026-03-01", food.id);

    const mid = await getBudgetProgress(u.id, b.id, "2026-03-10");
    expect(mid.elapsedDays).toBe(10);
    expect(mid.totalDays).toBe(31);
    expect(mid.daysLeft).toBe(22);
    expect(mid.pct).toBe(0.5);
    expect(mid.projected).toBe("465.0000"); // 150 / 10 × 31
    expect(mid.projectionReliable).toBe(true);
    expect(mid.status).toBe("projected_over");
    expect(mid.remaining).toBe("150.0000");
    expect(mid.dailyAllowance).toBe("6.8182"); // 150 / 22
    expect(mid.expectedByToday).toBe("96.7742"); // 300 × 10 / 31

    // Too early for the pace to mean anything → no projected status.
    const early = await getBudgetProgress(u.id, b.id, "2026-03-02");
    expect(early.projectionReliable).toBe(false);
    expect(early.status).toBe("ok");

    // Late in the month the same spending is on track.
    expect((await getBudgetProgress(u.id, b.id, "2026-03-28")).status).toBe("ok");

    await expense(u.id, acc.id, "100", "2026-03-11", food.id);
    expect((await getBudgetProgress(u.id, b.id, "2026-03-28")).status).toBe("warning");
    await expense(u.id, acc.id, "60", "2026-03-12", food.id);
    const over = await getBudgetProgress(u.id, b.id, "2026-03-28");
    expect(over.status).toBe("over");
    expect(over.remaining).toBe("-10.0000");
    expect(over.dailyAllowance).toBe("0.0000");
  });

  it("uses the user's month start day", async () => {
    const u = await makeUser();
    await updatePreferences(u.id, { monthStartDay: 25 });
    const acc = await makeAccount(u.id);
    const food = await category(u.id, "Groceries");
    await expense(u.id, acc.id, "10", "2026-02-24", food.id);
    await expense(u.id, acc.id, "20", "2026-02-25", food.id);
    await expense(u.id, acc.id, "30", "2026-03-24", food.id);
    await expense(u.id, acc.id, "40", "2026-03-25", food.id);
    const b = await createBudget(u.id, { categoryId: food.id, amount: "500" });
    const p = await getBudgetProgress(u.id, b.id, "2026-03-10");
    expect(p.periodRange).toEqual({ from: "2026-02-25", to: "2026-03-24" });
    expect(p.spent).toBe("50.0000");
  });

  it("rolls over the previous period's surplus or overspend", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "5000" });
    const food = await category(u.id, "Groceries");
    const b = await createBudget(u.id, { categoryId: food.id, amount: "300", rollover: true });
    await db.update(budgets).set({ startDate: "2026-01-01" }).where(eq(budgets.id, b.id));
    await expense(u.id, acc.id, "200", "2026-02-10", food.id);
    await expense(u.id, acc.id, "50", "2026-03-02", food.id);
    const p = await getBudgetProgress(u.id, b.id, "2026-03-15");
    expect(p.rolloverAmount).toBe("100.0000");
    expect(p.available).toBe("400.0000");
    expect(p.remaining).toBe("350.0000");

    await expense(u.id, acc.id, "250", "2026-02-11", food.id); // Feb now 450 → −150
    expect((await getBudgetProgress(u.id, b.id, "2026-03-15")).rolloverAmount).toBe("-150.0000");

    // No rollover from before the budget existed.
    await db.update(budgets).set({ startDate: "2026-03-01" }).where(eq(budgets.id, b.id));
    expect((await getBudgetProgress(u.id, b.id, "2026-03-15")).rolloverAmount).toBe("0.0000");
  });

  it("returns spending history per period", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "5000" });
    const food = await category(u.id, "Groceries");
    const b = await createBudget(u.id, { categoryId: food.id, amount: "300" });
    await expense(u.id, acc.id, "10", "2025-10-15", food.id);
    await expense(u.id, acc.id, "20", "2026-01-31", food.id);
    await expense(u.id, acc.id, "30", "2026-03-01", food.id);
    const h = await budgetHistory(u.id, b.id, 6, "2026-03-15");
    expect(h).toHaveLength(6);
    expect(h[0]).toMatchObject({ from: "2025-10-01", to: "2025-10-31", spent: "10.0000", current: false });
    expect(h.map((x) => x.spent)).toEqual(["10.0000", "0.0000", "0.0000", "20.0000", "0.0000", "30.0000"]);
    expect(h[5].current).toBe(true);
    const custom = await createBudget(u.id, { name: "Trip", period: "custom", startDate: "2026-03-01", endDate: "2026-03-10", amount: "100" });
    expect(await budgetHistory(u.id, custom.id, 6, "2026-03-05")).toHaveLength(1);
  });

  it("validates input", async () => {
    const u = await makeUser();
    const salary = await category(u.id, "Salary");
    await expect(createBudget(u.id, { categoryId: salary.id, amount: "100" })).rejects.toThrow(/expense category/);
    await expect(createBudget(u.id, { period: "custom", amount: "100" })).rejects.toThrow();
    await expect(createBudget(u.id, { amount: "0" })).rejects.toThrow();
    await expect(createBudget(u.id, { amount: "10", alertThresholds: [0] })).rejects.toThrow();
    await expect(createBudget(u.id, { amount: "10", currency: "EUR" })).rejects.toThrow(/base currency/);
    const b = await createBudget(u.id, { amount: "10", alertThresholds: [100, 80, 80, 120] });
    expect(b.alertThresholds).toEqual([80, 100, 120]);
    const updated = await updateBudget(u.id, b.id, { amount: "20", name: "Everything" });
    expect(updated.amount).toBe("20.0000");
    await setBudgetArchived(u.id, b.id, true);
    expect((await listBudgetsWithProgress(u.id)).map((x) => x.id)).not.toContain(b.id);
    await deleteBudget(u.id, b.id);
    await expect(getBudget(u.id, b.id)).rejects.toThrow(/not found/);
  });
});

describe("budget alerts", () => {
  it("fires each threshold once per period and only notifies the highest new one", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "5000" });
    const food = await category(u.id, "Groceries");
    const b = await createBudget(u.id, { categoryId: food.id, amount: "100", alertOnProjected: false });
    await expense(u.id, acc.id, "95", "2026-03-02", food.id);

    const first = await generateBudgetAlerts(u.id, "2026-03-20");
    expect(first).toEqual({ recorded: 3, notified: 1 });
    let notes = (await listNotifications(u.id)).filter((n) => n.type === "budget");
    expect(notes).toHaveLength(1);
    expect(notes[0].dedupeKey).toBe(`budget:${b.id}:2026-03-01:90`);
    expect(notes[0].link).toBe("/budgets");

    expect(await generateBudgetAlerts(u.id, "2026-03-21")).toEqual({ recorded: 0, notified: 0 });

    await expense(u.id, acc.id, "10", "2026-03-21", food.id);
    expect(await generateBudgetAlerts(u.id, "2026-03-22")).toEqual({ recorded: 1, notified: 1 });
    notes = (await listNotifications(u.id)).filter((n) => n.type === "budget");
    expect(notes.map((n) => n.title)).toContain("Groceries is over budget");

    // A new period starts fresh.
    await expense(u.id, acc.id, "60", "2026-04-02", food.id);
    expect(await generateBudgetAlerts(u.id, "2026-04-20")).toEqual({ recorded: 1, notified: 1 });
    const events = await db.select().from(budgetAlertEvents).where(and(eq(budgetAlertEvents.budgetId, b.id), eq(budgetAlertEvents.periodStart, "2026-04-01")));
    expect(events.map((e) => e.threshold)).toEqual([50]);
  });

  it("alerts on projected overspend and respects notification preferences", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "5000" });
    const food = await category(u.id, "Groceries");
    const b = await createBudget(u.id, { categoryId: food.id, amount: "300", alertThresholds: [100] });
    await expense(u.id, acc.id, "150", "2026-03-01", food.id);
    expect(await generateBudgetAlerts(u.id, "2026-03-10")).toEqual({ recorded: 1, notified: 1 });
    const n = (await listNotifications(u.id)).find((x) => x.dedupeKey === `budget:${b.id}:2026-03-01:-1`);
    expect(n?.title).toMatch(/on pace/);

    await updateNotificationPreferences(u.id, { budgetAlerts: false });
    await expense(u.id, acc.id, "200", "2026-03-11", food.id);
    expect(await generateBudgetAlerts(u.id, "2026-03-12")).toEqual({ recorded: 1, notified: 0 });

    // Alerts off on the budget → nothing recorded.
    const quiet = await createBudget(u.id, { categoryId: food.id, amount: "10", alertsEnabled: false });
    await generateBudgetAlerts(u.id, "2026-03-12");
    expect(await db.select().from(budgetAlertEvents).where(eq(budgetAlertEvents.budgetId, quiet.id))).toHaveLength(0);
  });
});

describe("budget isolation", () => {
  it("user B can't read, modify or reference user A's budgets and categories", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const accA = await makeAccount(a.id, { openingBalance: "5000" });
    const foodA = await category(a.id, "Groceries");
    const budgetA = await createBudget(a.id, { categoryId: foodA.id, amount: "100" });
    await expense(a.id, accA.id, "50", "2026-03-02", foodA.id);

    await expect(getBudget(b.id, budgetA.id)).rejects.toThrow(/not found/);
    await expect(getBudgetProgress(b.id, budgetA.id)).rejects.toThrow(/not found/);
    await expect(budgetHistory(b.id, budgetA.id)).rejects.toThrow(/not found/);
    await expect(updateBudget(b.id, budgetA.id, { amount: "1" })).rejects.toThrow(/not found/);
    await expect(setBudgetArchived(b.id, budgetA.id, true)).rejects.toThrow(/not found/);
    await expect(deleteBudget(b.id, budgetA.id)).rejects.toThrow(/not found/);
    await expect(createBudget(b.id, { categoryId: foodA.id, amount: "100" })).rejects.toThrow(/not found/);
    expect(await listBudgetsWithProgress(b.id, "2026-03-10")).toEqual([]);

    // B's overall budget never sees A's spending.
    const overallB = await createBudget(b.id, { amount: "100" });
    expect((await getBudgetProgress(b.id, overallB.id, "2026-03-10")).spent).toBe("0.0000");
    expect((await getBudget(a.id, budgetA.id)).amount).toBe("100.0000");
  });
});
