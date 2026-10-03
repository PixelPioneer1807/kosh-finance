/**
 * CSV import (server side). The client sends raw CSV cells plus the user's column mapping; this
 * service re-interprets every row with the same shared parser (src/lib/csv-import.ts), validates
 * it with the same `transactionInput` rules as manual entry, resolves accounts/categories only
 * from the user's own records, and bulk-inserts each chunk inside one DB transaction.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/server/db";
import { accounts, categories, importBatches, merchants, transactions } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import {
  IMPORT_CHUNK_SIZE,
  MAX_IMPORT_ROWS,
  duplicateKey,
  importMappingSchema,
  importParseOptionsSchema,
  interpretRow,
  type InterpretedRow,
} from "@/lib/csv-import";
import { mul } from "@/lib/money";
import { optionalId } from "@/lib/validation";
import { assertOwned } from "./ownership";
import { getPreferences, requireRate } from "./preferences";
import { normalizeMerchant } from "./taxonomy";
import { transactionInput } from "./transactions";

/* ───────────── Fingerprints ───────────── */

/** import_hash = sha256(userId|accountId|date|signedAmount|normalizedDescription) */
export function importHash(userId: string, accountId: string, date: string, type: string, amount: string, description: string | null | undefined) {
  return createHash("sha256").update(`${userId}|${duplicateKey(accountId, date, type, amount, description)}`).digest("hex");
}

/**
 * Of the given fingerprints, which already exist among the user's live transactions?
 * Matches previously imported rows by import_hash, and manually-entered ones by recomputing the
 * fingerprint from (account, date, amount, merchant or notes).
 */
async function existingFingerprints(
  dbx: Tx | typeof db,
  userId: string,
  items: { hash: string; accountId: string; date: string }[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (!items.length) return found;
  const hashes = [...new Set(items.map((i) => i.hash))];
  for (let i = 0; i < hashes.length; i += 1000) {
    const rows = await dbx
      .select({ h: transactions.importHash })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNull(transactions.deletedAt), inArray(transactions.importHash, hashes.slice(i, i + 1000))));
    for (const r of rows) if (r.h) found.add(r.h);
  }
  const accountIds = [...new Set(items.map((i) => i.accountId))];
  const dates = items.map((i) => i.date).sort();
  const manual = await dbx
    .select({ accountId: transactions.accountId, date: transactions.date, type: transactions.type, amount: transactions.amount, merchant: merchants.name, notes: transactions.notes })
    .from(transactions)
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        isNull(transactions.importHash),
        inArray(transactions.accountId, accountIds),
        inArray(transactions.type, ["expense", "income", "refund"]),
        gte(transactions.date, dates[0]),
        lte(transactions.date, dates[dates.length - 1]),
      ),
    );
  for (const t of manual) found.add(importHash(userId, t.accountId, t.date, t.type, t.amount, t.merchant ?? t.notes));
  return found;
}

/* ───────────── Batches ───────────── */

export async function startImportBatch(userId: string, input: { filename?: string | null; rowCount: number }) {
  if (input.rowCount < 1) throw new AppError("VALIDATION", "The file has no rows to import.");
  if (input.rowCount > MAX_IMPORT_ROWS) throw new AppError("VALIDATION", `Import up to ${MAX_IMPORT_ROWS.toLocaleString("en")} rows at a time — split the file.`);
  const [row] = await db
    .insert(importBatches)
    .values({ userId, filename: input.filename?.slice(0, 200) || null, rowCount: input.rowCount })
    .returning();
  return row;
}

async function getBatch(userId: string, batchId: string, dbx: Tx | typeof db = db) {
  const [b] = await dbx.select().from(importBatches).where(and(eq(importBatches.id, batchId), eq(importBatches.userId, userId))).limit(1);
  if (!b) throw notFound("Import");
  return b;
}

/** Removes a batch that ended up importing nothing (keeps the history list meaningful). */
export async function finishImportBatch(userId: string, batchId: string) {
  const b = await getBatch(userId, batchId);
  if (b.importedCount === 0) await db.delete(importBatches).where(and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)));
  return { ...b, removed: b.importedCount === 0 };
}

export async function listImportBatches(userId: string, limit = 20) {
  return db.select().from(importBatches).where(eq(importBatches.userId, userId)).orderBy(desc(importBatches.createdAt)).limit(limit);
}

/** Undo: permanently removes every transaction created by the batch. */
export async function undoImportBatch(userId: string, batchId: string) {
  return db.transaction(async (tx) => {
    const b = await getBatch(userId, batchId, tx);
    if (b.undoneAt) throw new AppError("CONFLICT", "This import was already undone.");
    const removed = await tx
      .delete(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.importBatchId, batchId)))
      .returning({ id: transactions.id });
    await tx.update(importBatches).set({ undoneAt: new Date() }).where(and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)));
    return { removed: removed.length };
  });
}

/* ───────────── Rows ───────────── */

export const importChunkInput = z.object({
  batchId: z.uuid(),
  mapping: importMappingSchema,
  options: importParseOptionsSchema.extend({
    /** Target account (used when there's no account column, or the row's account name doesn't match). */
    accountId: optionalId,
    defaultExpenseCategoryId: optionalId,
    defaultIncomeCategoryId: optionalId,
    /** Create categories that don't exist yet (otherwise they import as uncategorised/default). */
    createCategories: z.boolean().default(false),
    skipDuplicates: z.boolean().default(true),
    /** Line numbers the user chose to import even though they look like duplicates. */
    forceLines: z.array(z.number().int().min(0)).max(MAX_IMPORT_ROWS).default([]),
  }),
  rows: z
    .array(z.object({ line: z.number().int().min(0).max(MAX_IMPORT_ROWS + 10), cells: z.array(z.string().max(2000)).max(100) }))
    .min(1)
    .max(IMPORT_CHUNK_SIZE),
});
export type ImportChunkInput = z.input<typeof importChunkInput>;

export type RowResult = { line: number; status: "imported" | "duplicate" | "error"; message?: string };

type CatRow = { id: string; name: string; kind: "expense" | "income"; parentId: string | null };

function categoryResolver(cats: CatRow[]) {
  const lower = (s: string) => s.trim().toLowerCase();
  const byId = new Map(cats.map((c) => [c.id, c]));
  return (kind: "expense" | "income", ref: { parent: string | null; name: string }): CatRow | null => {
    const sameKind = cats.filter((c) => c.kind === kind);
    if (ref.parent) {
      const parent = sameKind.find((c) => !c.parentId && lower(c.name) === lower(ref.parent!));
      const child = parent && sameKind.find((c) => c.parentId === parent.id && lower(c.name) === lower(ref.name));
      if (child) return child;
      // Parent spelled differently ("Food" vs "Food & Dining"): fall back to a uniquely-named subcategory.
      const kids = sameKind.filter((c) => c.parentId && lower(c.name) === lower(ref.name));
      return kids.length === 1 ? kids[0] : null;
    }
    // Top-level match first, then a uniquely-named subcategory.
    const top = sameKind.find((c) => !c.parentId && lower(c.name) === lower(ref.name));
    if (top) return top;
    const kids = sameKind.filter((c) => c.parentId && byId.has(c.parentId) && lower(c.name) === lower(ref.name));
    return kids.length === 1 ? kids[0] : null;
  };
}

async function ensureCategory(tx: Tx, userId: string, kind: "expense" | "income", ref: { parent: string | null; name: string }, cats: CatRow[]): Promise<CatRow> {
  const resolve = categoryResolver(cats);
  let parentId: string | null = null;
  if (ref.parent) {
    const p = resolve(kind, { parent: null, name: ref.parent });
    parentId = p && !p.parentId ? p.id : (await ensureCategory(tx, userId, kind, { parent: null, name: ref.parent }, cats)).id;
  }
  const [created] = await tx
    .insert(categories)
    .values({ userId, kind, name: ref.name.trim().slice(0, 50), parentId, sortOrder: 1000 })
    .onConflictDoNothing()
    .returning({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId });
  const row =
    created ??
    (
      await tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId })
        .from(categories)
        .where(
          and(
            eq(categories.userId, userId),
            eq(categories.kind, kind),
            parentId ? eq(categories.parentId, parentId) : isNull(categories.parentId),
            sql`lower(${categories.name}) = ${ref.name.trim().toLowerCase()}`,
          ),
        )
        .limit(1)
    )[0];
  cats.push(row);
  return row;
}

/**
 * Import one chunk (≤ 500 rows) into an existing batch, atomically. Rows that fail validation
 * are reported, never half-written; duplicates are skipped unless forced.
 */
export async function importChunk(userId: string, raw: ImportChunkInput) {
  const input = importChunkInput.parse(raw);
  const { options, mapping } = input;
  if (options.amountMode === "signed" && mapping.amount === null) throw new AppError("VALIDATION", "Choose the amount column.");
  if (options.amountMode === "split" && mapping.debit === null && mapping.credit === null) throw new AppError("VALIDATION", "Choose the debit and/or credit column.");
  if (!options.accountId && mapping.account === null) throw new AppError("VALIDATION", "Choose the account to import into.");
  // Every id the client supplies must belong to this user.
  await assertOwned(userId, { account: options.accountId, category: [options.defaultExpenseCategoryId, options.defaultIncomeCategoryId].filter(Boolean) as string[] });

  return db.transaction(async (tx) => {
    const batch = await getBatch(userId, input.batchId, tx);
    if (batch.undoneAt) throw new AppError("CONFLICT", "This import was undone. Start a new import.");
    const prefs = await getPreferences(userId, tx);
    const userAccounts = await tx
      .select({ id: accounts.id, name: accounts.name, currency: accounts.currency, isArchived: accounts.isArchived })
      .from(accounts)
      .where(eq(accounts.userId, userId));
    const cats: CatRow[] = await tx
      .select({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.userId, userId));
    const defaults = {
      expense: cats.find((c) => c.id === options.defaultExpenseCategoryId) ?? null,
      income: cats.find((c) => c.id === options.defaultIncomeCategoryId) ?? null,
    };
    if (defaults.expense && defaults.expense.kind !== "expense") throw new AppError("VALIDATION", "The default expense category must be an expense category.");
    if (defaults.income && defaults.income.kind !== "income") throw new AppError("VALIDATION", "The default income category must be an income category.");
    const accountByName = new Map(userAccounts.map((a) => [a.name.trim().toLowerCase(), a]));
    const fallbackAccount = userAccounts.find((a) => a.id === options.accountId) ?? null;
    const resolveCat = categoryResolver(cats);
    const rates = new Map<string, string>();
    const forced = new Set(options.forceLines);

    const results: RowResult[] = [];
    type Ready = { line: number; values: typeof transactions.$inferInsert; merchant: string | null; hash: string };
    const ready: Ready[] = [];

    for (const r of input.rows) {
      const draft: InterpretedRow = interpretRow(r.cells, mapping, options);
      if (draft.errors.length) {
        results.push({ line: r.line, status: "error", message: draft.errors.join("; ") });
        continue;
      }
      let account = fallbackAccount;
      if (draft.accountName) {
        const named = accountByName.get(draft.accountName.toLowerCase());
        if (named) account = named;
        else if (!fallbackAccount) {
          results.push({ line: r.line, status: "error", message: `No account named "${draft.accountName.slice(0, 40)}"` });
          continue;
        }
      }
      if (!account) {
        results.push({ line: r.line, status: "error", message: "No account for this row" });
        continue;
      }
      const kind = draft.type === "income" ? "income" : "expense";
      let cat: CatRow | null = null;
      if (draft.category) {
        cat = resolveCat(kind, draft.category);
        if (!cat && options.createCategories) cat = await ensureCategory(tx, userId, kind, draft.category, cats);
      }
      cat ??= defaults[kind];

      // Same validation as manual entry.
      const parsed = transactionInput.safeParse({
        type: draft.type,
        accountId: account.id,
        amount: draft.amount,
        date: draft.date,
        categoryId: cat?.id ?? null,
        merchant: draft.merchant,
        notes: draft.notes,
      });
      if (!parsed.success) {
        results.push({ line: r.line, status: "error", message: parsed.error.issues.map((i) => i.message).join("; ") });
        continue;
      }
      const t = parsed.data;
      if (t.date < "1970-01-01" || t.date > "2200-12-31") {
        results.push({ line: r.line, status: "error", message: "Date is out of range" });
        continue;
      }
      let rate = rates.get(account.currency);
      if (!rate) {
        try {
          rate = await requireRate(userId, account.currency, prefs.currency, tx);
        } catch (e) {
          results.push({ line: r.line, status: "error", message: e instanceof AppError ? e.message : "Missing exchange rate" });
          continue;
        }
        rates.set(account.currency, rate);
      }
      const hash = importHash(userId, account.id, t.date, t.type, t.amount, t.merchant ?? t.notes);
      ready.push({
        line: r.line,
        hash,
        merchant: t.merchant,
        values: {
          userId,
          type: t.type,
          accountId: account.id,
          amount: t.amount,
          currency: account.currency,
          fxRate: rate,
          baseAmount: mul(t.amount, rate),
          date: t.date,
          categoryId: t.categoryId,
          notes: t.notes,
          source: "import",
          importBatchId: batch.id,
          importHash: hash,
        },
      });
    }

    // Duplicates: against existing data and within this chunk.
    const existing = ready.length ? await existingFingerprints(tx, userId, ready.map((r) => ({ hash: r.hash, accountId: r.values.accountId, date: r.values.date }))) : new Set<string>();
    const seen = new Set<string>();
    const toInsert: Ready[] = [];
    for (const r of ready) {
      const dup = existing.has(r.hash) || seen.has(r.hash);
      seen.add(r.hash);
      if (dup && options.skipDuplicates && !forced.has(r.line)) {
        results.push({ line: r.line, status: "duplicate", message: existing.has(r.hash) ? "Already in your transactions" : "Repeated in this file" });
        continue;
      }
      toInsert.push(r);
    }

    // Merchants: bulk find-or-create.
    const names = new Map<string, string>();
    for (const r of toInsert) if (r.merchant) names.set(normalizeMerchant(r.merchant), r.merchant);
    const merchantIds = new Map<string, string>();
    if (names.size) {
      const normalized = [...names.keys()];
      await tx
        .insert(merchants)
        .values(normalized.map((n) => ({ userId, name: names.get(n)!, normalizedName: n })))
        .onConflictDoNothing();
      for (let i = 0; i < normalized.length; i += 1000) {
        const rows = await tx
          .select({ id: merchants.id, n: merchants.normalizedName })
          .from(merchants)
          .where(and(eq(merchants.userId, userId), inArray(merchants.normalizedName, normalized.slice(i, i + 1000))));
        for (const m of rows) merchantIds.set(m.n, m.id);
      }
    }
    if (toInsert.length) {
      await tx.insert(transactions).values(toInsert.map((r) => ({ ...r.values, merchantId: r.merchant ? (merchantIds.get(normalizeMerchant(r.merchant)) ?? null) : null })));
    }
    for (const r of toInsert) results.push({ line: r.line, status: "imported" });

    const imported = toInsert.length;
    const skipped = results.length - imported;
    await tx
      .update(importBatches)
      .set({ importedCount: sql`${importBatches.importedCount} + ${imported}`, skippedCount: sql`${importBatches.skippedCount} + ${skipped}` })
      .where(and(eq(importBatches.id, batch.id), eq(importBatches.userId, userId)));

    results.sort((a, b) => a.line - b.line);
    return {
      imported,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      errors: results.filter((r) => r.status === "error").length,
      rows: results.filter((r) => r.status !== "imported"),
    };
  });
}

/**
 * Preview helper: which of these rows already exist (by fingerprint)? Accounts are checked for
 * ownership; rows referencing anything else are ignored.
 */
export const duplicateCheckInput = z.object({
  rows: z
    .array(z.object({ line: z.number().int().min(0), accountId: z.uuid(), date: z.string().max(10), type: z.enum(["expense", "income", "refund"]), amount: z.string().max(40), description: z.string().max(2000).nullable() }))
    .max(2000),
});

export async function findExistingDuplicates(userId: string, raw: z.input<typeof duplicateCheckInput>) {
  const { rows } = duplicateCheckInput.parse(raw);
  if (!rows.length) return [];
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const owned = new Set(
    (await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, userId), inArray(accounts.id, accountIds)))).map((a) => a.id),
  );
  const items = rows
    .filter((r) => owned.has(r.accountId) && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .flatMap((r) => {
      try {
        return [{ line: r.line, accountId: r.accountId, date: r.date, hash: importHash(userId, r.accountId, r.date, r.type, r.amount, r.description) }];
      } catch {
        return [];
      }
    });
  const found = await existingFingerprints(db, userId, items);
  return items.filter((i) => found.has(i.hash)).map((i) => i.line);
}
