/**
 * Analytics — every figure is computed in SQL from the ledger, in the user's base currency.
 *
 * Rules (docs/CONVENTIONS.md):
 * - Amounts are `base_amount`, aggregated as `numeric` and returned as exact decimal strings.
 * - Splits: a split transaction contributes each split's base amount to the split's category
 *   (`LEFT JOIN transaction_splits` + `COALESCE`).
 * - Spending = expenses − refunds. Transfers and adjustments never count.
 * - Categories flagged `exclude_from_reports` (or whose parent is) are left out of every total.
 * - Every query filters `user_id` and `deleted_at IS NULL`.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/server/db";
import { add, cmp, divInt, isZero, normalize, ratio, sub } from "@/lib/money";
import {
  addDaysISO,
  addMonthsISO,
  daysBetween,
  eachDay,
  maxISO,
  minISO,
  monthRange,
  previousPeriod,
  weekRange,
  type DateRange,
  type ISODate,
} from "@/lib/dates";
import { notFound } from "@/server/errors";
import { assertOwned } from "./ownership";
import { getPreferences } from "./preferences";
import { listBudgetsWithProgress } from "./budgets";
import { listTransactions } from "./transactions";

export type FlowType = "expense" | "income" | "refund";
const FLOW_TYPES: readonly FlowType[] = ["expense", "income", "refund"];

export type Delta = { change: string; pct: number | null };

export type AnalyticsCtx = { today: ISODate; monthStartDay: number; weekStartsOn: 0 | 1; currency: string; locale: string };

/** Preferences needed by analytics; callers that already have prefs can pass them to skip a query. */
export async function analyticsCtx(userId: string): Promise<AnalyticsCtx> {
  const p = await getPreferences(userId);
  return { today: p.today, monthStartDay: p.monthStartDay, weekStartsOn: p.weekStartsOn, currency: p.currency, locale: p.locale };
}

/* ───────────── SQL building blocks ───────────── */

const list = (vals: readonly string[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);

/**
 * One row per (transaction × split) with the base amount and effective category. Transactions
 * in excluded categories are dropped here so every aggregate built on `lines` agrees.
 */
function linesCte(userId: string, from: ISODate, to: ISODate, types: readonly FlowType[] = FLOW_TYPES, extra?: SQL): SQL {
  return sql`lines AS (
    SELECT t.id, t.type::text AS type, t.date, t.account_id, t.merchant_id, t.payment_method_id, t.recurring_id,
           COALESCE(s.category_id, t.category_id) AS category_id,
           COALESCE(c.parent_id, c.id) AS top_category_id,
           COALESCE(s.base_amount, t.base_amount) AS amt
      FROM transactions t
      LEFT JOIN transaction_splits s ON s.transaction_id = t.id AND s.user_id = ${userId}
      LEFT JOIN categories c ON c.id = COALESCE(s.category_id, t.category_id) AND c.user_id = ${userId}
      LEFT JOIN categories pc ON pc.id = c.parent_id AND pc.user_id = ${userId}
     WHERE t.user_id = ${userId}
       AND t.deleted_at IS NULL
       AND t.type IN (${list(types)})
       AND t.date >= ${from} AND t.date <= ${to}
       AND NOT (COALESCE(c.exclude_from_reports, false) OR COALESCE(pc.exclude_from_reports, false))
       ${extra ? sql`AND ${extra}` : sql``}
  )`;
}

/** Signed spending contribution of a line: expenses add, refunds subtract. */
const spendOf = (alias = "") => sql.raw(`CASE WHEN ${alias}type = 'expense' THEN ${alias}amt WHEN ${alias}type = 'refund' THEN -${alias}amt ELSE 0 END`);
const SPEND = spendOf();
const money = (expr: SQL) => sql`COALESCE(${expr}, 0)::text`;

export function delta(current: string, previous: string): Delta {
  const change = sub(current, previous);
  const prevAbs = previous.startsWith("-") ? previous.slice(1) : previous;
  return { change, pct: isZero(previous) ? null : ratio(change, prevAbs) };
}

const savingsRateOf = (income: string, net: string) => (cmp(income, "0") > 0 ? ratio(net, income) : null);

/** "All time" (or any unbounded) ranges are narrowed to the span the user actually has data for. */
export async function boundRange(userId: string, range: DateRange, today: ISODate): Promise<DateRange> {
  if (range.from > "1971-01-01" && range.to < "2999-01-01") return range;
  const [row] = await db.execute<{ first: string | null; last: string | null }>(sql`
    SELECT min(date)::text AS first, max(date)::text AS last FROM transactions
     WHERE user_id = ${userId} AND deleted_at IS NULL`);
  const first = row?.first ?? today;
  const last = row?.last ?? today;
  return { from: maxISO(range.from, minISO(first, today)), to: minISO(range.to, maxISO(today, last)) };
}

/** Days of the range that have already happened (at least 1) — the divisor for daily averages. */
export function elapsedDays(range: DateRange, today: ISODate) {
  if (today < range.from) return 1;
  return daysBetween(range.from, minISO(range.to, today)) + 1;
}

/* ───────────── Period summary ───────────── */

export type PeriodTotals = {
  range: DateRange;
  income: string;
  expenses: string;
  refunds: string;
  spending: string;
  net: string;
  savingsRate: number | null;
  txCount: number;
  days: number;
  avgDailySpend: string;
};

export type PeriodSummary = PeriodTotals & {
  previous: PeriodTotals | null;
  deltas: { income: Delta; spending: Delta; net: Delta; savingsRate: number | null } | null;
};

async function totalsFor(userId: string, cur: DateRange, prev: DateRange | null) {
  const from = prev ? prev.from : cur.from;
  const rows = await db.execute<Record<string, string | number>>(sql`
    WITH ${linesCte(userId, from, cur.to)}
    SELECT
      ${money(sql`SUM(amt) FILTER (WHERE type = 'income' AND date >= ${cur.from})`)} AS income,
      ${money(sql`SUM(amt) FILTER (WHERE type = 'expense' AND date >= ${cur.from})`)} AS expenses,
      ${money(sql`SUM(amt) FILTER (WHERE type = 'refund' AND date >= ${cur.from})`)} AS refunds,
      COUNT(DISTINCT id) FILTER (WHERE date >= ${cur.from})::int AS tx_count,
      ${money(sql`SUM(amt) FILTER (WHERE type = 'income' AND date < ${cur.from})`)} AS p_income,
      ${money(sql`SUM(amt) FILTER (WHERE type = 'expense' AND date < ${cur.from})`)} AS p_expenses,
      ${money(sql`SUM(amt) FILTER (WHERE type = 'refund' AND date < ${cur.from})`)} AS p_refunds,
      COUNT(DISTINCT id) FILTER (WHERE date < ${cur.from})::int AS p_tx_count
    FROM lines`);
  return rows[0];
}

function buildTotals(range: DateRange, income: string, expenses: string, refunds: string, txCount: number, today: ISODate): PeriodTotals {
  const spending = sub(expenses, refunds);
  const net = sub(income, spending);
  const days = elapsedDays(range, today);
  return {
    range,
    income: normalize(income),
    expenses: normalize(expenses),
    refunds: normalize(refunds),
    spending,
    net,
    savingsRate: savingsRateOf(income, net),
    txCount: Number(txCount),
    days,
    avgDailySpend: divInt(spending, days),
  };
}

/** Income, spending, savings and averages for a range, with the same-shaped previous period. */
export async function periodSummary(userId: string, range: DateRange, opts: { compare?: boolean; ctx?: AnalyticsCtx } = {}): Promise<PeriodSummary> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const cur = await boundRange(userId, range, ctx.today);
  const unbounded = cur.from !== range.from;
  const prev = opts.compare === false || unbounded ? null : previousPeriod(cur, ctx.monthStartDay);
  const r = await totalsFor(userId, cur, prev);
  const current = buildTotals(cur, String(r.income), String(r.expenses), String(r.refunds), Number(r.tx_count), ctx.today);
  if (!prev) return { ...current, previous: null, deltas: null };
  const previous = buildTotals(prev, String(r.p_income), String(r.p_expenses), String(r.p_refunds), Number(r.p_tx_count), ctx.today);
  return {
    ...current,
    previous,
    deltas: {
      income: delta(current.income, previous.income),
      spending: delta(current.spending, previous.spending),
      net: delta(current.net, previous.net),
      savingsRate: current.savingsRate !== null && previous.savingsRate !== null ? current.savingsRate - previous.savingsRate : null,
    },
  };
}

/* ───────────── Categories ───────────── */

export type CategoryAmount = {
  categoryId: string | null;
  name: string;
  icon: string;
  color: string;
  amount: string;
  previous: string;
  delta: Delta;
  /** Share of the period total (0..1). */
  share: number;
  count: number;
  /** Set on a parent row's synthetic child for amounts booked directly on the parent. */
  direct?: boolean;
  children: CategoryAmount[];
};

export type CategoryBreakdown = { range: DateRange; previousRange: DateRange | null; total: string; items: CategoryAmount[] };

type CatRow = { id: string; name: string; icon: string; color: string; parent_id: string | null };

async function userCategories(userId: string) {
  const rows = await db.execute<CatRow>(sql`
    SELECT id, name, icon, color, parent_id FROM categories WHERE user_id = ${userId}`);
  return new Map(rows.map((r) => [r.id, r]));
}

const UNCATEGORIZED = { name: "Uncategorized", icon: "circle-dashed", color: "#78716c" };

async function categoryBreakdown(
  userId: string,
  range: DateRange,
  kind: "expense" | "income",
  opts: { parentLevel?: boolean; compare?: boolean; ctx?: AnalyticsCtx; extra?: SQL } = {},
): Promise<CategoryBreakdown> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const cur = await boundRange(userId, range, ctx.today);
  const prev = opts.compare === false || cur.from !== range.from ? null : previousPeriod(cur, ctx.monthStartDay);
  const types: FlowType[] = kind === "income" ? ["income"] : ["expense", "refund"];
  const value = kind === "income" ? sql.raw("amt") : SPEND;
  const [rows, cats] = await Promise.all([
    db.execute<{ category_id: string | null; cur: string; prev: string; cnt: number }>(sql`
      WITH ${linesCte(userId, prev ? prev.from : cur.from, cur.to, types, opts.extra)}
      SELECT category_id,
             ${money(sql`SUM(${value}) FILTER (WHERE date >= ${cur.from})`)} AS cur,
             ${money(sql`SUM(${value}) FILTER (WHERE date < ${cur.from})`)} AS prev,
             COUNT(DISTINCT id) FILTER (WHERE date >= ${cur.from})::int AS cnt
        FROM lines GROUP BY category_id`),
    userCategories(userId),
  ]);

  const leaf = (id: string | null, amount: string, previous: string, count: number, direct = false): CategoryAmount => {
    const c = id ? cats.get(id) : undefined;
    return {
      categoryId: id,
      name: direct ? "General" : (c?.name ?? UNCATEGORIZED.name),
      icon: c?.icon ?? UNCATEGORIZED.icon,
      color: c?.color ?? UNCATEGORIZED.color,
      amount: normalize(amount),
      previous: normalize(previous),
      delta: delta(amount, previous),
      share: 0,
      count,
      direct: direct || undefined,
      children: [],
    };
  };

  let items: CategoryAmount[];
  if (opts.parentLevel === false) {
    items = rows.map((r) => leaf(r.category_id, r.cur, r.prev, Number(r.cnt)));
  } else {
    const parents = new Map<string, CategoryAmount>();
    for (const r of rows) {
      const c = r.category_id ? cats.get(r.category_id) : undefined;
      const topId = c?.parent_id ?? r.category_id;
      const key = topId ?? "__none__";
      let p = parents.get(key);
      if (!p) {
        p = leaf(topId, "0", "0", 0);
        parents.set(key, p);
      }
      p.amount = add(p.amount, r.cur);
      p.previous = add(p.previous, r.prev);
      p.count += Number(r.cnt);
      if (c?.parent_id) p.children.push(leaf(r.category_id, r.cur, r.prev, Number(r.cnt)));
      else if (r.category_id) p.children.push(leaf(r.category_id, r.cur, r.prev, Number(r.cnt), true));
    }
    items = [...parents.values()].map((p) => {
      p.delta = delta(p.amount, p.previous);
      // A parent with only direct amounts needs no breakdown.
      if (p.children.every((ch) => ch.direct)) p.children = [];
      return p;
    });
  }
  const total = add(...items.map((i) => i.amount));
  const byAmount = (a: CategoryAmount, b: CategoryAmount) => cmp(b.amount, a.amount) || a.name.localeCompare(b.name);
  const withShare = (i: CategoryAmount): CategoryAmount => ({
    ...i,
    share: isZero(total) ? 0 : ratio(i.amount, total),
    children: i.children.map(withShare).sort(byAmount),
  });
  items = items
    .filter((i) => !isZero(i.amount) || !isZero(i.previous))
    .map(withShare)
    .sort(byAmount);
  return { range: cur, previousRange: prev, total, items };
}

/** Spending (expenses − refunds) by category, rolled up to parents by default. */
export function spendingByCategory(userId: string, range: DateRange, opts: { parentLevel?: boolean; compare?: boolean; ctx?: AnalyticsCtx } = {}) {
  return categoryBreakdown(userId, range, "expense", opts);
}

/** Income by income category (salary, freelance, interest…). */
export function incomeBySource(userId: string, range: DateRange, opts: { parentLevel?: boolean; compare?: boolean; ctx?: AnalyticsCtx } = {}) {
  return categoryBreakdown(userId, range, "income", opts);
}

/* ───────────── Time series ───────────── */

export type Bucket = "day" | "week" | "month";

export type SeriesPoint = {
  /** Bucket start (may precede range.from for a partial first bucket). */
  key: ISODate;
  /** The part of the bucket inside the range. */
  from: ISODate;
  to: ISODate;
  income: string;
  expenses: string;
  refunds: string;
  spending: string;
  net: string;
  savingsRate: number | null;
};

/** Pick a bucket that keeps a chart readable (≤ ~62 bars). */
export function autoBucket(range: DateRange): Bucket {
  const days = daysBetween(range.from, range.to) + 1;
  if (days <= 62) return "day";
  if (days <= 26 * 7) return "week";
  return "month";
}

function bucketExpr(bucket: Bucket, ctx: AnalyticsCtx): SQL {
  if (bucket === "day") return sql`date`;
  if (bucket === "week")
    return ctx.weekStartsOn === 1 ? sql`(date - (EXTRACT(ISODOW FROM date)::int - 1))` : sql`(date - EXTRACT(DOW FROM date)::int)`;
  const shift = Math.max(0, Math.min(27, Math.trunc(ctx.monthStartDay) - 1));
  return sql`(date_trunc('month', date - ${shift}::int)::date + ${shift}::int)`;
}

/** Ordered bucket windows covering a range. */
export function bucketWindows(range: DateRange, bucket: Bucket, ctx: Pick<AnalyticsCtx, "weekStartsOn" | "monthStartDay">, limit = 1200): { key: ISODate; from: ISODate; to: ISODate }[] {
  const out: { key: ISODate; from: ISODate; to: ISODate }[] = [];
  if (bucket === "day") return eachDay(range, limit).map((d) => ({ key: d, from: d, to: d }));
  let w = bucket === "week" ? weekRange(range.from, ctx.weekStartsOn) : monthRange(range.from, ctx.monthStartDay);
  while (w.from <= range.to && out.length < limit) {
    out.push({ key: w.from, from: maxISO(w.from, range.from), to: minISO(w.to, range.to) });
    const next = addDaysISO(w.to, 1);
    w = bucket === "week" ? weekRange(next, ctx.weekStartsOn) : monthRange(next, ctx.monthStartDay);
  }
  return out;
}

/** Income / spending / net per bucket, zero-filled so gaps show as empty bars, not missing ones. */
export async function timeSeries(userId: string, range: DateRange, bucket: Bucket = autoBucket(range), opts: { ctx?: AnalyticsCtx } = {}): Promise<SeriesPoint[]> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const r = await boundRange(userId, range, ctx.today);
  const rows = await db.execute<{ k: string; income: string; expenses: string; refunds: string }>(sql`
    WITH ${linesCte(userId, r.from, r.to)}
    SELECT ${bucketExpr(bucket, ctx)}::text AS k,
           ${money(sql`SUM(amt) FILTER (WHERE type = 'income')`)} AS income,
           ${money(sql`SUM(amt) FILTER (WHERE type = 'expense')`)} AS expenses,
           ${money(sql`SUM(amt) FILTER (WHERE type = 'refund')`)} AS refunds
      FROM lines GROUP BY 1`);
  const byKey = new Map(rows.map((x) => [x.k, x]));
  return bucketWindows(r, bucket, ctx).map((w) => {
    const x = byKey.get(w.key);
    const income = normalize(x?.income ?? "0");
    const expenses = normalize(x?.expenses ?? "0");
    const refunds = normalize(x?.refunds ?? "0");
    const spending = sub(expenses, refunds);
    const net = sub(income, spending);
    return { ...w, income, expenses, refunds, spending, net, savingsRate: savingsRateOf(income, net) };
  });
}

/* ───────────── Cumulative spending (this period vs last) ───────────── */

export type CumulativePoint = { day: number; date: ISODate | null; previousDate: ISODate | null; current: string | null; previous: string | null };
export type CumulativeSpending = {
  current: DateRange;
  previous: DateRange;
  today: ISODate;
  points: CumulativePoint[];
  currentToDate: string;
  previousToSameDay: string;
  previousTotal: string;
};

/** Running spending total by day-of-period for the current budget month and the one before. */
export async function cumulativeSpending(userId: string, opts: { ref?: ISODate; ctx?: AnalyticsCtx } = {}): Promise<CumulativeSpending> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const ref = opts.ref ?? ctx.today;
  const cur = monthRange(ref, ctx.monthStartDay);
  const prev = monthRange(addDaysISO(cur.from, -1), ctx.monthStartDay);
  const rows = await db.execute<{ d: string; spend: string }>(sql`
    WITH ${linesCte(userId, prev.from, cur.to, ["expense", "refund"])}
    SELECT date::text AS d, ${money(sql`SUM(${SPEND})`)} AS spend FROM lines GROUP BY date`);
  const byDay = new Map(rows.map((r) => [r.d, r.spend]));
  const curLen = daysBetween(cur.from, cur.to) + 1;
  const prevLen = daysBetween(prev.from, prev.to) + 1;
  const points: CumulativePoint[] = [];
  let c = "0";
  let p = "0";
  let currentToDate = "0";
  let previousToSameDay = "0";
  const elapsed = ref < cur.from ? 0 : daysBetween(cur.from, minISO(ref, cur.to)) + 1;
  for (let i = 0; i < Math.max(curLen, prevLen); i++) {
    const date = i < curLen ? addDaysISO(cur.from, i) : null;
    const pdate = i < prevLen ? addDaysISO(prev.from, i) : null;
    if (date) c = add(c, byDay.get(date) ?? "0");
    if (pdate) p = add(p, byDay.get(pdate) ?? "0");
    const showCurrent = date !== null && date <= ref;
    if (showCurrent) currentToDate = c;
    if (i < elapsed && pdate) previousToSameDay = p;
    points.push({ day: i + 1, date, previousDate: pdate, current: showCurrent ? c : null, previous: pdate ? p : null });
  }
  return { current: cur, previous: prev, today: ref, points, currentToDate, previousToSameDay, previousTotal: p };
}

/* ───────────── Merchants ───────────── */

export type MerchantStat = {
  merchantId: string;
  name: string;
  categoryIcon: string | null;
  categoryColor: string | null;
  categoryName: string | null;
  /** Net spending (purchases − refunds) in the range. */
  total: string;
  count: number;
  /** Average purchase (gross purchases ÷ count). */
  avg: string;
  lastDate: ISODate | null;
  previous: string;
  delta: Delta;
};

export type MerchantSort = "total" | "count" | "recent" | "change";

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** Spending per merchant with count, average ticket, last purchase and change vs the previous period. */
export async function merchantStats(
  userId: string,
  range: DateRange,
  opts: { q?: string; limit?: number; offset?: number; sort?: MerchantSort; ctx?: AnalyticsCtx } = {},
): Promise<{ range: DateRange; previousRange: DateRange | null; rows: MerchantStat[]; total: number; hasMore: boolean }> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const cur = await boundRange(userId, range, ctx.today);
  const prev = cur.from !== range.from ? null : previousPeriod(cur, ctx.monthStartDay);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim().toLowerCase().slice(0, 80);
  const order =
    opts.sort === "count"
      ? sql`a.cnt DESC, a.total DESC`
      : opts.sort === "recent"
        ? sql`a.last_date DESC NULLS LAST, a.total DESC`
        : opts.sort === "change"
          ? sql`(a.total - a.prev) DESC, a.total DESC`
          : sql`a.total DESC, a.cnt DESC`;
  const rows = await db.execute<{
    id: string; name: string; c_icon: string | null; c_color: string | null; c_name: string | null;
    total: string; prev: string; gross: string; cnt: number; last_date: string | null; n: number;
  }>(sql`
    WITH ${linesCte(userId, prev ? prev.from : cur.from, cur.to, ["expense", "refund"], sql`t.merchant_id IS NOT NULL`)},
    a AS (
      SELECT merchant_id,
             COALESCE(SUM(${SPEND}) FILTER (WHERE date >= ${cur.from}), 0) AS total,
             COALESCE(SUM(${SPEND}) FILTER (WHERE date < ${cur.from}), 0) AS prev,
             COALESCE(SUM(amt) FILTER (WHERE type = 'expense' AND date >= ${cur.from}), 0) AS gross,
             COUNT(DISTINCT id) FILTER (WHERE type = 'expense' AND date >= ${cur.from})::int AS cnt,
             MAX(date) FILTER (WHERE date >= ${cur.from}) AS last_date
        FROM lines GROUP BY merchant_id
    )
    SELECT m.id, m.name, dc.icon AS c_icon, dc.color AS c_color, dc.name AS c_name,
           a.total::text AS total, a.prev::text AS prev, a.gross::text AS gross, a.cnt, a.last_date::text AS last_date,
           COUNT(*) OVER ()::int AS n
      FROM a
      JOIN merchants m ON m.id = a.merchant_id AND m.user_id = ${userId}
      LEFT JOIN categories dc ON dc.id = m.default_category_id AND dc.user_id = ${userId}
     WHERE a.cnt > 0 ${q ? sql`AND m.normalized_name LIKE ${`%${likeEscape(q)}%`}` : sql``}
     ORDER BY ${order}, m.name
     LIMIT ${limit} OFFSET ${offset}`);
  const total = rows[0]?.n ?? 0;
  return {
    range: cur,
    previousRange: prev,
    total,
    hasMore: offset + rows.length < total,
    rows: rows.map((r) => ({
      merchantId: r.id,
      name: r.name,
      categoryIcon: r.c_icon,
      categoryColor: r.c_color,
      categoryName: r.c_name,
      total: normalize(r.total),
      count: Number(r.cnt),
      avg: r.cnt > 0 ? divInt(r.gross, Number(r.cnt)) : "0.0000",
      lastDate: r.last_date,
      previous: normalize(r.prev),
      delta: delta(r.total, r.prev),
    })),
  };
}

export type MerchantDetail = {
  merchant: { id: string; name: string; defaultCategoryName: string | null; defaultCategoryIcon: string | null; defaultCategoryColor: string | null };
  lifetime: { total: string; count: number; avg: string; firstDate: ISODate | null; lastDate: ISODate | null };
  monthly: { key: ISODate; from: ISODate; to: ISODate; total: string; count: number }[];
  categories: { categoryId: string | null; name: string; icon: string; color: string; amount: string }[];
  recent: Awaited<ReturnType<typeof listTransactions>>["rows"];
};

/** Monthly history, lifetime stats, categories and recent purchases for one merchant. */
export async function merchantDetail(userId: string, merchantId: string, opts: { months?: number; ctx?: AnalyticsCtx } = {}): Promise<MerchantDetail> {
  await assertOwned(userId, { merchant: merchantId });
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const months = Math.min(Math.max(opts.months ?? 12, 1), 36);
  const last = monthRange(ctx.today, ctx.monthStartDay);
  const window: DateRange = { from: monthRange(addMonthsISO(last.from, -(months - 1)), ctx.monthStartDay).from, to: last.to };
  const merchantFilter = sql`t.merchant_id = ${merchantId}`;
  const [info, life, monthly, cats, recent] = await Promise.all([
    db.execute<{ id: string; name: string; c_name: string | null; c_icon: string | null; c_color: string | null }>(sql`
      SELECT m.id, m.name, c.name AS c_name, c.icon AS c_icon, c.color AS c_color FROM merchants m
        LEFT JOIN categories c ON c.id = m.default_category_id AND c.user_id = ${userId}
       WHERE m.id = ${merchantId} AND m.user_id = ${userId}`),
    db.execute<{ total: string; gross: string; cnt: number; first: string | null; last: string | null }>(sql`
      WITH ${linesCte(userId, "1970-01-01", "2999-12-31", ["expense", "refund"], merchantFilter)}
      SELECT ${money(sql`SUM(${SPEND})`)} AS total, ${money(sql`SUM(amt) FILTER (WHERE type = 'expense')`)} AS gross,
             COUNT(DISTINCT id) FILTER (WHERE type = 'expense')::int AS cnt, MIN(date)::text AS first, MAX(date)::text AS last
        FROM lines`),
    db.execute<{ k: string; total: string; cnt: number }>(sql`
      WITH ${linesCte(userId, window.from, window.to, ["expense", "refund"], merchantFilter)}
      SELECT ${bucketExpr("month", ctx)}::text AS k, ${money(sql`SUM(${SPEND})`)} AS total,
             COUNT(DISTINCT id) FILTER (WHERE type = 'expense')::int AS cnt
        FROM lines GROUP BY 1`),
    db.execute<{ category_id: string | null; name: string | null; icon: string | null; color: string | null; amount: string }>(sql`
      WITH ${linesCte(userId, "1970-01-01", "2999-12-31", ["expense", "refund"], merchantFilter)}
      SELECT l.category_id, c.name, c.icon, c.color, ${money(sql`SUM(${spendOf("l.")})`)} AS amount
        FROM lines l LEFT JOIN categories c ON c.id = l.category_id AND c.user_id = ${userId}
       GROUP BY l.category_id, c.name, c.icon, c.color ORDER BY SUM(${spendOf("l.")}) DESC`),
    listTransactions(userId, { merchantIds: [merchantId] }, { limit: 20 }),
  ]);
  const m = info[0];
  if (!m) throw notFound("Merchant");
  const l = life[0];
  const byKey = new Map(monthly.map((r) => [r.k, r]));
  return {
    merchant: { id: m.id, name: m.name, defaultCategoryName: m.c_name, defaultCategoryIcon: m.c_icon, defaultCategoryColor: m.c_color },
    lifetime: {
      total: normalize(l.total),
      count: Number(l.cnt),
      avg: l.cnt > 0 ? divInt(l.gross, Number(l.cnt)) : "0.0000",
      firstDate: l.first,
      lastDate: l.last,
    },
    monthly: bucketWindows(window, "month", ctx).map((w) => ({ ...w, total: normalize(byKey.get(w.key)?.total ?? "0"), count: Number(byKey.get(w.key)?.cnt ?? 0) })),
    categories: cats
      .filter((c) => !isZero(c.amount))
      .map((c) => ({
        categoryId: c.category_id,
        name: c.name ?? UNCATEGORIZED.name,
        icon: c.icon ?? UNCATEGORIZED.icon,
        color: c.color ?? UNCATEGORIZED.color,
        amount: normalize(c.amount),
      })),
    recent: recent.rows,
  };
}

/* ───────────── Accounts & payment methods ───────────── */

export type AccountFlow = { accountId: string; name: string; type: string; currency: string; income: string; expenses: string; refunds: string; spending: string; net: string; count: number };

/** Income and spending per account (base currency). */
export async function byAccount(userId: string, range: DateRange, opts: { ctx?: AnalyticsCtx } = {}): Promise<AccountFlow[]> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const r = await boundRange(userId, range, ctx.today);
  const rows = await db.execute<{ id: string; name: string; type: string; currency: string; income: string; expenses: string; refunds: string; cnt: number }>(sql`
    WITH ${linesCte(userId, r.from, r.to)}
    SELECT a.id, a.name, a.type::text AS type, a.currency,
           ${money(sql`SUM(l.amt) FILTER (WHERE l.type = 'income')`)} AS income,
           ${money(sql`SUM(l.amt) FILTER (WHERE l.type = 'expense')`)} AS expenses,
           ${money(sql`SUM(l.amt) FILTER (WHERE l.type = 'refund')`)} AS refunds,
           COUNT(DISTINCT l.id)::int AS cnt
      FROM lines l JOIN accounts a ON a.id = l.account_id AND a.user_id = ${userId}
     GROUP BY a.id, a.name, a.type, a.currency`);
  return rows
    .map((x) => {
      const spending = sub(x.expenses, x.refunds);
      return { accountId: x.id, name: x.name, type: x.type, currency: x.currency, income: normalize(x.income), expenses: normalize(x.expenses), refunds: normalize(x.refunds), spending, net: sub(x.income, spending), count: Number(x.cnt) };
    })
    .sort((a, b) => cmp(b.spending, a.spending) || cmp(b.income, a.income));
}

export type MethodSpend = { paymentMethodId: string | null; name: string; type: string | null; amount: string; share: number; count: number };

/** Spending per payment method (cash, card, UPI…). */
export async function byPaymentMethod(userId: string, range: DateRange, opts: { ctx?: AnalyticsCtx } = {}): Promise<{ total: string; items: MethodSpend[] }> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const r = await boundRange(userId, range, ctx.today);
  const rows = await db.execute<{ id: string | null; name: string | null; type: string | null; amount: string; cnt: number }>(sql`
    WITH ${linesCte(userId, r.from, r.to, ["expense", "refund"])}
    SELECT pm.id, pm.name, pm.type::text AS type, ${money(sql`SUM(${spendOf("l.")})`)} AS amount, COUNT(DISTINCT l.id)::int AS cnt
      FROM lines l LEFT JOIN payment_methods pm ON pm.id = l.payment_method_id AND pm.user_id = ${userId}
     GROUP BY pm.id, pm.name, pm.type`);
  const total = add(...rows.map((x) => x.amount));
  return {
    total,
    items: rows
      .filter((x) => !isZero(x.amount))
      .map((x) => ({ paymentMethodId: x.id, name: x.name ?? "No payment method", type: x.type, amount: normalize(x.amount), share: isZero(total) ? 0 : ratio(x.amount, total), count: Number(x.cnt) }))
      .sort((a, b) => cmp(b.amount, a.amount)),
  };
}

/* ───────────── Daily breakdown ───────────── */

export type DayTxn = {
  id: string;
  type: string;
  date: ISODate;
  amount: string;
  currency: string;
  baseAmount: string;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  merchantName: string | null;
  accountName: string;
  toAccountName: string | null;
  notes: string | null;
  hasSplits: boolean;
  isPending: boolean;
  recurringId: string | null;
};

export type DayRow = { date: ISODate; income: string; expenses: string; refunds: string; spending: string; net: string; count: number; transactions: DayTxn[] };

export type DailyBreakdown = {
  range: DateRange;
  /** True when the requested range was longer than `maxDays` and was shortened to its most recent days. */
  truncated: boolean;
  /** True when the range had more transactions than `txLimit`; day totals are still complete. */
  transactionsTruncated: boolean;
  days: DayRow[];
  totals: { income: string; spending: string; net: string; count: number; noSpendDays: number; avgDailySpend: string };
};

/** Per-day totals (newest first) with each day's transactions. Future days are not included. */
export async function dailyBreakdown(
  userId: string,
  range: DateRange,
  opts: { maxDays?: number; txLimit?: number; ctx?: AnalyticsCtx } = {},
): Promise<DailyBreakdown> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const maxDays = Math.min(Math.max(opts.maxDays ?? 62, 1), 400);
  const txLimit = Math.min(Math.max(opts.txLimit ?? 1500, 1), 5000);
  const b = await boundRange(userId, range, ctx.today);
  let to = b.to;
  if (b.from <= ctx.today) to = minISO(b.to, ctx.today);
  let from = b.from;
  let truncated = false;
  if (daysBetween(from, to) + 1 > maxDays) {
    from = addDaysISO(to, -(maxDays - 1));
    truncated = true;
  }
  const r = { from, to };
  const [agg, counts, txns] = await Promise.all([
    db.execute<{ d: string; income: string; expenses: string; refunds: string }>(sql`
      WITH ${linesCte(userId, from, to)}
      SELECT date::text AS d,
             ${money(sql`SUM(amt) FILTER (WHERE type = 'income')`)} AS income,
             ${money(sql`SUM(amt) FILTER (WHERE type = 'expense')`)} AS expenses,
             ${money(sql`SUM(amt) FILTER (WHERE type = 'refund')`)} AS refunds
        FROM lines GROUP BY date`),
    db.execute<{ d: string; n: number }>(sql`
      SELECT date::text AS d, COUNT(*)::int AS n FROM transactions
       WHERE user_id = ${userId} AND deleted_at IS NULL AND date >= ${from} AND date <= ${to}
       GROUP BY date`),
    db.execute<{
      id: string; type: string; d: string; amount: string; currency: string; base_amount: string; c_name: string | null; c_icon: string | null;
      c_color: string | null; m_name: string | null; a_name: string; to_name: string | null; notes: string | null; has_splits: boolean; is_pending: boolean; recurring_id: string | null;
    }>(sql`
      SELECT t.id, t.type::text AS type, t.date::text AS d, t.amount::text AS amount, t.currency, t.base_amount::text AS base_amount,
             c.name AS c_name, c.icon AS c_icon, c.color AS c_color, m.name AS m_name, a.name AS a_name, ta.name AS to_name,
             t.notes, t.has_splits, t.is_pending, t.recurring_id
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id AND a.user_id = ${userId}
        LEFT JOIN accounts ta ON ta.id = t.to_account_id AND ta.user_id = ${userId}
        LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = ${userId}
        LEFT JOIN merchants m ON m.id = t.merchant_id AND m.user_id = ${userId}
       WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.date >= ${from} AND t.date <= ${to}
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT ${txLimit + 1}`),
  ]);
  const aggBy = new Map(agg.map((x) => [x.d, x]));
  const countBy = new Map(counts.map((x) => [x.d, Number(x.n)]));
  const txBy = new Map<string, DayTxn[]>();
  for (const t of txns.slice(0, txLimit)) {
    const arr = txBy.get(t.d) ?? [];
    arr.push({
      id: t.id, type: t.type, date: t.d, amount: normalize(t.amount), currency: t.currency, baseAmount: normalize(t.base_amount),
      categoryName: t.c_name, categoryIcon: t.c_icon, categoryColor: t.c_color, merchantName: t.m_name, accountName: t.a_name,
      toAccountName: t.to_name, notes: t.notes, hasSplits: t.has_splits, isPending: t.is_pending, recurringId: t.recurring_id,
    });
    txBy.set(t.d, arr);
  }
  let income = "0";
  let spending = "0";
  let count = 0;
  let noSpendDays = 0;
  const days: DayRow[] = eachDay(r)
    .reverse()
    .map((d) => {
      const a = aggBy.get(d);
      const inc = normalize(a?.income ?? "0");
      const exp = normalize(a?.expenses ?? "0");
      const ref = normalize(a?.refunds ?? "0");
      const sp = sub(exp, ref);
      income = add(income, inc);
      spending = add(spending, sp);
      const n = countBy.get(d) ?? 0;
      count += n;
      if (isZero(exp)) noSpendDays++;
      return { date: d, income: inc, expenses: exp, refunds: ref, spending: sp, net: sub(inc, sp), count: n, transactions: txBy.get(d) ?? [] };
    });
  return {
    range: r,
    truncated,
    transactionsTruncated: txns.length > txLimit,
    days,
    totals: { income, spending, net: sub(income, spending), count, noSpendDays, avgDailySpend: divInt(spending, Math.max(days.length, 1)) },
  };
}

/* ───────────── Largest transactions ───────────── */

export type LargeTxn = {
  id: string;
  type: string;
  date: ISODate;
  baseAmount: string;
  amount: string;
  currency: string;
  merchantName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  accountName: string;
  notes: string | null;
  hasSplits: boolean;
};

/** Biggest expenses (or income) in a range, by base amount. */
export async function largestTransactions(userId: string, range: DateRange, opts: { type?: "expense" | "income"; limit?: number; ctx?: AnalyticsCtx } = {}): Promise<LargeTxn[]> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const r = await boundRange(userId, range, ctx.today);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const rows = await db.execute<{
    id: string; type: string; d: string; base_amount: string; amount: string; currency: string; m_name: string | null; c_name: string | null;
    c_icon: string | null; c_color: string | null; a_name: string; notes: string | null; has_splits: boolean;
  }>(sql`
    SELECT t.id, t.type::text AS type, t.date::text AS d, t.base_amount::text AS base_amount, t.amount::text AS amount, t.currency,
           m.name AS m_name, c.name AS c_name, c.icon AS c_icon, c.color AS c_color, a.name AS a_name, t.notes, t.has_splits
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id AND a.user_id = ${userId}
      LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = ${userId}
      LEFT JOIN categories pc ON pc.id = c.parent_id AND pc.user_id = ${userId}
      LEFT JOIN merchants m ON m.id = t.merchant_id AND m.user_id = ${userId}
     WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.type = ${opts.type ?? "expense"}
       AND t.date >= ${r.from} AND t.date <= ${r.to}
       AND NOT (COALESCE(c.exclude_from_reports, false) OR COALESCE(pc.exclude_from_reports, false))
     ORDER BY t.base_amount DESC, t.date DESC
     LIMIT ${limit}`);
  return rows.map((x) => ({
    id: x.id, type: x.type, date: x.d, baseAmount: normalize(x.base_amount), amount: normalize(x.amount), currency: x.currency,
    merchantName: x.m_name, categoryName: x.has_splits ? "Split" : x.c_name, categoryIcon: x.c_icon, categoryColor: x.c_color,
    accountName: x.a_name, notes: x.notes, hasSplits: x.has_splits,
  }));
}

/* ───────────── Recurring vs discretionary ───────────── */

export type RecurringSplit = {
  recurring: string;
  discretionary: string;
  total: string;
  recurringShare: number;
  recurringCount: number;
  discretionaryCount: number;
  /** Recurring spending by schedule kind (bill, subscription, expense). */
  byKind: { kind: string; amount: string; count: number }[];
};

/** Spending linked to a recurring schedule vs everything else. */
export async function recurringVsDiscretionary(userId: string, range: DateRange, opts: { ctx?: AnalyticsCtx } = {}): Promise<RecurringSplit> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const r = await boundRange(userId, range, ctx.today);
  const rows = await db.execute<{ kind: string | null; amount: string; cnt: number }>(sql`
    WITH ${linesCte(userId, r.from, r.to, ["expense", "refund"])}
    SELECT CASE WHEN l.recurring_id IS NULL THEN NULL ELSE COALESCE(rt.kind::text, 'expense') END AS kind,
           ${money(sql`SUM(${spendOf("l.")})`)} AS amount, COUNT(DISTINCT l.id) FILTER (WHERE l.type = 'expense')::int AS cnt
      FROM lines l LEFT JOIN recurring_transactions rt ON rt.id = l.recurring_id AND rt.user_id = ${userId}
     GROUP BY 1`);
  let recurring = "0";
  let discretionary = "0";
  let recurringCount = 0;
  let discretionaryCount = 0;
  const byKind: RecurringSplit["byKind"] = [];
  for (const x of rows) {
    if (x.kind === null) {
      discretionary = add(discretionary, x.amount);
      discretionaryCount += Number(x.cnt);
    } else {
      recurring = add(recurring, x.amount);
      recurringCount += Number(x.cnt);
      byKind.push({ kind: x.kind, amount: normalize(x.amount), count: Number(x.cnt) });
    }
  }
  const total = add(recurring, discretionary);
  return {
    recurring,
    discretionary,
    total,
    recurringShare: isZero(total) ? 0 : ratio(recurring, total),
    recurringCount,
    discretionaryCount,
    byKind: byKind.sort((a, b) => cmp(b.amount, a.amount)),
  };
}

/* ───────────── Category trends ───────────── */

export type CategoryTrend = {
  categoryId: string | null;
  name: string;
  icon: string;
  color: string;
  /** One value per month in `months`, oldest first. */
  values: string[];
  latest: string;
  /** Average of the months before the latest one. */
  baseline: string;
  change: string;
  changePct: number | null;
  direction: "up" | "down" | "flat";
};

/**
 * Top-level category spending over the last `months` complete months. "Latest" is the most recent
 * complete month, compared with the average of the months before it.
 */
export async function categoryTrends(userId: string, months = 6, opts: { ctx?: AnalyticsCtx; includeCurrent?: boolean } = {}): Promise<{ months: { key: ISODate; from: ISODate; to: ISODate }[]; categories: CategoryTrend[] }> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const n = Math.min(Math.max(Math.trunc(months), 2), 24);
  const current = monthRange(ctx.today, ctx.monthStartDay);
  const lastMonth = opts.includeCurrent ? current : monthRange(addDaysISO(current.from, -1), ctx.monthStartDay);
  const first = monthRange(addMonthsISO(lastMonth.from, -(n - 1)), ctx.monthStartDay);
  const window = { from: first.from, to: lastMonth.to };
  const windows = bucketWindows(window, "month", ctx);
  const [rows, cats] = await Promise.all([
    db.execute<{ k: string; top: string | null; amount: string }>(sql`
      WITH ${linesCte(userId, window.from, window.to, ["expense", "refund"])}
      SELECT ${bucketExpr("month", ctx)}::text AS k, top_category_id AS top, ${money(sql`SUM(${SPEND})`)} AS amount
        FROM lines GROUP BY 1, 2`),
    userCategories(userId),
  ]);
  const byCat = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const key = r.top ?? "__none__";
    const m = byCat.get(key) ?? new Map<string, string>();
    m.set(r.k, r.amount);
    byCat.set(key, m);
  }
  const out: CategoryTrend[] = [];
  for (const [key, m] of byCat) {
    const values = windows.map((w) => normalize(m.get(w.key) ?? "0"));
    if (values.every((v) => isZero(v))) continue;
    const latest = values[values.length - 1];
    const before = values.slice(0, -1);
    const baseline = divInt(add(...before), before.length);
    const d = delta(latest, baseline);
    const c = key === "__none__" ? undefined : cats.get(key);
    out.push({
      categoryId: key === "__none__" ? null : key,
      name: c?.name ?? UNCATEGORIZED.name,
      icon: c?.icon ?? UNCATEGORIZED.icon,
      color: c?.color ?? UNCATEGORIZED.color,
      values,
      latest,
      baseline,
      change: d.change,
      changePct: d.pct,
      direction: d.pct === null ? (isZero(latest) ? "flat" : "up") : d.pct > 0.1 ? "up" : d.pct < -0.1 ? "down" : "flat",
    });
  }
  out.sort((a, b) => cmp(b.change, a.change));
  return { months: windows, categories: out };
}

/* ───────────── Budget performance (read-only) ───────────── */

export type BudgetPerformance = {
  budgetId: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  period: string;
  window: DateRange;
  limit: string;
  spent: string;
  remaining: string;
  /** spent ÷ limit (may exceed 1). */
  used: number;
  status: "under" | "near" | "over";
};

/**
 * Spent vs limit for the user's monthly budgets in the budget month containing `ref`, plus custom
 * budgets whose window overlaps it. Numbers come from the budgets module (`listBudgetsWithProgress`)
 * so they match the Budgets page, rollover included. Weekly/yearly budgets are counted in `skipped`.
 */
export async function budgetPerformance(userId: string, ref: ISODate, opts: { ctx?: AnalyticsCtx } = {}): Promise<{ month: DateRange; items: BudgetPerformance[]; skipped: number }> {
  const ctx = opts.ctx ?? (await analyticsCtx(userId));
  const month = monthRange(ref, ctx.monthStartDay);
  // Evaluate at the month's last elapsed day so past months are complete and the current one is to-date.
  const evalDay = minISO(month.to, maxISO(month.from, ctx.today));
  const [list, cats] = await Promise.all([listBudgetsWithProgress(userId, evalDay), userCategories(userId)]);
  let skipped = 0;
  const items: BudgetPerformance[] = [];
  for (const b of list) {
    const overlaps = b.periodRange.from <= month.to && b.periodRange.to >= month.from;
    if (!(b.period === "monthly" || (b.period === "custom" && overlaps))) {
      skipped++;
      continue;
    }
    const c = b.categoryId ? cats.get(b.categoryId) : undefined;
    items.push({
      budgetId: b.id,
      name: b.name,
      categoryId: b.categoryId,
      categoryName: c?.name ?? null,
      categoryIcon: c?.icon ?? null,
      categoryColor: c?.color ?? null,
      period: b.period,
      window: b.periodRange,
      limit: b.available,
      spent: b.spent,
      remaining: b.remaining,
      used: b.pct,
      status: b.status === "over" ? "over" : b.status === "ok" ? "under" : "near",
    });
  }
  return { month, items: items.sort((a, b) => b.used - a.used), skipped };
}
