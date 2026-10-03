/** Categories, merchants, payment methods and tags — the user's own classification system. */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbOrTx } from "@/server/db";
import { categories, merchants, paymentMethods, tags, transactions, transactionSplits, budgets, recurringTransactions } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { hexColor, name, optionalId } from "@/lib/validation";
import { assertOwned } from "./ownership";

/* ───────────── Categories ───────────── */

export const categoryInput = z.object({
  name: name("Category name", 50),
  kind: z.enum(["expense", "income"]),
  parentId: optionalId,
  icon: z.string().min(1).max(40).default("circle"),
  color: hexColor.default("#64748b"),
  excludeFromReports: z.boolean().default(false),
});

export type CategoryNode = typeof categories.$inferSelect & { children: (typeof categories.$inferSelect)[] };

export async function listCategories(userId: string, opts: { includeArchived?: boolean } = {}) {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), opts.includeArchived ? undefined : eq(categories.isArchived, false)))
    .orderBy(asc(categories.kind), asc(categories.sortOrder), asc(categories.name));
}

export function buildCategoryTree(rows: (typeof categories.$inferSelect)[]): CategoryNode[] {
  const parents = rows.filter((r) => !r.parentId);
  return parents.map((p) => ({ ...p, children: rows.filter((r) => r.parentId === p.id) }));
}

export async function createCategory(userId: string, raw: z.input<typeof categoryInput>) {
  const input = categoryInput.parse(raw);
  if (input.parentId) {
    const parent = await getCategory(userId, input.parentId);
    if (parent.parentId) throw new AppError("VALIDATION", "Subcategories can only be one level deep.");
    if (parent.kind !== input.kind) throw new AppError("VALIDATION", "A subcategory must match its parent's type.");
  }
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${categories.sortOrder}), -1)::int` })
    .from(categories)
    .where(and(eq(categories.userId, userId), input.parentId ? eq(categories.parentId, input.parentId) : isNull(categories.parentId)));
  const [row] = await db.insert(categories).values({ ...input, userId, sortOrder: max + 1 }).returning();
  return row;
}

export async function updateCategory(userId: string, id: string, raw: Partial<z.input<typeof categoryInput>>) {
  const input = categoryInput.partial().parse(raw);
  // `.partial()` still applies field defaults (icon/colour/exclude) — keep only keys the caller sent.
  for (const k of Object.keys(input) as (keyof typeof input)[]) if (!(k in raw)) delete input[k];
  const current = await getCategory(userId, id);
  if (input.parentId !== undefined && input.parentId !== current.parentId) {
    if (input.parentId === id) throw new AppError("VALIDATION", "A category can't be its own parent.");
    if (input.parentId) {
      const parent = await getCategory(userId, input.parentId);
      if (parent.parentId) throw new AppError("VALIDATION", "Subcategories can only be one level deep.");
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(categories)
        .where(and(eq(categories.userId, userId), eq(categories.parentId, id)));
      if (count > 0) throw new AppError("VALIDATION", "Move this category's subcategories first.");
    }
  }
  delete (input as Record<string, unknown>).kind; // kind is fixed after creation
  const [row] = await db.update(categories).set(input).where(and(eq(categories.id, id), eq(categories.userId, userId))).returning();
  return row;
}

export async function getCategory(userId: string, id: string, dbx: DbOrTx = db) {
  const [row] = await dbx.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId))).limit(1);
  if (!row) throw notFound("Category");
  return row;
}

/**
 * Delete a category. Its transactions (and subcategories' transactions) are moved to
 * `reassignTo` if given, otherwise left uncategorised. Runs atomically.
 */
export async function deleteCategory(userId: string, id: string, reassignTo?: string | null) {
  const cat = await getCategory(userId, id);
  const children = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.userId, userId), eq(categories.parentId, id)));
  const ids = [id, ...children.map((c) => c.id)];
  if (reassignTo) {
    if (ids.includes(reassignTo)) throw new AppError("VALIDATION", "Pick a different category to move transactions to.");
    const target = await getCategory(userId, reassignTo);
    if (target.kind !== cat.kind) throw new AppError("VALIDATION", "Move transactions to a category of the same type.");
  }
  await db.transaction(async (tx) => {
    const to = reassignTo ?? null;
    await tx.update(transactions).set({ categoryId: to }).where(and(eq(transactions.userId, userId), inArray(transactions.categoryId, ids)));
    await tx.update(transactionSplits).set({ categoryId: to }).where(and(eq(transactionSplits.userId, userId), inArray(transactionSplits.categoryId, ids)));
    await tx.update(recurringTransactions).set({ categoryId: to }).where(and(eq(recurringTransactions.userId, userId), inArray(recurringTransactions.categoryId, ids)));
    if (to) await tx.update(budgets).set({ categoryId: to }).where(and(eq(budgets.userId, userId), inArray(budgets.categoryId, ids)));
    await tx.update(merchants).set({ defaultCategoryId: to }).where(and(eq(merchants.userId, userId), inArray(merchants.defaultCategoryId, ids)));
    await tx.delete(categories).where(and(eq(categories.userId, userId), inArray(categories.id, ids)));
  });
}

export async function reorderCategories(userId: string, orderedIds: string[]) {
  await assertOwned(userId, { category: orderedIds });
  await db.transaction(async (tx) => {
    for (const [i, cid] of orderedIds.entries()) {
      await tx.update(categories).set({ sortOrder: i }).where(and(eq(categories.id, cid), eq(categories.userId, userId)));
    }
  });
}

/** Category plus all of its subcategories (for "Food" budgets/filters including "Groceries"). */
export async function expandCategoryIds(userId: string, ids: string[], dbx: DbOrTx = db): Promise<string[]> {
  if (!ids.length) return [];
  const kids = await dbx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), inArray(categories.parentId, ids)));
  return [...new Set([...ids, ...kids.map((k) => k.id)])];
}

/* ───────────── Merchants ───────────── */

export const normalizeMerchant = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export async function findOrCreateMerchant(userId: string, rawName: string, dbx: DbOrTx = db) {
  const display = rawName.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!display) return null;
  const normalized = normalizeMerchant(display);
  const [existing] = await dbx
    .select()
    .from(merchants)
    .where(and(eq(merchants.userId, userId), eq(merchants.normalizedName, normalized)))
    .limit(1);
  if (existing) return existing;
  const [created] = await dbx
    .insert(merchants)
    .values({ userId, name: display, normalizedName: normalized })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await dbx.select().from(merchants).where(and(eq(merchants.userId, userId), eq(merchants.normalizedName, normalized))).limit(1);
  return raced ?? null;
}

export async function listMerchants(userId: string) {
  return db.select().from(merchants).where(eq(merchants.userId, userId)).orderBy(asc(merchants.name));
}

/** Merchant name suggestions, ranked by how often the user uses them. */
export async function suggestMerchants(userId: string, q: string, limit = 8) {
  const term = normalizeMerchant(q);
  const rows = await db.execute<{ id: string; name: string; default_category_id: string | null; uses: number }>(sql`
    SELECT m.id, m.name, m.default_category_id, count(t.id)::int AS uses
    FROM merchants m LEFT JOIN transactions t ON t.merchant_id = m.id AND t.deleted_at IS NULL
    WHERE m.user_id = ${userId} ${term ? sql`AND m.normalized_name LIKE ${"%" + term.replace(/[%_\\]/g, "\\$&") + "%"}` : sql``}
    GROUP BY m.id ORDER BY uses DESC, m.name ASC LIMIT ${limit}`);
  return rows.map((r) => ({ id: r.id, name: r.name, defaultCategoryId: r.default_category_id, uses: r.uses }));
}

export async function renameMerchant(userId: string, id: string, newName: string) {
  const display = newName.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!display) throw new AppError("VALIDATION", "Merchant name is required");
  const normalized = normalizeMerchant(display);
  const [clash] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(and(eq(merchants.userId, userId), eq(merchants.normalizedName, normalized)))
    .limit(1);
  if (clash && clash.id !== id) {
    // Merge into the existing merchant of that name.
    await db.transaction(async (tx) => {
      await tx.update(transactions).set({ merchantId: clash.id }).where(and(eq(transactions.userId, userId), eq(transactions.merchantId, id)));
      await tx.update(recurringTransactions).set({ merchantId: clash.id }).where(and(eq(recurringTransactions.userId, userId), eq(recurringTransactions.merchantId, id)));
      await tx.delete(merchants).where(and(eq(merchants.id, id), eq(merchants.userId, userId)));
    });
    return clash.id;
  }
  const [row] = await db
    .update(merchants)
    .set({ name: display, normalizedName: normalized })
    .where(and(eq(merchants.id, id), eq(merchants.userId, userId)))
    .returning({ id: merchants.id });
  if (!row) throw notFound("Merchant");
  return row.id;
}

/* ───────────── Payment methods ───────────── */

export const paymentMethodInput = z.object({
  name: name("Payment method", 40),
  type: z.enum(["cash", "bank_transfer", "debit_card", "credit_card", "upi", "wallet", "other"]),
  defaultAccountId: optionalId,
});

export async function listPaymentMethods(userId: string, opts: { includeArchived?: boolean } = {}) {
  return db
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.userId, userId), opts.includeArchived ? undefined : eq(paymentMethods.isArchived, false)))
    .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));
}

export async function createPaymentMethod(userId: string, raw: z.input<typeof paymentMethodInput>) {
  const input = paymentMethodInput.parse(raw);
  await assertOwned(userId, { account: input.defaultAccountId });
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${paymentMethods.sortOrder}), -1)::int` })
    .from(paymentMethods)
    .where(eq(paymentMethods.userId, userId));
  const [row] = await db.insert(paymentMethods).values({ ...input, userId, sortOrder: max + 1 }).returning();
  return row;
}

export async function updatePaymentMethod(userId: string, id: string, raw: Partial<z.input<typeof paymentMethodInput>> & { isArchived?: boolean }) {
  const input = paymentMethodInput.partial().extend({ isArchived: z.boolean().optional() }).parse(raw);
  await assertOwned(userId, { account: input.defaultAccountId });
  const [row] = await db.update(paymentMethods).set(input).where(and(eq(paymentMethods.id, id), eq(paymentMethods.userId, userId))).returning();
  if (!row) throw notFound("Payment method");
  return row;
}

export async function deletePaymentMethod(userId: string, id: string) {
  const [row] = await db.delete(paymentMethods).where(and(eq(paymentMethods.id, id), eq(paymentMethods.userId, userId))).returning({ id: paymentMethods.id });
  if (!row) throw notFound("Payment method");
}

/* ───────────── Tags ───────────── */

export async function listTags(userId: string) {
  return db.select().from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name));
}

export async function findOrCreateTags(userId: string, names: string[], dbx: DbOrTx = db) {
  const clean = [...new Map(names.map((n) => n.trim().replace(/^#/, "").slice(0, 30)).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
  if (!clean.length) return [];
  await dbx
    .insert(tags)
    .values(clean.map((n) => ({ userId, name: n })))
    .onConflictDoNothing();
  return dbx
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(sql`lower(${tags.name})`, clean.map((c) => c.toLowerCase()))));
}

export async function deleteTag(userId: string, id: string) {
  await db.delete(tags).where(and(eq(tags.id, id), eq(tags.userId, userId)));
}
