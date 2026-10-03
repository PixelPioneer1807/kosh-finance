import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import { recurringTransactions, transactions } from "@/server/db/schema";
import {
  createRecurring,
  deleteRecurring,
  detectPattern,
  detectRecurringCandidates,
  getRecurring,
  listRecurring,
  postOccurrence,
  priceChanges,
  processDueRecurring,
  recurringCostSummary,
  setRecurringStatus,
  skipOccurrence,
  updateRecurring,
  upcomingOccurrences,
} from "@/server/services/recurring";
import { createTransaction, deleteTransaction } from "@/server/services/transactions";
import { accountBalances } from "@/server/services/accounts";
import { addDaysISO, addMonthsISO, todayIn } from "@/lib/dates";
import { category, makeAccount, makeUser } from "./helpers";

const today = () => todayIn("UTC");

const postedFor = (rid: string) =>
  db.select().from(transactions).where(and(eq(transactions.recurringId, rid), isNull(transactions.deletedAt)));

describe("recurring schedules", () => {
  it("computes the next date from today and never backfills history on create", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const t = today();
    const fromToday = await createRecurring(u.id, { kind: "bill", name: "Rent", amount: "1200", accountId: acc.id, frequency: "monthly", startDate: t });
    expect(fromToday.nextDate).toBe(t);
    const past = await createRecurring(u.id, { kind: "bill", name: "Phone", amount: "30", accountId: acc.id, frequency: "weekly", startDate: addDaysISO(t, -10) });
    expect(past.nextDate).toBe(addDaysISO(t, 4));
    const ended = await createRecurring(u.id, { kind: "expense", name: "Old", amount: "5", frequency: "monthly", startDate: "2020-01-01", endDate: "2020-06-01" });
    expect(ended.status).toBe("ended");
    expect(ended.nextDate).toBeNull();
  });

  it("validates category kind and transfer accounts", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const salary = await category(u.id, "Salary");
    const groceries = await category(u.id, "Groceries");
    await expect(createRecurring(u.id, { kind: "bill", name: "X", amount: "1", categoryId: salary.id, frequency: "monthly", startDate: today() })).rejects.toThrow(/expense category/);
    await expect(createRecurring(u.id, { kind: "income", name: "Pay", amount: "1", categoryId: groceries.id, frequency: "monthly", startDate: today() })).rejects.toThrow(/income category/);
    await expect(createRecurring(u.id, { kind: "transfer", name: "Save", amount: "1", accountId: acc.id, frequency: "monthly", startDate: today() })).rejects.toThrow();
    await expect(createRecurring(u.id, { kind: "bill", name: "Auto", amount: "1", autoPost: true, frequency: "monthly", startDate: today() })).rejects.toThrow();
  });

  it("posting the same occurrence twice records one transaction (also under a race)", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "1000" });
    const t = today();
    const r = await createRecurring(u.id, { kind: "subscription", name: "StreamCo", amount: "15", accountId: acc.id, frequency: "monthly", startDate: t });
    const [p1, p2] = await Promise.all([postOccurrence(u.id, r.id, { occurrence: t }), postOccurrence(u.id, r.id, { occurrence: t })]);
    expect([p1.alreadyPosted, p2.alreadyPosted].sort()).toEqual([false, true]);
    const again = await postOccurrence(u.id, r.id, { occurrence: t });
    expect(again.alreadyPosted).toBe(true);
    expect(await postedFor(r.id)).toHaveLength(1);
    expect((await getRecurring(u.id, r.id)).nextDate).toBe(addMonthsISO(t, 1));
    expect((await accountBalances(u.id)).get(acc.id)).toBe("985.0000");
    const [txn] = await postedFor(r.id);
    expect(txn.type).toBe("expense");
    expect(txn.recurringDate).toBe(t);
  });

  it("re-posts an occurrence whose transaction was deleted, with custom date/amount", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "1000" });
    const other = await makeAccount(u.id, { name: "Card", type: "credit_card", openingBalance: "0" });
    const t = today();
    const r = await createRecurring(u.id, { kind: "bill", name: "Power", amount: "80", accountId: acc.id, frequency: "monthly", startDate: t });
    const first = await postOccurrence(u.id, r.id);
    await deleteTransaction(u.id, first.transactionId);
    const second = await postOccurrence(u.id, r.id, { occurrence: t, amount: "92.50", date: addDaysISO(t, -1), accountId: other.id });
    expect(second.alreadyPosted).toBe(false);
    const rows = await postedFor(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: "92.5000", date: addDaysISO(t, -1), accountId: other.id });
  });

  it("skip advances without recording; pause/resume doesn't create a backlog", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const t = today();
    const r = await createRecurring(u.id, { kind: "bill", name: "Gym", amount: "40", accountId: acc.id, frequency: "weekly", startDate: t });
    await skipOccurrence(u.id, r.id);
    expect((await getRecurring(u.id, r.id)).nextDate).toBe(addDaysISO(t, 7));
    expect(await postedFor(r.id)).toHaveLength(0);
    await setRecurringStatus(u.id, r.id, "paused");
    expect(await upcomingOccurrences(u.id, t, addDaysISO(t, 30))).toEqual([]);
    await setRecurringStatus(u.id, r.id, "active");
    expect((await getRecurring(u.id, r.id)).nextDate).toBe(t);
    await setRecurringStatus(u.id, r.id, "cancelled");
    const c = await getRecurring(u.id, r.id);
    expect(c.status).toBe("cancelled");
    expect(c.cancelledAt).toBe(t);
    expect((await listRecurring(u.id)).map((x) => x.id)).not.toContain(r.id);
    expect((await listRecurring(u.id, { includeInactive: true })).map((x) => x.id)).toContain(r.id);
  });

  it("editing keeps an unpaid overdue occurrence", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const t = today();
    const r = await createRecurring(u.id, { kind: "bill", name: "Water", amount: "20", accountId: acc.id, frequency: "weekly", startDate: addDaysISO(t, -14) });
    await db.update(recurringTransactions).set({ nextDate: addDaysISO(t, -7) }).where(eq(recurringTransactions.id, r.id));
    const upd = await updateRecurring(u.id, r.id, { kind: "bill", name: "Water bill", amount: "25", accountId: acc.id, frequency: "weekly", startDate: addDaysISO(t, -14) });
    expect(upd.nextDate).toBe(addDaysISO(t, -7));
    const occ = await upcomingOccurrences(u.id, t, addDaysISO(t, 8));
    expect(occ.map((o) => [o.date, o.status])).toEqual([
      [addDaysISO(t, -7), "overdue"],
      [t, "due"],
      [addDaysISO(t, 7), "upcoming"],
    ]);
  });

  it("processDueRecurring catches up every missed occurrence once", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "1000" });
    const salary = await category(u.id, "Salary");
    const t = today();
    const r = await createRecurring(u.id, { kind: "income", name: "Salary", amount: "500", accountId: acc.id, categoryId: salary.id, frequency: "weekly", startDate: addDaysISO(t, -21), autoPost: true, employer: "Acme" });
    await db.update(recurringTransactions).set({ nextDate: addDaysISO(t, -21) }).where(eq(recurringTransactions.id, r.id));
    expect(await processDueRecurring(u.id, t)).toEqual({ posted: 4 });
    expect(await processDueRecurring(u.id, t)).toEqual({ posted: 0 });
    const rows = await postedFor(r.id);
    expect(rows.map((x) => x.recurringDate).sort()).toEqual([addDaysISO(t, -21), addDaysISO(t, -14), addDaysISO(t, -7), t]);
    expect(rows.every((x) => x.type === "income" && x.source === "recurring")).toBe(true);
    expect((await getRecurring(u.id, r.id)).nextDate).toBe(addDaysISO(t, 7));
    expect((await accountBalances(u.id)).get(acc.id)).toBe("3000.0000");
  });

  it("recurring transfers post as transfers", async () => {
    const u = await makeUser();
    const a = await makeAccount(u.id, { openingBalance: "1000" });
    const s = await makeAccount(u.id, { name: "Savings", type: "savings", openingBalance: "0" });
    const r = await createRecurring(u.id, { kind: "transfer", name: "Save", amount: "100", accountId: a.id, toAccountId: s.id, frequency: "monthly", startDate: today() });
    await postOccurrence(u.id, r.id);
    const bal = await accountBalances(u.id);
    expect(bal.get(a.id)).toBe("900.0000");
    expect(bal.get(s.id)).toBe("100.0000");
  });

  it("normalises subscription cost to monthly and yearly exactly", async () => {
    const u = await makeUser();
    const t = today();
    await createRecurring(u.id, { kind: "subscription", name: "Weekly box", amount: "10", frequency: "weekly", startDate: t });
    await createRecurring(u.id, { kind: "subscription", name: "Quarterly", amount: "30", frequency: "quarterly", startDate: t });
    await createRecurring(u.id, { kind: "subscription", name: "Annual", amount: "100", frequency: "yearly", startDate: t });
    await createRecurring(u.id, { kind: "subscription", name: "Every 2 months", amount: "20", frequency: "custom", interval: 2, intervalUnit: "month", startDate: t });
    const paused = await createRecurring(u.id, { kind: "subscription", name: "Paused", amount: "999", frequency: "monthly", startDate: t });
    await setRecurringStatus(u.id, paused.id, "paused");
    await createRecurring(u.id, { kind: "bill", name: "Not a subscription", amount: "999", frequency: "monthly", startDate: t });
    const s = await recurringCostSummary(u.id);
    const by = new Map(s.items.map((i) => [i.name, i]));
    expect(by.get("Weekly box")).toMatchObject({ monthly: "43.4813", yearly: "521.7750" });
    expect(by.get("Quarterly")).toMatchObject({ monthly: "10.0000", yearly: "120.0000" });
    expect(by.get("Annual")).toMatchObject({ monthly: "8.3333", yearly: "100.0000" });
    expect(by.get("Every 2 months")).toMatchObject({ monthly: "10.0000", yearly: "120.0000" });
    expect(s.count).toBe(4);
    expect(s.monthly).toBe("71.8146");
    expect(s.yearly).toBe("861.7750");
  });
});

describe("recurring detection", () => {
  it("detectPattern finds monthly and weekly runs and rejects irregular or variable series", () => {
    const monthly = ["2026-02-05", "2026-03-05", "2026-04-06", "2026-05-05", "2026-06-05"].map((date, i) => ({ date, amount: i === 4 ? "17.4900" : "15.9900" }));
    expect(detectPattern(monthly, "2026-06-20")).toMatchObject({ frequency: "monthly", count: 5, typicalAmount: "15.9900", lastDate: "2026-06-05", nextExpected: "2026-07-05", fixedAmount: false });
    const weekly = ["2026-05-26", "2026-06-02", "2026-06-09", "2026-06-16"].map((date) => ({ date, amount: "12" }));
    expect(detectPattern(weekly, "2026-06-20")).toMatchObject({ frequency: "weekly", count: 4, nextExpected: "2026-06-23", fixedAmount: true });
    const irregular = ["2026-03-01", "2026-03-04", "2026-04-20", "2026-06-01"].map((date) => ({ date, amount: "10" }));
    expect(detectPattern(irregular, "2026-06-20")).toBeNull();
    const variable = ["2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05"].map((date, i) => ({ date, amount: String(20 + i * 15) }));
    expect(detectPattern(variable, "2026-06-20")).toBeNull();
    // Stopped two months ago → probably cancelled.
    expect(detectPattern(monthly.slice(0, 3), "2026-06-20")).toBeNull();
  });

  it("suggests untracked merchants from history", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "10000" });
    const subs = await category(u.id, "Subscriptions");
    const t = today();
    const months = [-4, -3, -2, -1].map((m) => addMonthsISO(addDaysISO(t, -3), m)).concat(addDaysISO(t, -3));
    for (const d of months) await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "15.99", date: d, categoryId: subs.id, merchant: "StreamCo" });
    for (const d of months) await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "9.99", date: d, merchant: "MusicBox" });
    for (const d of [-40, -30, -3]) await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "50", date: addDaysISO(t, d), merchant: "Corner Shop" });
    await createRecurring(u.id, { kind: "subscription", name: "MusicBox", amount: "9.99", frequency: "monthly", startDate: t });

    const found = await detectRecurringCandidates(u.id, t);
    expect(found.map((f) => f.merchantName)).toEqual(["StreamCo"]);
    expect(found[0]).toMatchObject({ frequency: "monthly", typicalAmount: "15.9900", categoryId: subs.id, accountId: acc.id, count: 5, fixedAmount: true, currency: "USD" });
    expect(found[0].nextExpected > t).toBe(true);

    // Once tracked (with the merchant), it's no longer suggested.
    await createRecurring(u.id, { kind: "subscription", name: "Streaming", merchant: "streamco", amount: "15.99", frequency: "monthly", startDate: t });
    expect(await detectRecurringCandidates(u.id, t)).toEqual([]);
  });

  it("flags subscription price changes", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "1000" });
    const t = today();
    const r = await createRecurring(u.id, { kind: "subscription", name: "StreamCo", amount: "10", accountId: acc.id, frequency: "monthly", startDate: t });
    await postOccurrence(u.id, r.id, { amount: "10" });
    expect(await priceChanges(u.id)).toEqual([]);
    await postOccurrence(u.id, r.id, { amount: "12" });
    const changes = await priceChanges(u.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ recurringId: r.id, expected: "10.0000", charged: "12.0000", difference: "2.0000", changePct: 0.2 });
  });
});

describe("recurring isolation", () => {
  it("user B can't read, modify, post or reference user A's items", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const accA = await makeAccount(a.id, { openingBalance: "1000" });
    const accB = await makeAccount(b.id, { openingBalance: "1000" });
    const subsA = await category(a.id, "Subscriptions");
    const t = today();
    const r = await createRecurring(a.id, { kind: "subscription", name: "StreamCo", amount: "10", accountId: accA.id, categoryId: subsA.id, frequency: "monthly", startDate: t });
    const input = { kind: "subscription" as const, name: "Hijack", amount: "1", accountId: accB.id, frequency: "monthly" as const, startDate: t };

    await expect(getRecurring(b.id, r.id)).rejects.toThrow(/not found/);
    await expect(updateRecurring(b.id, r.id, input)).rejects.toThrow(/not found/);
    await expect(setRecurringStatus(b.id, r.id, "paused")).rejects.toThrow(/not found/);
    await expect(skipOccurrence(b.id, r.id)).rejects.toThrow(/not found/);
    await expect(postOccurrence(b.id, r.id)).rejects.toThrow(/not found/);
    await expect(deleteRecurring(b.id, r.id)).rejects.toThrow(/not found/);
    expect(await listRecurring(b.id, { includeInactive: true })).toEqual([]);
    expect(await upcomingOccurrences(b.id, t, addDaysISO(t, 40))).toEqual([]);
    expect((await recurringCostSummary(b.id)).count).toBe(0);
    expect(await priceChanges(b.id)).toEqual([]);

    await expect(createRecurring(b.id, { ...input, accountId: accA.id })).rejects.toThrow(/not found/);
    await expect(createRecurring(b.id, { ...input, categoryId: subsA.id })).rejects.toThrow(/not found/);
    const own = await createRecurring(b.id, input);
    await expect(postOccurrence(b.id, own.id, { accountId: accA.id })).rejects.toThrow(/not found/);

    const still = await getRecurring(a.id, r.id);
    expect(still.name).toBe("StreamCo");
    expect(still.status).toBe("active");
    expect(await postedFor(r.id)).toHaveLength(0);
  });
});
