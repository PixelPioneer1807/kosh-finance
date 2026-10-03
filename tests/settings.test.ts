import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { budgets, merchants, transactionSplits, transactions } from "@/server/db/schema";
import { changeBaseCurrency, divRate, getPreferences, listExchangeRates, upsertExchangeRate, updatePreferences, getNotificationPreferences } from "@/server/services/preferences";
import { createTransaction, getTransaction } from "@/server/services/transactions";
import { createCategory, createPaymentMethod, deleteCategory, getCategory, listCategories, renameMerchant, updateCategory } from "@/server/services/taxonomy";
import {
  deleteMerchant,
  fetchLatestRates,
  moveCategory,
  saveNotificationPreferences,
  setCategoryArchived,
  updateAppearance,
  updateGeneralPreferences,
  listMerchantsWithUsage,
  listTagsWithUsage,
  getAiUsage,
} from "@/server/services/settings";
import { add } from "@/lib/money";
import { category, makeAccount, makeUser } from "./helpers";

describe("changeBaseCurrency", () => {
  it("re-expresses rates and base amounts against the new base", async () => {
    const u = await makeUser({ currency: "USD" });
    const usd = await makeAccount(u.id, { name: "USD", currency: "USD" });
    const inr = await makeAccount(u.id, { name: "INR", currency: "INR", openingBalance: "0" });
    await upsertExchangeRate(u.id, "INR", "0.012"); // 1 INR = 0.012 USD
    await upsertExchangeRate(u.id, "EUR", "1.1"); // 1 EUR = 1.1 USD
    const t1 = await createTransaction(u.id, { type: "expense", accountId: usd.id, amount: "100", date: "2026-09-01" });
    const t2 = await createTransaction(u.id, { type: "expense", accountId: inr.id, amount: "1000", date: "2026-09-01" });
    expect(t2.baseAmount).toBe("12.0000");
    const g = await category(u.id, "Groceries");
    const h = await category(u.id, "Household");
    const t3 = await createTransaction(u.id, { type: "expense", accountId: usd.id, amount: "10", date: "2026-09-01", splits: [{ categoryId: g.id, amount: "3.33" }, { categoryId: h.id, amount: "6.67" }] });
    await db.insert(budgets).values({ userId: u.id, name: "All", amount: "600", currency: "USD" });
    await updatePreferences(u.id, { expectedMonthlyIncome: "1200" });

    await expect(changeBaseCurrency(u.id, "GBP")).rejects.toThrow(/exchange rate for GBP/);
    await changeBaseCurrency(u.id, "INR");

    const prefs = await getPreferences(u.id);
    expect(prefs.currency).toBe("INR");
    const rates = Object.fromEntries((await listExchangeRates(u.id)).map((r) => [r.currency, r.rate]));
    // 1 USD = 1/0.012 INR = 83.3333333333 ; 1 EUR = 1.1/0.012 = 91.6666666667
    expect(rates.USD).toBe("83.3333333333");
    expect(rates.EUR).toBe("91.6666666667");
    expect(rates.INR).toBeUndefined();
    const [a, b] = await Promise.all([getTransaction(u.id, t1.id), getTransaction(u.id, t2.id)]);
    expect(a.baseAmount).toBe("8333.3333");
    expect(b.baseAmount).toBe("1000.0000");
    expect(b.fxRate).toBe("1.0000000000");
    // Splits still add up exactly to their transaction's base amount.
    const t3n = await getTransaction(u.id, t3.id);
    const splits = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, t3.id));
    expect(add(...splits.map((s) => s.baseAmount))).toBe(t3n.baseAmount);
    const [bud] = await db.select().from(budgets).where(eq(budgets.userId, u.id));
    expect(bud).toMatchObject({ currency: "INR", amount: "50000.0000" });
    expect(prefs.expectedMonthlyIncome).toBe("100000.0000");

    // Round trip back to USD restores the original figures.
    await changeBaseCurrency(u.id, "USD");
    expect((await getTransaction(u.id, t1.id)).baseAmount).toBe("100.0000");
    expect((await getTransaction(u.id, t2.id)).baseAmount).toBe("12.0000");
    const back = Object.fromEntries((await listExchangeRates(u.id)).map((r) => [r.currency, r.rate]));
    expect(back.INR).toBe("0.0120000000");
    expect(back.EUR).toBe("1.1000000000");
  });

  it("allows switching freely when there's no data yet", async () => {
    const u = await makeUser({ currency: "USD" });
    await changeBaseCurrency(u.id, "EUR");
    expect((await getPreferences(u.id)).currency).toBe("EUR");
  });

  it("divRate is exact to 10 decimal places", () => {
    expect(divRate("0.0120481928", "1")).toBe("0.0120481928");
    expect(divRate("1", "3")).toBe("0.3333333333");
    expect(divRate("2", "3")).toBe("0.6666666667");
    expect(divRate("1.1", "0.012")).toBe("91.6666666667");
  });
});

describe("categories", () => {
  it("deletes a category moving its (and its children's) transactions to another", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const food = await category(u.id, "Food & Dining");
    const coffee = await category(u.id, "Coffee");
    const other = await category(u.id, "Other");
    const salary = await category(u.id, "Salary");
    const t1 = await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "5", date: "2026-09-01", categoryId: coffee.id });
    const t2 = await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "9", date: "2026-09-01", categoryId: food.id });
    await expect(deleteCategory(u.id, food.id, salary.id)).rejects.toThrow(/same type/);
    await expect(deleteCategory(u.id, food.id, coffee.id)).rejects.toThrow(/different category/);
    await deleteCategory(u.id, food.id, other.id);
    expect((await getTransaction(u.id, t1.id)).categoryId).toBe(other.id);
    expect((await getTransaction(u.id, t2.id)).categoryId).toBe(other.id);
    await expect(getCategory(u.id, coffee.id)).rejects.toThrow(/not found/);
  });

  it("deleting without reassignment leaves transactions uncategorised", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const fuel = await category(u.id, "Fuel");
    const t = await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "5", date: "2026-09-01", categoryId: fuel.id });
    await deleteCategory(u.id, fuel.id, null);
    expect((await getTransaction(u.id, t.id)).categoryId).toBeNull();
  });

  it("partial updates keep the other fields (regression: defaults used to reset icon/colour)", async () => {
    const u = await makeUser();
    const c = await createCategory(u.id, { name: "Pets", kind: "expense", icon: "dog", color: "#ef4444", excludeFromReports: true });
    await updateCategory(u.id, c.id, { name: "Pet care" });
    expect(await getCategory(u.id, c.id)).toMatchObject({ name: "Pet care", icon: "dog", color: "#ef4444", excludeFromReports: true });
    await updateCategory(u.id, c.id, { excludeFromReports: false });
    expect(await getCategory(u.id, c.id)).toMatchObject({ icon: "dog", excludeFromReports: false });
  });

  it("archives (with children) and reorders among siblings", async () => {
    const u = await makeUser();
    const food = await category(u.id, "Food & Dining");
    await setCategoryArchived(u.id, food.id, true);
    const active = await listCategories(u.id);
    expect(active.some((c) => c.id === food.id || c.parentId === food.id)).toBe(false);
    await setCategoryArchived(u.id, food.id, false);

    const parents = (await listCategories(u.id)).filter((c) => c.kind === "expense" && !c.parentId);
    const [first, second] = parents;
    await moveCategory(u.id, second.id, "up");
    const after = (await listCategories(u.id)).filter((c) => c.kind === "expense" && !c.parentId);
    expect(after[0].id).toBe(second.id);
    expect(after[1].id).toBe(first.id);
    await moveCategory(u.id, after[0].id, "up"); // already first → no-op
    expect((await listCategories(u.id)).filter((c) => c.kind === "expense" && !c.parentId)[0].id).toBe(second.id);
  });
});

describe("preferences & settings services", () => {
  it("validates general preferences and default ownership", async () => {
    const u = await makeUser();
    const other = await makeUser();
    const accOther = await makeAccount(other.id);
    const pmOther = await createPaymentMethod(other.id, { name: "Their card", type: "credit_card" });
    const base = { timezone: "Asia/Kolkata", locale: "en-IN", weekStartsOn: 0 as const, monthStartDay: 25, expectedMonthlyIncome: "5000" };
    await updateGeneralPreferences(u.id, base);
    const p = await getPreferences(u.id);
    expect(p).toMatchObject({ timezone: "Asia/Kolkata", locale: "en-IN", weekStartsOn: 0, monthStartDay: 25, expectedMonthlyIncome: "5000.0000" });
    await expect(updateGeneralPreferences(u.id, { ...base, monthStartDay: 31 })).rejects.toThrow();
    await expect(updateGeneralPreferences(u.id, { ...base, timezone: "Mars/Olympus" })).rejects.toThrow();
    await expect(updateGeneralPreferences(u.id, { ...base, defaultAccountId: accOther.id })).rejects.toThrow(/not found/);
    await expect(updateGeneralPreferences(u.id, { ...base, defaultPaymentMethodId: pmOther.id })).rejects.toThrow(/not found/);
  });

  it("saves appearance with validated widgets", async () => {
    const u = await makeUser();
    await updateAppearance(u.id, { theme: "dark", defaultDateRange: "last_30", dashboardWidgets: [{ id: "recent", visible: true }, { id: "goals", visible: false }] });
    const p = await getPreferences(u.id);
    expect(p.theme).toBe("dark");
    expect(p.dashboardWidgets.slice(0, 2)).toEqual([{ id: "recent", visible: true }, { id: "goals", visible: false }]);
    await expect(updateAppearance(u.id, { theme: "dark", defaultDateRange: "last_30", dashboardWidgets: [{ id: "hax", visible: true }] })).rejects.toThrow();
    await expect(updateAppearance(u.id, { theme: "neon" as "dark", defaultDateRange: "last_30", dashboardWidgets: [] })).rejects.toThrow();
  });

  it("saves notification preferences and quiet hours", async () => {
    const u = await makeUser();
    const base = {
      dailyReminderEnabled: true,
      dailyReminderTime: "21:00",
      missingEntriesDays: 2,
      budgetAlerts: true,
      billReminders: false,
      subscriptionReminders: true,
      creditCardReminders: true,
      incomeReminders: false,
      goalReminders: true,
      maxPerDay: 3,
      quietHoursEnabled: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    };
    await saveNotificationPreferences(u.id, base);
    expect(await getNotificationPreferences(u.id)).toMatchObject({ dailyReminderTime: "21:00", billReminders: false, maxPerDay: 3, quietHoursStart: null, quietHoursEnd: null });
    await saveNotificationPreferences(u.id, { ...base, quietHoursEnabled: true });
    expect(await getNotificationPreferences(u.id)).toMatchObject({ quietHoursStart: "22:00", quietHoursEnd: "07:00" });
    await expect(saveNotificationPreferences(u.id, { ...base, dailyReminderTime: "25:00" })).rejects.toThrow();
    await expect(saveNotificationPreferences(u.id, { ...base, quietHoursEnabled: true, quietHoursEnd: "22:00" })).rejects.toThrow();
  });

  it("fetches latest rates (mocked) and inverts them; fails gracefully", async () => {
    const ok = (async () => new Response(JSON.stringify({ date: "2026-10-02", rates: { INR: 83.25, EUR: 0.92 } }), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchLatestRates("USD", ["INR", "EUR", "XYZ", "USD"], ok);
    expect(r.date).toBe("2026-10-02");
    expect(Number(r.rates.INR)).toBeCloseTo(1 / 83.25, 9);
    expect(Number(r.rates.EUR)).toBeCloseTo(1 / 0.92, 9);
    expect(r.missing).toEqual(["XYZ"]);
    const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchLatestRates("USD", ["INR"], bad)).rejects.toThrow(/Couldn't reach/);
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    await expect(fetchLatestRates("USD", ["INR"], boom)).rejects.toThrow(/Couldn't reach/);
  });

  it("reports AI usage for today", async () => {
    const u = await makeUser();
    expect((await getAiUsage(u.id)).today.requests).toBe(0);
    await db.execute(`INSERT INTO ai_usage (user_id, day, requests, input_tokens, output_tokens) VALUES ('${u.id}', current_date, 3, 100, 50)`);
    expect((await getAiUsage(u.id)).today).toMatchObject({ requests: 3, inputTokens: 100, outputTokens: 50 });
  });

  it("isolation: B can't archive/move/delete A's categories or merchants, or see their usage", async () => {
    const A = await makeUser();
    const B = await makeUser();
    const accA = await makeAccount(A.id);
    const catA = await category(A.id, "Groceries");
    await createTransaction(A.id, { type: "expense", accountId: accA.id, amount: "5", date: "2026-09-01", merchant: "Secret shop", tags: ["private"] });
    const [merA] = await db.select().from(merchants).where(eq(merchants.userId, A.id));
    await expect(setCategoryArchived(B.id, catA.id, true)).rejects.toThrow(/not found/);
    await expect(moveCategory(B.id, catA.id, "up")).rejects.toThrow(/not found/);
    await expect(deleteMerchant(B.id, merA.id)).rejects.toThrow(/not found/);
    await expect(renameMerchant(B.id, merA.id, "pwned")).rejects.toThrow(/not found/);
    expect((await getCategory(A.id, catA.id)).isArchived).toBe(false);
    expect((await listMerchantsWithUsage(B.id)).map((m) => m.id)).not.toContain(merA.id);
    expect(await listTagsWithUsage(B.id)).toEqual([]);
    expect((await listMerchantsWithUsage(A.id)).find((m) => m.id === merA.id)?.uses).toBe(1);
    expect((await listTagsWithUsage(A.id))[0]).toMatchObject({ name: "private", uses: 1 });
    const [t] = await db.select().from(transactions).where(eq(transactions.userId, A.id));
    expect(t.merchantId).toBe(merA.id);
  });
});
