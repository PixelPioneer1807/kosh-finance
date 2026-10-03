"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import {
  categoryInput,
  createCategory,
  createPaymentMethod,
  deleteCategory,
  deletePaymentMethod,
  deleteTag,
  paymentMethodInput,
  renameMerchant,
  updateCategory,
  updatePaymentMethod,
} from "@/server/services/taxonomy";
import { deleteMerchant, moveCategory, setCategoryArchived } from "@/server/services/settings";

const id = z.uuid();

/* ───────────── Categories ───────────── */

export const createCategoryAction = userAction(categoryInput, async (input, { userId }) => {
  const c = await createCategory(userId, input);
  refresh();
  return { id: c.id };
});

export const updateCategoryAction = userAction(
  z.object({ id, data: categoryInput.omit({ kind: true }) }),
  async ({ id, data }, { userId }) => {
    await updateCategory(userId, id, data);
    refresh();
    return null;
  },
);

export const setCategoryExcludedAction = userAction(z.object({ id, excluded: z.boolean() }), async ({ id, excluded }, { userId }) => {
  await updateCategory(userId, id, { excludeFromReports: excluded });
  refresh();
  return null;
});

export const archiveCategoryAction = userAction(z.object({ id, archived: z.boolean() }), async ({ id, archived }, { userId }) => {
  await setCategoryArchived(userId, id, archived);
  refresh();
  return null;
});

export const moveCategoryAction = userAction(z.object({ id, direction: z.enum(["up", "down"]) }), async ({ id, direction }, { userId }) => {
  await moveCategory(userId, id, direction);
  refresh();
  return null;
});

export const deleteCategoryAction = userAction(z.object({ id, reassignTo: z.uuid().nullable() }), async ({ id, reassignTo }, { userId }) => {
  await deleteCategory(userId, id, reassignTo);
  refresh();
  return null;
});

/* ───────────── Payment methods ───────────── */

export const createPaymentMethodAction = userAction(paymentMethodInput, async (input, { userId }) => {
  const p = await createPaymentMethod(userId, input);
  refresh();
  return { id: p.id };
});

export const updatePaymentMethodAction = userAction(z.object({ id, data: paymentMethodInput }), async ({ id, data }, { userId }) => {
  await updatePaymentMethod(userId, id, data);
  refresh();
  return null;
});

export const archivePaymentMethodAction = userAction(z.object({ id, archived: z.boolean() }), async ({ id, archived }, { userId }) => {
  await updatePaymentMethod(userId, id, { isArchived: archived });
  refresh();
  return null;
});

export const deletePaymentMethodAction = userAction(z.object({ id }), async ({ id }, { userId }) => {
  await deletePaymentMethod(userId, id);
  refresh();
  return null;
});

/* ───────────── Merchants & tags ───────────── */

export const renameMerchantAction = userAction(z.object({ id, name: z.string().trim().min(1, "Enter a name").max(80) }), async ({ id, name }, { userId }) => {
  const resultId = await renameMerchant(userId, id, name);
  refresh();
  return { id: resultId, merged: resultId !== id };
});

export const deleteMerchantAction = userAction(z.object({ id }), async ({ id }, { userId }) => {
  await deleteMerchant(userId, id);
  refresh();
  return null;
});

export const deleteTagAction = userAction(z.object({ id }), async ({ id }, { userId }) => {
  await deleteTag(userId, id);
  refresh();
  return null;
});
