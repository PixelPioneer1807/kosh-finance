"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import {
  GOAL_STATUS_ACTIONS,
  addContribution,
  contributionInput,
  createGoal,
  deleteContribution,
  deleteGoal,
  goalInput,
  listContributions,
  setGoalStatus,
  updateGoal,
} from "@/server/services/goals";

export const createGoalAction = userAction(goalInput, async (input, { userId }) => {
  const g = await createGoal(userId, input);
  refresh();
  return { id: g.id };
});

export const updateGoalAction = userAction(z.object({ id: z.uuid(), data: goalInput }), async ({ id, data }, { userId }) => {
  await updateGoal(userId, id, data);
  refresh();
  return { id };
});

export const setGoalStatusAction = userAction(z.object({ id: z.uuid(), action: z.enum(GOAL_STATUS_ACTIONS) }), async ({ id, action }, { userId }) => {
  const g = await setGoalStatus(userId, id, action);
  refresh();
  return { status: g.status };
});

export const deleteGoalAction = userAction(z.object({ id: z.uuid() }), async ({ id }, { userId }) => {
  await deleteGoal(userId, id);
  refresh();
  return null;
});

export const addContributionAction = userAction(contributionInput, async (input, { userId }) => {
  const r = await addContribution(userId, input);
  refresh();
  return { id: r.contribution.id, completed: r.completed, transactionId: r.contribution.transactionId };
});

export const listContributionsAction = userAction(z.object({ goalId: z.uuid() }), async ({ goalId }, { userId }) => listContributions(userId, goalId));

export const deleteContributionAction = userAction(z.object({ id: z.uuid(), keepTransfer: z.boolean().default(false) }), async ({ id, keepTransfer }, { userId }) => {
  await deleteContribution(userId, id, { keepTransfer });
  refresh();
  return null;
});
