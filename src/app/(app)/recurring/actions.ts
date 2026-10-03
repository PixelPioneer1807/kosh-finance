"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import {
  acceptPriceChange,
  createRecurring,
  deleteRecurring,
  postOccurrence,
  recurringInput,
  setRecurringStatus,
  skipOccurrence,
  updateRecurring,
} from "@/server/services/recurring";
import { isoDate, optionalId, optionalMoney, positiveMoney } from "@/lib/validation";

export const createRecurringAction = userAction(recurringInput, async (input, { userId }) => {
  const r = await createRecurring(userId, input);
  refresh();
  return { id: r.id };
});

export const updateRecurringAction = userAction(z.object({ id: z.uuid(), data: recurringInput }), async ({ id, data }, { userId }) => {
  await updateRecurring(userId, id, data);
  refresh();
  return { id };
});

export const deleteRecurringAction = userAction(z.uuid(), async (id, { userId }) => {
  await deleteRecurring(userId, id);
  refresh();
  return { id };
});

export const setRecurringStatusAction = userAction(
  z.object({ id: z.uuid(), status: z.enum(["active", "paused", "cancelled"]) }),
  async ({ id, status }, { userId }) => {
    await setRecurringStatus(userId, id, status);
    refresh();
    return { id };
  },
);

/** "Mark paid" / "Mark received": records the occurrence as a real transaction. */
export const markPaidAction = userAction(
  z.object({
    id: z.uuid(),
    occurrence: isoDate.optional(),
    date: isoDate.optional(),
    amount: optionalMoney,
    accountId: optionalId,
  }),
  async ({ id, occurrence, date, amount, accountId }, { userId }) => {
    const r = await postOccurrence(userId, id, { occurrence, date, amount: amount ?? undefined, accountId: accountId ?? undefined, source: "manual" });
    refresh();
    return r;
  },
);

export const skipOccurrenceAction = userAction(z.uuid(), async (id, { userId }) => {
  await skipOccurrence(userId, id);
  refresh();
  return { id };
});

/** One-click "Track it" for a detected pattern. Anchored on the last observed charge. */
export const acceptSuggestionAction = userAction(
  z.object({
    merchantName: z.string().trim().min(1).max(80),
    kind: z.enum(["bill", "subscription", "expense"]),
    amount: positiveMoney,
    accountId: optionalId,
    categoryId: optionalId,
    frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]),
    lastDate: isoDate,
  }),
  async (s, { userId }) => {
    const r = await createRecurring(userId, {
      kind: s.kind,
      name: s.merchantName,
      merchant: s.merchantName,
      amount: s.amount,
      accountId: s.accountId,
      categoryId: s.categoryId,
      frequency: s.frequency,
      startDate: s.lastDate,
    });
    refresh();
    return { id: r.id, nextDate: r.nextDate };
  },
);

export const acceptPriceChangeAction = userAction(z.object({ id: z.uuid(), amount: positiveMoney }), async ({ id, amount }, { userId }) => {
  await acceptPriceChange(userId, id, amount);
  refresh();
  return { id };
});
