"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import { budgetHistory, budgetInput, createBudget, deleteBudget, generateBudgetAlerts, setBudgetArchived, updateBudget } from "@/server/services/budgets";

/** Alerts are best-effort after a budget change; a failure must never fail the save. */
async function refreshAlerts(userId: string) {
  try {
    await generateBudgetAlerts(userId);
  } catch (e) {
    console.error("[budgets] alert generation failed", e instanceof Error ? e.message : e);
  }
}

export const createBudgetAction = userAction(budgetInput, async (input, { userId }) => {
  const b = await createBudget(userId, input);
  await refreshAlerts(userId);
  refresh();
  return { id: b.id };
});

export const updateBudgetAction = userAction(z.object({ id: z.uuid(), data: budgetInput }), async ({ id, data }, { userId }) => {
  await updateBudget(userId, id, data);
  await refreshAlerts(userId);
  refresh();
  return { id };
});

export const archiveBudgetAction = userAction(z.object({ id: z.uuid(), archived: z.boolean() }), async ({ id, archived }, { userId }) => {
  await setBudgetArchived(userId, id, archived);
  refresh();
  return { id };
});

export const deleteBudgetAction = userAction(z.uuid(), async (id, { userId }) => {
  await deleteBudget(userId, id);
  refresh();
  return { id };
});

export const budgetHistoryAction = userAction(
  z.object({ id: z.uuid(), periods: z.number().int().min(1).max(12).default(6) }),
  async ({ id, periods }, { userId }) => budgetHistory(userId, id, periods),
);
