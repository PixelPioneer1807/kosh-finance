"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import {
  aiUsageToday,
  cancelAction,
  confirmAction,
  deleteConversation,
  getConversation,
  listConversations,
  MAX_USER_MESSAGE,
  renameConversation,
  runAssistant,
} from "@/server/ai/assistant";
import { aiInterpretation } from "@/server/services/insights";

export const sendMessageAction = userAction(
  z.object({ conversationId: z.uuid().nullable(), message: z.string().trim().min(1, "Type a message").max(MAX_USER_MESSAGE) }),
  async ({ conversationId, message }, { userId }) => {
    const reply = await runAssistant(userId, conversationId, message);
    return { ...reply, usage: await aiUsageToday(userId) };
  },
);

export const confirmAiActionAction = userAction(z.uuid(), async (id, { userId }) => {
  const card = await confirmAction(userId, id);
  refresh();
  return card;
});

export const cancelAiActionAction = userAction(z.uuid(), async (id, { userId }) => cancelAction(userId, id));

export const listConversationsAction = userAction(z.object({}).optional(), async (_input, { userId }) => listConversations(userId));

export const getConversationAction = userAction(z.uuid(), async (id, { userId }) => getConversation(userId, id));

export const renameConversationAction = userAction(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(80) }), async ({ id, title }, { userId }) => {
  await renameConversation(userId, id, title);
  return { id, title };
});

export const deleteConversationAction = userAction(z.uuid(), async (id, { userId }) => {
  await deleteConversation(userId, id);
  return { id };
});

/** "Explain with AI" on the insights widget: a short interpretation of the computed insights. */
export const explainInsightsAction = userAction(z.object({}).optional(), async (_input, { userId }) => aiInterpretation(userId));
