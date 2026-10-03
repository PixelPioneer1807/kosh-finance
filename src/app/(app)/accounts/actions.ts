"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import { accountInput, createAccount, deleteAccount, reorderAccounts, setAccountArchived, updateAccount } from "@/server/services/accounts";
import { createTransaction } from "@/server/services/transactions";
import { getAccount, accountBalances } from "@/server/services/accounts";
import { getPreferences } from "@/server/services/preferences";
import { AppError } from "@/server/errors";
import { signedMoney } from "@/lib/validation";
import { isZero, sub } from "@/lib/money";

export const createAccountAction = userAction(accountInput, async (input, { userId }) => {
  const a = await createAccount(userId, input);
  refresh();
  return { id: a.id };
});

export const updateAccountAction = userAction(z.object({ id: z.uuid(), data: accountInput }), async ({ id, data }, { userId }) => {
  await updateAccount(userId, id, data);
  refresh();
  return null;
});

export const archiveAccountAction = userAction(z.object({ id: z.uuid(), archived: z.boolean() }), async ({ id, archived }, { userId }) => {
  await setAccountArchived(userId, id, archived);
  refresh();
  return null;
});

export const deleteAccountAction = userAction(z.object({ id: z.uuid(), confirmName: z.string() }), async ({ id, confirmName }, { userId }) => {
  const acc = await getAccount(userId, id);
  if (confirmName.trim() !== acc.name) throw new AppError("VALIDATION", "Type the account name exactly to confirm.");
  await deleteAccount(userId, id);
  refresh();
  return null;
});

export const reorderAccountsAction = userAction(z.array(z.uuid()).max(200), async (ids, { userId }) => {
  await reorderAccounts(userId, ids);
  refresh();
  return null;
});

/** Reconcile: record an adjustment so the ledger matches the real-world balance. */
export const reconcileAccountAction = userAction(z.object({ id: z.uuid(), actualBalance: signedMoney }), async ({ id, actualBalance }, { userId }) => {
  const acc = await getAccount(userId, id);
  const current = (await accountBalances(userId)).get(id) ?? acc.openingBalance;
  const liability = acc.type === "credit_card" || acc.type === "loan";
  // For liabilities the user types what they owe (positive); the ledger stores it as negative.
  const target = liability ? sub("0", actualBalance.replace("-", "")) : actualBalance;
  const diff = sub(target, current);
  if (isZero(diff)) return { adjusted: false };
  const prefs = await getPreferences(userId);
  await createTransaction(userId, { type: "adjustment", accountId: id, amount: diff, date: prefs.today, notes: "Balance reconciliation" });
  refresh();
  return { adjusted: true };
});
