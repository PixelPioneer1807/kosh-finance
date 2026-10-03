import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { budgets, categories, goalContributions, goals, recurringTransactions, transactions, accounts, tags, merchants, exchangeRates } from "@/server/db/schema";
import { exportUserData, restoreUserData, dataCounts } from "@/server/services/backup";
import { createTransaction, refundTransaction, getTransaction } from "@/server/services/transactions";
import { accountBalances, listAccounts } from "@/server/services/accounts";
import { getPreferences, upsertExchangeRate, updatePreferences } from "@/server/services/preferences";
import { listCategories } from "@/server/services/taxonomy";
import { category, makeAccount, makeUser } from "./helpers";

async function seed(userId: string) {
  const bank = await makeAccount(userId, { name: "Bank", openingBalance: "5000" });
  const card = await makeAccount(userId, { name: "Card", type: "credit_card", openingBalance: "100" });
  const eur = await makeAccount(userId, { name: "Euro wallet", type: "wallet", currency: "EUR", openingBalance: "50" });
  await upsertExchangeRate(userId, "EUR", "1.1");
  const groceries = await category(userId, "Groceries");
  const household = await category(userId, "Household");
  const salary = await category(userId, "Salary");
  const [rec] = await db
    .insert(recurringTransactions)
    .values({ userId, name: "Netflix", kind: "subscription", amount: "15", currency: "USD", accountId: card.id, categoryId: groceries.id, startDate: "2026-01-05", nextDate: "2026-10-05" })
    .returning();
  const exp = await createTransaction(userId, { type: "expense", accountId: bank.id, amount: "120", date: "2026-09-01", categoryId: groceries.id, merchant: "Whole Foods", tags: ["family"] });
  await refundTransaction(userId, exp.id, { amount: "20", date: "2026-09-03" });
  await createTransaction(userId, {
    type: "expense",
    accountId: card.id,
    amount: "100",
    date: "2026-09-04",
    splits: [
      { categoryId: groceries.id, amount: "60" },
      { categoryId: household.id, amount: "40" },
    ],
  });
  await createTransaction(userId, { type: "income", accountId: bank.id, amount: "3000", date: "2026-09-25", categoryId: salary.id, merchant: "ACME" });
  await createTransaction(userId, { type: "transfer", accountId: bank.id, toAccountId: card.id, amount: "200", date: "2026-09-26" });
  await createTransaction(userId, { type: "expense", accountId: eur.id, amount: "10", date: "2026-09-27", notes: "Croissant" });
  const recTxn = await createTransaction(userId, { type: "expense", accountId: card.id, amount: "15", date: "2026-09-05", categoryId: groceries.id }, { source: "recurring", recurringId: rec.id, recurringDate: "2026-09-05" });
  const [budget] = await db.insert(budgets).values({ userId, name: "Food", categoryId: groceries.id, amount: "500", currency: "USD" }).returning();
  const [goal] = await db.insert(goals).values({ userId, name: "Trip", targetAmount: "2000", currency: "USD", linkedAccountId: bank.id }).returning();
  await db.insert(goalContributions).values({ userId, goalId: goal.id, amount: "250", date: "2026-09-10", transactionId: recTxn.id });
  await updatePreferences(userId, { defaultAccountId: card.id, monthStartDay: 25 });
  return { bank, card, eur, budget, goal, rec };
}

const sortBal = (m: Map<string, string>, accs: { id: string; name: string }[]) =>
  accs.map((a) => [a.name, m.get(a.id)]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));

describe("backup & restore", () => {
  it("exports a versioned file without secrets", async () => {
    const u = await makeUser();
    await seed(u.id);
    const file = await exportUserData(u.id);
    expect(file.version).toBe(1);
    expect(file.transactions.length).toBe(7);
    const text = JSON.stringify(file);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain(u.id); // no user ids anywhere
    expect(text).not.toMatch(/"data":/); // no receipt bytes
    const split = file.transactions.find((t) => (t.splits as unknown[]).length > 0)!;
    expect(split.splits).toHaveLength(2);
  });

  it("round-trips: backup → restore (replace) into a fresh user gives identical counts and balances", async () => {
    const A = await makeUser();
    await seed(A.id);
    const file = JSON.parse(JSON.stringify(await exportUserData(A.id)));
    const B = await makeUser();
    const summary = await restoreUserData(B.id, file, "replace");
    expect(summary.transactions).toBe(7);
    expect(await dataCounts(B.id)).toEqual(await dataCounts(A.id));
    const accA = await listAccounts(A.id, { includeArchived: true });
    const accB = await listAccounts(B.id, { includeArchived: true });
    expect(sortBal(await accountBalances(B.id), accB)).toEqual(sortBal(await accountBalances(A.id), accA));
    // Ids are fresh, never reused.
    const idsA = new Set(accA.map((a) => a.id));
    expect(accB.some((a) => idsA.has(a.id))).toBe(false);
    // Relationships survive the remap.
    const txB = await db.select().from(transactions).where(eq(transactions.userId, B.id));
    const refund = txB.find((t) => t.type === "refund")!;
    expect(txB.find((t) => t.id === refund.refundOfId)?.amount).toBe("120.0000");
    const split = txB.find((t) => t.hasSplits)!;
    expect((await getTransaction(B.id, split.id)).splits.map((s) => s.amount)).toEqual(["60.0000", "40.0000"]);
    const tagged = txB.find((t) => t.amount === "120.0000")!;
    expect((await getTransaction(B.id, tagged.id)).tags.map((t) => t.name)).toEqual(["family"]);
    const [recB] = await db.select().from(recurringTransactions).where(eq(recurringTransactions.userId, B.id));
    expect(txB.find((t) => t.recurringId === recB.id)?.recurringDate).toBe("2026-09-05");
    const [goalB] = await db.select().from(goals).where(eq(goals.userId, B.id));
    const [contribB] = await db.select().from(goalContributions).where(eq(goalContributions.userId, B.id));
    expect(contribB.goalId).toBe(goalB.id);
    expect(txB.some((t) => t.id === contribB.transactionId)).toBe(true);
    const prefsB = await getPreferences(B.id);
    expect(prefsB.monthStartDay).toBe(25);
    expect(accB.find((a) => a.id === prefsB.defaultAccountId)?.name).toBe("Card");
    const catsB = await listCategories(B.id);
    expect(catsB.length).toBe((await listCategories(A.id)).length);
    expect(catsB.find((c) => c.name === "Groceries")?.parentId).toBe(catsB.find((c) => c.name === "Food & Dining")?.id);
    const [rateB] = await db.select().from(exchangeRates).where(eq(exchangeRates.userId, B.id));
    expect(rateB).toMatchObject({ currency: "EUR", rate: "1.1000000000" });
  });

  it("replace wipes the user's existing financial data first; merge adds without duplicating", async () => {
    const A = await makeUser();
    await seed(A.id);
    const file = JSON.parse(JSON.stringify(await exportUserData(A.id)));
    const B = await makeUser();
    const old = await makeAccount(B.id, { name: "Old account" });
    await createTransaction(B.id, { type: "expense", accountId: old.id, amount: "1", date: "2026-01-01" });
    await restoreUserData(B.id, file, "replace");
    expect((await listAccounts(B.id, { includeArchived: true })).map((a) => a.name)).not.toContain("Old account");

    // Merging the same backup again: names are reused and identical transactions are skipped.
    const before = await dataCounts(B.id);
    const s = await restoreUserData(B.id, file, "merge");
    expect(s.accounts).toBe(0);
    expect(s.categories).toBe(0);
    expect(s.transactions).toBe(0);
    expect(s.skippedTransactions).toBe(7);
    expect((await dataCounts(B.id)).transactions).toBe(before.transactions);
  });

  it("merge refuses a backup in a different base currency", async () => {
    const A = await makeUser({ currency: "USD" });
    await seed(A.id);
    const file = await exportUserData(A.id);
    const B = await makeUser({ currency: "INR" });
    await expect(restoreUserData(B.id, file, "merge")).rejects.toThrow(/base currency/);
  });

  it("rejects invalid files and leaves data untouched", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    await expect(restoreUserData(u.id, { hello: "world" }, "replace")).rejects.toThrow(/valid Kosh backup/);
    await expect(
      restoreUserData(u.id, { version: 1, accounts: [], transactions: [{ id: "t1", type: "expense", accountId: "missing", amount: "1", baseAmount: "1", date: "2026-01-01" }] }, "replace"),
    ).rejects.toThrow(/account isn't in the file/);
    await expect(restoreUserData(u.id, { version: 1, transactions: [{ id: "t", type: "expense", accountId: "a", amount: "-5", baseAmount: "1", date: "2026-01-01" }] }, "replace")).rejects.toThrow(
      /valid Kosh backup/,
    );
    // The failed replace rolled back: the account is still there.
    expect((await listAccounts(u.id)).map((a) => a.id)).toContain(acc.id);
  });

  it("a tampered backup can't touch or reference another user's records", async () => {
    const victim = await makeUser();
    const vAcc = await makeAccount(victim.id, { name: "Victim bank", openingBalance: "999" });
    const vCat = await category(victim.id, "Groceries");
    const vTx = await createTransaction(victim.id, { type: "expense", accountId: vAcc.id, amount: "42", date: "2026-09-01", categoryId: vCat.id });
    const [vTag] = await db.insert(tags).values({ userId: victim.id, name: "secret" }).returning();
    const [vMer] = await db.select().from(merchants).where(eq(merchants.userId, victim.id)).limit(1);
    void vMer;

    const attacker = await makeUser();
    const tampered = {
      version: 1,
      preferences: { currency: "USD" },
      // Reuse the victim's real ids and user id everywhere.
      accounts: [{ id: vAcc.id, userId: victim.id, name: "Victim bank", type: "checking", currency: "USD", openingBalance: "0" }],
      categories: [{ id: vCat.id, userId: victim.id, name: "Groceries", kind: "expense" }],
      tags: [{ id: vTag.id, userId: victim.id, name: "secret" }],
      transactions: [
        { id: vTx.id, userId: victim.id, type: "expense", accountId: vAcc.id, amount: "1", baseAmount: "1", date: "2026-09-02", categoryId: vCat.id, tagIds: [vTag.id] },
        // A reference to an id that's *not* in the file (victim's category) is dropped, not linked.
        { id: "x2", type: "expense", accountId: vAcc.id, amount: "2", baseAmount: "2", date: "2026-09-03", categoryId: "00000000-0000-0000-0000-000000000000", refundOfId: vTx.id },
      ],
      budgets: [{ id: "b", name: "x", categoryId: "11111111-1111-1111-1111-111111111111", amount: "10", currency: "USD" }],
      contributions: [{ goalId: "nope", amount: "5", date: "2026-01-01" }],
    };
    await restoreUserData(attacker.id, tampered, "replace");

    // Victim's records are untouched.
    const [va] = await db.select().from(accounts).where(eq(accounts.id, vAcc.id));
    expect(va).toMatchObject({ userId: victim.id, openingBalance: "999.0000" });
    const vt = await getTransaction(victim.id, vTx.id);
    expect(vt.amount).toBe("42.0000");
    const [vc] = await db.select().from(categories).where(eq(categories.id, vCat.id));
    expect(vc.userId).toBe(victim.id);
    expect((await accountBalances(victim.id)).get(vAcc.id)).toBe("957.0000");

    // Attacker got fresh copies with fresh ids, all owned by the attacker.
    const aTx = await db.select().from(transactions).where(eq(transactions.userId, attacker.id));
    expect(aTx).toHaveLength(2);
    expect(aTx.some((t) => t.id === vTx.id)).toBe(false);
    const aAcc = await listAccounts(attacker.id);
    expect(aAcc).toHaveLength(1);
    expect(aAcc[0].id).not.toBe(vAcc.id);
    expect(aTx.every((t) => t.accountId === aAcc[0].id && t.refundOfId === null)).toBe(true);
    expect(aTx.find((t) => t.amount === "2.0000")?.categoryId).toBeNull();
    expect(await db.$count(budgets, eq(budgets.userId, attacker.id))).toBe(0);

    // The victim's own replace-restore from an attacker file still only affects the victim.
    const before = await dataCounts(attacker.id);
    await restoreUserData(victim.id, await exportUserData(victim.id), "merge");
    expect(await dataCounts(attacker.id)).toEqual(before);
  });
});
