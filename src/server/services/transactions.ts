import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type DbOrTx, type Tx } from "@/server/db";
import {
  accounts,
  categories,
  merchants,
  paymentMethods,
  receipts,
  transactionSplits,
  transactions,
  transactionTags,
} from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { add, cmp, isZero, mul, normalize, sub, toUnits } from "@/lib/money";
import { currencyCode, id, isoDate, optionalId, optionalMoney, optionalText, positiveMoney, signedMoney } from "@/lib/validation";
import { getAccount } from "./accounts";
import { assertOwned } from "./ownership";
import { getPreferences, requireRate } from "./preferences";
import { expandCategoryIds, findOrCreateMerchant, findOrCreateTags } from "./taxonomy";

export const TRANSACTION_TYPES = ["expense", "income", "transfer", "refund", "adjustment"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const splitInput = z.object({
  categoryId: id,
  amount: positiveMoney,
  notes: optionalText(200),
});

export const transactionInput = z
  .object({
    type: z.enum(TRANSACTION_TYPES),
    accountId: id,
    amount: signedMoney,
    date: isoDate,
    categoryId: optionalId,
    merchant: optionalText(80),
    paymentMethodId: optionalId,
    notes: optionalText(1000),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
    toAccountId: optionalId,
    toAmount: optionalMoney,
    refundOfId: optionalId,
    splits: z.array(splitInput).max(50).default([]),
    isPending: z.boolean().default(false),
    originalAmount: optionalMoney,
    originalCurrency: z.union([z.literal(""), z.null(), currencyCode]).optional().transform((v) => v || null),
    /** Optional override of the conversion rate into the base currency. */
    fxRate: z
      .union([z.literal(""), z.null(), z.string().regex(/^\d+(\.\d{1,10})?$/, "Invalid rate")])
      .optional()
      .transform((v) => v || null),
    receiptId: optionalId,
  })
  .superRefine((v, ctx) => {
    if (v.type !== "adjustment" && toUnits(v.amount) <= BigInt(0))
      ctx.addIssue({ code: "custom", path: ["amount"], message: "Amount must be greater than zero" });
    if (v.type === "adjustment" && isZero(v.amount)) ctx.addIssue({ code: "custom", path: ["amount"], message: "Adjustment can't be zero" });
    if (v.type === "transfer") {
      if (!v.toAccountId) ctx.addIssue({ code: "custom", path: ["toAccountId"], message: "Choose the account the money goes to" });
      if (v.toAccountId === v.accountId) ctx.addIssue({ code: "custom", path: ["toAccountId"], message: "Pick two different accounts" });
    }
    if (v.splits.length === 1) ctx.addIssue({ code: "custom", path: ["splits"], message: "A split needs at least two parts" });
    if (v.splits.length > 1) {
      if (v.type !== "expense" && v.type !== "income")
        ctx.addIssue({ code: "custom", path: ["splits"], message: "Only expenses and income can be split" });
      const total = add(...v.splits.map((s) => s.amount));
      if (cmp(total, v.amount) !== 0)
        ctx.addIssue({ code: "custom", path: ["splits"], message: `Split parts must add up to the total (${normalize(v.amount)}), they add up to ${total}` });
    }
  });

export type TransactionInput = z.input<typeof transactionInput>;

type CreateOpts = {
  source?: (typeof transactions.$inferInsert)["source"];
  recurringId?: string | null;
  recurringDate?: string | null;
  importBatchId?: string | null;
  importHash?: string | null;
};

/** Validates every rule that needs the database (ownership, kinds, refund caps, FX). */
async function prepare(tx: Tx, userId: string, input: z.output<typeof transactionInput>, editingId?: string) {
  const prefs = await getPreferences(userId, tx);
  const account = await getAccount(userId, input.accountId, tx);
  await assertOwned(
    userId,
    {
      category: [input.categoryId, ...input.splits.map((s) => s.categoryId)].filter(Boolean) as string[],
      paymentMethod: input.paymentMethodId,
      toAccount: input.type === "transfer" ? input.toAccountId : null,
      transaction: input.refundOfId,
    },
    tx,
  );

  const isTransfer = input.type === "transfer";
  let categoryId = isTransfer ? null : input.categoryId;
  let toAmount: string | null = null;
  let refundOfId: string | null = null;

  if (isTransfer) {
    const to = await getAccount(userId, input.toAccountId!, tx);
    if (to.currency === account.currency) toAmount = input.toAmount ?? input.amount;
    else {
      if (!input.toAmount || isZero(input.toAmount))
        throw new AppError("VALIDATION", `Enter the amount received in ${to.currency}.`, { toAmount: ["Required for cross-currency transfers"] });
      toAmount = input.toAmount;
    }
  }

  if (input.type === "refund" && input.refundOfId) {
    const [orig] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, input.refundOfId), eq(transactions.userId, userId), isNull(transactions.deletedAt)))
      .limit(1);
    if (!orig) throw notFound("Original transaction");
    if (orig.type !== "expense") throw new AppError("VALIDATION", "Only expenses can be refunded.");
    refundOfId = orig.id;
    categoryId ??= orig.categoryId;
    const origAccount = await getAccount(userId, orig.accountId, tx);
    if (origAccount.currency === account.currency) {
      const [{ refunded }] = await tx
        .select({ refunded: sql<string>`coalesce(sum(${transactions.amount}), 0)::text` })
        .from(transactions)
        .where(
          and(
            eq(transactions.refundOfId, orig.id),
            isNull(transactions.deletedAt),
            editingId ? ne(transactions.id, editingId) : undefined,
          ),
        );
      const remaining = sub(orig.amount, refunded);
      if (cmp(input.amount, remaining) > 0)
        throw new AppError("VALIDATION", `Refunds can't exceed the original amount. Up to ${normalize(remaining)} can still be refunded.`, {
          amount: ["Exceeds refundable amount"],
        });
    }
  }

  // Category kind must match the transaction direction.
  const catIds = [categoryId, ...input.splits.map((s) => s.categoryId)].filter(Boolean) as string[];
  if (catIds.length && input.type !== "adjustment") {
    const wantKind = input.type === "income" ? "income" : "expense";
    const rows = await tx
      .select({ id: categories.id, kind: categories.kind })
      .from(categories)
      .where(and(eq(categories.userId, userId), inArray(categories.id, catIds)));
    if (rows.some((r) => r.kind !== wantKind))
      throw new AppError("VALIDATION", `Choose ${wantKind === "income" ? "an income" : "an expense"} category.`, { categoryId: ["Wrong category type"] });
  }

  const fxRate = input.fxRate ?? (await requireRate(userId, account.currency, prefs.currency, tx));
  const baseAmount = mul(input.amount, fxRate);

  let merchantId: string | null = null;
  if (input.merchant && !isTransfer) {
    const m = await findOrCreateMerchant(userId, input.merchant, tx);
    merchantId = m?.id ?? null;
    // Learn the user's preferred category for this merchant (powers auto-categorisation).
    if (m && categoryId && input.type === "expense" && input.splits.length === 0 && m.defaultCategoryId !== categoryId)
      await tx.update(merchants).set({ defaultCategoryId: categoryId }).where(eq(merchants.id, m.id));
  }

  const hasSplits = input.splits.length > 1;
  return {
    values: {
      userId,
      type: input.type,
      accountId: account.id,
      amount: normalize(input.amount),
      currency: account.currency,
      fxRate,
      baseAmount,
      originalAmount: input.originalCurrency && input.originalCurrency !== account.currency ? input.originalAmount : null,
      originalCurrency: input.originalCurrency && input.originalCurrency !== account.currency ? input.originalCurrency : null,
      date: input.date,
      categoryId: hasSplits ? null : categoryId,
      merchantId,
      paymentMethodId: isTransfer ? null : input.paymentMethodId,
      notes: input.notes,
      toAccountId: isTransfer ? input.toAccountId : null,
      toAmount,
      refundOfId,
      hasSplits,
      isPending: input.isPending,
    },
    splits: hasSplits ? input.splits : [],
    fxRate,
    baseAmount,
  };
}

async function writeChildren(
  tx: Tx,
  userId: string,
  txnId: string,
  prepared: Awaited<ReturnType<typeof prepare>>,
  tagNames: string[],
  receiptId: string | null,
) {
  await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, txnId));
  if (prepared.splits.length) {
    // Convert each split to base currency; put any rounding remainder on the last split so
    // the split base amounts always add up exactly to the transaction's base amount.
    const bases = prepared.splits.map((s) => mul(s.amount, prepared.fxRate));
    const drift = sub(prepared.baseAmount, add(...bases));
    bases[bases.length - 1] = add(bases[bases.length - 1], drift);
    await tx.insert(transactionSplits).values(
      prepared.splits.map((s, i) => ({ userId, transactionId: txnId, categoryId: s.categoryId, amount: s.amount, baseAmount: bases[i], notes: s.notes, sortOrder: i })),
    );
  }
  await tx.delete(transactionTags).where(eq(transactionTags.transactionId, txnId));
  if (tagNames.length) {
    const t = await findOrCreateTags(userId, tagNames, tx);
    if (t.length) await tx.insert(transactionTags).values(t.map((tag) => ({ transactionId: txnId, tagId: tag.id, userId })));
  }
  if (receiptId) {
    const updated = await tx
      .update(receipts)
      .set({ transactionId: txnId })
      .where(and(eq(receipts.id, receiptId), eq(receipts.userId, userId)))
      .returning({ id: receipts.id });
    if (!updated.length) throw notFound("Receipt");
  }
}

export async function createTransaction(userId: string, raw: TransactionInput, opts: CreateOpts = {}, dbx?: Tx) {
  const input = transactionInput.parse(raw);
  const run = async (tx: Tx) => {
    const prepared = await prepare(tx, userId, input);
    const [row] = await tx
      .insert(transactions)
      .values({
        ...prepared.values,
        source: opts.source ?? "manual",
        recurringId: opts.recurringId ?? null,
        recurringDate: opts.recurringDate ?? null,
        importBatchId: opts.importBatchId ?? null,
        importHash: opts.importHash ?? null,
      })
      .returning();
    await writeChildren(tx, userId, row.id, prepared, input.tags, input.receiptId);
    return row;
  };
  return dbx ? run(dbx) : db.transaction(run);
}

export async function updateTransaction(userId: string, txnId: string, raw: TransactionInput) {
  const input = transactionInput.parse(raw);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.id, txnId), eq(transactions.userId, userId), isNull(transactions.deletedAt)))
      .for("update")
      .limit(1);
    if (!existing) throw notFound("Transaction");
    if (input.refundOfId === txnId) throw new AppError("VALIDATION", "A transaction can't refund itself.");
    const prepared = await prepare(tx, userId, input, txnId);
    const [row] = await tx.update(transactions).set(prepared.values).where(and(eq(transactions.id, txnId), eq(transactions.userId, userId))).returning();
    await writeChildren(tx, userId, txnId, prepared, input.tags, input.receiptId);
    return row;
  });
}

/** Soft delete so the UI can offer "Undo". Purged permanently after 30 days. */
export async function deleteTransaction(userId: string, txnId: string) {
  const [row] = await db
    .update(transactions)
    .set({ deletedAt: new Date() })
    .where(and(eq(transactions.id, txnId), eq(transactions.userId, userId), isNull(transactions.deletedAt)))
    .returning({ id: transactions.id });
  if (!row) throw notFound("Transaction");
}

export async function deleteTransactions(userId: string, ids: string[]) {
  if (!ids.length) return 0;
  const rows = await db
    .update(transactions)
    .set({ deletedAt: new Date() })
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids), isNull(transactions.deletedAt)))
    .returning({ id: transactions.id });
  return rows.length;
}

export async function restoreTransactions(userId: string, ids: string[]) {
  if (!ids.length) return 0;
  const rows = await db
    .update(transactions)
    .set({ deletedAt: null })
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids), isNotNull(transactions.deletedAt)))
    .returning({ id: transactions.id });
  return rows.length;
}

export async function bulkCategorize(userId: string, ids: string[], categoryId: string | null) {
  if (categoryId) await assertOwned(userId, { category: categoryId });
  const rows = await db
    .update(transactions)
    .set({ categoryId })
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids), eq(transactions.hasSplits, false), inArray(transactions.type, ["expense", "income", "refund"])))
    .returning({ id: transactions.id });
  return rows.length;
}

export async function duplicateTransaction(userId: string, txnId: string, date?: string) {
  const t = await getTransaction(userId, txnId);
  const prefs = await getPreferences(userId);
  return createTransaction(userId, {
    type: t.type,
    accountId: t.accountId,
    amount: t.amount,
    date: date ?? prefs.today,
    categoryId: t.categoryId,
    merchant: t.merchantName,
    paymentMethodId: t.paymentMethodId,
    notes: t.notes,
    tags: t.tags.map((x) => x.name),
    toAccountId: t.toAccountId,
    toAmount: t.toAmount,
    refundOfId: t.refundOfId,
    splits: t.splits.map((s) => ({ categoryId: s.categoryId!, amount: s.amount, notes: s.notes })).filter((s) => s.categoryId),
    isPending: false,
    originalAmount: t.originalAmount,
    originalCurrency: t.originalCurrency,
    fxRate: t.fxRate,
  });
}

/** Record a refund against an expense (full by default). */
export async function refundTransaction(userId: string, originalId: string, opts: { amount?: string; date?: string; accountId?: string; notes?: string | null } = {}) {
  const orig = await getTransaction(userId, originalId);
  if (orig.type !== "expense") throw new AppError("VALIDATION", "Only expenses can be refunded.");
  const prefs = await getPreferences(userId);
  const remaining = sub(orig.amount, orig.refundedAmount);
  return createTransaction(userId, {
    type: "refund",
    accountId: opts.accountId ?? orig.accountId,
    amount: opts.amount ?? remaining,
    date: opts.date ?? prefs.today,
    categoryId: orig.categoryId ?? orig.splits[0]?.categoryId ?? null,
    merchant: orig.merchantName,
    paymentMethodId: orig.paymentMethodId,
    notes: opts.notes ?? null,
    refundOfId: orig.id,
  });
}

/* ───────────── Reading ───────────── */

const toAcc = alias(accounts, "to_acc");
const parentCat = alias(categories, "parent_cat");

const listColumns = {
  id: transactions.id,
  type: transactions.type,
  accountId: transactions.accountId,
  accountName: accounts.name,
  amount: transactions.amount,
  currency: transactions.currency,
  fxRate: transactions.fxRate,
  baseAmount: transactions.baseAmount,
  originalAmount: transactions.originalAmount,
  originalCurrency: transactions.originalCurrency,
  date: transactions.date,
  categoryId: transactions.categoryId,
  categoryName: categories.name,
  categoryIcon: categories.icon,
  categoryColor: categories.color,
  parentCategoryName: parentCat.name,
  merchantId: transactions.merchantId,
  merchantName: merchants.name,
  paymentMethodId: transactions.paymentMethodId,
  paymentMethodName: paymentMethods.name,
  notes: transactions.notes,
  toAccountId: transactions.toAccountId,
  toAccountName: toAcc.name,
  toAmount: transactions.toAmount,
  toCurrency: toAcc.currency,
  refundOfId: transactions.refundOfId,
  recurringId: transactions.recurringId,
  hasSplits: transactions.hasSplits,
  isPending: transactions.isPending,
  source: transactions.source,
  createdAt: transactions.createdAt,
  tags: sql<{ id: string; name: string }[]>`coalesce((
    SELECT json_agg(json_build_object('id', tg.id, 'name', tg.name) ORDER BY tg.name)
    FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ${transactions.id}), '[]'::json)`,
  refundedAmount: sql<string>`(SELECT coalesce(sum(r.amount), 0)::text FROM transactions r
    WHERE r.refund_of_id = ${transactions.id} AND r.deleted_at IS NULL)`,
  receiptCount: sql<number>`(SELECT count(*)::int FROM receipts rc WHERE rc.transaction_id = ${transactions.id})`,
  splits: sql<{ id: string; categoryId: string | null; categoryName: string | null; categoryColor: string | null; amount: string; notes: string | null }[]>`coalesce((
    SELECT json_agg(json_build_object('id', s.id, 'categoryId', s.category_id, 'categoryName', sc.name, 'categoryColor', sc.color, 'amount', s.amount::text, 'notes', s.notes) ORDER BY s.sort_order)
    FROM transaction_splits s LEFT JOIN categories sc ON sc.id = s.category_id WHERE s.transaction_id = ${transactions.id}), '[]'::json)`,
};

function baseQuery(dbx: DbOrTx = db) {
  return dbx
    .select(listColumns)
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(toAcc, eq(toAcc.id, transactions.toAccountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(parentCat, eq(parentCat.id, categories.parentId))
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .leftJoin(paymentMethods, eq(paymentMethods.id, transactions.paymentMethodId));
}

export type TransactionRow = Awaited<ReturnType<typeof listTransactions>>["rows"][number];

export async function getTransaction(userId: string, txnId: string) {
  const [row] = await baseQuery()
    .where(and(eq(transactions.id, txnId), eq(transactions.userId, userId), isNull(transactions.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Transaction");
  const [refunds, files] = await Promise.all([
    db
      .select({ id: transactions.id, amount: transactions.amount, date: transactions.date })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.refundOfId, txnId), isNull(transactions.deletedAt)))
      .orderBy(asc(transactions.date)),
    db
      .select({ id: receipts.id, filename: receipts.filename, mimeType: receipts.mimeType, sizeBytes: receipts.sizeBytes })
      .from(receipts)
      .where(and(eq(receipts.userId, userId), eq(receipts.transactionId, txnId))),
  ]);
  return { ...row, refunds, receipts: files };
}

export const transactionFilters = z.object({
  q: z.string().trim().max(100).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  types: z.array(z.enum(TRANSACTION_TYPES)).optional(),
  accountIds: z.array(z.uuid()).optional(),
  categoryIds: z.array(z.uuid()).optional(),
  merchantIds: z.array(z.uuid()).optional(),
  paymentMethodIds: z.array(z.uuid()).optional(),
  tagIds: z.array(z.uuid()).optional(),
  minAmount: z.string().optional(),
  maxAmount: z.string().optional(),
  recurring: z.boolean().optional(),
  refunded: z.boolean().optional(),
  hasReceipt: z.boolean().optional(),
  pending: z.boolean().optional(),
  uncategorized: z.boolean().optional(),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).optional(),
});
export type TransactionFilters = z.infer<typeof transactionFilters>;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

async function buildWhere(userId: string, f: TransactionFilters): Promise<SQL> {
  const conds: (SQL | undefined)[] = [eq(transactions.userId, userId), isNull(transactions.deletedAt)];
  if (f.from) conds.push(gte(transactions.date, f.from));
  if (f.to) conds.push(lte(transactions.date, f.to));
  if (f.types?.length) conds.push(inArray(transactions.type, f.types));
  if (f.accountIds?.length) conds.push(or(inArray(transactions.accountId, f.accountIds), inArray(transactions.toAccountId, f.accountIds)));
  if (f.merchantIds?.length) conds.push(inArray(transactions.merchantId, f.merchantIds));
  if (f.paymentMethodIds?.length) conds.push(inArray(transactions.paymentMethodId, f.paymentMethodIds));
  if (f.categoryIds?.length) {
    const ids = await expandCategoryIds(userId, f.categoryIds);
    conds.push(
      or(
        inArray(transactions.categoryId, ids),
        sql`EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = ${transactions.id} AND s.category_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}))`,
      ),
    );
  }
  if (f.tagIds?.length)
    conds.push(sql`EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = ${transactions.id} AND tt.tag_id IN (${sql.join(f.tagIds.map((i) => sql`${i}`), sql`, `)}))`);
  const minA = safeAmount(f.minAmount);
  const maxA = safeAmount(f.maxAmount);
  if (minA) conds.push(sql`abs(${transactions.amount}) >= ${minA}`);
  if (maxA) conds.push(sql`abs(${transactions.amount}) <= ${maxA}`);
  if (f.recurring !== undefined) conds.push(f.recurring ? isNotNull(transactions.recurringId) : isNull(transactions.recurringId));
  if (f.refunded !== undefined) {
    const exists = sql`EXISTS (SELECT 1 FROM transactions r WHERE r.refund_of_id = ${transactions.id} AND r.deleted_at IS NULL)`;
    conds.push(f.refunded ? or(exists, eq(transactions.type, "refund")) : sql`NOT ${exists}`);
  }
  if (f.hasReceipt !== undefined) {
    const exists = sql`EXISTS (SELECT 1 FROM receipts rc WHERE rc.transaction_id = ${transactions.id})`;
    conds.push(f.hasReceipt ? exists : sql`NOT ${exists}`);
  }
  if (f.pending !== undefined) conds.push(eq(transactions.isPending, f.pending));
  if (f.uncategorized) conds.push(and(isNull(transactions.categoryId), eq(transactions.hasSplits, false), inArray(transactions.type, ["expense", "income"])));
  if (f.q) {
    const term = `%${likeEscape(f.q.toLowerCase())}%`;
    const amount = safeAmount(f.q.replace(/[^\d.]/g, "") || undefined);
    conds.push(
      or(
        sql`lower(${merchants.name}) LIKE ${term}`,
        sql`lower(${transactions.notes}) LIKE ${term}`,
        sql`lower(${categories.name}) LIKE ${term}`,
        sql`lower(${parentCat.name}) LIKE ${term}`,
        sql`lower(${accounts.name}) LIKE ${term}`,
        sql`lower(${paymentMethods.name}) LIKE ${term}`,
        sql`EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ${transactions.id} AND lower(tg.name) LIKE ${term})`,
        amount && /^\s*[\d.,]+\s*$/.test(f.q) ? sql`${transactions.amount} = ${amount}` : undefined,
      ),
    );
  }
  return and(...conds)!;
}

function safeAmount(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const n = normalize(v);
    return toUnits(n) >= BigInt(0) ? n : null;
  } catch {
    return null;
  }
}

export async function listTransactions(userId: string, filters: TransactionFilters = {}, page: { limit?: number; offset?: number } = {}) {
  const f = transactionFilters.parse(filters);
  const limit = Math.min(Math.max(page.limit ?? 50, 1), 500);
  const offset = Math.max(page.offset ?? 0, 0);
  const where = await buildWhere(userId, f);
  const order =
    f.sort === "amount_desc"
      ? [desc(transactions.baseAmount), desc(transactions.date)]
      : f.sort === "amount_asc"
        ? [asc(transactions.baseAmount), desc(transactions.date)]
        : f.sort === "date_asc"
          ? [asc(transactions.date), asc(transactions.createdAt)]
          : [desc(transactions.date), desc(transactions.createdAt)];
  const rows = await baseQuery()
    .where(where)
    .orderBy(...order)
    .limit(limit + 1)
    .offset(offset);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit, nextOffset: offset + limit };
}

/** Totals for the current filter (base currency). Transfers are excluded from income/spending. */
export async function summarizeTransactions(userId: string, filters: TransactionFilters = {}) {
  const f = transactionFilters.parse(filters);
  const where = await buildWhere(userId, f);
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      income: sql<string>`coalesce(sum(${transactions.baseAmount}) FILTER (WHERE ${transactions.type} = 'income'), 0)::text`,
      expenses: sql<string>`coalesce(sum(${transactions.baseAmount}) FILTER (WHERE ${transactions.type} = 'expense'), 0)::text`,
      refunds: sql<string>`coalesce(sum(${transactions.baseAmount}) FILTER (WHERE ${transactions.type} = 'refund'), 0)::text`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(toAcc, eq(toAcc.id, transactions.toAccountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(parentCat, eq(parentCat.id, categories.parentId))
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .leftJoin(paymentMethods, eq(paymentMethods.id, transactions.paymentMethodId))
    .where(where);
  const spending = sub(row.expenses, row.refunds);
  return { count: row.count, income: normalize(row.income), expenses: normalize(row.expenses), refunds: normalize(row.refunds), spending, net: sub(row.income, spending) };
}

/** Suggest a category for a merchant name from the user's own history. */
export async function suggestCategoryForMerchant(userId: string, merchantName: string) {
  const normalized = merchantName.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return null;
  const [m] = await db
    .select({ categoryId: merchants.defaultCategoryId })
    .from(merchants)
    .where(and(eq(merchants.userId, userId), eq(merchants.normalizedName, normalized)))
    .limit(1);
  return m?.categoryId ?? null;
}

export async function recentTransactions(userId: string, limit = 8) {
  return (await listTransactions(userId, {}, { limit })).rows;
}

