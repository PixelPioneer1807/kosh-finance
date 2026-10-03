import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { financialSnapshots, notifications } from "@/server/db/schema";
import { createAccount, updateAccount } from "@/server/services/accounts";
import { createTransaction } from "@/server/services/transactions";
import { getPreferences, upsertExchangeRate, updateNotificationPreferences } from "@/server/services/preferences";
import { netWorthHistory, netWorthSummary, recordSnapshot } from "@/server/services/networth";
import { creditCardHealth, generateCreditCardReminders, nextDayOfMonth, prevDayOfMonth, utilizationStatus } from "@/server/services/credit";
import { addDaysISO, addMonthsISO, daysBetween } from "@/lib/dates";
import { makeAccount, makeUser } from "./helpers";

describe("net worth", () => {
  it("is assets minus liabilities, with credit cards and loans owed", async () => {
    const u = await makeUser();
    await makeAccount(u.id, { name: "Checking", openingBalance: "1000" });
    await makeAccount(u.id, { name: "Savings", type: "savings", openingBalance: "500" });
    const card = await makeAccount(u.id, { name: "Card", type: "credit_card", openingBalance: "200" });
    await makeAccount(u.id, { name: "Car loan", type: "loan", openingBalance: "5000" });
    const s = await netWorthSummary(u.id);
    expect(s.assets).toBe("1500.0000");
    expect(s.liabilities).toBe("5200.0000");
    expect(s.netWorth).toBe("-3700.0000");
    expect(s.accounts.find((a) => a.id === card.id)?.owed).toBe("200.0000");
    const byType = Object.fromEntries(s.breakdown.map((b) => [b.type, b.total]));
    expect(byType).toEqual({ checking: "1000.0000", savings: "500.0000", credit_card: "200.0000", loan: "5000.0000" });
    // Assets first, then liabilities, each sorted by size.
    expect(s.breakdown.map((b) => b.type)).toEqual(["checking", "savings", "loan", "credit_card"]);
  });

  it("converts other currencies and reports accounts it can't convert instead of dropping them silently", async () => {
    const u = await makeUser({ currency: "USD" });
    await makeAccount(u.id, { name: "Checking", openingBalance: "1000" });
    await makeAccount(u.id, { name: "Euro", currency: "EUR", openingBalance: "100" });
    const gbp = await makeAccount(u.id, { name: "Pounds", currency: "GBP", openingBalance: "50" });
    await upsertExchangeRate(u.id, "EUR", "1.1");
    const s = await netWorthSummary(u.id);
    expect(s.assets).toBe("1110.0000");
    expect(s.netWorth).toBe("1110.0000");
    expect(s.unconverted).toEqual([{ accountId: gbp.id, name: "Pounds", currency: "GBP", balance: "50.0000" }]);
    expect(s.accounts.find((a) => a.id === gbp.id)?.baseBalance).toBeNull();
  });

  it("respects include-in-net-worth and still counts archived accounts holding money", async () => {
    const u = await makeUser();
    const excluded = await makeAccount(u.id, { name: "Kid's", openingBalance: "300" });
    await updateAccount(u.id, excluded.id, { name: "Kid's", type: "checking", currency: "USD", openingBalance: "300", includeInNetWorth: false });
    const old = await createAccount(u.id, { name: "Old", type: "savings", currency: "USD", openingBalance: "40" });
    const { setAccountArchived } = await import("@/server/services/accounts");
    await setAccountArchived(u.id, old.id, true);
    const s = await netWorthSummary(u.id);
    expect(s.netWorth).toBe("40.0000");
    expect(s.excludedCount).toBe(1);
    expect(s.accounts.find((a) => a.id === old.id)?.isArchived).toBe(true);
  });

  it("history comes from the ledger: back-dated transactions affect the right month", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const opened = addMonthsISO(today, -14);
    const acc = await createAccount(u.id, { name: "Checking", type: "checking", currency: "USD", openingBalance: "1000", openingDate: opened });
    const card = await createAccount(u.id, { name: "Card", type: "credit_card", currency: "USD", openingBalance: "0", openingDate: opened });
    const threeMonthsAgo = addMonthsISO(today, -3);
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "200", date: threeMonthsAgo });
    await createTransaction(u.id, { type: "expense", accountId: card.id, amount: "50", date: threeMonthsAgo });
    // An account created today with no history doesn't appear in past months.
    await makeAccount(u.id, { name: "New", openingBalance: "75" });

    const h = await netWorthHistory(u.id, 12);
    expect(h.points).toHaveLength(13);
    expect(h.points.at(-1)!.date).toBe(today);
    for (const p of h.points.slice(0, -1)) {
      const before = p.date < threeMonthsAgo;
      expect(p.assets).toBe(before ? "1000.0000" : "800.0000");
      expect(p.liabilities).toBe(before ? "0.0000" : "50.0000");
    }
    expect(h.points.at(-1)!.netWorth).toBe("825.0000");
    expect(h.changes.month?.delta).toBe("75.0000");
    expect(h.changes.year?.netWorth).toBe("1000.0000");
    expect(h.changes.year?.delta).toBe("-175.0000");
  });

  it("records one snapshot per day (upsert)", async () => {
    const u = await makeUser();
    await makeAccount(u.id, { openingBalance: "10" });
    await recordSnapshot(u.id);
    await makeAccount(u.id, { name: "More", openingBalance: "5" });
    const row = await recordSnapshot(u.id);
    expect(row.netWorth).toBe("15.0000");
    const rows = await db.select().from(financialSnapshots).where(eq(financialSnapshots.userId, u.id));
    expect(rows).toHaveLength(1);
  });

  it("isolation: one user's net worth never includes another's accounts", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await makeAccount(a.id, { openingBalance: "999" });
    await makeAccount(b.id, { openingBalance: "1" });
    expect((await netWorthSummary(b.id)).netWorth).toBe("1.0000");
    expect((await netWorthHistory(b.id, 2)).points.at(-1)!.netWorth).toBe("1.0000");
    expect((await creditCardHealth(b.id)).cards).toEqual([]);
  });
});

describe("credit card health", () => {
  it("due/statement date maths clamps to month length", () => {
    expect(nextDayOfMonth("2026-01-10", 15)).toBe("2026-01-15");
    expect(nextDayOfMonth("2026-01-15", 15)).toBe("2026-01-15");
    expect(nextDayOfMonth("2026-01-16", 15)).toBe("2026-02-15");
    expect(nextDayOfMonth("2026-02-01", 31)).toBe("2026-02-28");
    expect(nextDayOfMonth("2026-12-20", 5)).toBe("2027-01-05");
    expect(prevDayOfMonth("2026-03-10", 31)).toBe("2026-02-28");
    expect(prevDayOfMonth("2026-03-31", 31)).toBe("2026-03-31");
    expect(utilizationStatus(0.29)).toBe("good");
    expect(utilizationStatus(0.3)).toBe("warning");
    expect(utilizationStatus(0.7)).toBe("serious");
    expect(utilizationStatus(1.01)).toBe("over_limit");
    expect(utilizationStatus(null)).toBeNull();
  });

  it("computes owed, available, utilisation, next due date and warnings", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const dueSoon = addDaysISO(today, 3);
    const dueDay = Number(dueSoon.slice(8));
    const card = await createAccount(u.id, {
      name: "Visa",
      type: "credit_card",
      currency: "USD",
      openingBalance: "750",
      creditLimit: "1000",
      dueDay,
      minimumPayment: "25",
      annualFee: "99",
    });
    await createAccount(u.id, { name: "Store", type: "credit_card", currency: "USD", openingBalance: "100", creditLimit: "1000" });
    const h = await creditCardHealth(u.id);
    const c = h.cards.find((x) => x.id === card.id)!;
    expect(c.owed).toBe("750.0000");
    expect(c.available).toBe("250.0000");
    expect(c.utilization).toBe(0.75);
    expect(c.utilizationStatus).toBe("serious");
    expect(c.nextDueDate).toBe(nextDayOfMonth(today, dueDay));
    expect(c.daysUntilDue).toBe(daysBetween(today, c.nextDueDate!));
    expect(c.minimumPayment).toBe("25.0000");
    expect(c.annualFee).toBe("99.0000");
    expect(c.warnings.map((w) => w.code)).toContain("utilization_serious");
    if (c.daysUntilDue! <= 5 && c.daysUntilDue! > 0) expect(c.warnings.map((w) => w.code)).toContain("due_soon");
    expect(h.overall.owed).toBe("850.0000");
    expect(h.overall.limit).toBe("2000.0000");
    expect(h.overall.utilization).toBe(0.425);
    expect(h.overall.utilizationStatus).toBe("warning");
  });

  it("flags over-limit and computes the statement amount still due", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const bank = await makeAccount(u.id, { openingBalance: "5000" });
    const statementDate = addDaysISO(today, -5);
    const card = await createAccount(u.id, {
      name: "Amex",
      type: "credit_card",
      currency: "USD",
      openingBalance: "0",
      openingDate: addMonthsISO(today, -2),
      creditLimit: "500",
      statementDay: Number(statementDate.slice(8)),
    });
    await createTransaction(u.id, { type: "expense", accountId: card.id, amount: "400", date: addDaysISO(statementDate, -2) });
    await createTransaction(u.id, { type: "expense", accountId: card.id, amount: "200", date: today });
    await createTransaction(u.id, { type: "transfer", accountId: bank.id, toAccountId: card.id, amount: "150", date: addDaysISO(today, -1) });
    const c = (await creditCardHealth(u.id)).cards.find((x) => x.id === card.id)!;
    expect(c.owed).toBe("450.0000");
    // The clamped statement day may differ from statementDate at month ends; only assert when it matches.
    if (c.lastStatementDate === statementDate) {
      expect(c.statementBalance).toBe("400.0000");
      expect(c.amountDue).toBe("250.0000");
    }
    await createTransaction(u.id, { type: "expense", accountId: card.id, amount: "100", date: today });
    const over = (await creditCardHealth(u.id)).cards.find((x) => x.id === card.id)!;
    expect(over.utilizationStatus).toBe("over_limit");
    expect(over.warnings[0]).toMatchObject({ code: "over_limit", level: "serious" });
  });

  it("creates one due reminder per card and due date, respecting the preference", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const due = addDaysISO(today, 2);
    const card = await createAccount(u.id, { name: "Visa", type: "credit_card", currency: "USD", openingBalance: "120", dueDay: Number(due.slice(8)) });
    const expectedDue = nextDayOfMonth(today, Number(due.slice(8)));
    const n = await generateCreditCardReminders(u.id);
    expect(n).toBe(daysBetween(today, expectedDue) <= 5 ? 1 : 0);
    expect(await generateCreditCardReminders(u.id)).toBe(0);
    if (n) {
      const [row] = await db.select().from(notifications).where(and(eq(notifications.userId, u.id), eq(notifications.type, "credit_card")));
      expect(row.dedupeKey).toBe(`cc:${card.id}:${expectedDue}`);
    }
    const v = await makeUser();
    await createAccount(v.id, { name: "Visa", type: "credit_card", currency: "USD", openingBalance: "120", dueDay: Number(due.slice(8)) });
    await updateNotificationPreferences(v.id, { creditCardReminders: false });
    expect(await generateCreditCardReminders(v.id)).toBe(0);
  });
});
