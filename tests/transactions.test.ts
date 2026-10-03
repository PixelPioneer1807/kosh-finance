import { describe, expect, it } from "vitest";
import { createTransaction, updateTransaction, deleteTransaction, restoreTransactions, getTransaction, listTransactions, summarizeTransactions, duplicateTransaction, refundTransaction } from "@/server/services/transactions";
import { accountBalances, listAccounts } from "@/server/services/accounts";
import { upsertExchangeRate } from "@/server/services/preferences";
import { category, makeAccount, makeUser } from "./helpers";

describe("transactions", () => {
  it("creates, edits, deletes and restores an expense; balances follow", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "1000" });
    const food = await category(u.id, "Food & Dining");
    const t = await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "45.50", date: "2026-10-01", categoryId: food.id, merchant: "Starbucks", tags: ["coffee", "work"] });
    expect((await accountBalances(u.id)).get(acc.id)).toBe("954.5000");
    const full = await getTransaction(u.id, t.id);
    expect(full.merchantName).toBe("Starbucks");
    expect(full.tags.map((x) => x.name).sort()).toEqual(["coffee", "work"]);

    await updateTransaction(u.id, t.id, { type: "expense", accountId: acc.id, amount: "50", date: "2026-10-01", categoryId: food.id, merchant: "Starbucks" });
    expect((await accountBalances(u.id)).get(acc.id)).toBe("950.0000");
    expect((await getTransaction(u.id, t.id)).tags).toEqual([]);

    await deleteTransaction(u.id, t.id);
    expect((await accountBalances(u.id)).get(acc.id)).toBe("1000.0000");
    await expect(getTransaction(u.id, t.id)).rejects.toThrow(/not found/);
    await restoreTransactions(u.id, [t.id]);
    expect((await accountBalances(u.id)).get(acc.id)).toBe("950.0000");
  });

  it("learns the merchant's category", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const coffee = await category(u.id, "Coffee");
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "4", date: "2026-10-01", categoryId: coffee.id, merchant: "Blue Tokai" });
    const { suggestCategoryForMerchant } = await import("@/server/services/transactions");
    expect(await suggestCategoryForMerchant(u.id, "  blue   TOKAI ")).toBe(coffee.id);
  });

  it("transfers move money without counting as spending or income", async () => {
    const u = await makeUser();
    const a = await makeAccount(u.id, { name: "Checking", openingBalance: "1000" });
    const b = await makeAccount(u.id, { name: "Savings", type: "savings", openingBalance: "0" });
    await createTransaction(u.id, { type: "transfer", accountId: a.id, toAccountId: b.id, amount: "300", date: "2026-10-02" });
    const bal = await accountBalances(u.id);
    expect(bal.get(a.id)).toBe("700.0000");
    expect(bal.get(b.id)).toBe("300.0000");
    const s = await summarizeTransactions(u.id, {});
    expect(s.spending).toBe("0.0000");
    expect(s.income).toBe("0.0000");
    await expect(createTransaction(u.id, { type: "transfer", accountId: a.id, toAccountId: a.id, amount: "1", date: "2026-10-02" })).rejects.toThrow(/different accounts/);
  });

  it("credit card payments are transfers that reduce what is owed", async () => {
    const u = await makeUser();
    const bank = await makeAccount(u.id, { openingBalance: "5000" });
    const card = await makeAccount(u.id, { name: "Card", type: "credit_card", openingBalance: "200" });
    expect((await accountBalances(u.id)).get(card.id)).toBe("-200.0000");
    await createTransaction(u.id, { type: "expense", accountId: card.id, amount: "100", date: "2026-10-02" });
    await createTransaction(u.id, { type: "transfer", accountId: bank.id, toAccountId: card.id, amount: "300", date: "2026-10-03" });
    expect((await accountBalances(u.id)).get(card.id)).toBe("0.0000");
  });

  it("splits must add up exactly (validated server-side)", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const groceries = await category(u.id, "Groceries");
    const household = await category(u.id, "Household");
    await expect(
      createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "100", date: "2026-10-01", splits: [{ categoryId: groceries.id, amount: "60" }, { categoryId: household.id, amount: "30" }] }),
    ).rejects.toThrow(/add up/);
    const t = await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "100", date: "2026-10-01", splits: [{ categoryId: groceries.id, amount: "60.01" }, { categoryId: household.id, amount: "39.99" }] });
    const full = await getTransaction(u.id, t.id);
    expect(full.hasSplits).toBe(true);
    expect(full.splits.map((s) => s.amount)).toEqual(["60.0100", "39.9900"]);
    // Filtering by a split category finds the transaction.
    const { rows } = await listTransactions(u.id, { categoryIds: [household.id] });
    expect(rows.map((r) => r.id)).toContain(t.id);
  });

  it("refunds link to the original, reduce net spending, and can't exceed the original", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "1000" });
    const shop = await category(u.id, "Shopping");
    const t = await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "200", date: "2026-10-01", categoryId: shop.id, merchant: "Shoe store" });
    await refundTransaction(u.id, t.id, { amount: "50", date: "2026-10-05" });
    await expect(refundTransaction(u.id, t.id, { amount: "151", date: "2026-10-05" })).rejects.toThrow(/can't exceed/);
    const full = await getTransaction(u.id, t.id);
    expect(full.refundedAmount).toBe("50.0000");
    const s = await summarizeTransactions(u.id, {});
    expect(s.spending).toBe("150.0000");
    expect(s.income).toBe("0.0000"); // refunds are not income
    expect((await accountBalances(u.id)).get(acc.id)).toBe("850.0000");
  });

  it("rejects category kind mismatches", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const salary = await category(u.id, "Salary");
    await expect(createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "5", date: "2026-10-01", categoryId: salary.id })).rejects.toThrow(/expense category/);
  });

  it("converts foreign-currency accounts into the base currency", async () => {
    const u = await makeUser({ currency: "INR" });
    const eur = await makeAccount(u.id, { currency: "EUR", openingBalance: "0" });
    await expect(createTransaction(u.id, { type: "expense", accountId: eur.id, amount: "10", date: "2026-10-01" })).rejects.toThrow(/exchange rate/);
    await upsertExchangeRate(u.id, "EUR", "90.5");
    const t = await createTransaction(u.id, { type: "expense", accountId: eur.id, amount: "10", date: "2026-10-01" });
    expect(t.baseAmount).toBe("905.0000");
  });

  it("duplicates and searches", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const t = await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "12.34", date: "2026-09-01", merchant: "Uber", notes: "airport ride" });
    await duplicateTransaction(u.id, t.id, "2026-09-02");
    expect((await listTransactions(u.id, { q: "uber" })).rows).toHaveLength(2);
    expect((await listTransactions(u.id, { q: "AIRPORT" })).rows).toHaveLength(2);
    expect((await listTransactions(u.id, { q: "12.34" })).rows).toHaveLength(2);
    expect((await listTransactions(u.id, { from: "2026-09-02", to: "2026-09-02" })).rows).toHaveLength(1);
    expect((await listTransactions(u.id, { minAmount: "13" })).rows).toHaveLength(0);
    // SQL metacharacters are treated as data
    expect((await listTransactions(u.id, { q: "'; DROP TABLE transactions; --" })).rows).toHaveLength(0);
    expect((await listTransactions(u.id, { q: "%" })).rows).toHaveLength(0);
    expect((await listAccounts(u.id))[0].balance).toBe("975.3200");
  });
});
