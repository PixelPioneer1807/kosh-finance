/**
 * Recurring transactions, bills, subscriptions and income schedules — one engine.
 * `kind` distinguishes how the item is presented; scheduling and posting are shared.
 *
 * Posting is idempotent: a transaction stores (recurring_id, recurring_date) under a unique
 * index, so the same occurrence can never be recorded twice even if cron and a user click race.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { categories, recurringTransactions, transactions, type RecurringTransaction } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { frequency, isoDate, name, optionalDate, optionalId, optionalMoney, optionalText, positiveMoney, unit } from "@/lib/validation";
import { nextAfter, nextOnOrAfter, occurrencesBetween, perMonthFactor, type Rule } from "@/lib/recurrence";
import { abs, add, cmp, divInt, mul, normalize, ratio, sub, toUnits } from "@/lib/money";
import { assertOwned } from "./ownership";
import { getAccount } from "./accounts";
import { getPreferences, rateMap } from "./preferences";
import { createTransaction } from "./transactions";
import { findOrCreateMerchant, normalizeMerchant } from "./taxonomy";
import { addDaysISO, addMonthsISO, daysBetween, maxISO, type ISODate } from "@/lib/dates";

export const RECURRING_KINDS = ["expense", "bill", "subscription", "income", "transfer"] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];

export const recurringInput = z
  .object({
    kind: z.enum(RECURRING_KINDS),
    name: name("Name", 80),
    amount: positiveMoney,
    accountId: optionalId,
    toAccountId: optionalId,
    categoryId: optionalId,
    merchant: optionalText(80),
    paymentMethodId: optionalId,
    notes: optionalText(500),
    frequency: frequency,
    interval: z.coerce.number().int().min(1).max(365).default(1),
    intervalUnit: unit.default("month"),
    startDate: isoDate,
    endDate: optionalDate,
    autoPost: z.boolean().default(false),
    remindDaysBefore: z.coerce.number().int().min(0).max(30).default(2),
    status: z.enum(["active", "paused", "cancelled", "ended"]).default("active"),
    serviceUrl: z
      .union([z.literal(""), z.null(), z.url({ protocol: /^https?$/ })])
      .optional()
      .transform((v) => v || null),
    trialEndsAt: optionalDate,
    employer: optionalText(80),
    grossAmount: optionalMoney,
    deductions: z
      .array(z.object({ label: z.string().trim().min(1).max(60), amount: positiveMoney, kind: z.enum(["tax", "deduction", "bonus"]) }))
      .max(20)
      .default([]),
    /** Currency for items without an account; defaults to the account's or the base currency. */
    currency: z.string().length(3).toUpperCase().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.endDate && v.endDate < v.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be after the start date" });
    if (v.kind === "transfer" && (!v.accountId || !v.toAccountId))
      ctx.addIssue({ code: "custom", path: ["toAccountId"], message: "Choose both accounts for a recurring transfer" });
    if (v.kind === "transfer" && v.accountId === v.toAccountId) ctx.addIssue({ code: "custom", path: ["toAccountId"], message: "Pick two different accounts" });
    if (v.autoPost && !v.accountId) ctx.addIssue({ code: "custom", path: ["accountId"], message: "Choose an account to post to automatically" });
  });
export type RecurringInput = z.input<typeof recurringInput>;

const toRule = (r: Pick<RecurringTransaction, "frequency" | "interval" | "intervalUnit" | "startDate" | "endDate">): Rule => ({
  frequency: r.frequency,
  interval: r.interval,
  intervalUnit: r.intervalUnit,
  startDate: r.startDate,
  endDate: r.endDate,
});

export const transactionTypeFor = (kind: RecurringKind) => (kind === "income" ? "income" : kind === "transfer" ? "transfer" : "expense");

/** Latest occurrence date already recorded as a (non-deleted) transaction for this item. */
async function lastPostedOccurrence(userId: string, rid: string): Promise<ISODate | null> {
  const [row] = await db
    .select({ d: sql<string | null>`max(${transactions.recurringDate})::text` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.recurringId, rid), isNull(transactions.deletedAt)));
  return row?.d ?? null;
}

async function buildRow(userId: string, input: z.output<typeof recurringInput>, existing?: RecurringTransaction) {
  await assertOwned(userId, { account: input.accountId, toAccount: input.toAccountId, category: input.categoryId, paymentMethod: input.paymentMethodId });
  const isTransfer = input.kind === "transfer";
  if (input.categoryId && !isTransfer) {
    const [cat] = await db
      .select({ kind: categories.kind })
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.userId, userId)))
      .limit(1);
    const want = input.kind === "income" ? "income" : "expense";
    if (cat && cat.kind !== want)
      throw new AppError("VALIDATION", `Choose ${want === "income" ? "an income" : "an expense"} category.`, { categoryId: ["Wrong category type"] });
  }
  const prefs = await getPreferences(userId);
  const currency = input.accountId ? (await getAccount(userId, input.accountId)).currency : (input.currency ?? prefs.currency);
  const merchant = input.merchant && !isTransfer ? await findOrCreateMerchant(userId, input.merchant) : null;
  const rule = toRule({ ...input, endDate: input.endDate ?? null });
  // New items start from today (no backlog of "overdue" history). Edits keep an unpaid
  // overdue occurrence and never move back onto an occurrence that was already recorded.
  let anchor = maxISO(input.startDate, prefs.today);
  if (existing) {
    const last = await lastPostedOccurrence(userId, existing.id);
    const keep = existing.nextDate && existing.status === "active" ? existing.nextDate : prefs.today;
    anchor = maxISO(input.startDate, keep);
    if (last) anchor = maxISO(anchor, addDaysISO(last, 1));
  }
  const nextDate = input.status === "active" ? nextOnOrAfter(rule, anchor) : existing?.nextDate && input.status === "paused" ? nextOnOrAfter(rule, anchor) : null;
  const status = nextDate === null && input.status === "active" ? ("ended" as const) : input.status;
  return {
    userId,
    kind: input.kind,
    name: input.name,
    amount: input.amount,
    currency,
    accountId: input.accountId,
    toAccountId: isTransfer ? input.toAccountId : null,
    categoryId: isTransfer ? null : input.categoryId,
    merchantId: merchant?.id ?? null,
    paymentMethodId: isTransfer ? null : input.paymentMethodId,
    notes: input.notes,
    frequency: input.frequency,
    interval: input.frequency === "custom" ? input.interval : 1,
    intervalUnit: input.frequency === "custom" ? input.intervalUnit : ("month" as const),
    startDate: input.startDate,
    endDate: input.endDate,
    nextDate,
    autoPost: input.autoPost,
    remindDaysBefore: input.remindDaysBefore,
    status,
    serviceUrl: input.kind === "subscription" ? input.serviceUrl : null,
    trialEndsAt: input.kind === "subscription" ? input.trialEndsAt : null,
    cancelledAt: status === "cancelled" ? (existing?.cancelledAt ?? prefs.today) : null,
    employer: input.kind === "income" ? input.employer : null,
    grossAmount: input.kind === "income" ? input.grossAmount : null,
    deductions: input.kind === "income" ? input.deductions : null,
  };
}

export async function createRecurring(userId: string, raw: RecurringInput) {
  const row = await buildRow(userId, recurringInput.parse(raw));
  const [created] = await db.insert(recurringTransactions).values(row).returning();
  return created;
}

export async function updateRecurring(userId: string, rid: string, raw: RecurringInput) {
  const existing = await getRecurring(userId, rid);
  const row = await buildRow(userId, recurringInput.parse(raw), existing);
  const [updated] = await db
    .update(recurringTransactions)
    .set(row)
    .where(and(eq(recurringTransactions.id, rid), eq(recurringTransactions.userId, userId)))
    .returning();
  return updated;
}

export async function setRecurringStatus(userId: string, rid: string, status: "active" | "paused" | "cancelled") {
  const item = await getRecurring(userId, rid);
  const prefs = await getPreferences(userId);
  let nextDate = item.nextDate;
  if (status === "active") {
    // Resuming doesn't create a backlog: continue from today, after anything already recorded.
    const last = await lastPostedOccurrence(userId, rid);
    let anchor = maxISO(item.startDate, prefs.today);
    if (last) anchor = maxISO(anchor, addDaysISO(last, 1));
    nextDate = nextOnOrAfter(toRule(item), anchor);
  }
  await db
    .update(recurringTransactions)
    .set({
      status: status === "active" && !nextDate ? "ended" : status,
      nextDate,
      cancelledAt: status === "cancelled" ? (item.cancelledAt ?? prefs.today) : null,
    })
    .where(and(eq(recurringTransactions.id, rid), eq(recurringTransactions.userId, userId)));
}

export async function deleteRecurring(userId: string, rid: string) {
  const [row] = await db
    .delete(recurringTransactions)
    .where(and(eq(recurringTransactions.id, rid), eq(recurringTransactions.userId, userId)))
    .returning({ id: recurringTransactions.id });
  if (!row) throw notFound("Recurring item");
}

export async function getRecurring(userId: string, rid: string) {
  const [row] = await db
    .select()
    .from(recurringTransactions)
    .where(and(eq(recurringTransactions.id, rid), eq(recurringTransactions.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Recurring item");
  return row;
}

export async function listRecurring(userId: string, opts: { kinds?: RecurringKind[]; includeInactive?: boolean } = {}) {
  return db
    .select()
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        opts.kinds?.length ? inArray(recurringTransactions.kind, opts.kinds) : undefined,
        opts.includeInactive ? undefined : inArray(recurringTransactions.status, ["active", "paused"]),
      ),
    )
    .orderBy(asc(recurringTransactions.nextDate), asc(recurringTransactions.name));
}

/**
 * Record the current (next due) occurrence as a real transaction and advance the schedule.
 * Used by "Mark paid"/"Mark received" and by auto-posting.
 */
export async function postOccurrence(
  userId: string,
  rid: string,
  opts: { date?: ISODate; amount?: string; accountId?: string; occurrence?: ISODate; source?: "manual" | "recurring" } = {},
) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(recurringTransactions)
      .where(and(eq(recurringTransactions.id, rid), eq(recurringTransactions.userId, userId)))
      .for("update")
      .limit(1);
    if (!item) throw notFound("Recurring item");
    const occurrence = opts.occurrence ?? item.nextDate;
    if (!occurrence) throw new AppError("VALIDATION", "This item has no upcoming occurrence.");
    const accountId = opts.accountId ?? item.accountId;
    if (!accountId) throw new AppError("VALIDATION", "Choose which account this was paid from.", { accountId: ["Required"] });
    let [already]: ({ id: string; deletedAt: Date | null } | undefined)[] = await tx
      .select({ id: transactions.id, deletedAt: transactions.deletedAt })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.recurringId, rid), eq(transactions.recurringDate, occurrence)))
      .limit(1);
    if (already?.deletedAt) {
      // The user deleted the earlier record of this occurrence; free the idempotency slot.
      await tx.delete(transactions).where(and(eq(transactions.id, already.id), eq(transactions.userId, userId)));
      already = undefined;
    }
    let txnId = already?.id ?? null;
    if (!already) {
      const merchantName = item.merchantId
        ? (await tx.execute<{ name: string }>(sql`SELECT name FROM merchants WHERE id = ${item.merchantId} AND user_id = ${userId}`))[0]?.name
        : null;
      const t = await createTransaction(
        userId,
        {
          type: transactionTypeFor(item.kind),
          accountId,
          toAccountId: item.kind === "transfer" ? item.toAccountId : null,
          amount: opts.amount ?? item.amount,
          date: opts.date ?? occurrence,
          categoryId: item.kind === "transfer" ? null : item.categoryId,
          merchant: merchantName ?? (item.kind === "transfer" ? null : item.kind === "income" ? item.employer : item.name),
          paymentMethodId: item.paymentMethodId,
          notes: item.notes,
        },
        { source: opts.source ?? "manual", recurringId: rid, recurringDate: occurrence },
        tx,
      );
      txnId = t.id;
    }
    // Only advance if we posted the current occurrence (not an older one).
    if (!item.nextDate || occurrence >= item.nextDate) {
      const next = nextAfter(toRule(item), occurrence);
      await tx
        .update(recurringTransactions)
        .set({ nextDate: next, status: next ? item.status : "ended" })
        .where(and(eq(recurringTransactions.id, rid), eq(recurringTransactions.userId, userId)));
    }
    return { transactionId: txnId!, alreadyPosted: Boolean(already) };
  });
}

/** Skip the next occurrence without recording a transaction. */
export async function skipOccurrence(userId: string, rid: string) {
  const item = await getRecurring(userId, rid);
  if (!item.nextDate) return;
  const next = nextAfter(toRule(item), item.nextDate);
  await db
    .update(recurringTransactions)
    .set({ nextDate: next, status: next ? item.status : "ended" })
    .where(and(eq(recurringTransactions.id, rid), eq(recurringTransactions.userId, userId)));
}

/** Auto-post every due occurrence (up to today) for items with autoPost enabled. Idempotent. */
export async function processDueRecurring(userId: string, today?: ISODate) {
  const day = today ?? (await getPreferences(userId)).today;
  const due = await db
    .select()
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.status, "active"),
        eq(recurringTransactions.autoPost, true),
        isNotNull(recurringTransactions.nextDate),
        lte(recurringTransactions.nextDate, day),
      ),
    );
  let posted = 0;
  for (const item of due) {
    let guard = 0;
    let current: ISODate | null = item.nextDate;
    while (current && current <= day && guard++ < 60) {
      try {
        const r = await postOccurrence(userId, item.id, { occurrence: current, source: "recurring" });
        if (!r.alreadyPosted) posted++;
      } catch (e) {
        console.error("[recurring] auto-post failed", item.id, e instanceof Error ? e.message : e);
        break;
      }
      current = nextAfter(toRule(item), current);
    }
  }
  return { posted };
}

export type Occurrence = {
  recurringId: string;
  name: string;
  kind: RecurringKind;
  date: ISODate;
  amount: string;
  currency: string;
  baseAmount: string | null;
  accountId: string | null;
  categoryId: string | null;
  autoPost: boolean;
  status: "overdue" | "due" | "upcoming";
};

/** Scheduled occurrences in [from, to]. Unpaid manual items before `today` are flagged overdue. */
export async function upcomingOccurrences(userId: string, from: ISODate, to: ISODate, opts: { kinds?: RecurringKind[] } = {}): Promise<Occurrence[]> {
  const prefs = await getPreferences(userId);
  const rates = await rateMap(userId, prefs.currency);
  const items = (await listRecurring(userId, { kinds: opts.kinds })).filter((i) => i.status === "active" && i.nextDate);
  const out: Occurrence[] = [];
  for (const item of items) {
    const start = item.nextDate! < from ? item.nextDate! : from;
    for (const date of occurrencesBetween(toRule(item), maxISO(start, item.nextDate!), to, 400)) {
      if (date < from && (item.autoPost || date >= prefs.today)) continue;
      const rate = rates.get(item.currency);
      out.push({
        recurringId: item.id,
        name: item.name,
        kind: item.kind,
        date,
        amount: normalize(item.amount),
        currency: item.currency,
        baseAmount: rate ? mul(item.amount, rate) : null,
        accountId: item.accountId,
        categoryId: item.categoryId,
        autoPost: item.autoPost,
        status: date < prefs.today ? "overdue" : date === prefs.today ? "due" : "upcoming",
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
}

/** Exact monthly and yearly cost of one item (in its own currency). */
export function normalizedCost(i: Pick<RecurringTransaction, "amount" | "frequency" | "interval" | "intervalUnit">) {
  const { num, den } = perMonthFactor(i);
  return { monthly: divInt(mul(i.amount, String(num)), den), yearly: divInt(mul(i.amount, String(num * 12)), den) };
}

/** Monthly / yearly cost of active subscriptions (or any kinds), normalised and in base currency. */
export async function recurringCostSummary(userId: string, kinds: RecurringKind[] = ["subscription"]) {
  const prefs = await getPreferences(userId);
  const rates = await rateMap(userId, prefs.currency);
  const items = (await listRecurring(userId, { kinds })).filter((i) => i.status === "active");
  let monthly = "0";
  let yearly = "0";
  const unconverted: string[] = [];
  const perItem = items.map((i) => {
    const cost = normalizedCost(i);
    const rate = rates.get(i.currency);
    if (rate) {
      monthly = add(monthly, mul(cost.monthly, rate));
      yearly = add(yearly, mul(cost.yearly, rate));
    } else unconverted.push(i.currency);
    return { id: i.id, name: i.name, monthly: cost.monthly, yearly: cost.yearly, currency: i.currency };
  });
  return {
    count: items.length,
    monthly: normalize(monthly),
    yearly: normalize(yearly),
    currency: prefs.currency,
    items: perItem,
    unconvertedCurrencies: [...new Set(unconverted)],
  };
}

/** Most recent recorded transaction per recurring item ("Paid 3 Oct · $42"). */
export async function lastPostings(userId: string): Promise<Map<string, { date: ISODate; amount: string; transactionId: string }>> {
  const rows = await db.execute<{ rid: string; date: string; amount: string; id: string }>(sql`
    SELECT DISTINCT ON (t.recurring_id) t.recurring_id AS rid, t.date::text AS date, t.amount::text AS amount, t.id
    FROM transactions t
    WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.recurring_id IS NOT NULL
    ORDER BY t.recurring_id, t.recurring_date DESC, t.created_at DESC`);
  return new Map(rows.map((r) => [r.rid, { date: r.date, amount: normalize(r.amount), transactionId: r.id }]));
}

/* ───────────── Detection (suggestions only — the user confirms) ───────────── */

export type DetectedFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

const PATTERNS: { frequency: DetectedFrequency; days: number; lookbackDays: number }[] = [
  { frequency: "weekly", days: 7, lookbackDays: 183 },
  { frequency: "biweekly", days: 14, lookbackDays: 183 },
  { frequency: "monthly", days: 30.44, lookbackDays: 183 },
  { frequency: "quarterly", days: 91.31, lookbackDays: 400 },
  { frequency: "yearly", days: 365.25, lookbackDays: 800 },
];
const INTERVAL_TOLERANCE = 0.2;
const AMOUNT_TOLERANCE = 0.15;

export type RecurringCandidate = {
  merchantId: string;
  merchantName: string;
  categoryId: string | null;
  accountId: string;
  currency: string;
  typicalAmount: string;
  /** True when every charge had the same amount (looks like a subscription rather than a bill). */
  fixedAmount: boolean;
  frequency: DetectedFrequency;
  lastDate: ISODate;
  nextExpected: ISODate;
  count: number;
};

function median(values: string[]): string {
  const sorted = [...values].sort((a, b) => cmp(a, b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? normalize(sorted[mid]) : divInt(add(sorted[mid - 1], sorted[mid]), 2);
}

function advance(date: ISODate, f: DetectedFrequency): ISODate {
  switch (f) {
    case "weekly":
      return addDaysISO(date, 7);
    case "biweekly":
      return addDaysISO(date, 14);
    case "monthly":
      return addMonthsISO(date, 1);
    case "quarterly":
      return addMonthsISO(date, 3);
    case "yearly":
      return addMonthsISO(date, 12);
  }
}

/**
 * Pure detection over one merchant's charges (sorted by date, one per date): finds the longest
 * recent run of ≥3 charges at a regular interval (±20%) with similar amounts (±15% of the median).
 */
export function detectPattern(series: { date: ISODate; amount: string }[], today: ISODate) {
  let best: { frequency: DetectedFrequency; run: { date: ISODate; amount: string }[] } | null = null;
  for (const p of PATTERNS) {
    const from = addDaysISO(today, -p.lookbackDays);
    const pts = series.filter((s) => s.date >= from && s.date <= today);
    if (pts.length < 3) continue;
    // Walk back from the most recent charge while the gaps fit the pattern.
    const run = [pts[pts.length - 1]];
    for (let i = pts.length - 2; i >= 0; i--) {
      const gap = daysBetween(pts[i].date, run[0].date);
      if (Math.abs(gap - p.days) <= p.days * INTERVAL_TOLERANCE) run.unshift(pts[i]);
      else if (gap < p.days * (1 - INTERVAL_TOLERANCE)) continue; // an extra one-off charge in between
      else break;
    }
    if (run.length < 3) continue;
    const typical = median(run.map((r) => r.amount));
    const similar = run.every((r) => Math.abs(ratio(sub(r.amount, typical), typical)) <= AMOUNT_TOLERANCE);
    if (!similar) continue;
    // Stale: the next charge is long overdue, so it was probably cancelled.
    const last = run[run.length - 1].date;
    if (daysBetween(last, today) > p.days * (1 + INTERVAL_TOLERANCE) + 3) continue;
    if (!best || run.length > best.run.length) best = { frequency: p.frequency, run };
  }
  if (!best) return null;
  const amounts = best.run.map((r) => r.amount);
  const last = best.run[best.run.length - 1].date;
  let next = advance(last, best.frequency);
  while (next < today) next = advance(next, best.frequency);
  return {
    frequency: best.frequency,
    typicalAmount: median(amounts),
    fixedAmount: amounts.every((a) => cmp(a, amounts[0]) === 0),
    lastDate: last,
    nextExpected: next,
    count: best.run.length,
  };
}

/** Suggest recurring items from expense history (merchants not already tracked). */
export async function detectRecurringCandidates(userId: string, today?: ISODate): Promise<RecurringCandidate[]> {
  const day = today ?? (await getPreferences(userId)).today;
  const since = addDaysISO(day, -800);
  const tracked = await db
    .select({ merchantId: recurringTransactions.merchantId, name: recurringTransactions.name, categoryId: recurringTransactions.categoryId, amount: recurringTransactions.amount, status: recurringTransactions.status })
    .from(recurringTransactions)
    .where(eq(recurringTransactions.userId, userId));
  // An item tracked without a merchant (e.g. "Rent" in the Housing › Rent category) still covers
  // matching charges: same category and an amount within 15%.
  const coveredByTracked = (categoryId: string | null, typical: string) =>
    tracked.some(
      (t) =>
        t.status !== "cancelled" && t.status !== "ended" && categoryId && t.categoryId === categoryId &&
        Math.abs(ratio(sub(typical, t.amount), t.amount)) <= 0.15,
    );
  const trackedMerchants = new Set(tracked.map((t) => t.merchantId).filter(Boolean));
  const trackedNames = new Set(tracked.map((t) => normalizeMerchant(t.name)));
  type Row = { merchant_id: string; merchant_name: string; normalized: string; date: string; amount: string; currency: string; account_id: string; category_id: string | null };
  const rows = await db.execute<Row>(sql`
    SELECT t.merchant_id, m.name AS merchant_name, m.normalized_name AS normalized, t.date::text AS date,
           t.amount::text AS amount, t.currency, t.account_id, t.category_id
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id AND m.user_id = t.user_id
    WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.type = 'expense'
      AND t.recurring_id IS NULL AND t.date BETWEEN ${since}::date AND ${day}::date
    ORDER BY t.merchant_id, t.currency, t.date, t.created_at`);
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (trackedMerchants.has(r.merchant_id) || trackedNames.has(r.normalized)) continue;
    const key = `${r.merchant_id}|${r.currency}`;
    const g = groups.get(key) ?? [];
    // One charge per day (two coffees on the same day aren't two occurrences).
    if (g.length && g[g.length - 1].date === r.date) continue;
    g.push(r);
    groups.set(key, g);
  }
  const out: RecurringCandidate[] = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const found = detectPattern(g.map((r) => ({ date: r.date, amount: r.amount })), day);
    if (!found) continue;
    const latest = g[g.length - 1];
    if (coveredByTracked(latest.category_id, found.typicalAmount)) continue;
    out.push({
      merchantId: latest.merchant_id,
      merchantName: latest.merchant_name,
      categoryId: latest.category_id,
      accountId: latest.account_id,
      currency: latest.currency,
      ...found,
    });
  }
  return out.sort((a, b) => (a.nextExpected < b.nextExpected ? -1 : a.nextExpected > b.nextExpected ? 1 : a.merchantName.localeCompare(b.merchantName)));
}

export type PriceChange = {
  recurringId: string;
  name: string;
  currency: string;
  expected: string;
  charged: string;
  difference: string;
  /** Relative change, e.g. 0.2 = 20% more. Display only. */
  changePct: number;
  date: ISODate;
};

/**
 * Subscriptions whose most recent charge (posted from the schedule, or logged for the same
 * merchant) differs from the tracked amount — e.g. a streaming price increase.
 */
export async function priceChanges(userId: string): Promise<PriceChange[]> {
  const items = (await listRecurring(userId, { kinds: ["subscription"] })).filter((i) => i.status === "active");
  if (!items.length) return [];
  const rows = await db.execute<{ rid: string; amount: string; currency: string; date: string }>(sql`
    SELECT DISTINCT ON (r.id) r.id AS rid, t.amount::text AS amount, t.currency, t.date::text AS date
    FROM recurring_transactions r
    JOIN transactions t ON t.user_id = r.user_id AND t.deleted_at IS NULL AND t.type = 'expense'
      AND (t.recurring_id = r.id OR (r.merchant_id IS NOT NULL AND t.merchant_id = r.merchant_id))
    WHERE r.user_id = ${userId} AND r.id IN (${sql.join(items.map((i) => sql`${i.id}::uuid`), sql`, `)})
    ORDER BY r.id, t.date DESC, t.created_at DESC`);
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: PriceChange[] = [];
  for (const r of rows) {
    const item = byId.get(r.rid);
    if (!item || r.currency !== item.currency || cmp(r.amount, item.amount) === 0) continue;
    const difference = sub(r.amount, item.amount);
    out.push({
      recurringId: item.id,
      name: item.name,
      currency: item.currency,
      expected: normalize(item.amount),
      charged: normalize(r.amount),
      difference,
      changePct: ratio(difference, item.amount),
      date: r.date,
    });
  }
  return out.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
}

/** Update a subscription's tracked amount to what was actually charged. */
export async function acceptPriceChange(userId: string, rid: string, amount: string) {
  const item = await getRecurring(userId, rid);
  const value = normalize(amount);
  if (toUnits(value) <= BigInt(0)) throw new AppError("VALIDATION", "Amount must be greater than zero");
  await db
    .update(recurringTransactions)
    .set({ amount: abs(value) })
    .where(and(eq(recurringTransactions.id, item.id), eq(recurringTransactions.userId, userId)));
}

export { toRule as recurringRule };
