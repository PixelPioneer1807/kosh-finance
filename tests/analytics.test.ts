import { beforeAll, describe, expect, it } from "vitest";
import Papa from "papaparse";
import { db } from "@/server/db";
import { budgets, goalContributions, goals } from "@/server/db/schema";
import { createTransaction, deleteTransaction, refundTransaction } from "@/server/services/transactions";
import { createCategory } from "@/server/services/taxonomy";
import { getPreferences, upsertExchangeRate } from "@/server/services/preferences";
import { createRecurring, postOccurrence } from "@/server/services/recurring";
import { listPaymentMethods } from "@/server/services/taxonomy";
import {
  byAccount,
  byPaymentMethod,
  categoryTrends,
  cumulativeSpending,
  dailyBreakdown,
  incomeBySource,
  largestTransactions,
  merchantDetail,
  merchantStats,
  periodSummary,
  recurringVsDiscretionary,
  spendingByCategory,
  timeSeries,
} from "@/server/services/analytics";
import { monthlyReview, reviewableMonths } from "@/server/services/review";
import { buildReport, REPORT_TYPES } from "@/server/services/reports";
import { reportToCsv, transactionCsvChunks, transactionFiltersFromParams } from "@/server/services/exports";
import { csvCell, csvRow, roundDecimal } from "@/lib/csv";
import { addDaysISO, addMonthsISO, monthRange } from "@/lib/dates";
import { category, makeAccount, makeUser } from "./helpers";

const SEPT = { from: "2026-09-01", to: "2026-09-30" };

let A: Awaited<ReturnType<typeof makeUser>>;
let B: Awaited<ReturnType<typeof makeUser>>;
let freshId: string;

beforeAll(async () => {
  A = await makeUser();
  const checking = await makeAccount(A.id, { name: "Checking", openingBalance: "5000" });
  const card = await makeAccount(A.id, { name: "Card", type: "credit_card", openingBalance: "0" });
  const eur = await makeAccount(A.id, { name: "Euro", currency: "EUR", openingBalance: "0" });
  await upsertExchangeRate(A.id, "EUR", "1.1");
  const groceries = await category(A.id, "Groceries");
  const household = await category(A.id, "Household");
  const other = await category(A.id, "Other");
  const salary = await category(A.id, "Salary");
  const reimb = await createCategory(A.id, { name: "Reimbursable", kind: "expense", excludeFromReports: true });
  const cash = (await listPaymentMethods(A.id)).find((p) => p.name === "Cash")!;

  // Previous month
  const aug = await createTransaction(A.id, { type: "expense", accountId: checking.id, amount: "50", date: "2026-08-10", categoryId: groceries.id, merchant: "FreshMart" });
  freshId = aug.merchantId!;
  // September
  await createTransaction(A.id, { type: "income", accountId: checking.id, amount: "3000", date: "2026-09-01", categoryId: salary.id, merchant: "Employer" });
  const e1 = await createTransaction(A.id, {
    type: "expense", accountId: checking.id, amount: "100", date: "2026-09-05", categoryId: groceries.id, merchant: "FreshMart",
    paymentMethodId: cash.id, notes: "=cmd|' /C calc'!A0",
  });
  await createTransaction(A.id, {
    type: "expense", accountId: checking.id, amount: "100", date: "2026-09-06", merchant: "MegaStore",
    splits: [{ categoryId: groceries.id, amount: "60" }, { categoryId: household.id, amount: "40" }],
  });
  await refundTransaction(A.id, e1.id, { amount: "30", date: "2026-09-08" });
  await createTransaction(A.id, { type: "transfer", accountId: checking.id, toAccountId: card.id, amount: "500", date: "2026-09-10" });
  await createTransaction(A.id, { type: "adjustment", accountId: checking.id, amount: "25", date: "2026-09-11" });
  await createTransaction(A.id, { type: "expense", accountId: eur.id, amount: "10", date: "2026-09-12", categoryId: other.id });
  await createTransaction(A.id, { type: "expense", accountId: checking.id, amount: "200", date: "2026-09-13", categoryId: reimb.id });
  const del = await createTransaction(A.id, { type: "expense", accountId: checking.id, amount: "999", date: "2026-09-14", categoryId: groceries.id });
  await deleteTransaction(A.id, del.id);

  // Planning data read by the review
  const food = await category(A.id, "Food & Dining");
  await db.insert(budgets).values([
    { userId: A.id, name: "Food", period: "monthly", categoryId: food.id, amount: "120", currency: "USD" },
    { userId: A.id, name: "Everything", period: "monthly", categoryId: null, amount: "1000", currency: "USD" },
  ]);
  const [goal] = await db.insert(goals).values({ userId: A.id, name: "Holiday", targetAmount: "2000", currency: "USD" }).returning();
  await db.insert(goalContributions).values({ userId: A.id, goalId: goal.id, amount: "100", date: "2026-09-15" });

  // User B — same merchant name, same month; must never leak into A's numbers.
  B = await makeUser();
  const bAcc = await makeAccount(B.id, { openingBalance: "100" });
  await createTransaction(B.id, { type: "expense", accountId: bAcc.id, amount: "999", date: "2026-09-05", categoryId: (await category(B.id, "Groceries")).id, merchant: "FreshMart" });
});

describe("period summary", () => {
  it("totals income, spending (expenses − refunds) across splits and currencies; skips transfers, adjustments, excluded and deleted", async () => {
    const s = await periodSummary(A.id, SEPT);
    expect(s.income).toBe("3000.0000");
    expect(s.expenses).toBe("211.0000"); // 100 + 100 (split) + 11 (EUR 10 × 1.1)
    expect(s.refunds).toBe("30.0000");
    expect(s.spending).toBe("181.0000");
    expect(s.net).toBe("2819.0000");
    expect(s.savingsRate).toBeCloseTo(2819 / 3000, 5);
    expect(s.txCount).toBe(5);
    expect(s.days).toBe(30);
    expect(s.avgDailySpend).toBe("6.0333");
    expect(s.previous?.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(s.previous?.spending).toBe("50.0000");
    expect(s.deltas?.spending.change).toBe("131.0000");
    expect(s.deltas?.spending.pct).toBeCloseTo(2.62, 5);
    expect(s.deltas?.income.pct).toBeNull(); // no income last month
  });

  it("bounds all-time ranges to the data", async () => {
    const s = await periodSummary(A.id, { from: "1970-01-01", to: "2999-12-31" });
    expect(s.range.from).toBe("2026-08-10");
    expect(s.spending).toBe("231.0000");
    expect(s.previous).toBeNull();
  });
});

describe("categories", () => {
  it("rolls splits and refunds up to parents with a children breakdown", async () => {
    const c = await spendingByCategory(A.id, SEPT);
    expect(c.total).toBe("181.0000");
    const names = c.items.map((i) => [i.name, i.amount]);
    expect(names).toEqual([
      ["Food & Dining", "130.0000"],
      ["Shopping", "40.0000"],
      ["Other", "11.0000"],
    ]);
    const food = c.items[0];
    expect(food.children.map((x) => [x.name, x.amount])).toEqual([["Groceries", "130.0000"]]);
    expect(food.previous).toBe("50.0000");
    expect(food.delta.change).toBe("80.0000");
    expect(food.share).toBeCloseTo(130 / 181, 5);
    expect(c.items.find((i) => i.name === "Reimbursable")).toBeUndefined();
  });

  it("leaf level and income sources", async () => {
    const leaf = await spendingByCategory(A.id, SEPT, { parentLevel: false });
    expect(leaf.items.map((i) => i.name)).toEqual(["Groceries", "Household", "Other"]);
    const inc = await incomeBySource(A.id, SEPT);
    expect(inc.items.map((i) => [i.name, i.amount])).toEqual([["Salary", "3000.0000"]]);
  });
});

describe("time series", () => {
  it("zero-fills buckets", async () => {
    const days = await timeSeries(A.id, SEPT, "day");
    expect(days).toHaveLength(30);
    expect(days.find((d) => d.key === "2026-09-08")?.spending).toBe("-30.0000");
    expect(days.find((d) => d.key === "2026-09-02")?.spending).toBe("0.0000");
    const months = await timeSeries(A.id, { from: "2026-07-01", to: "2026-09-30" }, "month");
    expect(months.map((m) => [m.key, m.spending, m.income])).toEqual([
      ["2026-07-01", "0.0000", "0.0000"],
      ["2026-08-01", "50.0000", "0.0000"],
      ["2026-09-01", "181.0000", "3000.0000"],
    ]);
    const weeks = await timeSeries(A.id, SEPT, "week");
    expect(weeks[0].key).toBe("2026-08-31"); // Monday-start week containing 1 Sep
    expect(weeks.reduce((s, w) => s + Number(w.spending), 0)).toBeCloseTo(181, 4);
  });

  it("cumulative spending this month vs last by day of month", async () => {
    const c = await cumulativeSpending(A.id, { ref: "2026-09-15" });
    expect(c.current).toEqual(SEPT);
    expect(c.points).toHaveLength(31);
    expect(c.points[14].current).toBe("181.0000");
    expect(c.points[15].current).toBeNull();
    expect(c.points[9].previous).toBe("50.0000");
    expect(c.currentToDate).toBe("181.0000");
    expect(c.previousToSameDay).toBe("50.0000");
    expect(c.previousTotal).toBe("50.0000");
  });
});

describe("merchants", () => {
  it("totals, counts, average ticket and trend", async () => {
    const m = await merchantStats(A.id, SEPT);
    expect(m.rows.map((r) => [r.name, r.total, r.count, r.avg])).toEqual([
      ["MegaStore", "100.0000", 1, "100.0000"],
      ["FreshMart", "70.0000", 1, "100.0000"],
    ]);
    const fresh = m.rows[1];
    expect(fresh.previous).toBe("50.0000");
    expect(fresh.delta.change).toBe("20.0000");
    expect(fresh.lastDate).toBe("2026-09-08");
    const q = await merchantStats(A.id, SEPT, { q: "FRESH" });
    expect(q.rows.map((r) => r.name)).toEqual(["FreshMart"]);
    expect((await merchantStats(A.id, SEPT, { q: "%" })).rows).toHaveLength(0);
  });

  it("merchant detail has monthly history and is owner-only", async () => {
    const d = await merchantDetail(A.id, freshId, { months: 12 });
    expect(d.merchant.name).toBe("FreshMart");
    expect(d.lifetime).toMatchObject({ total: "120.0000", count: 2, avg: "75.0000", firstDate: "2026-08-10" });
    expect(d.monthly.find((x) => x.key === "2026-08-01")?.total).toBe("50.0000");
    expect(d.monthly.find((x) => x.key === "2026-09-01")?.total).toBe("70.0000");
    expect(d.recent.length).toBe(3);
    await expect(merchantDetail(B.id, freshId)).rejects.toThrow(/not found/);
  });
});

describe("breakdowns", () => {
  it("by account and payment method", async () => {
    const accts = await byAccount(A.id, SEPT);
    expect(accts.find((a) => a.name === "Checking")).toMatchObject({ income: "3000.0000", spending: "170.0000" });
    expect(accts.find((a) => a.name === "Euro")).toMatchObject({ spending: "11.0000" });
    expect(accts.find((a) => a.name === "Card")).toBeUndefined();
    const pm = await byPaymentMethod(A.id, SEPT);
    expect(pm.total).toBe("181.0000");
    expect(pm.items.map((i) => [i.name, i.amount])).toEqual([
      ["No payment method", "111.0000"],
      ["Cash", "70.0000"],
    ]);
  });

  it("largest transactions skip excluded categories", async () => {
    const l = await largestTransactions(A.id, SEPT, { limit: 5 });
    expect(l.map((t) => t.baseAmount)).toEqual(["100.0000", "100.0000", "11.0000"]);
    const inc = await largestTransactions(A.id, SEPT, { type: "income" });
    expect(inc[0].baseAmount).toBe("3000.0000");
  });

  it("daily breakdown with transactions per day", async () => {
    const d = await dailyBreakdown(A.id, SEPT);
    expect(d.days).toHaveLength(30);
    expect(d.days[0].date).toBe("2026-09-30");
    const day5 = d.days.find((x) => x.date === "2026-09-05")!;
    expect(day5).toMatchObject({ expenses: "100.0000", spending: "100.0000", count: 1 });
    expect(day5.transactions[0].merchantName).toBe("FreshMart");
    const day8 = d.days.find((x) => x.date === "2026-09-08")!;
    expect(day8.net).toBe("30.0000");
    expect(d.days.find((x) => x.date === "2026-09-11")!.count).toBe(1); // adjustment listed, not totalled
    expect(d.days.find((x) => x.date === "2026-09-14")!.count).toBe(0); // deleted
    expect(d.totals).toMatchObject({ income: "3000.0000", spending: "181.0000", count: 8, noSpendDays: 27 });
    const short = await dailyBreakdown(A.id, SEPT, { maxDays: 7 });
    expect(short.truncated).toBe(true);
    expect(short.days).toHaveLength(7);
  });

  it("recurring vs discretionary and category trends", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "10000" });
    const subs = await category(u.id, "Subscriptions");
    const groceries = await category(u.id, "Groceries");
    const { today } = await getPreferences(u.id);
    const cur = monthRange(today);
    const last = monthRange(addDaysISO(cur.from, -1));
    const r = await createRecurring(u.id, { kind: "subscription", name: "Music", amount: "15", accountId: acc.id, categoryId: subs.id, frequency: "monthly", startDate: last.from });
    await postOccurrence(u.id, r.id, { occurrence: last.from, date: last.from });
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "85", date: addDaysISO(last.from, 1), categoryId: groceries.id });
    const split = await recurringVsDiscretionary(u.id, last);
    expect(split).toMatchObject({ recurring: "15.0000", discretionary: "85.0000", total: "100.0000", recurringCount: 1, discretionaryCount: 1 });
    expect(split.byKind).toEqual([{ kind: "subscription", amount: "15.0000", count: 1 }]);
    for (let i = 1; i <= 5; i++) await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "100", date: addMonthsISO(last.from, -i), categoryId: groceries.id });
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "215", date: last.from, categoryId: groceries.id });
    const t = await categoryTrends(u.id, 6);
    expect(t.months).toHaveLength(6);
    const food = t.categories.find((c) => c.name === "Food & Dining")!;
    expect(food.values).toEqual(["100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "300.0000"]);
    expect(food).toMatchObject({ latest: "300.0000", baseline: "100.0000", change: "200.0000", direction: "up" });
    expect(t.categories[0].name).toBe("Food & Dining");
  });
});

describe("monthly review", () => {
  it("computes the month's facts", async () => {
    const r = await monthlyReview(A.id, "2026-09");
    expect(r.range).toEqual(SEPT);
    expect(r.complete).toBe(true);
    expect(r.summary.income).toBe("3000.0000");
    expect(r.summary.spending).toBe("181.0000");
    expect(r.summary.net).toBe("2819.0000");
    expect(r.threeMonthAverage).toMatchObject({ spending: "50.0000", months: 1 });
    expect(r.vsAverage.spending.change).toBe("131.0000");
    expect(r.categories[0].name).toBe("Food & Dining");
    expect(r.largestTransactions[0].baseAmount).toBe("100.0000");
    expect(r.budgets.items.map((b) => [b.name, b.spent, b.status])).toEqual([
      ["Food", "130.0000", "over"],
      ["Everything", "181.0000", "under"],
    ]);
    expect(r.goals.total).toBe("100.0000");
    expect(r.noSpendDays).toMatchObject({ count: 27, ofDays: 30 });
    expect(r.topMerchants[0].name).toBe("MegaStore");
    expect(r.notableChanges.find((c) => c.name === "Food & Dining")?.direction).toBe("up");
    const text = r.facts.map((f) => f.text).join(" ");
    expect(text).toContain("$3,000.00");
    expect(text).toContain("$181.00");
    expect(text).toMatch(/1 of 2 budgets went over: Food/);
    await expect(monthlyReview(A.id, "2026-13")).rejects.toThrow(/YYYY-MM/);
    const months = await reviewableMonths(A.id);
    expect(months).toContain("2026-08");
    expect(months).not.toContain("2026-07");
  });
});

describe("isolation", () => {
  it("B's analytics contain only B's data and A's are unaffected by B", async () => {
    const b = await periodSummary(B.id, SEPT);
    expect(b.spending).toBe("999.0000");
    expect(b.income).toBe("0.0000");
    expect((await spendingByCategory(B.id, SEPT)).total).toBe("999.0000");
    const bm = await merchantStats(B.id, SEPT);
    expect(bm.rows.map((r) => [r.name, r.total])).toEqual([["FreshMart", "999.0000"]]);
    expect((await dailyBreakdown(B.id, SEPT)).totals.count).toBe(1);
    expect((await byPaymentMethod(B.id, SEPT)).total).toBe("999.0000");
    expect((await largestTransactions(B.id, SEPT)).map((t) => t.baseAmount)).toEqual(["999.0000"]);
    const br = await monthlyReview(B.id, "2026-09");
    expect(br.budgets.items).toHaveLength(0);
    expect(br.goals.total).toBe("0.0000");
    // A's numbers are unchanged by B's spending at the same merchant name
    expect((await periodSummary(A.id, SEPT)).spending).toBe("181.0000");
    expect((await merchantStats(A.id, SEPT, { q: "fresh" })).rows[0].total).toBe("70.0000");
  });
});

describe("csv", () => {
  it("escapes and guards against formula injection", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-abc")).toBe("'-abc");
    expect(csvCell("  =1")).toBe("'  =1");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
    expect(csvCell(null)).toBe("");
    expect(csvRow(["x", 1, null])).toBe("x,1,\r\n");
    expect(roundDecimal("12.3450")).toBe("12.35");
    expect(roundDecimal("-12.3449")).toBe("-12.34");
    expect(roundDecimal("-0.0010")).toBe("0.00");
    expect(roundDecimal("5")).toBe("5.00");
  });

  it("exports filtered transactions with the same filters as the list", async () => {
    const prefs = await getPreferences(A.id);
    const filters = transactionFiltersFromParams(new URLSearchParams("from=2026-09-01&to=2026-09-30"), prefs);
    expect(filters).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    let out = "";
    for await (const chunk of transactionCsvChunks(A.id, filters, "USD", { pageSize: 3 })) out += chunk;
    expect(out.startsWith("﻿")).toBe(true);
    const parsed = Papa.parse<string[]>(out.slice(1).trim(), { skipEmptyLines: true }).data;
    expect(parsed[0][0]).toBe("Date");
    expect(parsed).toHaveLength(1 + 8);
    const notesCol = parsed[0].indexOf("Notes");
    const injected = parsed.find((r) => r[notesCol]?.includes("cmd"))!;
    expect(injected[notesCol].startsWith("'=")).toBe(true);
    const amountCol = parsed[0].indexOf("Amount");
    expect(parsed.find((r) => r[1] === "income")![amountCol]).toBe("3000.00");
    expect(parsed.find((r) => r[1] === "refund")![amountCol]).toBe("30.00");
    const split = parsed.slice(1).find((r) => r[parsed[0].indexOf("Splits")]);
    expect(split![parsed[0].indexOf("Splits")]).toBe("Groceries: 60.00; Household: 40.00");
    // B's export never includes A's rows
    let bOut = "";
    for await (const chunk of transactionCsvChunks(B.id, filters, "USD")) bOut += chunk;
    expect(Papa.parse(bOut.slice(1).trim()).data).toHaveLength(2);
    // Filters: types and ids are validated
    const f2 = transactionFiltersFromParams(new URLSearchParams("type=expense,bogus&account=not-a-uuid&range=last_month"), prefs);
    expect(f2.types).toEqual(["expense"]);
    expect(f2.accountIds).toEqual([]);
  });
});

describe("reports", () => {
  it("builds every report type and exports CSV", async () => {
    for (const t of REPORT_TYPES) {
      const r = await buildReport(A.id, t.id, SEPT);
      expect(r.type).toBe(t.id);
      expect(r.tables.length).toBeGreaterThan(0);
      const csv = reportToCsv(r);
      expect(csv).toContain(r.title);
    }
    const spending = await buildReport(A.id, "spending", SEPT);
    expect(spending.kpis.find((k) => k.label === "Spending")?.value).toBe("181.0000");
    const nw = await buildReport(A.id, "net_worth", SEPT);
    const last = nw.tables[0].rows.at(-1)!;
    // Checking 7105 + card 500 (overpaid) − EUR overdraft 11
    expect(last).toMatchObject({ date: "2026-09-30", assets: "7605.0000", liabilities: "11.0000", netWorth: "7594.0000" });
    const monthly = await buildReport(A.id, "monthly", SEPT);
    expect(monthly.notes.join(" ")).toContain("$181.00");
    const bOnly = await buildReport(B.id, "spending", SEPT);
    expect(bOnly.kpis.find((k) => k.label === "Spending")?.value).toBe("999.0000");
  });
});
