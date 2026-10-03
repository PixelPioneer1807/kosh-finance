import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { goalContributions, goals } from "@/server/db/schema";
import { createTransaction } from "@/server/services/transactions";
import { createAccount } from "@/server/services/accounts";
import { createRecurring } from "@/server/services/recurring";
import { getPreferences, upsertExchangeRate } from "@/server/services/preferences";
import { cashFlowForecast, discretionaryDailyAverage, safeToSpend } from "@/server/services/forecast";
import { calendarMonth } from "@/server/services/calendar";
import { addDaysISO, monthRange, toDate } from "@/lib/dates";
import { category, makeAccount, makeUser } from "./helpers";

async function setup() {
  const u = await makeUser();
  const { today } = await getPreferences(u.id);
  const checking = await makeAccount(u.id, { name: "Checking", openingBalance: "2000" });
  const savings = await makeAccount(u.id, { name: "Savings", type: "savings", openingBalance: "1000" });
  const invest = await makeAccount(u.id, { name: "Brokerage", type: "investment", openingBalance: "0" });
  await upsertExchangeRate(u.id, "EUR", "1.1");
  await makeAccount(u.id, { name: "Euro wallet", type: "wallet", currency: "EUR", openingBalance: "100" }); // 110 in base
  const cardDue = addDaysISO(today, 5);
  await createAccount(u.id, { name: "Visa", type: "credit_card", currency: "USD", openingBalance: "300", dueDay: toDate(cardDue).getDate() });
  const groceries = await category(u.id, "Groceries");
  // Discretionary history: 90 spent ten days ago → 9/day over 10 days of history.
  await createTransaction(u.id, { type: "expense", accountId: checking.id, amount: "90", date: addDaysISO(today, -10), categoryId: groceries.id });

  await createRecurring(u.id, { kind: "income", name: "Salary", amount: "3000", accountId: checking.id, frequency: "monthly", startDate: addDaysISO(today, 10) });
  await createRecurring(u.id, { kind: "bill", name: "Rent", amount: "1200", accountId: checking.id, frequency: "monthly", startDate: addDaysISO(today, 3) });
  await createRecurring(u.id, { kind: "subscription", name: "Music", amount: "10", accountId: checking.id, frequency: "monthly", startDate: addDaysISO(today, 15) });
  await createRecurring(u.id, { kind: "transfer", name: "Invest", amount: "100", accountId: checking.id, toAccountId: invest.id, frequency: "monthly", startDate: addDaysISO(today, 2) });
  await createRecurring(u.id, { kind: "transfer", name: "To savings", amount: "50", accountId: checking.id, toAccountId: savings.id, frequency: "monthly", startDate: addDaysISO(today, 4) });
  return { u, today, checking, savings };
}

describe("cash-flow forecast", () => {
  it("projects balances from liquid accounts, schedules and average discretionary spend — labelled as a forecast", async () => {
    const { u, today } = await setup();
    const v = await discretionaryDailyAverage(u.id, today);
    expect(v.daily).toBe("9.0000");

    const f = await cashFlowForecast(u.id, 30);
    expect(f.kind).toBe("forecast");
    expect(f.method.length).toBeGreaterThan(3);
    expect(f.method.join(" ")).toMatch(/projection/i);
    expect(f.startingBalance).toBe("3020.0000"); // 1910 + 1000 + 110 (EUR)
    expect(f.points).toHaveLength(31);
    expect(f.points[0].date).toBe(today);

    const items = f.items.map((i) => [i.name, i.kind, i.amount, i.date]);
    expect(items).toContainEqual(["Salary", "income", "3000.0000", addDaysISO(today, 10)]);
    expect(items).toContainEqual(["Rent", "bill", "-1200.0000", addDaysISO(today, 3)]);
    expect(items).toContainEqual(["Music", "subscription", "-10.0000", addDaysISO(today, 15)]);
    expect(items).toContainEqual(["Invest", "transfer", "-100.0000", addDaysISO(today, 2)]);
    expect(items).toContainEqual(["Visa payment", "card_due", "-300.0000", addDaysISO(today, 5)]);
    expect(items.find((i) => i[0] === "To savings")).toBeUndefined(); // liquid → liquid is neutral

    expect(f.totals.scheduledIncome).toBe("3000.0000");
    expect(f.totals.scheduledExpenses).toBe("1610.0000");
    expect(f.totals.variableSpending).toBe("270.0000");
    expect(f.totals.projectedExpenses).toBe("1880.0000");
    expect(f.totals.projectedSavings).toBe("1120.0000");
    expect(f.totals.endingBalance).toBe("4140.0000");
    expect(f.points.at(-1)!.balance).toBe("4140.0000");
    // Lowest point is just before payday: 3020 − 100 − 1200 − 300 − 9×9
    expect(f.totals.lowestBalance).toBe("1339.0000");
    expect(f.totals.lowestBalanceDate).toBe(addDaysISO(today, 9));
    expect(f.shortfallDate).toBeNull();
  });

  it("flags a shortfall", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const acc = await makeAccount(u.id, { openingBalance: "100" });
    await createRecurring(u.id, { kind: "bill", name: "Insurance", amount: "500", accountId: acc.id, frequency: "yearly", startDate: addDaysISO(today, 7) });
    const f = await cashFlowForecast(u.id, 60);
    expect(f.days).toBe(60);
    expect(f.shortfallDate).toBe(addDaysISO(today, 7));
    expect(f.totals.endingBalance).toBe("-400.0000");
  });
});

describe("safe to spend", () => {
  it("subtracts bills due before payday and remaining goal contributions; gives a per-day allowance", async () => {
    const { u, today } = await setup();
    const [goal] = await db.insert(goals).values({ userId: u.id, name: "Emergency fund", targetAmount: "5000", currency: "USD", contributionFrequency: "monthly", targetContribution: "200" }).returning();
    await db.insert(goalContributions).values({ userId: u.id, goalId: goal.id, amount: "50", date: today });

    const s = await safeToSpend(u.id);
    expect(s.kind).toBe("calculation");
    expect(s.basis).toBe("next_income");
    expect(s.nextIncome).toMatchObject({ name: "Salary", date: addDaysISO(today, 10) });
    expect(s.windowEnd).toBe(addDaysISO(today, 9));
    expect(s.daysRemaining).toBe(10);
    // 3020 − Rent 1200 − Invest 100 − Visa 300 − goal 150 (Music is after payday)
    expect(s.amount).toBe("1270.0000");
    expect(s.perDay).toBe("127.0000");
    const keys = Object.fromEntries(s.breakdown.map((b) => [b.key, b.amount]));
    expect(keys).toEqual({ balance: "3020.0000", bills: "-1200.0000", transfers: "-100.0000", cards: "-300.0000", goals: "-150.0000" });
    expect(s.breakdown.find((b) => b.key === "bills")!.items.map((i) => i.label)).toEqual(["Rent"]);
  });

  it("falls back to the end of the month without an income schedule", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const acc = await makeAccount(u.id, { openingBalance: "600" });
    const end = monthRange(today).to;
    await createRecurring(u.id, { kind: "bill", name: "Phone", amount: "40", accountId: acc.id, frequency: "monthly", startDate: end });
    const s = await safeToSpend(u.id);
    expect(s.basis).toBe("month_end");
    expect(s.nextIncome).toBeNull();
    expect(s.windowEnd).toBe(end);
    expect(s.amount).toBe("560.0000");
    expect(s.daysRemaining).toBe(Math.round((toDate(end).getTime() - toDate(today).getTime()) / 86_400_000) + 1);
  });

  it("is isolated per user", async () => {
    const { u } = await setup();
    const other = await makeUser();
    await makeAccount(other.id, { openingBalance: "75" });
    const s = await safeToSpend(other.id);
    expect(s.amount).toBe("75.0000");
    expect(s.breakdown.map((b) => b.key)).toEqual(["balance"]);
    const f = await cashFlowForecast(other.id, 30);
    expect(f.items).toHaveLength(0);
    expect(f.startingBalance).toBe("75.0000");
    expect(f.dailyVariableSpend).toBe("0.0000");
    // The first user's goals/schedules didn't change
    expect((await cashFlowForecast(u.id, 30)).totals.endingBalance).toBe("4140.0000");
  });
});

describe("calendar", () => {
  it("shows actual daily totals and scheduled items with forecast balances; owner-only", async () => {
    const { u, today } = await setup();
    const rentDay = addDaysISO(today, 3);
    const c = await calendarMonth(u.id, rentDay.slice(0, 7));
    const rent = c.scheduled.find((i) => i.name === "Rent" && i.date === rentDay)!;
    expect(rent).toMatchObject({ kind: "bill", amount: "-1200.0000", status: "upcoming" });
    expect(c.scheduled.some((i) => i.kind === "card_due")).toBe(true);
    expect(c.projected?.[rentDay]).toBeDefined();
    expect(c.days.length % 7).toBe(0);

    const spentDay = addDaysISO(today, -10);
    const past = await calendarMonth(u.id, spentDay.slice(0, 7));
    const d = past.days.find((x) => x.date === spentDay)!;
    expect(d).toMatchObject({ spending: "90.0000", count: 1 });
    expect(past.transactions[spentDay]).toHaveLength(1);

    const other = await makeUser();
    const oc = await calendarMonth(other.id, spentDay.slice(0, 7));
    expect(oc.scheduled).toHaveLength(0);
    expect(Object.keys(oc.transactions)).toHaveLength(0);
    await expect(calendarMonth(u.id, "2026-13")).rejects.toThrow(/YYYY-MM/);
  });
});
