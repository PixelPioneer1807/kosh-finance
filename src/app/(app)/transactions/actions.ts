"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { generateBudgetAlerts } from "@/server/services/budgets";
import { z } from "zod";
import { userAction } from "@/server/safe";
import {
  bulkCategorize,
  createTransaction,
  deleteTransactions,
  duplicateTransaction,
  getTransaction,
  listTransactions,
  refundTransaction,
  restoreTransactions,
  suggestCategoryForMerchant,
  transactionFilters,
  transactionInput,
  updateTransaction,
} from "@/server/services/transactions";
import { suggestMerchants } from "@/server/services/taxonomy";
import { parseTransactionText } from "@/server/ai/parse";
import { isoDate, optionalMoney } from "@/lib/validation";

const ids = z.array(z.uuid()).min(1).max(500);

/** Re-check budget thresholds once the response is sent (never blocks or fails the save). */
function checkBudgetsLater(userId: string) {
  after(() => generateBudgetAlerts(userId).catch((e) => console.error("[budgets] alert check failed", e)));
}

export const createTransactionAction = userAction(transactionInput, async (input, { userId }) => {
  const t = await createTransaction(userId, input);
  checkBudgetsLater(userId);
  refresh();
  return { id: t.id };
});

export const updateTransactionAction = userAction(z.object({ id: z.uuid(), data: transactionInput }), async ({ id, data }, { userId }) => {
  await updateTransaction(userId, id, data);
  checkBudgetsLater(userId);
  refresh();
  return { id };
});

export const deleteTransactionsAction = userAction(ids, async (list, { userId }) => {
  const n = await deleteTransactions(userId, list);
  refresh();
  return { count: n };
});

export const restoreTransactionsAction = userAction(ids, async (list, { userId }) => {
  const n = await restoreTransactions(userId, list);
  refresh();
  return { count: n };
});

export const duplicateTransactionAction = userAction(z.object({ id: z.uuid(), date: isoDate.optional() }), async ({ id, date }, { userId }) => {
  const t = await duplicateTransaction(userId, id, date);
  refresh();
  return { id: t.id };
});

export const refundTransactionAction = userAction(
  z.object({ id: z.uuid(), amount: optionalMoney, date: isoDate.optional(), notes: z.string().max(500).nullish() }),
  async ({ id, amount, date, notes }, { userId }) => {
    const t = await refundTransaction(userId, id, { amount: amount ?? undefined, date, notes });
    refresh();
    return { id: t.id };
  },
);

export const bulkCategorizeAction = userAction(z.object({ ids, categoryId: z.uuid().nullable() }), async ({ ids, categoryId }, { userId }) => {
  const n = await bulkCategorize(userId, ids, categoryId);
  refresh();
  return { count: n };
});

export const getTransactionAction = userAction(z.uuid(), async (id, { userId }) => getTransaction(userId, id));

export const loadTransactionsAction = userAction(
  z.object({ filters: transactionFilters, offset: z.number().int().min(0), limit: z.number().int().min(1).max(200).default(50) }),
  async ({ filters, offset, limit }, { userId }) => listTransactions(userId, filters, { offset, limit }),
);

export const suggestMerchantsAction = userAction(z.string().max(80), async (q, { userId }) => suggestMerchants(userId, q));

export const merchantCategoryAction = userAction(z.string().max(80), async (name, { userId }) => suggestCategoryForMerchant(userId, name));

export const parseTextAction = userAction(z.string().trim().min(1).max(300), async (text, { userId }) => parseTransactionText(userId, text));
