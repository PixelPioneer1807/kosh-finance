/**
 * Full JSON backup & restore.
 *
 * Export: a versioned snapshot of everything the user owns (no secrets, sessions, password hash
 * or receipt bytes — receipts appear as metadata only).
 *
 * Restore: the file is untrusted input. It's validated with Zod, every id in it is treated as an
 * opaque local key and remapped to a fresh UUID, every row is written with the *current* user's
 * id, and references that don't resolve inside the file are dropped (optional) or rejected
 * (required). So a tampered file can never read, overwrite or attach to another user's records.
 * Everything happens in one DB transaction.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/server/db";
import {
  accounts,
  auditLogs,
  budgetAlertEvents,
  budgets,
  categories,
  exchangeRates,
  financialSnapshots,
  goalContributions,
  goals,
  importBatches,
  merchants,
  notificationPreferences,
  paymentMethods,
  receipts,
  recurringTransactions,
  tags,
  transactionSplits,
  transactions,
  transactionTags,
  userPreferences,
  accountType,
  budgetPeriod,
  categoryKind,
  goalStatus,
  paymentMethodType,
  recurrenceFrequency,
  recurrenceUnit,
  recurringKind,
  recurringStatus,
  transactionSource,
  transactionType,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { isZero, normalize, toUnits } from "@/lib/money";
import { currencyCode, hexColor, isoDate, signedMoney, timeOfDay } from "@/lib/validation";
import { getNotificationPreferences, getPreferences } from "./preferences";
import { normalizeMerchant } from "./taxonomy";

export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/* ───────────── Export ───────────── */

function strip<T extends Record<string, unknown>>(row: T, ...keys: string[]) {
  const out: Record<string, unknown> = { ...row };
  for (const k of ["userId", ...keys]) delete out[k];
  return out;
}

export async function exportUserData(userId: string) {
  const [prefs, notif, accs, cats, mers, pms, tgs, txns, splits, txTags, rec, buds, gls, contribs, rates, rcpts] = await Promise.all([
    getPreferences(userId),
    getNotificationPreferences(userId),
    db.select().from(accounts).where(eq(accounts.userId, userId)).orderBy(accounts.sortOrder),
    db.select().from(categories).where(eq(categories.userId, userId)).orderBy(categories.sortOrder),
    db.select().from(merchants).where(eq(merchants.userId, userId)),
    db.select().from(paymentMethods).where(eq(paymentMethods.userId, userId)).orderBy(paymentMethods.sortOrder),
    db.select().from(tags).where(eq(tags.userId, userId)),
    db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNull(transactions.deletedAt)))
      .orderBy(transactions.date, transactions.createdAt),
    db.select().from(transactionSplits).where(eq(transactionSplits.userId, userId)).orderBy(transactionSplits.sortOrder),
    db.select().from(transactionTags).where(eq(transactionTags.userId, userId)),
    db.select().from(recurringTransactions).where(eq(recurringTransactions.userId, userId)),
    db.select().from(budgets).where(eq(budgets.userId, userId)),
    db.select().from(goals).where(eq(goals.userId, userId)).orderBy(goals.sortOrder),
    db.select().from(goalContributions).where(eq(goalContributions.userId, userId)).orderBy(goalContributions.date),
    db.select().from(exchangeRates).where(eq(exchangeRates.userId, userId)),
    db
      .select({ id: receipts.id, transactionId: receipts.transactionId, filename: receipts.filename, mimeType: receipts.mimeType, sizeBytes: receipts.sizeBytes, createdAt: receipts.createdAt })
      .from(receipts)
      .where(eq(receipts.userId, userId)),
  ]);
  const live = txns.filter((t) => !t.deletedAt);
  const liveIds = new Set(live.map((t) => t.id));
  const splitsBy = new Map<string, typeof splits>();
  for (const s of splits) if (liveIds.has(s.transactionId)) splitsBy.set(s.transactionId, [...(splitsBy.get(s.transactionId) ?? []), s]);
  const tagsBy = new Map<string, string[]>();
  for (const t of txTags) if (liveIds.has(t.transactionId)) tagsBy.set(t.transactionId, [...(tagsBy.get(t.transactionId) ?? []), t.tagId]);

  const p = strip(prefs, "updatedAt", "today");
  return {
    app: "kosh",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    preferences: p,
    notificationPreferences: strip(notif, "updatedAt", "pushEnabled"),
    accounts: accs.map((a) => strip(a)),
    categories: cats.map((c) => strip(c)),
    merchants: mers.map((m) => strip(m, "normalizedName")),
    paymentMethods: pms.map((m) => strip(m)),
    tags: tgs.map((t) => strip(t)),
    transactions: live.map((t) => ({
      ...strip(t, "importBatchId", "deletedAt"),
      splits: (splitsBy.get(t.id) ?? []).map((s) => strip(s, "transactionId", "id")),
      tagIds: tagsBy.get(t.id) ?? [],
    })),
    recurring: rec.map((r) => strip(r)),
    budgets: buds.map((b) => strip(b)),
    goals: gls.map((g) => strip(g)),
    contributions: contribs.map((c) => strip(c)),
    exchangeRates: rates.map((r) => strip(r)),
    receipts: rcpts,
  };
}

export type BackupFile = Awaited<ReturnType<typeof exportUserData>>;

/* ───────────── Validation ───────────── */

const key = z.string().min(1).max(100);
const optKey = z.union([key, z.null()]).optional().transform((v) => v ?? null);
const txt = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().slice(0, max) : null));
const reqText = (max: number) => z.string().trim().min(1).max(max);
const optMoney = z.union([signedMoney, z.null()]).optional().transform((v) => v ?? null);
const posMoney = signedMoney.refine((v) => toUnits(v) > BigInt(0), "Amount must be positive");
const optDate = z.union([isoDate, z.null()]).optional().transform((v) => v ?? null);
const rateStr = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = String(v).trim();
  if (!/^\d{1,10}(\.\d{1,10})?$/.test(s) || Number(s) <= 0) {
    ctx.addIssue({ code: "custom", message: "Invalid rate" });
    return z.NEVER;
  }
  return s;
});
const day = z.union([z.number().int().min(1).max(31), z.null()]).optional().transform((v) => v ?? null);
const int = (min = 0, max = 1_000_000) => z.number().int().min(min).max(max);
const bool = (d: boolean) => z.boolean().default(d);
const color = z.union([hexColor, z.null()]).optional().transform((v) => v ?? null);
const enumOf = <T extends [string, ...string[]]>(values: T) => z.enum(values);
const instant = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  });

const accountSchema = z.object({
  id: key,
  name: reqText(60),
  type: enumOf(accountType.enumValues),
  currency: currencyCode,
  openingBalance: signedMoney.default("0"),
  openingDate: optDate,
  institution: txt(80),
  notes: txt(500),
  color,
  icon: txt(40),
  includeInNetWorth: bool(true),
  isArchived: bool(false),
  sortOrder: int().default(0),
  creditLimit: optMoney,
  statementDay: day,
  dueDay: day,
  minimumPayment: optMoney,
  annualFee: optMoney,
  interestRate: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 1000 ? null : String(v))),
});

const categorySchema = z.object({
  id: key,
  parentId: optKey,
  name: reqText(50),
  kind: enumOf(categoryKind.enumValues),
  icon: z.string().min(1).max(40).default("circle"),
  color: hexColor.default("#64748b"),
  sortOrder: int().default(0),
  isArchived: bool(false),
  excludeFromReports: bool(false),
});

const merchantSchema = z.object({ id: key, name: reqText(80), defaultCategoryId: optKey });
const paymentMethodSchema = z.object({
  id: key,
  name: reqText(40),
  type: enumOf(paymentMethodType.enumValues).default("other"),
  defaultAccountId: optKey,
  sortOrder: int().default(0),
  isArchived: bool(false),
});
const tagSchema = z.object({ id: key, name: reqText(30), color: txt(20) });

const splitSchema = z.object({ categoryId: optKey, amount: posMoney, baseAmount: signedMoney, notes: txt(200), sortOrder: int().default(0) });

const transactionSchema = z
  .object({
    id: key,
    type: enumOf(transactionType.enumValues),
    accountId: key,
    amount: signedMoney,
    fxRate: rateStr.default("1"),
    baseAmount: signedMoney,
    originalAmount: optMoney,
    originalCurrency: z.union([currencyCode, z.null()]).optional().transform((v) => v ?? null),
    date: isoDate,
    categoryId: optKey,
    merchantId: optKey,
    paymentMethodId: optKey,
    notes: txt(1000),
    toAccountId: optKey,
    toAmount: optMoney,
    refundOfId: optKey,
    recurringId: optKey,
    recurringDate: optDate,
    isPending: bool(false),
    source: enumOf(transactionSource.enumValues).default("manual"),
    importHash: txt(100),
    splits: z.array(splitSchema).max(50).default([]),
    tagIds: z.array(key).max(50).default([]),
  })
  .superRefine((t, ctx) => {
    if (t.type === "adjustment" ? isZero(t.amount) : toUnits(t.amount) <= BigInt(0))
      ctx.addIssue({ code: "custom", path: ["amount"], message: "Invalid amount for this transaction type" });
    if (t.type === "transfer" && (!t.toAccountId || t.toAccountId === t.accountId))
      ctx.addIssue({ code: "custom", path: ["toAccountId"], message: "Transfers need two different accounts" });
  });

const recurringSchema = z.object({
  id: key,
  kind: enumOf(recurringKind.enumValues).default("expense"),
  name: reqText(80),
  amount: posMoney,
  currency: currencyCode,
  accountId: optKey,
  toAccountId: optKey,
  categoryId: optKey,
  merchantId: optKey,
  paymentMethodId: optKey,
  notes: txt(1000),
  frequency: enumOf(recurrenceFrequency.enumValues).default("monthly"),
  interval: int(1, 1000).default(1),
  intervalUnit: enumOf(recurrenceUnit.enumValues).default("month"),
  startDate: isoDate,
  endDate: optDate,
  nextDate: optDate,
  autoPost: bool(false),
  remindDaysBefore: int(0, 365).default(2),
  status: enumOf(recurringStatus.enumValues).default("active"),
  serviceUrl: txt(500),
  trialEndsAt: optDate,
  cancelledAt: optDate,
  employer: txt(120),
  grossAmount: optMoney,
  deductions: z
    .array(z.object({ label: z.string().max(80), amount: signedMoney, kind: z.enum(["tax", "deduction", "bonus"]) }))
    .max(50)
    .nullish()
    .transform((v) => v ?? null),
});

const budgetSchema = z.object({
  id: key,
  name: reqText(80),
  period: enumOf(budgetPeriod.enumValues).default("monthly"),
  categoryId: optKey,
  includeSubcategories: bool(true),
  amount: posMoney,
  currency: currencyCode,
  startDate: optDate,
  endDate: optDate,
  rollover: bool(false),
  alertsEnabled: bool(true),
  alertThresholds: z.array(int(1, 1000)).max(10).default([50, 75, 90, 100]),
  alertOnProjected: bool(true),
  isArchived: bool(false),
});

const goalSchema = z.object({
  id: key,
  name: reqText(80),
  kind: z.string().min(1).max(40).default("custom"),
  icon: txt(40),
  color,
  targetAmount: posMoney,
  startingAmount: signedMoney.default("0"),
  currency: currencyCode,
  deadline: optDate,
  contributionFrequency: z.union([enumOf(recurrenceFrequency.enumValues), z.null()]).optional().transform((v) => v ?? null),
  targetContribution: optMoney,
  linkedAccountId: optKey,
  status: enumOf(goalStatus.enumValues).default("active"),
  completedAt: instant,
  notes: txt(1000),
  sortOrder: int().default(0),
});

const contributionSchema = z.object({
  goalId: key,
  amount: signedMoney.refine((v) => !isZero(v), "Contribution can't be zero"),
  date: isoDate,
  note: txt(500),
  transactionId: optKey,
});

const preferencesSchema = z
  .object({
    currency: currencyCode,
    timezone: z.string().max(80),
    locale: z.string().max(35),
    theme: z.enum(["light", "dark", "system"]),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]),
    monthStartDay: int(1, 28),
    aiEnabled: z.boolean(),
    aiInsightsEnabled: z.boolean(),
    dashboardWidgets: z.array(z.object({ id: z.string().max(40), visible: z.boolean() })).max(50).nullable(),
    defaultDateRange: z.string().max(30),
    defaultAccountId: optKey,
    defaultPaymentMethodId: optKey,
    expectedMonthlyIncome: optMoney,
  })
  .partial();

const notificationSchema = z
  .object({
    dailyReminderEnabled: z.boolean(),
    dailyReminderTime: timeOfDay,
    missingEntriesDays: int(0, 60),
    budgetAlerts: z.boolean(),
    billReminders: z.boolean(),
    subscriptionReminders: z.boolean(),
    creditCardReminders: z.boolean(),
    incomeReminders: z.boolean(),
    goalReminders: z.boolean(),
    maxPerDay: int(0, 50),
    quietHoursStart: z.union([timeOfDay, z.null()]),
    quietHoursEnd: z.union([timeOfDay, z.null()]),
  })
  .partial();

const LIMIT = 200_000;
export const backupSchema = z.object({
  app: z.literal("kosh").optional(),
  version: z.number().int().min(1).max(BACKUP_VERSION),
  exportedAt: z.string().max(40).optional(),
  preferences: preferencesSchema.optional(),
  notificationPreferences: notificationSchema.optional(),
  accounts: z.array(accountSchema).max(1000).default([]),
  categories: z.array(categorySchema).max(2000).default([]),
  merchants: z.array(merchantSchema).max(50_000).default([]),
  paymentMethods: z.array(paymentMethodSchema).max(500).default([]),
  tags: z.array(tagSchema).max(5000).default([]),
  transactions: z.array(transactionSchema).max(LIMIT).default([]),
  recurring: z.array(recurringSchema).max(2000).default([]),
  budgets: z.array(budgetSchema).max(2000).default([]),
  goals: z.array(goalSchema).max(1000).default([]),
  contributions: z.array(contributionSchema).max(LIMIT).default([]),
  exchangeRates: z.array(z.object({ currency: currencyCode, rate: rateStr })).max(500).default([]),
});
export type BackupInput = z.input<typeof backupSchema>;

/* ───────────── Restore ───────────── */

export type RestoreMode = "merge" | "replace";

export type RestoreSummary = {
  mode: RestoreMode;
  accounts: number;
  categories: number;
  merchants: number;
  paymentMethods: number;
  tags: number;
  transactions: number;
  skippedTransactions: number;
  recurring: number;
  budgets: number;
  goals: number;
  contributions: number;
  exchangeRates: number;
};

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>, size = 500) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/** Deletes every financial record the user owns (keeps the login, preferences and notifications). */
export async function wipeFinancialData(tx: Tx, userId: string) {
  await tx.delete(receipts).where(eq(receipts.userId, userId));
  await tx.delete(goalContributions).where(eq(goalContributions.userId, userId));
  await tx.delete(budgetAlertEvents).where(eq(budgetAlertEvents.userId, userId));
  await tx.delete(transactions).where(eq(transactions.userId, userId));
  await tx.delete(goals).where(eq(goals.userId, userId));
  await tx.delete(budgets).where(eq(budgets.userId, userId));
  await tx.delete(recurringTransactions).where(eq(recurringTransactions.userId, userId));
  await tx.delete(paymentMethods).where(eq(paymentMethods.userId, userId));
  await tx.delete(merchants).where(eq(merchants.userId, userId));
  await tx.delete(tags).where(eq(tags.userId, userId));
  await tx.delete(categories).where(eq(categories.userId, userId));
  await tx.delete(accounts).where(eq(accounts.userId, userId));
  await tx.delete(exchangeRates).where(eq(exchangeRates.userId, userId));
  await tx.delete(importBatches).where(eq(importBatches.userId, userId));
  await tx.delete(financialSnapshots).where(eq(financialSnapshots.userId, userId));
}

function describeZod(err: z.ZodError) {
  const i = err.issues[0];
  return i ? `${i.path.join(".") || "file"}: ${i.message}` : "Invalid file";
}

export async function restoreUserData(userId: string, json: unknown, mode: RestoreMode): Promise<RestoreSummary> {
  const parsed = backupSchema.safeParse(json);
  if (!parsed.success) throw new AppError("VALIDATION", `This isn't a valid Kosh backup (${describeZod(parsed.error)}).`);
  const data = parsed.data;
  const current = await getPreferences(userId);
  const fileBase = data.preferences?.currency ?? current.currency;
  if (mode === "merge" && fileBase !== current.currency && data.transactions.length)
    throw new AppError(
      "VALIDATION",
      `This backup uses ${fileBase} as its base currency but yours is ${current.currency}. Switch your base currency to ${fileBase} first, or restore with “Replace”.`,
    );

  try {
    return await db.transaction(async (tx) => {
      if (mode === "replace") await wipeFinancialData(tx, userId);
      const summary: RestoreSummary = {
        mode,
        accounts: 0,
        categories: 0,
        merchants: 0,
        paymentMethods: 0,
        tags: 0,
        transactions: 0,
        skippedTransactions: 0,
        recurring: 0,
        budgets: 0,
        goals: 0,
        contributions: 0,
        exchangeRates: 0,
      };
      const lower = (s: string) => s.trim().toLowerCase();

      /* Accounts */
      const accMap = new Map<string, { id: string; currency: string }>();
      const existingAcc = mode === "merge" ? await tx.select({ id: accounts.id, name: accounts.name, currency: accounts.currency }).from(accounts).where(eq(accounts.userId, userId)) : [];
      const accByKey = new Map(existingAcc.map((a) => [`${lower(a.name)}|${a.currency}`, a]));
      const newAccounts: (typeof accounts.$inferInsert)[] = [];
      for (const a of data.accounts) {
        if (accMap.has(a.id)) continue;
        const k = `${lower(a.name)}|${a.currency}`;
        const hit = accByKey.get(k);
        if (hit) {
          accMap.set(a.id, { id: hit.id, currency: hit.currency });
          continue;
        }
        const id = randomUUID();
        accMap.set(a.id, { id, currency: a.currency });
        accByKey.set(k, { id, name: a.name, currency: a.currency });
        const { id: _drop, ...rest } = a;
        void _drop;
        newAccounts.push({ ...rest, id, userId });
      }
      await insertChunked(newAccounts, (c) => tx.insert(accounts).values(c));
      summary.accounts = newAccounts.length;

      /* Categories (parents before children; one level deep) */
      const catMap = new Map<string, { id: string; kind: string }>();
      const existingCats =
        mode === "merge"
          ? await tx.select({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId }).from(categories).where(eq(categories.userId, userId))
          : [];
      const catKey = (kind: string, parentId: string | null, name: string) => `${kind}|${parentId ?? ""}|${lower(name)}`;
      const catByKey = new Map(existingCats.map((c) => [catKey(c.kind, c.parentId, c.name), c.id]));
      const fileCatIds = new Set(data.categories.map((c) => c.id));
      const parents = data.categories.filter((c) => !c.parentId || !fileCatIds.has(c.parentId));
      const children = data.categories.filter((c) => c.parentId && fileCatIds.has(c.parentId));
      const newCats: (typeof categories.$inferInsert)[] = [];
      const addCat = (c: (typeof data.categories)[number], parentId: string | null) => {
        if (catMap.has(c.id)) return;
        const k = catKey(c.kind, parentId, c.name);
        const hit = catByKey.get(k);
        if (hit) {
          catMap.set(c.id, { id: hit, kind: c.kind });
          return;
        }
        const id = randomUUID();
        catMap.set(c.id, { id, kind: c.kind });
        catByKey.set(k, id);
        newCats.push({ id, userId, parentId, name: c.name, kind: c.kind, icon: c.icon, color: c.color, sortOrder: c.sortOrder, isArchived: c.isArchived, excludeFromReports: c.excludeFromReports });
      };
      for (const c of parents) addCat(c, null);
      const parentNewIds = new Set(newCats.map((c) => c.id));
      for (const c of children) {
        const parent = catMap.get(c.parentId!);
        const parentRow = data.categories.find((p) => p.id === c.parentId);
        // Only one level deep and the same kind as the parent; otherwise make it top-level.
        const ok = parent && parentRow && !parentRow.parentId && parent.kind === c.kind;
        addCat(c, ok ? parent.id : null);
      }
      await insertChunked(newCats.filter((c) => parentNewIds.has(c.id!)), (c) => tx.insert(categories).values(c));
      await insertChunked(newCats.filter((c) => !parentNewIds.has(c.id!)), (c) => tx.insert(categories).values(c));
      summary.categories = newCats.length;
      const cat = (k: string | null) => (k ? (catMap.get(k)?.id ?? null) : null);
      const acc = (k: string | null) => (k ? (accMap.get(k)?.id ?? null) : null);

      /* Merchants */
      const merMap = new Map<string, string>();
      const existingMer = mode === "merge" ? await tx.select({ id: merchants.id, n: merchants.normalizedName }).from(merchants).where(eq(merchants.userId, userId)) : [];
      const merByKey = new Map(existingMer.map((m) => [m.n, m.id]));
      const newMer: (typeof merchants.$inferInsert)[] = [];
      for (const m of data.merchants) {
        const display = m.name.replace(/\s+/g, " ").slice(0, 80);
        const n = normalizeMerchant(display);
        const hit = merByKey.get(n);
        if (hit) {
          merMap.set(m.id, hit);
          continue;
        }
        const id = randomUUID();
        merMap.set(m.id, id);
        merByKey.set(n, id);
        newMer.push({ id, userId, name: display, normalizedName: n, defaultCategoryId: cat(m.defaultCategoryId) });
      }
      await insertChunked(newMer, (c) => tx.insert(merchants).values(c));
      summary.merchants = newMer.length;
      const mer = (k: string | null) => (k ? (merMap.get(k) ?? null) : null);

      /* Payment methods */
      const pmMap = new Map<string, string>();
      const existingPm = mode === "merge" ? await tx.select({ id: paymentMethods.id, name: paymentMethods.name }).from(paymentMethods).where(eq(paymentMethods.userId, userId)) : [];
      const pmByKey = new Map(existingPm.map((p) => [lower(p.name), p.id]));
      const newPm: (typeof paymentMethods.$inferInsert)[] = [];
      for (const p of data.paymentMethods) {
        const hit = pmByKey.get(lower(p.name));
        if (hit) {
          pmMap.set(p.id, hit);
          continue;
        }
        const id = randomUUID();
        pmMap.set(p.id, id);
        pmByKey.set(lower(p.name), id);
        newPm.push({ id, userId, name: p.name, type: p.type, defaultAccountId: acc(p.defaultAccountId), sortOrder: p.sortOrder, isArchived: p.isArchived });
      }
      await insertChunked(newPm, (c) => tx.insert(paymentMethods).values(c));
      summary.paymentMethods = newPm.length;
      const pm = (k: string | null) => (k ? (pmMap.get(k) ?? null) : null);

      /* Tags */
      const tagMap = new Map<string, string>();
      const existingTags = mode === "merge" ? await tx.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.userId, userId)) : [];
      const tagByKey = new Map(existingTags.map((t) => [lower(t.name), t.id]));
      const newTags: (typeof tags.$inferInsert)[] = [];
      for (const t of data.tags) {
        const hit = tagByKey.get(lower(t.name));
        if (hit) {
          tagMap.set(t.id, hit);
          continue;
        }
        const id = randomUUID();
        tagMap.set(t.id, id);
        tagByKey.set(lower(t.name), id);
        newTags.push({ id, userId, name: t.name, color: t.color });
      }
      await insertChunked(newTags, (c) => tx.insert(tags).values(c));
      summary.tags = newTags.length;

      /* Recurring */
      const recMap = new Map<string, string>();
      const newRec: (typeof recurringTransactions.$inferInsert)[] = [];
      for (const r of data.recurring) {
        const id = randomUUID();
        recMap.set(r.id, id);
        const { id: _drop, ...rest } = r;
        void _drop;
        newRec.push({
          ...rest,
          id,
          userId,
          accountId: acc(r.accountId),
          toAccountId: acc(r.toAccountId),
          categoryId: cat(r.categoryId),
          merchantId: mer(r.merchantId),
          paymentMethodId: pm(r.paymentMethodId),
        });
      }
      await insertChunked(newRec, (c) => tx.insert(recurringTransactions).values(c));
      summary.recurring = newRec.length;

      /* Transactions */
      const txMap = new Map<string, string>();
      const existingKeys = new Set<string>();
      if (mode === "merge") {
        const rows = await tx
          .select({ a: transactions.accountId, d: transactions.date, t: transactions.type, amt: transactions.amount, m: transactions.merchantId, to: transactions.toAccountId })
          .from(transactions)
          .where(and(eq(transactions.userId, userId), isNull(transactions.deletedAt)));
        for (const r of rows) existingKeys.add(`${r.a}|${r.d}|${r.t}|${normalize(r.amt)}|${r.m ?? ""}|${r.to ?? ""}`);
      }
      const newTx: (typeof transactions.$inferInsert)[] = [];
      const newSplits: (typeof transactionSplits.$inferInsert)[] = [];
      const newTxTags: (typeof transactionTags.$inferInsert)[] = [];
      const refunds: { id: string; refundOf: string }[] = [];
      for (const t of data.transactions) {
        if (txMap.has(t.id)) throw new AppError("VALIDATION", "This backup contains duplicate transaction ids.");
        const account = accMap.get(t.accountId);
        if (!account) throw new AppError("VALIDATION", "This backup has a transaction whose account isn't in the file.");
        const toAccount = t.type === "transfer" ? accMap.get(t.toAccountId!) : undefined;
        if (t.type === "transfer" && (!toAccount || toAccount.id === account.id))
          throw new AppError("VALIDATION", "This backup has a transfer whose destination account isn't in the file.");
        const merchantId = t.type === "transfer" ? null : mer(t.merchantId);
        const k = `${account.id}|${t.date}|${t.type}|${normalize(t.amount)}|${merchantId ?? ""}|${toAccount?.id ?? ""}`;
        if (mode === "merge" && existingKeys.has(k)) {
          summary.skippedTransactions++;
          continue;
        }
        const id = randomUUID();
        txMap.set(t.id, id);
        const splits = t.type === "expense" || t.type === "income" ? t.splits : [];
        newTx.push({
          id,
          userId,
          type: t.type,
          accountId: account.id,
          amount: t.amount,
          currency: account.currency,
          fxRate: t.fxRate,
          baseAmount: t.baseAmount,
          originalAmount: t.originalAmount,
          originalCurrency: t.originalCurrency,
          date: t.date,
          categoryId: t.type === "transfer" || splits.length > 1 ? null : cat(t.categoryId),
          merchantId,
          paymentMethodId: t.type === "transfer" ? null : pm(t.paymentMethodId),
          notes: t.notes,
          toAccountId: toAccount?.id ?? null,
          toAmount: t.type === "transfer" ? (t.toAmount ?? t.amount) : null,
          recurringId: t.recurringId ? (recMap.get(t.recurringId) ?? null) : null,
          recurringDate: t.recurringId && recMap.has(t.recurringId) ? t.recurringDate : null,
          importHash: t.importHash,
          hasSplits: splits.length > 1,
          isPending: t.isPending,
          source: t.source,
        });
        if (splits.length > 1)
          splits.forEach((s, i) => newSplits.push({ userId, transactionId: id, categoryId: cat(s.categoryId), amount: s.amount, baseAmount: s.baseAmount, notes: s.notes, sortOrder: s.sortOrder ?? i }));
        for (const tagKey of new Set(t.tagIds)) {
          const tagId = tagMap.get(tagKey);
          if (tagId) newTxTags.push({ transactionId: id, tagId, userId });
        }
        if (t.type === "refund" && t.refundOfId) refunds.push({ id, refundOf: t.refundOfId });
      }
      await insertChunked(newTx, (c) => tx.insert(transactions).values(c), 400);
      await insertChunked(newSplits, (c) => tx.insert(transactionSplits).values(c));
      await insertChunked(newTxTags, (c) => tx.insert(transactionTags).values(c).onConflictDoNothing());
      for (const r of refunds) {
        const orig = txMap.get(r.refundOf);
        if (orig) await tx.update(transactions).set({ refundOfId: orig }).where(and(eq(transactions.id, r.id), eq(transactions.userId, userId)));
      }
      summary.transactions = newTx.length;
      const txn = (k: string | null) => (k ? (txMap.get(k) ?? null) : null);

      /* Budgets */
      const newBudgets: (typeof budgets.$inferInsert)[] = [];
      for (const b of data.budgets) {
        const categoryId = cat(b.categoryId);
        if (b.categoryId && !categoryId) continue; // never silently turn a category budget into an overall one
        const { id: _drop, ...rest } = b;
        void _drop;
        newBudgets.push({ ...rest, id: randomUUID(), userId, categoryId });
      }
      await insertChunked(newBudgets, (c) => tx.insert(budgets).values(c));
      summary.budgets = newBudgets.length;

      /* Goals & contributions */
      const goalMap = new Map<string, string>();
      const newGoals: (typeof goals.$inferInsert)[] = [];
      for (const g of data.goals) {
        const id = randomUUID();
        goalMap.set(g.id, id);
        const { id: _drop, ...rest } = g;
        void _drop;
        newGoals.push({ ...rest, id, userId, linkedAccountId: acc(g.linkedAccountId) });
      }
      await insertChunked(newGoals, (c) => tx.insert(goals).values(c));
      summary.goals = newGoals.length;
      const newContribs: (typeof goalContributions.$inferInsert)[] = [];
      for (const c of data.contributions) {
        const goalId = goalMap.get(c.goalId);
        if (!goalId) continue;
        newContribs.push({ userId, goalId, amount: c.amount, date: c.date, note: c.note, transactionId: txn(c.transactionId) });
      }
      await insertChunked(newContribs, (c) => tx.insert(goalContributions).values(c));
      summary.contributions = newContribs.length;

      /* Exchange rates */
      const base = mode === "replace" ? fileBase : current.currency;
      const rates = data.exchangeRates.filter((r) => r.currency !== base);
      const uniqueRates = [...new Map(rates.map((r) => [r.currency, r])).values()];
      if (uniqueRates.length) {
        const inserted = await tx
          .insert(exchangeRates)
          .values(uniqueRates.map((r) => ({ userId, currency: r.currency, rate: r.rate })))
          .onConflictDoNothing()
          .returning({ c: exchangeRates.currency });
        summary.exchangeRates = inserted.length;
      }

      /* Preferences (replace mode only) */
      if (mode === "replace" && data.preferences) {
        const p = data.preferences;
        await tx
          .update(userPreferences)
          .set({
            ...p,
            defaultAccountId: p.defaultAccountId ? acc(p.defaultAccountId) : null,
            defaultPaymentMethodId: p.defaultPaymentMethodId ? pm(p.defaultPaymentMethodId) : null,
          })
          .where(eq(userPreferences.userId, userId));
      }
      if (mode === "replace" && data.notificationPreferences && Object.keys(data.notificationPreferences).length) {
        await getNotificationPreferences(userId);
        await tx.update(notificationPreferences).set(data.notificationPreferences).where(eq(notificationPreferences.userId, userId));
      }

      await tx.insert(auditLogs).values({ actorId: userId, targetUserId: userId, action: "data.restored", meta: { ...summary } });
      return summary;
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    const pg = e as { code?: string; cause?: { code?: string } };
    const code = pg?.code ?? pg?.cause?.code;
    if (code && /^(23|22)/.test(code)) throw new AppError("VALIDATION", "This backup contains data that conflicts or is invalid. Nothing was changed.");
    throw e;
  }
}

/** Counts of what the user currently has (for the Data page and confirmations). */
export async function dataCounts(userId: string) {
  const count = async (table: typeof accounts | typeof categories | typeof budgets | typeof goals | typeof recurringTransactions) =>
    (await db.$count(table, eq(table.userId, userId))) as number;
  const [acc, cats, txns, bud, gl, rec] = await Promise.all([
    count(accounts),
    count(categories),
    db.$count(transactions, and(eq(transactions.userId, userId), isNull(transactions.deletedAt))),
    count(budgets),
    count(goals),
    count(recurringTransactions),
  ]);
  return { accounts: acc, categories: cats, transactions: txns, budgets: bud, goals: gl, recurring: rec };
}
