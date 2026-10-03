/**
 * Data isolation: User B must never read, modify, delete, or reference User A's records.
 * Every service takes the authenticated userId from the session — these tests call services
 * with B's id and A's record ids, i.e. exactly what a tampered URL/API parameter would do.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { createTransaction, getTransaction, updateTransaction, deleteTransaction, listTransactions, refundTransaction, duplicateTransaction, deleteTransactions, restoreTransactions, bulkCategorize } from "@/server/services/transactions";
import { getAccount, updateAccount, deleteAccount, listAccounts, setAccountArchived } from "@/server/services/accounts";
import { updateCategory, deleteCategory, listCategories, getCategory } from "@/server/services/taxonomy";
import { category, makeAccount, makeUser } from "./helpers";

let A: Awaited<ReturnType<typeof makeUser>>;
let B: Awaited<ReturnType<typeof makeUser>>;
let accA: Awaited<ReturnType<typeof makeAccount>>;
let accB: Awaited<ReturnType<typeof makeAccount>>;
let txnA: Awaited<ReturnType<typeof createTransaction>>;

beforeAll(async () => {
  A = await makeUser();
  B = await makeUser();
  accA = await makeAccount(A.id, { name: "A checking" });
  accB = await makeAccount(B.id, { name: "B checking" });
  txnA = await createTransaction(A.id, { type: "expense", accountId: accA.id, amount: "99", date: "2026-10-01", merchant: "Secret merchant", notes: "private" });
});

describe("user data isolation", () => {
  it("B cannot read A's transaction or account by id", async () => {
    await expect(getTransaction(B.id, txnA.id)).rejects.toThrow(/not found/);
    await expect(getAccount(B.id, accA.id)).rejects.toThrow(/not found/);
  });
  it("B's lists and searches never include A's data", async () => {
    const { rows } = await listTransactions(B.id, { q: "secret" });
    expect(rows).toHaveLength(0);
    expect((await listTransactions(B.id, { accountIds: [accA.id] })).rows).toHaveLength(0);
    expect((await listAccounts(B.id)).map((a) => a.id)).not.toContain(accA.id);
    const bCats = new Set((await listCategories(B.id)).map((c) => c.id));
    for (const c of await listCategories(A.id)) expect(bCats.has(c.id)).toBe(false);
  });
  it("B cannot modify or delete A's records", async () => {
    await expect(updateTransaction(B.id, txnA.id, { type: "expense", accountId: accB.id, amount: "1", date: "2026-10-01" })).rejects.toThrow(/not found/);
    await expect(deleteTransaction(B.id, txnA.id)).rejects.toThrow(/not found/);
    expect(await deleteTransactions(B.id, [txnA.id])).toBe(0);
    expect(await bulkCategorize(B.id, [txnA.id], null)).toBe(0);
    await expect(updateAccount(B.id, accA.id, { name: "pwned", type: "checking", currency: "USD" })).rejects.toThrow(/not found/);
    await expect(setAccountArchived(B.id, accA.id, true)).rejects.toThrow(/not found/);
    await expect(deleteAccount(B.id, accA.id)).rejects.toThrow(/not found/);
    const catA = await category(A.id, "Food & Dining");
    await expect(updateCategory(B.id, catA.id, { name: "pwned" })).rejects.toThrow(/not found/);
    await expect(deleteCategory(B.id, catA.id)).rejects.toThrow(/not found/);
    // A's data is untouched
    expect((await getTransaction(A.id, txnA.id)).amount).toBe("99.0000");
    expect((await getCategory(A.id, catA.id)).name).toBe("Food & Dining");
  });
  it("B cannot attach records to A's account, category, or transaction", async () => {
    await expect(createTransaction(B.id, { type: "expense", accountId: accA.id, amount: "1", date: "2026-10-01" })).rejects.toThrow(/not found/);
    const catA = await category(A.id, "Food & Dining");
    await expect(createTransaction(B.id, { type: "expense", accountId: accB.id, amount: "1", date: "2026-10-01", categoryId: catA.id })).rejects.toThrow(/not found/);
    await expect(createTransaction(B.id, { type: "transfer", accountId: accB.id, toAccountId: accA.id, amount: "1", date: "2026-10-01" })).rejects.toThrow(/not found/);
    await expect(createTransaction(B.id, { type: "refund", accountId: accB.id, amount: "1", date: "2026-10-01", refundOfId: txnA.id })).rejects.toThrow(/not found/);
    await expect(refundTransaction(B.id, txnA.id)).rejects.toThrow(/not found/);
    await expect(duplicateTransaction(B.id, txnA.id)).rejects.toThrow(/not found/);
    const splitCat = await category(A.id, "Groceries");
    const bCat = await category(B.id, "Groceries");
    await expect(
      createTransaction(B.id, { type: "expense", accountId: accB.id, amount: "2", date: "2026-10-01", splits: [{ categoryId: bCat.id, amount: "1" }, { categoryId: splitCat.id, amount: "1" }] }),
    ).rejects.toThrow(/not found/);
  });
  it("B cannot restore A's deleted transaction", async () => {
    const t = await createTransaction(A.id, { type: "expense", accountId: accA.id, amount: "5", date: "2026-10-01" });
    await deleteTransaction(A.id, t.id);
    expect(await restoreTransactions(B.id, [t.id])).toBe(0);
  });
});
