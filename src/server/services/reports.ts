/**
 * Printable reports. Each report is a plain data structure (KPIs, an optional chart series and
 * tables) so the same object renders on screen, prints, and exports to CSV.
 */
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { add, cmp, isZero, neg, normalize, ratio, sub } from "@/lib/money";
import { addDaysISO, formatDate, monthRange, yearRange, minISO, type DateRange, type ISODate } from "@/lib/dates";
import { AppError } from "@/server/errors";
import {
  analyticsCtx,
  boundRange,
  budgetPerformance,
  bucketWindows,
  byAccount,
  byPaymentMethod,
  incomeBySource,
  merchantStats,
  periodSummary,
  recurringVsDiscretionary,
  spendingByCategory,
  timeSeries,
  type AnalyticsCtx,
  type CategoryAmount,
} from "./analytics";
import { monthlyReview } from "./review";
import { accountBalances } from "./accounts";
import { rateMap, convert } from "./preferences";

export const REPORT_TYPES = [
  { id: "monthly", label: "Monthly report", description: "Income, spending, savings, top categories and budgets for one month" },
  { id: "yearly", label: "Year in review", description: "Month-by-month totals, categories and merchants for a year" },
  { id: "spending", label: "Spending", description: "Where money went: categories, merchants, payment methods" },
  { id: "income", label: "Income", description: "Income by source and account over time" },
  { id: "budget", label: "Budgets", description: "Budgeted vs spent for each month" },
  { id: "savings", label: "Savings", description: "Savings and savings rate by month, goal contributions" },
  { id: "net_worth", label: "Net worth", description: "Assets, liabilities and net worth at each month end" },
] as const;
export type ReportType = (typeof REPORT_TYPES)[number]["id"];
export const isReportType = (v: unknown): v is ReportType => REPORT_TYPES.some((t) => t.id === v);

export type ValueKind = "text" | "money" | "percent" | "number" | "date";
export type ReportColumn = { key: string; label: string; kind: ValueKind; indentKey?: string };
export type ReportRow = Record<string, string | number | null>;
export type ReportTable = { id: string; title: string; description?: string; columns: ReportColumn[]; rows: ReportRow[]; totals?: ReportRow; empty?: string };
export type ReportKpi = { label: string; value: string | number | null; kind: ValueKind; hint?: string };
/** A simple chart: one or more series over the same labels (rendered as bars, or a line for net worth). */
export type ReportChart = {
  title: string;
  form: "bars" | "line";
  series: { key: string; label: string; role: "income" | "spending" | "savings" | "netWorth" }[];
  points: { label: string; values: Record<string, string> }[];
};

export type Report = {
  type: ReportType;
  title: string;
  subtitle: string;
  range: DateRange;
  currency: string;
  generatedOn: ISODate;
  kpis: ReportKpi[];
  chart: ReportChart | null;
  tables: ReportTable[];
  notes: string[];
};

const MAX_MONTHS = 36;

const rangeLabel = (r: DateRange) => `${formatDate(r.from)} – ${formatDate(r.to)}`;

function categoryRows(items: CategoryAmount[], withChildren: boolean): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const c of items) {
    rows.push({ name: c.name, amount: c.amount, share: c.share, previous: c.previous, change: c.delta.change, changePct: c.delta.pct, level: 0 });
    if (withChildren)
      for (const ch of c.children)
        rows.push({ name: ch.name, amount: ch.amount, share: ch.share, previous: ch.previous, change: ch.delta.change, changePct: ch.delta.pct, level: 1 });
  }
  return rows;
}

const categoryColumns: ReportColumn[] = [
  { key: "name", label: "Category", kind: "text", indentKey: "level" },
  { key: "amount", label: "Amount", kind: "money" },
  { key: "share", label: "Share", kind: "percent" },
  { key: "previous", label: "Previous period", kind: "money" },
  { key: "change", label: "Change", kind: "money" },
];

const monthColumns: ReportColumn[] = [
  { key: "month", label: "Month", kind: "text" },
  { key: "income", label: "Income", kind: "money" },
  { key: "spending", label: "Spending", kind: "money" },
  { key: "net", label: "Saved", kind: "money" },
  { key: "rate", label: "Savings rate", kind: "percent" },
];

async function monthlySeriesTable(userId: string, range: DateRange, ctx: AnalyticsCtx) {
  const series = await timeSeries(userId, range, "month", { ctx });
  const rows = series.map((p) => ({ month: monthLabel(p.key, ctx), income: p.income, spending: p.spending, net: p.net, rate: p.savingsRate }));
  const totals = {
    income: add(...series.map((p) => p.income)),
    spending: add(...series.map((p) => p.spending)),
    net: add(...series.map((p) => p.net)),
  };
  return { series, rows, totals: { ...totals, rate: cmp(totals.income, "0") > 0 ? ratio(totals.net, totals.income) : null } };
}

const monthLabel = (key: ISODate, ctx: AnalyticsCtx) => (ctx.monthStartDay > 1 ? `From ${formatDate(key, "d MMM yyyy")}` : formatDate(key, "MMM yyyy"));

function summaryKpis(s: Awaited<ReturnType<typeof periodSummary>>): ReportKpi[] {
  return [
    { label: "Income", value: s.income, kind: "money" },
    { label: "Spending", value: s.spending, kind: "money", hint: isZero(s.refunds) ? undefined : `after ${normalize(s.refunds)} of refunds` },
    { label: "Saved", value: s.net, kind: "money" },
    { label: "Savings rate", value: s.savingsRate, kind: "percent" },
    { label: "Average daily spend", value: s.avgDailySpend, kind: "money" },
    { label: "Transactions", value: s.txCount, kind: "number" },
  ];
}

/** Build a report. `range` is interpreted per type (monthly/yearly use the month/year containing `range.from`). */
export async function buildReport(userId: string, type: ReportType, rangeIn: DateRange): Promise<Report> {
  if (!isReportType(type)) throw new AppError("VALIDATION", "Unknown report type.");
  const ctx = await analyticsCtx(userId);
  const base = { type, currency: ctx.currency, generatedOn: ctx.today, notes: [] as string[], chart: null as ReportChart | null };

  switch (type) {
    case "monthly": {
      const month = monthRange(rangeIn.from, ctx.monthStartDay).from.slice(0, 7);
      const r = await monthlyReview(userId, month);
      return {
        ...base,
        title: ctx.monthStartDay > 1 ? `Monthly report · from ${formatDate(r.range.from, "d MMM yyyy")}` : `Monthly report · ${formatDate(r.range.from, "MMMM yyyy")}`,
        subtitle: rangeLabel(r.range) + (r.complete ? "" : " (month in progress)"),
        range: r.range,
        kpis: summaryKpis(r.summary),
        tables: [
          { id: "categories", title: "Spending by category", columns: categoryColumns, rows: categoryRows(r.categories, true), totals: { amount: r.summary.spending }, empty: "No spending this month." },
          {
            id: "budgets",
            title: "Budget performance",
            columns: [
              { key: "name", label: "Budget", kind: "text" },
              { key: "limit", label: "Budgeted", kind: "money" },
              { key: "spent", label: "Spent", kind: "money" },
              { key: "remaining", label: "Remaining", kind: "money" },
              { key: "used", label: "Used", kind: "percent" },
            ],
            rows: r.budgets.items.map((b) => ({ name: b.name, limit: b.limit, spent: b.spent, remaining: b.remaining, used: b.used })),
            empty: "No monthly budgets.",
          },
          {
            id: "largest",
            title: "Largest expenses",
            columns: [
              { key: "date", label: "Date", kind: "date" },
              { key: "merchant", label: "Merchant / note", kind: "text" },
              { key: "category", label: "Category", kind: "text" },
              { key: "amount", label: "Amount", kind: "money" },
            ],
            rows: r.largestTransactions.map((t) => ({ date: t.date, merchant: t.merchantName ?? t.notes ?? "—", category: t.categoryName ?? "Uncategorized", amount: t.baseAmount })),
            empty: "No expenses.",
          },
          {
            id: "merchants",
            title: "Top merchants",
            columns: [
              { key: "name", label: "Merchant", kind: "text" },
              { key: "count", label: "Purchases", kind: "number" },
              { key: "total", label: "Spent", kind: "money" },
            ],
            rows: r.topMerchants.map((m) => ({ name: m.name, count: m.count, total: m.total })),
            empty: "No merchant spending.",
          },
        ],
        notes: r.facts.map((f) => f.text),
      };
    }

    case "yearly": {
      const year = yearRange(rangeIn.from);
      const [summary, months, cats, merchants] = await Promise.all([
        periodSummary(userId, year, { ctx }),
        monthlySeriesTable(userId, year, ctx),
        spendingByCategory(userId, year, { ctx }),
        merchantStats(userId, year, { limit: 10, ctx }),
      ]);
      return {
        ...base,
        title: `Year in review · ${year.from.slice(0, 4)}`,
        subtitle: rangeLabel(year),
        range: year,
        kpis: summaryKpis(summary),
        chart: {
          title: "Income and spending by month",
          form: "bars",
          series: [
            { key: "income", label: "Income", role: "income" },
            { key: "spending", label: "Spending", role: "spending" },
          ],
          points: months.series.map((p) => ({ label: formatDate(p.key, "MMM"), values: { income: p.income, spending: p.spending } })),
        },
        tables: [
          { id: "months", title: "Month by month", columns: monthColumns, rows: months.rows, totals: months.totals },
          { id: "categories", title: "Spending by category", columns: categoryColumns, rows: categoryRows(cats.items, false), totals: { amount: cats.total }, empty: "No spending this year." },
          {
            id: "merchants",
            title: "Top merchants",
            columns: [
              { key: "name", label: "Merchant", kind: "text" },
              { key: "count", label: "Purchases", kind: "number" },
              { key: "avg", label: "Average", kind: "money" },
              { key: "total", label: "Spent", kind: "money" },
            ],
            rows: merchants.rows.map((m) => ({ name: m.name, count: m.count, avg: m.avg, total: m.total })),
            empty: "No merchant spending.",
          },
        ],
      };
    }

    case "spending": {
      const range = await boundRange(userId, rangeIn, ctx.today);
      const [summary, cats, merchants, methods, split] = await Promise.all([
        periodSummary(userId, range, { ctx }),
        spendingByCategory(userId, range, { ctx }),
        merchantStats(userId, range, { limit: 20, ctx }),
        byPaymentMethod(userId, range, { ctx }),
        recurringVsDiscretionary(userId, range, { ctx }),
      ]);
      return {
        ...base,
        title: "Spending report",
        subtitle: rangeLabel(range),
        range,
        kpis: [
          { label: "Spending", value: summary.spending, kind: "money" },
          { label: "Expenses", value: summary.expenses, kind: "money" },
          { label: "Refunds", value: summary.refunds, kind: "money" },
          { label: "Average daily spend", value: summary.avgDailySpend, kind: "money" },
          { label: "Recurring share", value: split.recurringShare, kind: "percent" },
        ],
        tables: [
          { id: "categories", title: "By category", columns: categoryColumns, rows: categoryRows(cats.items, true), totals: { amount: cats.total }, empty: "No spending in this range." },
          {
            id: "merchants",
            title: "Top merchants",
            columns: [
              { key: "name", label: "Merchant", kind: "text" },
              { key: "count", label: "Purchases", kind: "number" },
              { key: "avg", label: "Average", kind: "money" },
              { key: "total", label: "Spent", kind: "money" },
              { key: "change", label: "Change vs previous", kind: "money" },
            ],
            rows: merchants.rows.map((m) => ({ name: m.name, count: m.count, avg: m.avg, total: m.total, change: m.delta.change })),
            empty: "No merchant spending.",
          },
          {
            id: "methods",
            title: "By payment method",
            columns: [
              { key: "name", label: "Payment method", kind: "text" },
              { key: "count", label: "Transactions", kind: "number" },
              { key: "amount", label: "Spent", kind: "money" },
              { key: "share", label: "Share", kind: "percent" },
            ],
            rows: methods.items.map((m) => ({ name: m.name, count: m.count, amount: m.amount, share: m.share })),
            totals: { amount: methods.total },
          },
          {
            id: "recurring",
            title: "Recurring vs discretionary",
            columns: [
              { key: "name", label: "Type", kind: "text" },
              { key: "count", label: "Transactions", kind: "number" },
              { key: "amount", label: "Spent", kind: "money" },
            ],
            rows: [
              { name: "Recurring (bills, subscriptions, scheduled)", count: split.recurringCount, amount: split.recurring },
              { name: "Discretionary", count: split.discretionaryCount, amount: split.discretionary },
            ],
            totals: { amount: split.total },
          },
        ],
      };
    }

    case "income": {
      const range = await boundRange(userId, rangeIn, ctx.today);
      const [summary, sources, accounts, months] = await Promise.all([
        periodSummary(userId, range, { ctx }),
        incomeBySource(userId, range, { ctx }),
        byAccount(userId, range, { ctx }),
        monthlySeriesTable(userId, range, ctx),
      ]);
      return {
        ...base,
        title: "Income report",
        subtitle: rangeLabel(range),
        range,
        kpis: [
          { label: "Income", value: summary.income, kind: "money" },
          { label: "Previous period", value: summary.previous?.income ?? null, kind: "money" },
          { label: "Change", value: summary.deltas?.income.pct ?? null, kind: "percent" },
          { label: "Income sources", value: sources.items.length, kind: "number" },
        ],
        chart: {
          title: "Income by month",
          form: "bars",
          series: [{ key: "income", label: "Income", role: "income" }],
          points: months.series.map((p) => ({ label: monthLabel(p.key, ctx), values: { income: p.income } })),
        },
        tables: [
          { id: "sources", title: "By source", columns: categoryColumns.map((c) => (c.key === "name" ? { ...c, label: "Source" } : c)), rows: categoryRows(sources.items, true), totals: { amount: sources.total }, empty: "No income in this range." },
          {
            id: "accounts",
            title: "By account",
            columns: [
              { key: "name", label: "Account", kind: "text" },
              { key: "income", label: "Income", kind: "money" },
            ],
            rows: accounts.filter((a) => !isZero(a.income)).map((a) => ({ name: a.name, income: a.income })),
          },
          { id: "months", title: "Month by month", columns: monthColumns.slice(0, 2), rows: months.rows, totals: { income: months.totals.income } },
        ],
      };
    }

    case "budget": {
      const range = await boundRange(userId, rangeIn, ctx.today);
      const windows = bucketWindows(range, "month", ctx, 24);
      const perMonth = await Promise.all(windows.map((w) => budgetPerformance(userId, w.key, { ctx })));
      const rows: ReportRow[] = [];
      let limit = "0";
      let spent = "0";
      perMonth.forEach((p, i) => {
        for (const b of p.items) {
          rows.push({ month: monthLabel(windows[i].key, ctx), name: b.name, limit: b.limit, spent: b.spent, remaining: b.remaining, used: b.used, status: b.status === "over" ? "Over" : b.status === "near" ? "Near limit" : "Within" });
          limit = add(limit, b.limit);
          spent = add(spent, b.spent);
        }
      });
      const over = rows.filter((r) => r.status === "Over").length;
      return {
        ...base,
        title: "Budget report",
        subtitle: rangeLabel(range),
        range,
        kpis: [
          { label: "Budgeted", value: limit, kind: "money" },
          { label: "Spent in budgets", value: spent, kind: "money" },
          { label: "Budget-months over limit", value: over, kind: "number" },
          { label: "Budget-months tracked", value: rows.length, kind: "number" },
        ],
        tables: [
          {
            id: "budgets",
            title: "Budgeted vs spent",
            columns: [
              { key: "month", label: "Month", kind: "text" },
              { key: "name", label: "Budget", kind: "text" },
              { key: "limit", label: "Budgeted", kind: "money" },
              { key: "spent", label: "Spent", kind: "money" },
              { key: "remaining", label: "Remaining", kind: "money" },
              { key: "used", label: "Used", kind: "percent" },
              { key: "status", label: "Status", kind: "text" },
            ],
            rows,
            empty: "No monthly budgets in this range.",
          },
        ],
        notes: ["Covers monthly budgets (and custom budgets overlapping each month). Rollover amounts are not included."],
      };
    }

    case "savings": {
      const range = await boundRange(userId, rangeIn, ctx.today);
      const [summary, months, goals] = await Promise.all([
        periodSummary(userId, range, { ctx }),
        monthlySeriesTable(userId, range, ctx),
        db.execute<{ name: string; currency: string; amount: string; cnt: number }>(sql`
          SELECT g.name, g.currency, SUM(gc.amount)::text AS amount, COUNT(*)::int AS cnt
            FROM goal_contributions gc JOIN goals g ON g.id = gc.goal_id AND g.user_id = ${userId}
           WHERE gc.user_id = ${userId} AND gc.date >= ${range.from} AND gc.date <= ${range.to}
           GROUP BY g.id, g.name, g.currency ORDER BY g.name`),
      ]);
      const rates = await rateMap(userId, ctx.currency);
      const goalRows = goals.map((g) => ({ name: g.name, count: Number(g.cnt), amount: convert(g.amount, g.currency, rates) ?? null, original: `${normalize(g.amount)} ${g.currency}` }));
      return {
        ...base,
        title: "Savings report",
        subtitle: rangeLabel(range),
        range,
        kpis: [
          { label: "Saved", value: summary.net, kind: "money" },
          { label: "Savings rate", value: summary.savingsRate, kind: "percent" },
          { label: "Income", value: summary.income, kind: "money" },
          { label: "Spending", value: summary.spending, kind: "money" },
          { label: "Goal contributions", value: add(...goalRows.map((g) => g.amount ?? "0")), kind: "money" },
        ],
        chart: {
          title: "Saved per month",
          form: "bars",
          series: [{ key: "net", label: "Saved", role: "savings" }],
          points: months.series.map((p) => ({ label: monthLabel(p.key, ctx), values: { net: p.net } })),
        },
        tables: [
          { id: "months", title: "Month by month", columns: monthColumns, rows: months.rows, totals: months.totals },
          {
            id: "goals",
            title: "Goal contributions",
            columns: [
              { key: "name", label: "Goal", kind: "text" },
              { key: "count", label: "Contributions", kind: "number" },
              { key: "original", label: "Amount (goal currency)", kind: "text" },
              { key: "amount", label: "Amount", kind: "money" },
            ],
            rows: goalRows,
            empty: "No goal contributions in this range.",
          },
        ],
        notes: ["Saved = income − spending. Transfers between your accounts are not counted as income or spending."],
      };
    }

    case "net_worth": {
      const r = await netWorthAtMonthEnds(userId, rangeIn, ctx);
      const last = r.points[r.points.length - 1];
      const first = r.points[0];
      return {
        ...base,
        title: "Net worth report",
        subtitle: rangeLabel(r.range),
        range: r.range,
        kpis: [
          { label: "Net worth", value: last?.netWorth ?? null, kind: "money" },
          { label: "Assets", value: last?.assets ?? null, kind: "money" },
          { label: "Liabilities", value: last?.liabilities ?? null, kind: "money" },
          { label: "Change over range", value: last && first ? sub(last.netWorth, first.netWorth) : null, kind: "money" },
        ],
        chart: {
          title: "Net worth at each month end",
          form: "line",
          series: [{ key: "netWorth", label: "Net worth", role: "netWorth" }],
          points: r.points.map((p) => ({ label: formatDate(p.date, "MMM yyyy"), values: { netWorth: p.netWorth } })),
        },
        tables: [
          {
            id: "history",
            title: "Month-end balances",
            columns: [
              { key: "date", label: "Date", kind: "date" },
              { key: "assets", label: "Assets", kind: "money" },
              { key: "liabilities", label: "Liabilities", kind: "money" },
              { key: "netWorth", label: "Net worth", kind: "money" },
              { key: "change", label: "Change", kind: "money" },
            ],
            rows: r.points.map((p) => ({ ...p })),
          },
          {
            id: "accounts",
            title: `Accounts at ${formatDate(r.range.to)}`,
            columns: [
              { key: "name", label: "Account", kind: "text" },
              { key: "type", label: "Type", kind: "text" },
              { key: "native", label: "Balance (account currency)", kind: "text" },
              { key: "balance", label: "Balance", kind: "money" },
            ],
            rows: r.accounts,
          },
        ],
        notes: [
          "Balances are computed from your transactions as of each month end, and converted at today's exchange rates.",
          ...(r.unconverted.length ? [`Accounts in ${r.unconverted.join(", ")} are left out — add exchange rates in Settings.`] : []),
          "Accounts excluded from net worth are not counted.",
        ],
      };
    }
  }
  throw new AppError("VALIDATION", "Unknown report type.");
}

/** Assets, liabilities and net worth at each month end in the range (current FX rates). */
export async function netWorthAtMonthEnds(userId: string, rangeIn: DateRange, ctxIn?: AnalyticsCtx) {
  const ctx = ctxIn ?? (await analyticsCtx(userId));
  const [accts, rates, firstRow] = await Promise.all([
    db.execute<{ id: string; name: string; type: string; currency: string; include: boolean; opening_date: string | null; created: string }>(sql`
      SELECT id, name, type::text AS type, currency, include_in_net_worth AS include, opening_date::text AS opening_date, created_at::date::text AS created
        FROM accounts WHERE user_id = ${userId} ORDER BY sort_order, created_at`),
    rateMap(userId, ctx.currency),
    db.execute<{ first: string | null }>(sql`SELECT min(date)::text AS first FROM transactions WHERE user_id = ${userId} AND deleted_at IS NULL`),
  ]);
  const earliest = [firstRow[0]?.first, ...accts.map((a) => a.opening_date ?? a.created)].filter(Boolean).sort()[0] ?? ctx.today;
  const from = rangeIn.from < earliest ? earliest : rangeIn.from;
  const to = minISO(rangeIn.to, ctx.today);
  const range = { from: from <= to ? from : to, to };
  let ends = bucketWindows(range, "month", { weekStartsOn: ctx.weekStartsOn, monthStartDay: 1 }, 400).map((w) => w.to);
  if (ends.length > MAX_MONTHS) ends = ends.slice(-MAX_MONTHS);
  const included = accts.filter((a) => a.include);
  const unconverted = [...new Set(included.filter((a) => !rates.has(a.currency)).map((a) => a.currency))];
  const snapshots = await Promise.all(ends.map((d) => accountBalances(userId, d)));
  let prevNet: string | null = null;
  const points = ends.map((date, i) => {
    let assets = "0";
    let liabilities = "0";
    for (const a of included) {
      const bal = snapshots[i].get(a.id);
      if (bal === undefined) continue;
      const base = convert(bal, a.currency, rates);
      if (base === null) continue;
      // Money owed (negative balances — cards, loans, overdrafts) is a liability; the rest are assets.
      if (cmp(base, "0") < 0) liabilities = add(liabilities, neg(base));
      else assets = add(assets, base);
    }
    const netWorth = sub(assets, liabilities);
    const change = prevNet === null ? null : sub(netWorth, prevNet);
    prevNet = netWorth;
    return { date, assets, liabilities, netWorth, change };
  });
  const latest = snapshots[snapshots.length - 1];
  const accounts = included.map((a) => {
    const bal = latest?.get(a.id) ?? "0";
    return { name: a.name, type: a.type.replace("_", " "), native: `${normalize(bal)} ${a.currency}`, balance: convert(bal, a.currency, rates) };
  });
  return { range: { from: range.from, to: ends[ends.length - 1] ?? range.to }, points, accounts, unconverted };
}

/** Default range for a report type when the user hasn't picked one. */
export function defaultReportRange(type: ReportType, today: ISODate, monthStartDay: number): DateRange {
  if (type === "monthly") return monthRange(today, monthStartDay);
  if (type === "yearly") return yearRange(today);
  if (type === "net_worth") return { from: addDaysISO(yearRange(today).from, -365), to: today };
  return monthRange(today, monthStartDay);
}
