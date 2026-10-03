import "server-only";
/**
 * Tools the assistant model may call.
 *
 * Security model
 * - Every tool runs with the *authenticated* userId from `ToolContext`; no tool accepts a user id,
 *   and every query filters on `user_id`. Ids/names the model passes are resolved inside the
 *   user's own data only, so a foreign id behaves exactly like a non-existent one.
 * - All arguments are validated with zod; result sizes are capped.
 * - Read tools never write. Write tools (`propose_*`) only store a *pending* row in `ai_actions`;
 *   nothing changes until the user presses Confirm (see ./ai-actions.ts).
 * - Amounts are decimal strings in the user's base currency unless a `currency` says otherwise.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { aiActions, budgets } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { add, cmp, divInt, formatMoney, isPositive, mul, normalize, ratio, sub, toUnits, fromUnits, max as moneyMax, MoneyParseError } from "@/lib/money";
import { addDaysISO, daysBetween, isISODate, monthRange, type ISODate } from "@/lib/dates";
import { perMonthFactor, type Frequency } from "@/lib/recurrence";
import { isLiquidType, listAccounts, accountBalances } from "@/server/services/accounts";
import { getRate, rateMap, type Prefs } from "@/server/services/preferences";
import { listCategories, listPaymentMethods, expandCategoryIds, normalizeMerchant } from "@/server/services/taxonomy";
import { getTransaction, listTransactions, summarizeTransactions, suggestCategoryForMerchant, transactionInput, type TransactionFilters } from "@/server/services/transactions";
import { listRecurring, recurringCostSummary, upcomingOccurrences } from "@/server/services/recurring";
import { budgetInput, listBudgetsWithProgress } from "@/server/services/budgets";
import { listGoalsWithProgress } from "@/server/services/goals";
import { dailySpending, spendingByCategoryId, spendingTotal } from "@/server/services/spending-queries";
import type { ToolDef } from "./groq";

export const ACTION_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS_PER_TURN = 5;
const MAX_RESULT_CHARS = 14_000;

export type ToolContext = {
  userId: string;
  prefs: Prefs;
  conversationId: string | null;
  /** ids of ai_actions proposed during this turn (filled by propose_* tools). */
  proposed: string[];
  /** Per-turn memo (category list etc.). */
  cache: Map<string, unknown>;
};

export function makeToolContext(userId: string, prefs: Prefs, conversationId: string | null = null): ToolContext {
  return { userId, prefs, conversationId, proposed: [], cache: new Map() };
}

/* ───────────── Small helpers ───────────── */

/** Round a 4-dp decimal string to `decimals` places (half away from zero) for compact model output. */
export function dp(v: string | null | undefined, decimals = 2): string {
  const u = toUnits(v ?? "0");
  const stepU = BigInt(10 ** (4 - decimals));
  const neg = u < BigInt(0);
  const a = neg ? -u : u;
  let q = a / stepU;
  if ((a % stepU) * BigInt(2) >= stepU) q += BigInt(1);
  const s = fromUnits((neg ? -q : q) * stepU);
  return decimals === 0 ? s.split(".")[0] : s.slice(0, s.length - (4 - decimals));
}

const pct = (part: string, whole: string) => (isPositive(whole) ? Math.round(ratio(part, whole) * 1000) / 10 : null);
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : null);

const isoDateArg = z.string().refine(isISODate, "Use a real date in YYYY-MM-DD format");
const amountArg = z.union([z.string(), z.number()]);

function parseAmount(v: string | number, label = "amount", opts: { allowZero?: boolean } = {}): string {
  try {
    const n = normalize(typeof v === "number" ? String(v) : v.replace(/[^\d.\-]/g, ""));
    if (toUnits(n) < BigInt(0) || (!opts.allowZero && toUnits(n) === BigInt(0))) throw new AppError("VALIDATION", `${label} must be greater than zero`);
    if (toUnits(n) > toUnits("999999999999")) throw new AppError("VALIDATION", `${label} is too large`);
    return n;
  } catch (e) {
    if (e instanceof MoneyParseError) throw new AppError("VALIDATION", `Invalid ${label}`);
    throw e;
  }
}

function currentPeriod(ctx: ToolContext) {
  return monthRange(ctx.prefs.today, ctx.prefs.monthStartDay);
}

function resolveRange(ctx: ToolContext, from?: string | null, to?: string | null) {
  const def = currentPeriod(ctx);
  const f = from ?? def.from;
  const t = to ?? (from ? ctx.prefs.today : def.to);
  if (f > t) throw new AppError("VALIDATION", "`from` must be on or before `to`");
  if (daysBetween(f, t) > 366 * 5) throw new AppError("VALIDATION", "Date range is too long (max 5 years)");
  return { from: f, to: t };
}

type Cat = Awaited<ReturnType<typeof listCategories>>[number];

async function userCategories(ctx: ToolContext): Promise<Cat[]> {
  const hit = ctx.cache.get("cats") as Cat[] | undefined;
  if (hit) return hit;
  const cats = await listCategories(ctx.userId, { includeArchived: true });
  ctx.cache.set("cats", cats);
  return cats;
}

function catLabel(c: Cat, cats: Cat[]) {
  const parent = c.parentId ? cats.find((p) => p.id === c.parentId) : null;
  return parent ? `${parent.name} › ${c.name}` : c.name;
}

/** Resolve a category *name* within the user's own categories. */
async function resolveCategory(ctx: ToolContext, raw: string, kind?: "expense" | "income"): Promise<Cat> {
  const cats = (await userCategories(ctx)).filter((c) => !kind || c.kind === kind);
  const q = raw.trim().toLowerCase().replace(/\s*(›|>|\/)\s*/g, " › ");
  if (!q) throw new AppError("VALIDATION", "Category name is empty");
  const active = cats.filter((c) => !c.isArchived);
  const byLabel = active.find((c) => catLabel(c, cats).toLowerCase() === q) ?? active.find((c) => c.name.toLowerCase() === q);
  if (byLabel) return byLabel;
  const partial = active.filter((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
  const top = partial.filter((c) => !c.parentId);
  if (partial.length === 1) return partial[0];
  if (top.length === 1) return top[0];
  const suggestions = (partial.length ? partial : active.filter((c) => !c.parentId)).slice(0, 12).map((c) => catLabel(c, cats));
  throw new AppError("NOT_FOUND", `No single ${kind ?? ""} category matches "${clip(raw, 40)}". Options: ${suggestions.join(", ")}`.replace(/\s+/g, " "));
}

/* ───────────── Shared SQL ───────────── */

async function categoryBreakdown(ctx: ToolContext, from: ISODate, to: ISODate, group: "top" | "detailed") {
  const [rows, cats] = await Promise.all([spendingByCategoryId(ctx.userId, from, to), userCategories(ctx)]);
  const byKey = new Map<string, { label: string; categoryId: string | null; amount: string; count: number }>();
  for (const r of rows) {
    const c = r.categoryId ? cats.find((x) => x.id === r.categoryId) : undefined;
    const target = c && group === "top" && c.parentId ? (cats.find((x) => x.id === c.parentId) ?? c) : c;
    const key = target?.id ?? "uncategorized";
    const label = target ? (group === "top" ? target.name : catLabel(target, cats)) : "Uncategorized";
    const cur = byKey.get(key) ?? { label, categoryId: target?.id ?? null, amount: "0", count: 0 };
    cur.amount = add(cur.amount, r.amount);
    cur.count += r.count;
    byKey.set(key, cur);
  }
  return [...byKey.values()].sort((a, b) => cmp(b.amount, a.amount));
}

/* ───────────── Tool schemas ───────────── */

const range = { from: isoDateArg.nullish().describe("Start date YYYY-MM-DD (default: start of the current month)"), to: isoDateArg.nullish().describe("End date YYYY-MM-DD") };
const rangeObj = z.object({ from: isoDateArg, to: isoDateArg });

const S = {
  get_period_summary: z.object(range),
  spending_by_category: z.object({
    ...range,
    limit: z.number().int().min(1).max(30).nullish(),
    group: z.enum(["top", "detailed"]).nullish().describe("top = roll subcategories into their parent (default); detailed = each subcategory"),
  }),
  list_transactions: z.object({
    q: z.string().max(80).nullish().describe("Free-text search in merchant, notes, category, account, tags"),
    ...range,
    minAmount: amountArg.nullish(),
    maxAmount: amountArg.nullish(),
    type: z.enum(["expense", "income", "transfer", "refund"]).nullish(),
    category: z.string().max(80).nullish().describe("Category name (includes its subcategories)"),
    merchant: z.string().max(80).nullish().describe("Merchant name (partial match)"),
    uncategorized: z.boolean().nullish(),
    limit: z.number().int().min(1).max(50).nullish(),
    sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).nullish(),
  }),
  top_merchants: z.object({ ...range, limit: z.number().int().min(1).max(25).nullish() }),
  compare_periods: z.object({ a: rangeObj.describe("The period of interest (e.g. this month)"), b: rangeObj.describe("The baseline period (e.g. last month)") }),
  category_trend: z.object({ category: z.string().min(1).max(80), months: z.number().int().min(2).max(24).nullish() }),
  list_budgets_status: z.object({}),
  upcoming_bills: z.object({ days: z.number().int().min(1).max(90).nullish(), includeIncome: z.boolean().nullish() }),
  list_subscriptions: z.object({}),
  goals_status: z.object({}),
  account_balances: z.object({}),
  net_worth: z.object({}),
  cash_flow_projection: z.object({ days: z.number().int().min(7).max(90).nullish() }),
  safe_to_spend: z.object({}),
  what_if: z.object({ category: z.string().min(1).max(80), reducePercent: z.number().min(1).max(100) }),

  propose_add_transaction: z.object({
    type: z.enum(["expense", "income"]).nullish(),
    amount: amountArg,
    date: isoDateArg.nullish().describe("Default today"),
    merchant: z.string().max(80).nullish(),
    category: z.string().max(80).nullish().describe("Category name from the user's list"),
    account: z.string().max(80).nullish().describe("Account name (default: the user's default account)"),
    paymentMethod: z.string().max(40).nullish(),
    notes: z.string().max(500).nullish(),
  }),
  propose_create_budget: z.object({
    category: z.string().max(80).nullish().describe("Expense category name; omit for an overall spending budget"),
    amount: amountArg,
    period: z.enum(["weekly", "monthly", "yearly"]).nullish(),
    name: z.string().max(60).nullish(),
  }),
  propose_create_goal: z.object({
    name: z.string().min(1).max(60),
    targetAmount: amountArg,
    deadline: isoDateArg.nullish(),
    startingAmount: amountArg.nullish(),
    monthlyContribution: amountArg.nullish(),
  }),
  propose_add_goal_contribution: z.object({
    goal: z.string().min(1).max(80).describe("Goal name"),
    amount: amountArg,
    withdrawal: z.boolean().nullish().describe("true to take money out of the goal"),
    date: isoDateArg.nullish(),
    note: z.string().max(200).nullish(),
  }),
  propose_update_transaction: z.object({
    transactionId: z.uuid().describe("id from list_transactions"),
    category: z.string().max(80).nullish(),
    amount: amountArg.nullish(),
    date: isoDateArg.nullish(),
    notes: z.string().max(500).nullish(),
  }),
  propose_delete_transactions: z.object({ transactionIds: z.array(z.uuid()).min(1).max(50).describe("ids from list_transactions") }),
} as const;

export type ToolName = keyof typeof S;

const DESCRIPTIONS: Record<ToolName, string> = {
  get_period_summary: "Income, spending (expenses − refunds), net savings and savings rate for a date range.",
  spending_by_category: "Spending per category for a date range, largest first, with share of total.",
  list_transactions: "Find individual transactions with filters. Returns ids usable by propose_update_transaction / propose_delete_transactions.",
  top_merchants: "Merchants with the most spending in a date range.",
  compare_periods: "Compare two date ranges: totals and the categories that changed most.",
  category_trend: "Monthly spending in one category (incl. subcategories) for the last N months.",
  list_budgets_status: "Active budgets for the current period: limit, spent, remaining and projected end-of-period spend.",
  upcoming_bills: "Scheduled bills, subscriptions and recurring expenses due in the next N days (overdue included).",
  list_subscriptions: "Active subscriptions with their monthly and yearly cost.",
  goals_status: "Savings goals: target, saved, progress, deadline, required monthly saving and projected completion.",
  account_balances: "Current balance of each account.",
  net_worth: "Assets, liabilities and net worth now and 30 days ago.",
  cash_flow_projection: "FORECAST of liquid cash over the next N days from balances, scheduled items and average daily spending.",
  safe_to_spend: "How much can be spent for the rest of the current month after upcoming bills and goal contributions.",
  what_if: "What-if: savings from reducing spending in a category by a percentage, based on the last 3 full months.",
  propose_add_transaction: "PROPOSE adding an expense or income. Not executed until the user confirms.",
  propose_create_budget: "PROPOSE creating a budget. Not executed until the user confirms.",
  propose_create_goal: "PROPOSE creating a savings goal. Not executed until the user confirms.",
  propose_add_goal_contribution: "PROPOSE adding money to (or withdrawing from) a goal. Not executed until the user confirms.",
  propose_update_transaction: "PROPOSE changing a transaction's category, amount, date or notes. Not executed until the user confirms.",
  propose_delete_transactions: "PROPOSE deleting transactions (destructive; only when the user explicitly asks). Not executed until the user confirms.",
};

export const TOOL_LABELS: Record<ToolName, string> = {
  get_period_summary: "Period summary",
  spending_by_category: "Spending by category",
  list_transactions: "Transactions",
  top_merchants: "Top merchants",
  compare_periods: "Period comparison",
  category_trend: "Category trend",
  list_budgets_status: "Budgets",
  upcoming_bills: "Upcoming bills",
  list_subscriptions: "Subscriptions",
  goals_status: "Goals",
  account_balances: "Account balances",
  net_worth: "Net worth",
  cash_flow_projection: "Cash-flow forecast",
  safe_to_spend: "Safe to spend",
  what_if: "What-if calculation",
  propose_add_transaction: "Proposed transaction",
  propose_create_budget: "Proposed budget",
  propose_create_goal: "Proposed goal",
  propose_add_goal_contribution: "Proposed goal contribution",
  propose_update_transaction: "Proposed edit",
  propose_delete_transactions: "Proposed deletion",
};

/** Compact JSON schema for the model: optional fields are simply omitted, so drop `null` unions. */
function slim(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slim);
  if (!node || typeof node !== "object") return node;
  const o = { ...(node as Record<string, unknown>) };
  if (Array.isArray(o.anyOf)) {
    const rest = (o.anyOf as Record<string, unknown>[]).filter((x) => x.type !== "null");
    if (rest.length === 1) {
      const { anyOf: _drop, ...others } = o;
      void _drop;
      return slim({ ...others, ...rest[0] });
    }
    o.anyOf = rest;
  }
  if (Array.isArray(o.type)) {
    const t = (o.type as string[]).filter((x) => x !== "null");
    o.type = t.length === 1 ? t[0] : t;
  }
  delete o.$schema;
  delete o.additionalProperties;
  for (const k of Object.keys(o)) if (k !== "enum" && k !== "required") o[k] = slim(o[k]);
  return o;
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return slim(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as Record<string, unknown>;
}

export const TOOL_DEFS: ToolDef[] = (Object.keys(S) as ToolName[]).map((name) => ({
  type: "function",
  function: { name, description: DESCRIPTIONS[name], parameters: jsonSchemaFor(S[name]) },
}));

export const isToolName = (n: string): n is ToolName => Object.prototype.hasOwnProperty.call(S, n);

/* ───────────── Read tools ───────────── */

type Args<N extends ToolName> = z.output<(typeof S)[N]>;

async function getPeriodSummary(ctx: ToolContext, a: Args<"get_period_summary">) {
  const r = resolveRange(ctx, a.from, a.to);
  const s = await summarizeTransactions(ctx.userId, { from: r.from, to: r.to });
  return {
    period: r,
    currency: ctx.prefs.currency,
    transactionCount: s.count,
    income: dp(s.income),
    expenses: dp(s.expenses),
    refunds: dp(s.refunds),
    spending: dp(s.spending),
    netSavings: dp(s.net),
    savingsRatePercent: pct(s.net, s.income),
    note: "Spending = expenses − refunds. Transfers between accounts are excluded.",
  };
}

async function spendingByCategory(ctx: ToolContext, a: Args<"spending_by_category">) {
  const r = resolveRange(ctx, a.from, a.to);
  const rows = await categoryBreakdown(ctx, r.from, r.to, a.group ?? "top");
  const total = add(...rows.map((x) => x.amount));
  const limit = a.limit ?? 12;
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  return {
    period: r,
    currency: ctx.prefs.currency,
    totalSpending: dp(total),
    categories: shown.map((x) => ({ category: x.label, amount: dp(x.amount), sharePercent: pct(x.amount, total), transactions: x.count })),
    ...(rest.length ? { otherCategories: { count: rest.length, amount: dp(add(...rest.map((x) => x.amount))) } } : {}),
  };
}

async function merchantIdsMatching(userId: string, name: string) {
  const term = normalizeMerchant(name).replace(/[%_\\]/g, "\\$&");
  if (!term) return [];
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM merchants WHERE user_id = ${userId} AND normalized_name LIKE ${"%" + term + "%"} LIMIT 50`);
  return rows.map((r) => r.id);
}

async function listTransactionsTool(ctx: ToolContext, a: Args<"list_transactions">) {
  const f: TransactionFilters = { sort: a.sort ?? "date_desc" };
  if (a.from || a.to) Object.assign(f, resolveRange(ctx, a.from ?? "1970-01-01", a.to ?? ctx.prefs.today));
  if (a.q) f.q = a.q;
  if (a.type) f.types = [a.type];
  if (a.minAmount != null) f.minAmount = parseAmount(a.minAmount, "minAmount", { allowZero: true });
  if (a.maxAmount != null) f.maxAmount = parseAmount(a.maxAmount, "maxAmount", { allowZero: true });
  if (a.uncategorized) f.uncategorized = true;
  if (a.category) f.categoryIds = [(await resolveCategory(ctx, a.category)).id];
  if (a.merchant) {
    const ids = await merchantIdsMatching(ctx.userId, a.merchant);
    if (!ids.length) return { currency: ctx.prefs.currency, transactions: [], note: `No merchant matching "${clip(a.merchant, 40)}".` };
    f.merchantIds = ids;
  }
  const limit = a.limit ?? 20;
  const [{ rows, hasMore }, summary] = await Promise.all([listTransactions(ctx.userId, f, { limit }), summarizeTransactions(ctx.userId, f)]);
  return {
    baseCurrency: ctx.prefs.currency,
    matchingCount: summary.count,
    matchingTotals: { income: dp(summary.income), spending: dp(summary.spending) },
    hasMore,
    transactions: rows.map((t) => ({
      id: t.id,
      date: t.date,
      type: t.type,
      amount: dp(t.amount),
      currency: t.currency,
      ...(t.currency !== ctx.prefs.currency ? { baseAmount: dp(t.baseAmount) } : {}),
      merchant: clip(t.merchantName, 60),
      category: t.hasSplits ? `Split: ${t.splits.map((s) => s.categoryName ?? "Uncategorized").join(", ")}` : t.categoryName ? (t.parentCategoryName ? `${t.parentCategoryName} › ${t.categoryName}` : t.categoryName) : null,
      account: t.type === "transfer" ? `${t.accountName} → ${t.toAccountName}` : t.accountName,
      notes: clip(t.notes, 120),
      ...(t.isPending ? { pending: true } : {}),
      ...(t.recurringId ? { recurring: true } : {}),
    })),
  };
}

async function topMerchants(ctx: ToolContext, a: Args<"top_merchants">) {
  const r = resolveRange(ctx, a.from, a.to);
  const rows = await db.execute<{ name: string; amount: string; count: number }>(sql`
    SELECT m.name, SUM(CASE WHEN t.type = 'refund' THEN -t.base_amount ELSE t.base_amount END)::text AS amount, COUNT(*)::int AS count
    FROM transactions t JOIN merchants m ON m.id = t.merchant_id AND m.user_id = ${ctx.userId}
    WHERE t.user_id = ${ctx.userId} AND t.deleted_at IS NULL AND t.type IN ('expense', 'refund') AND t.date BETWEEN ${r.from} AND ${r.to}
    GROUP BY m.id, m.name
    ORDER BY SUM(CASE WHEN t.type = 'refund' THEN -t.base_amount ELSE t.base_amount END) DESC
    LIMIT ${a.limit ?? 10}`);
  return { period: r, currency: ctx.prefs.currency, merchants: rows.map((m) => ({ merchant: clip(m.name, 60), amount: dp(m.amount), transactions: Number(m.count) })) };
}

async function comparePeriods(ctx: ToolContext, a: Args<"compare_periods">) {
  for (const p of [a.a, a.b]) if (p.from > p.to) throw new AppError("VALIDATION", "Each period's `from` must be on or before its `to`");
  const [sa, sb, ca, cb] = await Promise.all([
    summarizeTransactions(ctx.userId, a.a),
    summarizeTransactions(ctx.userId, a.b),
    categoryBreakdown(ctx, a.a.from, a.a.to, "top"),
    categoryBreakdown(ctx, a.b.from, a.b.to, "top"),
  ]);
  const labels = new Set([...ca.map((c) => c.label), ...cb.map((c) => c.label)]);
  const changes = [...labels]
    .map((label) => {
      const x = ca.find((c) => c.label === label)?.amount ?? "0";
      const y = cb.find((c) => c.label === label)?.amount ?? "0";
      return { category: label, a: x, b: y, change: sub(x, y) };
    })
    .sort((p, q) => cmp(q.change.replace("-", ""), p.change.replace("-", "")))
    .slice(0, 8)
    .map((c) => ({ category: c.category, periodA: dp(c.a), periodB: dp(c.b), change: dp(c.change), changePercent: isPositive(c.b) ? Math.round((ratio(c.a, c.b) - 1) * 1000) / 10 : null }));
  const row = (s: typeof sa) => ({ income: dp(s.income), spending: dp(s.spending), netSavings: dp(s.net), savingsRatePercent: pct(s.net, s.income), transactions: s.count });
  return {
    currency: ctx.prefs.currency,
    periodA: { ...a.a, ...row(sa), days: daysBetween(a.a.from, a.a.to) + 1 },
    periodB: { ...a.b, ...row(sb), days: daysBetween(a.b.from, a.b.to) + 1 },
    spendingChange: dp(sub(sa.spending, sb.spending)),
    spendingChangePercent: isPositive(sb.spending) ? Math.round((ratio(sa.spending, sb.spending) - 1) * 1000) / 10 : null,
    biggestCategoryChanges: changes,
    note: "If the periods have different lengths (e.g. month-to-date vs a full month), say so when comparing.",
  };
}

/** The last `n` budget periods (oldest first) ending with the current one. */
function lastPeriods(ctx: ToolContext, n: number) {
  const out = [currentPeriod(ctx)];
  while (out.length < n) out.unshift(monthRange(addDaysISO(out[0].from, -1), ctx.prefs.monthStartDay));
  return out;
}

async function categoryTrend(ctx: ToolContext, a: Args<"category_trend">) {
  const cat = await resolveCategory(ctx, a.category, "expense");
  const ids = await expandCategoryIds(ctx.userId, [cat.id]);
  const periods = lastPeriods(ctx, a.months ?? 6);
  const days = await dailySpending(ctx.userId, periods[0].from, periods[periods.length - 1].to, ids);
  const months = periods.map((p, i) => ({
    from: p.from,
    to: p.to,
    amount: dp(add(...days.filter((d) => d.date >= p.from && d.date <= p.to).map((d) => d.amount))),
    ...(i === periods.length - 1 ? { partial: true, daysElapsed: daysBetween(p.from, ctx.prefs.today) + 1 } : {}),
  }));
  const full = months.slice(0, -1);
  return {
    category: catLabel(cat, await userCategories(ctx)),
    currency: ctx.prefs.currency,
    months,
    averageOfFullMonths: full.length ? dp(divInt(add(...full.map((m) => m.amount)), full.length)) : null,
  };
}

async function listBudgetsStatus(ctx: ToolContext) {
  const [list, cats] = await Promise.all([listBudgetsWithProgress(ctx.userId, ctx.prefs.today), userCategories(ctx)]);
  if (!list.length) return { budgets: [], note: "The user has no active budgets." };
  return {
    currency: ctx.prefs.currency,
    budgets: list.slice(0, 40).map((b) => {
      const c = b.categoryId ? cats.find((k) => k.id === b.categoryId) : null;
      return {
        name: clip(b.name, 60),
        category: c ? catLabel(c, cats) : "All spending",
        period: b.period,
        window: b.periodRange,
        available: dp(b.available),
        ...(b.rollover ? { rolloverIncluded: dp(b.rolloverAmount) } : {}),
        spent: dp(b.spent),
        remaining: dp(b.remaining),
        usedPercent: Math.round(b.pct * 1000) / 10,
        projectedSpend: dp(b.projected),
        projectionReliable: b.projectionReliable,
        status: b.status,
        daysLeft: b.daysLeft,
        dailyAllowance: dp(b.dailyAllowance),
      };
    }),
    note: "projectedSpend is a straight-line FORECAST from the pace so far (unreliable early in a period).",
  };
}

async function upcomingBills(ctx: ToolContext, a: Args<"upcoming_bills">) {
  const days = a.days ?? 14;
  const to = addDaysISO(ctx.prefs.today, days);
  const kinds = a.includeIncome ? (["expense", "bill", "subscription", "income"] as const) : (["expense", "bill", "subscription"] as const);
  const items = await upcomingOccurrences(ctx.userId, ctx.prefs.today, to, { kinds: [...kinds] });
  const out = items.filter((i) => i.kind !== "income");
  const inc = items.filter((i) => i.kind === "income");
  const total = (l: typeof items) => dp(add(...l.map((i) => i.baseAmount ?? "0")));
  return {
    window: { from: ctx.prefs.today, to },
    baseCurrency: ctx.prefs.currency,
    bills: out.slice(0, 40).map((i) => ({ name: clip(i.name, 60), kind: i.kind, date: i.date, amount: dp(i.amount), currency: i.currency, status: i.status, autoPay: i.autoPost })),
    billsTotal: total(out),
    ...(a.includeIncome ? { expectedIncome: inc.slice(0, 20).map((i) => ({ name: clip(i.name, 60), date: i.date, amount: dp(i.amount), currency: i.currency })), expectedIncomeTotal: total(inc) } : {}),
    ...(items.some((i) => !i.baseAmount) ? { note: "Some items are in a currency without an exchange rate and are excluded from totals." } : {}),
  };
}

async function listSubscriptions(ctx: ToolContext) {
  const [summary, items] = await Promise.all([recurringCostSummary(ctx.userId, ["subscription"]), listRecurring(ctx.userId, { kinds: ["subscription"] })]);
  if (!summary.count) return { subscriptions: [], note: "No active subscriptions are tracked." };
  return {
    currency: summary.currency,
    count: summary.count,
    monthlyTotal: dp(summary.monthly),
    yearlyTotal: dp(summary.yearly),
    subscriptions: items
      .filter((i) => i.status === "active")
      .slice(0, 40)
      .map((i) => ({
        name: clip(i.name, 60),
        amount: dp(i.amount),
        currency: i.currency,
        frequency: i.frequency,
        nextDate: i.nextDate,
        monthlyEquivalent: dp(summary.items.find((x) => x.id === i.id)?.monthly ?? "0"),
        ...(i.trialEndsAt ? { trialEndsAt: i.trialEndsAt } : {}),
      })),
    ...(summary.unconvertedCurrencies.length ? { note: `Excluded from totals (no exchange rate): ${summary.unconvertedCurrencies.join(", ")}` } : {}),
  };
}

async function goalsStatus(ctx: ToolContext) {
  const list = await listGoalsWithProgress(ctx.userId, { status: ["active", "completed"] });
  if (!list.length) return { goals: [], note: "The user has no savings goals." };
  return {
    goals: list.slice(0, 30).map((g) => ({
      name: clip(g.name, 60),
      status: g.status,
      currency: g.currency,
      target: dp(g.targetAmount),
      saved: dp(g.current),
      remaining: dp(g.remaining),
      progressPercent: Math.round(g.progress * 1000) / 10,
      deadline: g.deadline,
      perPeriod: g.periodFrequency,
      requiredPerPeriodToHitDeadline: g.requiredPerPeriod ? dp(g.requiredPerPeriod) : null,
      recentPacePerPeriod: g.pacePerPeriod ? dp(g.pacePerPeriod) : null,
      projectedCompletionDate: g.projectedCompletionDate,
      track: g.track,
      lastContributionDate: g.lastContributionDate,
    })),
    note: "projectedCompletionDate is a FORECAST at the recent contribution pace (null = no positive recent pace).",
  };
}

async function convertedAccounts(ctx: ToolContext) {
  const [list, rates] = await Promise.all([listAccounts(ctx.userId), rateMap(ctx.userId, ctx.prefs.currency)]);
  return list.map((a) => {
    const r = rates.get(a.currency);
    return { ...a, baseBalance: r ? mul(a.balance, r) : null };
  });
}

async function accountBalancesTool(ctx: ToolContext) {
  const list = await convertedAccounts(ctx);
  if (!list.length) return { accounts: [], note: "The user has no accounts yet." };
  return {
    baseCurrency: ctx.prefs.currency,
    accounts: list.slice(0, 40).map((a) => ({
      name: clip(a.name, 60),
      type: a.type,
      currency: a.currency,
      balance: dp(a.balance),
      ...(a.currency !== ctx.prefs.currency ? { balanceInBase: a.baseBalance ? dp(a.baseBalance) : null } : {}),
      ...(a.liability ? { liability: true, note: "negative = amount owed" } : {}),
      ...(a.availableCredit ? { availableCredit: dp(a.availableCredit) } : {}),
    })),
    liquidTotal: dp(add(...list.filter((a) => isLiquidType(a.type)).map((a) => a.baseBalance ?? "0"))),
  };
}

async function netWorth(ctx: ToolContext) {
  const list = (await convertedAccounts(ctx)).filter((a) => a.includeInNetWorth);
  const rates = await rateMap(ctx.userId, ctx.prefs.currency);
  const past = await accountBalances(ctx.userId, addDaysISO(ctx.prefs.today, -30));
  let assets = "0";
  let liabilities = "0";
  let pastNet = "0";
  const missing = new Set<string>();
  for (const a of list) {
    if (!a.baseBalance) {
      missing.add(a.currency);
      continue;
    }
    if (isPositive(a.baseBalance)) assets = add(assets, a.baseBalance);
    else liabilities = add(liabilities, a.baseBalance.replace("-", ""));
    const pb = past.get(a.id);
    if (pb) pastNet = add(pastNet, mul(pb, rates.get(a.currency)!));
  }
  const net = sub(assets, liabilities);
  return {
    currency: ctx.prefs.currency,
    assets: dp(assets),
    liabilities: dp(liabilities),
    netWorth: dp(net),
    netWorth30DaysAgo: dp(pastNet),
    change30Days: dp(sub(net, pastNet)),
    accountsIncluded: list.length,
    ...(missing.size ? { note: `Excluded (no exchange rate): ${[...missing].join(", ")}` } : {}),
  };
}

async function liquidBalance(ctx: ToolContext) {
  const list = await convertedAccounts(ctx);
  return add(...list.filter((a) => isLiquidType(a.type)).map((a) => a.baseBalance ?? "0"));
}

export async function cashFlowProjection(userId: string, prefs: Prefs, days: number, liquid?: string) {
  const ctx = makeToolContext(userId, prefs);
  const start = liquid ?? (await liquidBalance(ctx));
  const to = addDaysISO(prefs.today, days);
  const occ = await upcomingOccurrences(userId, prefs.today, to, { kinds: ["expense", "bill", "subscription", "income"] });
  const lookback = await spendingTotal(userId, addDaysISO(prefs.today, -90), addDaysISO(prefs.today, -1), null, { excludeRecurring: true });
  const avgDaily = divInt(lookback, 90);
  let bal = start;
  let low = { balance: start, date: prefs.today };
  let income = "0";
  let outflows = "0";
  for (let i = 0; i <= days; i++) {
    const d = addDaysISO(prefs.today, i);
    for (const o of occ.filter((x) => (i === 0 ? x.date <= d : x.date === d))) {
      if (!o.baseAmount) continue;
      if (o.kind === "income") {
        income = add(income, o.baseAmount);
        bal = add(bal, o.baseAmount);
      } else {
        outflows = add(outflows, o.baseAmount);
        bal = sub(bal, o.baseAmount);
      }
    }
    if (i > 0) bal = sub(bal, avgDaily);
    if (cmp(bal, low.balance) < 0) low = { balance: bal, date: d };
  }
  return { start, to, income, outflows, avgDaily, end: bal, low, occurrences: occ.length };
}

async function cashFlowProjectionTool(ctx: ToolContext, a: Args<"cash_flow_projection">) {
  const days = a.days ?? 30;
  const p = await cashFlowProjection(ctx.userId, ctx.prefs, days);
  return {
    kind: "FORECAST — an estimate, not a fact",
    currency: ctx.prefs.currency,
    window: { from: ctx.prefs.today, to: p.to },
    startingLiquidBalance: dp(p.start),
    scheduledIncome: dp(p.income),
    scheduledOutflows: dp(p.outflows),
    averageDailyDiscretionarySpend: dp(p.avgDaily),
    projectedEndBalance: dp(p.end),
    lowestProjectedBalance: dp(p.low.balance),
    lowestOn: p.low.date,
    assumptions: [
      "Liquid = checking, savings, cash and wallet accounts.",
      "Scheduled = active recurring bills, subscriptions and income (including overdue ones).",
      "Discretionary spend = average daily non-recurring spending over the last 90 days.",
      "Transfers and credit-card payments are not modelled.",
    ],
  };
}

export async function safeToSpend(userId: string, prefs: Prefs) {
  const ctx = makeToolContext(userId, prefs);
  const period = currentPeriod(ctx);
  const [liquid, occ, goalList, rates] = await Promise.all([
    liquidBalance(ctx),
    upcomingOccurrences(userId, prefs.today, period.to, { kinds: ["expense", "bill", "subscription", "income"] }),
    listGoalsWithProgress(userId, { status: ["active"] }),
    rateMap(userId, prefs.currency),
  ]);
  const bills = occ.filter((o) => o.kind !== "income");
  const billsTotal = add(...bills.map((o) => o.baseAmount ?? "0"));
  const expectedIncome = add(...occ.filter((o) => o.kind === "income").map((o) => o.baseAmount ?? "0"));
  // Goal set-aside: the monthly-equivalent planned contribution not yet made this period.
  let goalsSetAside = "0";
  for (const g of goalList) {
    const planned = g.targetContribution ?? g.requiredPerPeriod;
    if (!planned || !isPositive(g.remaining)) continue;
    const { num, den } = perMonthFactor({ frequency: g.periodFrequency as Frequency, interval: 1, intervalUnit: "month" });
    const monthly = divInt(mul(planned, String(num)), den);
    const rows = await db.execute<{ s: string }>(sql`
      SELECT COALESCE(SUM(amount), 0)::text AS s FROM goal_contributions
      WHERE user_id = ${userId} AND goal_id = ${g.id} AND date BETWEEN ${period.from} AND ${period.to}`);
    const left = moneyMax(sub(monthly, rows[0]?.s ?? "0"), "0");
    const rate = rates.get(g.currency);
    if (rate) goalsSetAside = add(goalsSetAside, mul(left, rate));
  }
  const safe = sub(sub(liquid, billsTotal), goalsSetAside);
  const daysLeft = daysBetween(prefs.today, period.to) + 1;
  return { period, liquid, billsTotal, billsCount: bills.length, goalsSetAside, expectedIncome, safe, daysLeft, perDay: isPositive(safe) ? divInt(safe, daysLeft) : "0" };
}

async function safeToSpendTool(ctx: ToolContext) {
  const s = await safeToSpend(ctx.userId, ctx.prefs);
  return {
    kind: "CALCULATION",
    currency: ctx.prefs.currency,
    period: s.period,
    liquidBalance: dp(s.liquid),
    upcomingBillsUntilPeriodEnd: dp(s.billsTotal),
    upcomingBillsCount: s.billsCount,
    goalContributionsStillPlanned: dp(s.goalsSetAside),
    safeToSpend: dp(s.safe),
    daysLeftInPeriod: s.daysLeft,
    perDay: dp(s.perDay),
    expectedIncomeNotCounted: dp(s.expectedIncome),
    formula: "safeToSpend = liquid balance − upcoming bills until period end − planned goal contributions. Expected income is NOT counted until it arrives.",
  };
}

async function whatIf(ctx: ToolContext, a: Args<"what_if">) {
  const cat = await resolveCategory(ctx, a.category, "expense");
  const ids = await expandCategoryIds(ctx.userId, [cat.id]);
  const periods = lastPeriods(ctx, 4).slice(0, 3); // the 3 full periods before the current one
  const days = await dailySpending(ctx.userId, periods[0].from, periods[2].to, ids);
  const perMonth = periods.map((p) => ({ from: p.from, to: p.to, amount: add(...days.filter((d) => d.date >= p.from && d.date <= p.to).map((d) => d.amount)) }));
  const avg = divInt(add(...perMonth.map((m) => m.amount)), 3);
  const factor = String(Math.round(a.reducePercent * 100) / 10000);
  const monthlySavings = mul(avg, factor);
  return {
    kind: "CALCULATION",
    category: catLabel(cat, await userCategories(ctx)),
    currency: ctx.prefs.currency,
    basis: perMonth.map((m) => ({ ...m, amount: dp(m.amount) })),
    averageMonthlySpend: dp(avg),
    reducePercent: a.reducePercent,
    monthlySavings: dp(monthlySavings),
    annualSavings: dp(mul(monthlySavings, "12")),
    newMonthlySpend: dp(sub(avg, monthlySavings)),
    ...(isPositive(avg) ? {} : { note: "No spending in this category in the last 3 full months." }),
  };
}

/* ───────────── Write tools: proposals only ───────────── */

export type ActionDetail = { label: string; value: string };
export type ActionPayload = Record<string, unknown> & { display: ActionDetail[] };

async function storeProposal(ctx: ToolContext, actionType: string, payload: ActionPayload, summary: string, destructive = false) {
  if (ctx.proposed.length >= MAX_PROPOSALS_PER_TURN) throw new AppError("VALIDATION", `At most ${MAX_PROPOSALS_PER_TURN} proposals per message.`);
  const [row] = await db
    .insert(aiActions)
    .values({ userId: ctx.userId, conversationId: ctx.conversationId, actionType, payload, summary: summary.slice(0, 500), destructive, status: "pending", expiresAt: new Date(Date.now() + ACTION_TTL_MS) })
    .returning({ id: aiActions.id });
  ctx.proposed.push(row.id);
  return {
    proposed: true,
    actionId: row.id,
    summary,
    destructive,
    status: "PENDING — nothing has changed yet. The user must press Confirm on the card shown under your reply; it expires in 30 minutes.",
  };
}

const money = (ctx: ToolContext, v: string, currency?: string) => formatMoney(v, currency ?? ctx.prefs.currency, { locale: ctx.prefs.locale });

async function proposeAddTransaction(ctx: ToolContext, a: Args<"propose_add_transaction">) {
  const type = a.type ?? "expense";
  const amount = parseAmount(a.amount);
  const date = a.date ?? ctx.prefs.today;
  if (date > addDaysISO(ctx.prefs.today, 366)) throw new AppError("VALIDATION", "Date is too far in the future");
  const accounts = (await listAccounts(ctx.userId)).filter((x) => !x.isArchived);
  if (!accounts.length) throw new AppError("VALIDATION", "The user has no accounts yet — they need to create one first.");
  let account = accounts.find((x) => x.id === ctx.prefs.defaultAccountId) ?? accounts[0];
  if (a.account) {
    const q = a.account.trim().toLowerCase();
    const found = accounts.find((x) => x.name.toLowerCase() === q) ?? accounts.filter((x) => x.name.toLowerCase().includes(q))[0];
    if (!found) throw new AppError("NOT_FOUND", `No account named "${clip(a.account, 40)}". Accounts: ${accounts.map((x) => x.name).join(", ")}`);
    account = found;
  }
  if (account.currency !== ctx.prefs.currency && !(await getRate(ctx.userId, account.currency, ctx.prefs.currency)))
    throw new AppError("VALIDATION", `Account ${account.name} is in ${account.currency} and there's no exchange rate to ${ctx.prefs.currency} yet.`);
  const merchant = a.merchant?.trim().slice(0, 80) || null;
  let category: Cat | null = a.category ? await resolveCategory(ctx, a.category, type) : null;
  if (!category && merchant) {
    const learned = await suggestCategoryForMerchant(ctx.userId, merchant);
    category = (await userCategories(ctx)).find((c) => c.id === learned && c.kind === type) ?? null;
  }
  let paymentMethodId: string | null = null;
  let paymentMethodName: string | null = null;
  if (a.paymentMethod) {
    const q = a.paymentMethod.trim().toLowerCase();
    const pm = (await listPaymentMethods(ctx.userId)).find((p) => p.name.toLowerCase() === q || p.name.toLowerCase().includes(q));
    if (pm) [paymentMethodId, paymentMethodName] = [pm.id, pm.name];
  }
  const input = {
    type,
    accountId: account.id,
    amount,
    date,
    categoryId: category?.id ?? null,
    merchant,
    paymentMethodId,
    notes: a.notes?.trim().slice(0, 500) || null,
    tags: [] as string[],
  };
  const check = transactionInput.safeParse(input);
  if (!check.success) throw new AppError("VALIDATION", check.error.issues[0]?.message ?? "Invalid transaction");
  const cats = await userCategories(ctx);
  const display: ActionDetail[] = [
    { label: "Type", value: type === "income" ? "Income" : "Expense" },
    { label: "Amount", value: money(ctx, amount, account.currency) },
    { label: "Date", value: date },
    ...(merchant ? [{ label: type === "income" ? "From" : "Merchant", value: merchant }] : []),
    { label: "Category", value: category ? catLabel(category, cats) : "Uncategorized" },
    { label: "Account", value: account.name },
    ...(paymentMethodName ? [{ label: "Paid with", value: paymentMethodName }] : []),
    ...(input.notes ? [{ label: "Notes", value: clip(input.notes, 120)! }] : []),
  ];
  const summary = `Add ${type} of ${money(ctx, amount, account.currency)}${merchant ? ` ${type === "income" ? "from" : "at"} ${merchant}` : ""} on ${date}${category ? ` (${category.name})` : ""} — ${account.name}`;
  return storeProposal(ctx, "add_transaction", { input, display }, summary);
}

async function proposeCreateBudget(ctx: ToolContext, a: Args<"propose_create_budget">) {
  const amount = parseAmount(a.amount);
  const period = a.period ?? "monthly";
  const category = a.category ? await resolveCategory(ctx, a.category, "expense") : null;
  const existing = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(and(eq(budgets.userId, ctx.userId), eq(budgets.isArchived, false), eq(budgets.period, period), category ? eq(budgets.categoryId, category.id) : sql`${budgets.categoryId} IS NULL`))
    .limit(1);
  if (existing.length) throw new AppError("CONFLICT", `There's already an active ${period} budget for ${category?.name ?? "overall spending"}. Suggest editing it on the Budgets page instead.`);
  const name = (a.name?.trim() || (category ? category.name : "Overall spending")).slice(0, 60);
  const input = { name, period, categoryId: category?.id ?? null, amount, includeSubcategories: true };
  const check = budgetInput.safeParse(input);
  if (!check.success) throw new AppError("VALIDATION", check.error.issues[0]?.message ?? "Invalid budget");
  const display: ActionDetail[] = [
    { label: "Name", value: name },
    { label: "Category", value: category ? catLabel(category, await userCategories(ctx)) : "All spending" },
    { label: "Limit", value: `${money(ctx, amount)} / ${period.replace("ly", "")}` },
  ];
  return storeProposal(ctx, "create_budget", { input, display }, `Create a ${period} budget of ${money(ctx, amount)} for ${category?.name ?? "all spending"}`);
}

async function proposeCreateGoal(ctx: ToolContext, a: Args<"propose_create_goal">) {
  const target = parseAmount(a.targetAmount, "targetAmount");
  const starting = a.startingAmount != null ? parseAmount(a.startingAmount, "startingAmount", { allowZero: true }) : "0.0000";
  const monthly = a.monthlyContribution != null ? parseAmount(a.monthlyContribution, "monthlyContribution") : null;
  if (a.deadline && a.deadline <= ctx.prefs.today) throw new AppError("VALIDATION", "The deadline must be in the future");
  const name = a.name.trim().slice(0, 60);
  const input = { name, targetAmount: target, startingAmount: starting, deadline: a.deadline ?? null, targetContribution: monthly, contributionFrequency: monthly ? ("monthly" as const) : null };
  const display: ActionDetail[] = [
    { label: "Goal", value: name },
    { label: "Target", value: money(ctx, target) },
    ...(isPositive(starting) ? [{ label: "Already saved", value: money(ctx, starting) }] : []),
    ...(a.deadline ? [{ label: "Deadline", value: a.deadline }] : []),
    ...(monthly ? [{ label: "Monthly contribution", value: money(ctx, monthly) }] : []),
  ];
  return storeProposal(ctx, "create_goal", { input, display }, `Create goal "${name}" with a target of ${money(ctx, target)}${a.deadline ? ` by ${a.deadline}` : ""}`);
}

async function proposeGoalContribution(ctx: ToolContext, a: Args<"propose_add_goal_contribution">) {
  const amount = parseAmount(a.amount);
  const list = await listGoalsWithProgress(ctx.userId, { status: ["active", "completed"] });
  const q = a.goal.trim().toLowerCase();
  const exact = list.filter((g) => g.name.toLowerCase() === q);
  const matches = exact.length ? exact : list.filter((g) => g.name.toLowerCase().includes(q) || q.includes(g.name.toLowerCase()));
  if (matches.length !== 1)
    throw new AppError(
      "NOT_FOUND",
      matches.length ? `Several goals match "${clip(a.goal, 40)}": ${matches.map((g) => g.name).join(", ")}` : `No goal named "${clip(a.goal, 40)}". Goals: ${list.map((g) => g.name).join(", ") || "none"}`,
    );
  const goal = matches[0];
  const withdraw = Boolean(a.withdrawal);
  if (withdraw && cmp(amount, goal.current) > 0) throw new AppError("VALIDATION", `The goal only holds ${money(ctx, goal.current, goal.currency)}.`);
  const date = a.date ?? ctx.prefs.today;
  if (date > ctx.prefs.today) throw new AppError("VALIDATION", "Contributions can't be in the future");
  const input = { goalId: goal.id, direction: withdraw ? ("withdraw" as const) : ("contribute" as const), amount, date, note: a.note?.trim().slice(0, 200) || null };
  const after = withdraw ? sub(goal.current, amount) : add(goal.current, amount);
  const display: ActionDetail[] = [
    { label: "Goal", value: goal.name },
    { label: withdraw ? "Withdraw" : "Add", value: money(ctx, amount, goal.currency) },
    { label: "Date", value: date },
    { label: "Saved after", value: `${money(ctx, after, goal.currency)} of ${money(ctx, goal.targetAmount, goal.currency)}` },
  ];
  return storeProposal(ctx, "add_goal_contribution", { input, display }, `${withdraw ? "Withdraw" : "Add"} ${money(ctx, amount, goal.currency)} ${withdraw ? "from" : "to"} goal "${goal.name}"`);
}

async function proposeUpdateTransaction(ctx: ToolContext, a: Args<"propose_update_transaction">) {
  const t = await getTransaction(ctx.userId, a.transactionId); // NOT_FOUND for foreign/missing ids
  const patch: { categoryId?: string | null; amount?: string; date?: string; notes?: string | null } = {};
  const display: ActionDetail[] = [{ label: "Transaction", value: `${t.date} · ${t.merchantName ?? t.categoryName ?? t.type} · ${money(ctx, t.amount, t.currency)}` }];
  const cats = await userCategories(ctx);
  if (a.category != null) {
    if (t.type === "transfer" || t.type === "adjustment") throw new AppError("VALIDATION", `A ${t.type} has no category.`);
    if (t.hasSplits) throw new AppError("VALIDATION", "This transaction is split across categories; edit it in the app.");
    const c = await resolveCategory(ctx, a.category, t.type === "income" ? "income" : "expense");
    patch.categoryId = c.id;
    display.push({ label: "Category", value: `${t.categoryName ?? "Uncategorized"} → ${catLabel(c, cats)}` });
  }
  if (a.amount != null) {
    if (t.hasSplits) throw new AppError("VALIDATION", "This transaction is split across categories; edit its amount in the app.");
    patch.amount = parseAmount(a.amount);
    display.push({ label: "Amount", value: `${money(ctx, t.amount, t.currency)} → ${money(ctx, patch.amount, t.currency)}` });
  }
  if (a.date != null) {
    patch.date = a.date;
    display.push({ label: "Date", value: `${t.date} → ${a.date}` });
  }
  if (a.notes !== undefined && a.notes !== null) {
    patch.notes = a.notes.trim().slice(0, 500) || null;
    display.push({ label: "Notes", value: `${clip(t.notes, 60) ?? "—"} → ${clip(patch.notes, 60) ?? "—"}` });
  }
  if (Object.keys(patch).length === 0) throw new AppError("VALIDATION", "Nothing to change — pass category, amount, date or notes.");
  return storeProposal(ctx, "update_transaction", { transactionId: t.id, patch, display }, `Edit the ${t.date} ${t.merchantName ?? t.type} transaction (${display.slice(1).map((d) => d.label.toLowerCase()).join(", ")})`);
}

async function proposeDeleteTransactions(ctx: ToolContext, a: Args<"propose_delete_transactions">) {
  const ids = [...new Set(a.transactionIds)];
  const rows = await db.execute<{ id: string; date: string; amount: string; currency: string; base_amount: string; merchant: string | null; type: string }>(sql`
    SELECT t.id, t.date::text, t.amount::text, t.currency, t.base_amount::text, m.name AS merchant, t.type::text
    FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id AND m.user_id = ${ctx.userId}
    WHERE t.user_id = ${ctx.userId} AND t.deleted_at IS NULL AND t.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    ORDER BY t.date DESC`);
  if (rows.length !== ids.length) throw new AppError("NOT_FOUND", `${ids.length - rows.length} of these transactions weren't found. List them again with list_transactions.`);
  const total = add(...rows.map((r) => r.base_amount));
  const display: ActionDetail[] = [
    { label: "Transactions", value: String(rows.length) },
    { label: "Total", value: money(ctx, total) },
    ...rows.slice(0, 5).map((r) => ({ label: r.date, value: `${clip(r.merchant, 40) ?? r.type} · ${money(ctx, r.amount, r.currency)}` })),
    ...(rows.length > 5 ? [{ label: "…", value: `and ${rows.length - 5} more` }] : []),
  ];
  return storeProposal(ctx, "delete_transactions", { ids, display }, `Delete ${rows.length} transaction${rows.length === 1 ? "" : "s"} totalling ${money(ctx, total)}`, true);
}

/* ───────────── Dispatcher ───────────── */

const HANDLERS: { [N in ToolName]: (ctx: ToolContext, args: Args<N>) => Promise<unknown> } = {
  get_period_summary: getPeriodSummary,
  spending_by_category: spendingByCategory,
  list_transactions: listTransactionsTool,
  top_merchants: topMerchants,
  compare_periods: comparePeriods,
  category_trend: categoryTrend,
  list_budgets_status: listBudgetsStatus,
  upcoming_bills: upcomingBills,
  list_subscriptions: listSubscriptions,
  goals_status: goalsStatus,
  account_balances: accountBalancesTool,
  net_worth: netWorth,
  cash_flow_projection: cashFlowProjectionTool,
  safe_to_spend: safeToSpendTool,
  what_if: whatIf,
  propose_add_transaction: proposeAddTransaction,
  propose_create_budget: proposeCreateBudget,
  propose_create_goal: proposeCreateGoal,
  propose_add_goal_contribution: proposeGoalContribution,
  propose_update_transaction: proposeUpdateTransaction,
  propose_delete_transactions: proposeDeleteTransactions,
};

export type ToolRun = { name: string; args: unknown; ok: boolean; result: unknown };

/**
 * Run one tool call from the model. Never throws: errors become `{ error }` results the model
 * can read and recover from. `rawArgs` is the model's JSON argument string (or an object in tests).
 */
export async function runTool(ctx: ToolContext, name: string, rawArgs: string | Record<string, unknown> | null | undefined): Promise<ToolRun> {
  let parsedArgs: unknown = {};
  try {
    parsedArgs = typeof rawArgs === "string" ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {});
  } catch {
    return { name, args: null, ok: false, result: { error: "Arguments were not valid JSON." } };
  }
  if (!isToolName(name)) return { name, args: parsedArgs, ok: false, result: { error: `Unknown tool "${String(name).slice(0, 40)}".` } };
  // Models often send `null` for "not set"; treat it as omitted.
  if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs))
    parsedArgs = Object.fromEntries(Object.entries(parsedArgs as Record<string, unknown>).filter(([, val]) => val !== null));
  const v = S[name].safeParse(parsedArgs);
  if (!v.success) {
    const issue = v.error.issues[0];
    return { name, args: parsedArgs, ok: false, result: { error: `Invalid arguments: ${issue?.path.join(".") || "input"} — ${issue?.message ?? "invalid"}` } };
  }
  try {
    const handler = HANDLERS[name] as (c: ToolContext, a: unknown) => Promise<unknown>;
    const result = await handler(ctx, v.data);
    return { name, args: v.data, ok: true, result };
  } catch (e) {
    if (e instanceof AppError) return { name, args: v.data, ok: false, result: { error: e.message } };
    if (e instanceof z.ZodError) return { name, args: v.data, ok: false, result: { error: `Invalid arguments: ${e.issues[0]?.message ?? "invalid"}` } };
    console.error(`[ai] tool ${name} failed`, e);
    return { name, args: v.data, ok: false, result: { error: "This tool failed unexpectedly. Tell the user the data couldn't be loaded." } };
  }
}

/**
 * Serialise a tool result for the model. The payload is JSON (so user-entered text like merchant
 * names or notes can't break out of its string), `<` is escaped so the data can't fake closing
 * tags, and the size is capped.
 */
export function wrapToolResult(name: string, result: unknown): string {
  let json = JSON.stringify(result ?? null);
  if (json.length > MAX_RESULT_CHARS) json = JSON.stringify({ truncated: true, note: "Result too large; narrow the query (shorter range or lower limit).", partial: json.slice(0, MAX_RESULT_CHARS - 400) });
  return `<data tool="${name}">${json.replace(/</g, "\\u003c")}</data>`;
}

/** Re-exported for the assistant system prompt. */
export async function referenceData(userId: string) {
  const [cats, accounts] = await Promise.all([listCategories(userId), listAccounts(userId)]);
  const label = (c: Cat) => {
    const p = c.parentId ? cats.find((x) => x.id === c.parentId) : null;
    return p ? `${p.name} › ${c.name}` : c.name;
  };
  return {
    expenseCategories: cats.filter((c) => c.kind === "expense").slice(0, 120).map(label),
    incomeCategories: cats.filter((c) => c.kind === "income").slice(0, 40).map(label),
    accounts: accounts.slice(0, 30).map((a) => ({ name: a.name, type: a.type, currency: a.currency })),
  };
}

