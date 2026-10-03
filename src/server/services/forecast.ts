/**
 * Cash-flow forecast and safe-to-spend. Everything here is a projection or a calculation, never
 * an actual — outputs carry `kind` and plain-language `method` notes so the UI can label them.
 *
 * Model (cash basis, base currency):
 * - Start from today's balance of liquid accounts (checking, savings, cash, wallet).
 * - Scheduled items come from the recurring engine (`upcomingOccurrences`). Income adds,
 *   expenses/bills/subscriptions subtract (whatever account pays them — card spending is paid
 *   from cash eventually), transfers between liquid accounts are neutral, transfers out of
 *   liquid accounts (investments, loan or card payments) subtract.
 * - What's already owed on credit cards is paid on the card's due day, unless a recurring
 *   transfer to that card is scheduled (then the transfer is the payment).
 * - Unscheduled day-to-day spending is estimated as the average daily discretionary spend
 *   (not linked to a recurring item) over the last 90 days.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { goalContributions, goals, recurringTransactions } from "@/server/db/schema";
import { add, cmp, divInt, isNegative, isPositive, isZero, mul, neg, normalize, sub } from "@/lib/money";
import { addDaysISO, daysBetween, minISO, monthRange, toDate, toISO, type DateRange, type ISODate } from "@/lib/dates";
import { perMonthFactor } from "@/lib/recurrence";
import { isLiabilityType, isLiquidType, listAccounts, type AccountWithBalance } from "./accounts";
import { getPreferences, rateMap, convert } from "./preferences";
import { upcomingOccurrences } from "./recurring";

export const FORECAST_HORIZONS = [30, 60, 90] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

export type ScheduledFlow = {
  /** Date the flow is expected (overdue items are moved to today). */
  date: ISODate;
  originalDate: ISODate;
  name: string;
  kind: "income" | "expense" | "bill" | "subscription" | "transfer" | "card_due" | "loan_due";
  /** Signed effect on liquid cash in base currency (+ in, − out). */
  amount: string;
  status: "overdue" | "due" | "upcoming";
  recurringId: string | null;
  accountId: string | null;
};

type Ctx = {
  today: ISODate;
  currency: string;
  monthStartDay: number;
  rates: Map<string, string>;
  accounts: AccountWithBalance[];
};

async function loadCtx(userId: string): Promise<Ctx> {
  const prefs = await getPreferences(userId);
  const [rates, accounts] = await Promise.all([rateMap(userId, prefs.currency), listAccounts(userId, { includeArchived: false })]);
  return { today: prefs.today, currency: prefs.currency, monthStartDay: prefs.monthStartDay, rates, accounts };
}

/** Liquid balance in base currency, plus accounts that couldn't be converted (no exchange rate). */
function liquidBalance(ctx: Ctx) {
  let total = "0";
  const included: { id: string; name: string; type: string; currency: string; balance: string; baseBalance: string }[] = [];
  const unconverted: { id: string; name: string; currency: string }[] = [];
  for (const a of ctx.accounts) {
    if (!isLiquidType(a.type)) continue;
    const base = convert(a.balance, a.currency, ctx.rates);
    if (base === null) {
      unconverted.push({ id: a.id, name: a.name, currency: a.currency });
      continue;
    }
    total = add(total, base);
    included.push({ id: a.id, name: a.name, type: a.type, currency: a.currency, balance: a.balance, baseBalance: base });
  }
  return { total, included, unconverted };
}

/** Next date (on/after `from`) that falls on day-of-month `day`, clamped to short months. */
function nextDayOfMonth(from: ISODate, day: number): ISODate {
  const d = toDate(from);
  for (let i = 0; i < 2; i++) {
    const y = d.getFullYear();
    const m = d.getMonth() + i;
    const last = new Date(y, m + 1, 0).getDate();
    const candidate = toISO(new Date(y, m, Math.min(day, last)));
    if (candidate >= from) return candidate;
  }
  return from;
}

/** Every scheduled cash flow in [today, to], with its signed effect on liquid balances. */
export async function scheduledFlows(userId: string, to: ISODate, ctxIn?: Ctx): Promise<{ flows: ScheduledFlow[]; unconverted: string[] }> {
  const ctx = ctxIn ?? (await loadCtx(userId));
  const accById = new Map(ctx.accounts.map((a) => [a.id, a]));
  const occ = await upcomingOccurrences(userId, ctx.today, to);
  const flows: ScheduledFlow[] = [];
  const unconverted = new Set<string>();
  const liquid = (id: string | null) => {
    if (!id) return null;
    const a = accById.get(id);
    return a ? isLiquidType(a.type) : null;
  };
  const cardsPaidByTransfer = new Set<string>();
  // Occurrences don't carry a transfer's destination account; fetch them in one query.
  const transferIds = [...new Set(occ.filter((o) => o.kind === "transfer").map((o) => o.recurringId))];
  const destinations = new Map<string, string | null>();
  if (transferIds.length) {
    const rows = await db
      .select({ id: recurringTransactions.id, to: recurringTransactions.toAccountId })
      .from(recurringTransactions)
      .where(and(eq(recurringTransactions.userId, userId), inArray(recurringTransactions.id, transferIds)));
    for (const r of rows) destinations.set(r.id, r.to);
  }

  for (const o of occ) {
    if (o.baseAmount === null) {
      unconverted.add(o.currency);
      continue;
    }
    const date = o.date < ctx.today ? ctx.today : o.date;
    const base: Omit<ScheduledFlow, "amount"> = {
      date,
      originalDate: o.date,
      name: o.name,
      kind: o.kind,
      status: o.status,
      recurringId: o.recurringId,
      accountId: o.accountId,
    };
    const acc = o.accountId ? accById.get(o.accountId) : undefined;
    if (o.kind === "income") {
      // Income into a non-liquid asset (e.g. straight into an investment) doesn't add cash.
      if (acc && !isLiquidType(acc.type) && !isLiabilityType(acc.type)) continue;
      flows.push({ ...base, amount: o.baseAmount });
    } else if (o.kind === "transfer") {
      const recurringToAccount = destinations.get(o.recurringId) ?? null;
      const fromLiquid = liquid(o.accountId);
      const toLiquid = liquid(recurringToAccount);
      const toAcc = recurringToAccount ? accById.get(recurringToAccount) : undefined;
      if (toAcc?.type === "credit_card") cardsPaidByTransfer.add(toAcc.id);
      if (fromLiquid && toLiquid === false) flows.push({ ...base, amount: neg(o.baseAmount) });
      else if (fromLiquid === false && toLiquid) flows.push({ ...base, amount: o.baseAmount });
      // liquid → liquid (or unknown accounts) is neutral.
    } else {
      if (acc && !isLiquidType(acc.type) && !isLiabilityType(acc.type)) continue;
      flows.push({ ...base, amount: neg(o.baseAmount) });
    }
  }

  // Card & loan dues from account settings.
  for (const a of ctx.accounts) {
    if (!a.dueDay || !isLiabilityType(a.type)) continue;
    const owed = isNegative(a.balance) ? neg(a.balance) : "0";
    if (isZero(owed)) continue;
    const date = nextDayOfMonth(ctx.today, a.dueDay);
    if (date > to) continue;
    if (a.type === "credit_card") {
      if (cardsPaidByTransfer.has(a.id)) continue;
      const base = convert(owed, a.currency, ctx.rates);
      if (base === null) {
        unconverted.add(a.currency);
        continue;
      }
      flows.push({ date, originalDate: date, name: `${a.name} payment`, kind: "card_due", amount: neg(base), status: date === ctx.today ? "due" : "upcoming", recurringId: null, accountId: a.id });
    } else if (a.minimumPayment && isPositive(a.minimumPayment)) {
      // Loans: the minimum payment each month in the horizon.
      let d = date;
      let guard = 0;
      while (d <= to && guard++ < 6) {
        const base = convert(minDecimal(a.minimumPayment, owed), a.currency, ctx.rates);
        if (base === null) {
          unconverted.add(a.currency);
          break;
        }
        flows.push({ date: d, originalDate: d, name: `${a.name} payment`, kind: "loan_due", amount: neg(base), status: d === ctx.today ? "due" : "upcoming", recurringId: null, accountId: a.id });
        d = nextDayOfMonth(addDaysISO(d, 1), a.dueDay);
      }
    }
  }
  flows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : cmp(x.amount, y.amount)));
  return { flows, unconverted: [...unconverted] };
}

const minDecimal = (a: string, b: string) => (cmp(a, b) <= 0 ? normalize(a) : normalize(b));

/** Average daily discretionary spending (expenses − refunds not linked to a recurring item). */
export async function discretionaryDailyAverage(userId: string, today: ISODate, lookbackDays = 90) {
  const from = addDaysISO(today, -lookbackDays);
  const to = addDaysISO(today, -1);
  const [row] = await db.execute<{ spend: string; first: string | null }>(sql`
    SELECT COALESCE(SUM(CASE WHEN t.type = 'expense' THEN COALESCE(s.base_amount, t.base_amount)
                             WHEN t.type = 'refund' THEN -t.base_amount ELSE 0 END), 0)::text AS spend,
           (SELECT min(date)::text FROM transactions WHERE user_id = ${userId} AND deleted_at IS NULL) AS first
      FROM transactions t
      LEFT JOIN transaction_splits s ON s.transaction_id = t.id AND s.user_id = ${userId}
      LEFT JOIN categories c ON c.id = COALESCE(s.category_id, t.category_id) AND c.user_id = ${userId}
      LEFT JOIN categories pc ON pc.id = c.parent_id AND pc.user_id = ${userId}
     WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.recurring_id IS NULL
       AND t.type IN ('expense', 'refund') AND t.date >= ${from} AND t.date <= ${to}
       AND NOT (COALESCE(c.exclude_from_reports, false) OR COALESCE(pc.exclude_from_reports, false))`);
  // With less history than the lookback, average over the days we actually have.
  const historyDays = row.first && row.first > from ? Math.max(daysBetween(row.first, to) + 1, 1) : lookbackDays;
  const total = isNegative(row.spend) ? "0" : normalize(row.spend);
  return { total, days: historyDays, daily: row.first && row.first <= to ? divInt(total, historyDays) : "0.0000", lookbackDays };
}

export type ForecastPoint = {
  date: ISODate;
  /** Projected end-of-day liquid balance. */
  balance: string;
  scheduledIn: string;
  scheduledOut: string;
  variable: string;
};

export type CashFlowForecast = {
  kind: "forecast";
  asOf: ISODate;
  days: number;
  currency: string;
  method: string[];
  startingBalance: string;
  accounts: { id: string; name: string; type: string; currency: string; balance: string; baseBalance: string }[];
  points: ForecastPoint[];
  items: ScheduledFlow[];
  dailyVariableSpend: string;
  totals: {
    scheduledIncome: string;
    scheduledExpenses: string;
    variableSpending: string;
    projectedIncome: string;
    projectedExpenses: string;
    projectedSavings: string;
    endingBalance: string;
    lowestBalance: string;
    lowestBalanceDate: ISODate;
  };
  /** First date the projected balance drops below zero, if any. */
  shortfallDate: ISODate | null;
  unconvertedCurrencies: string[];
  unconvertedAccounts: { id: string; name: string; currency: string }[];
};

/** Daily projected liquid balance for the next 30/60/90 days. */
export async function cashFlowForecast(userId: string, days: number = 30): Promise<CashFlowForecast> {
  const horizon = Math.min(Math.max(Math.trunc(days) || 30, 7), 120);
  const ctx = await loadCtx(userId);
  const end = addDaysISO(ctx.today, horizon);
  const [liq, sched, variable] = await Promise.all([
    Promise.resolve(liquidBalance(ctx)),
    scheduledFlows(userId, end, ctx),
    discretionaryDailyAverage(userId, ctx.today),
  ]);
  const byDate = new Map<string, ScheduledFlow[]>();
  for (const f of sched.flows) byDate.set(f.date, [...(byDate.get(f.date) ?? []), f]);

  let balance = liq.total;
  let scheduledIncome = "0";
  let scheduledExpenses = "0";
  let variableSpending = "0";
  let lowest = liq.total;
  let lowestDate = ctx.today;
  let shortfallDate: ISODate | null = null;
  const points: ForecastPoint[] = [];
  for (let i = 0; i <= horizon; i++) {
    const date = addDaysISO(ctx.today, i);
    let inflow = "0";
    let outflow = "0";
    for (const f of byDate.get(date) ?? []) {
      if (isNegative(f.amount)) outflow = add(outflow, neg(f.amount));
      else inflow = add(inflow, f.amount);
    }
    // Today's unscheduled spending is already reflected in today's balance.
    const v = i === 0 ? "0" : variable.daily;
    balance = sub(add(balance, inflow), add(outflow, v));
    scheduledIncome = add(scheduledIncome, inflow);
    scheduledExpenses = add(scheduledExpenses, outflow);
    variableSpending = add(variableSpending, v);
    if (cmp(balance, lowest) < 0) {
      lowest = balance;
      lowestDate = date;
    }
    if (!shortfallDate && isNegative(balance)) shortfallDate = date;
    points.push({ date, balance, scheduledIn: inflow, scheduledOut: outflow, variable: v });
  }
  const projectedExpenses = add(scheduledExpenses, variableSpending);
  return {
    kind: "forecast",
    asOf: ctx.today,
    days: horizon,
    currency: ctx.currency,
    method: [
      "Starts from today's balance of your bank, savings, cash and wallet accounts.",
      "Adds scheduled income and subtracts scheduled bills, subscriptions and recurring expenses from Bills & recurring. Unpaid overdue items are counted today.",
      "Transfers between your own cash accounts are neutral; transfers to investments, loans or cards reduce cash.",
      "Credit-card balances already owed are paid on each card's due day unless a recurring card payment is scheduled.",
      `Everyday spending is estimated at ${variable.daily} per day — your average non-recurring spending over the last ${variable.days} days.`,
      "This is a projection, not a guarantee.",
    ],
    startingBalance: liq.total,
    accounts: liq.included,
    points,
    items: sched.flows,
    dailyVariableSpend: variable.daily,
    totals: {
      scheduledIncome,
      scheduledExpenses,
      variableSpending,
      projectedIncome: scheduledIncome,
      projectedExpenses,
      projectedSavings: sub(scheduledIncome, projectedExpenses),
      endingBalance: balance,
      lowestBalance: lowest,
      lowestBalanceDate: lowestDate,
    },
    shortfallDate,
    unconvertedCurrencies: sched.unconverted,
    unconvertedAccounts: liq.unconverted,
  };
}

/* ───────────── Safe to spend ───────────── */

export type GoalCommitment = { goalId: string; name: string; monthlyTarget: string; contributedThisMonth: string; remaining: string; currency: string; baseRemaining: string };

/** What active goals still need this budget month (monthly target − contributed so far). */
export async function goalCommitmentsThisMonth(userId: string, month: DateRange, today: ISODate, rates: Map<string, string>) {
  const rows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")));
  if (!rows.length) return { total: "0", items: [] as GoalCommitment[], unconverted: [] as string[] };
  const ids = rows.map((g) => g.id);
  const [monthSums, allSums] = await Promise.all([
    db
      .select({ goalId: goalContributions.goalId, total: sql<string>`coalesce(sum(${goalContributions.amount}), 0)::text` })
      .from(goalContributions)
      .where(and(eq(goalContributions.userId, userId), inArray(goalContributions.goalId, ids), gte(goalContributions.date, month.from), lte(goalContributions.date, month.to)))
      .groupBy(goalContributions.goalId),
    db
      .select({ goalId: goalContributions.goalId, total: sql<string>`coalesce(sum(${goalContributions.amount}), 0)::text` })
      .from(goalContributions)
      .where(and(eq(goalContributions.userId, userId), inArray(goalContributions.goalId, ids)))
      .groupBy(goalContributions.goalId),
  ]);
  const monthBy = new Map(monthSums.map((r) => [r.goalId, r.total]));
  const allBy = new Map(allSums.map((r) => [r.goalId, r.total]));
  const items: GoalCommitment[] = [];
  const unconverted = new Set<string>();
  let total = "0";
  for (const g of rows) {
    const saved = add(g.startingAmount, allBy.get(g.id) ?? "0");
    const toGo = sub(g.targetAmount, saved);
    if (!isPositive(toGo)) continue;
    let monthly: string | null = null;
    if (g.targetContribution && isPositive(g.targetContribution) && g.contributionFrequency) {
      const { num, den } = perMonthFactor({ frequency: g.contributionFrequency, interval: 1, intervalUnit: "month" });
      monthly = divInt(mul(g.targetContribution, String(num)), den);
    } else if (g.deadline && g.deadline >= today) {
      // Even split of what's left over the remaining budget months (including this one).
      const months = Math.max(1, monthsBetween(month.from, g.deadline) + 1);
      monthly = divInt(toGo, months);
    }
    if (!monthly) continue;
    monthly = minDecimal(monthly, toGo);
    const contributed = monthBy.get(g.id) ?? "0";
    const remaining = cmp(monthly, contributed) > 0 ? sub(monthly, contributed) : "0.0000";
    if (isZero(remaining)) continue;
    const base = convert(remaining, g.currency, rates);
    if (base === null) {
      unconverted.add(g.currency);
      continue;
    }
    total = add(total, base);
    items.push({ goalId: g.id, name: g.name, monthlyTarget: monthly, contributedThisMonth: normalize(contributed), remaining, currency: g.currency, baseRemaining: base });
  }
  return { total, items, unconverted: [...unconverted] };
}

function monthsBetween(from: ISODate, to: ISODate) {
  const a = toDate(from);
  const b = toDate(to);
  return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
}

export type SafeToSpend = {
  kind: "calculation";
  asOf: ISODate;
  currency: string;
  /** Liquid balance − commitments due before the window ends. May be negative. */
  amount: string;
  /** Per-day allowance for the rest of the window (0 when amount ≤ 0). */
  perDay: string;
  windowEnd: ISODate;
  daysRemaining: number;
  basis: "next_income" | "month_end";
  nextIncome: { date: ISODate; name: string; amount: string } | null;
  breakdown: {
    key: "balance" | "bills" | "transfers" | "cards" | "goals";
    label: string;
    /** Signed: balance positive, deductions negative. */
    amount: string;
    items: { label: string; date?: ISODate; amount: string; status?: string }[];
  }[];
  method: string[];
  unconvertedCurrencies: string[];
};

/**
 * Liquid cash minus bills, subscriptions and other commitments due before the next income
 * (or the end of the budget month when no income is scheduled), minus what goals still need
 * this month. Includes a per-day allowance until then.
 */
export async function safeToSpend(userId: string): Promise<SafeToSpend> {
  const ctx = await loadCtx(userId);
  const month = monthRange(ctx.today, ctx.monthStartDay);
  const lookahead = addDaysISO(ctx.today, 62);
  const [liq, sched, goalsDue] = await Promise.all([
    Promise.resolve(liquidBalance(ctx)),
    scheduledFlows(userId, lookahead, ctx),
    goalCommitmentsThisMonth(userId, month, ctx.today, ctx.rates),
  ]);
  const income = sched.flows.find((f) => f.kind === "income" && f.originalDate > ctx.today && isPositive(f.amount));
  const basis: SafeToSpend["basis"] = income ? "next_income" : "month_end";
  const windowEnd = income ? addDaysISO(income.date, -1) : month.to;
  const due = sched.flows.filter((f) => f.date <= windowEnd && isNegative(f.amount));
  const sumOf = (fs: ScheduledFlow[]) => add(...fs.map((f) => f.amount));
  const bills = due.filter((f) => f.kind === "bill" || f.kind === "subscription" || f.kind === "expense");
  const transfers = due.filter((f) => f.kind === "transfer");
  const cards = due.filter((f) => f.kind === "card_due" || f.kind === "loan_due");
  const toItem = (f: ScheduledFlow) => ({ label: f.name, date: f.originalDate, amount: f.amount, status: f.status });
  const goalTotal = goalsDue.total;
  const amount = add(liq.total, sumOf(bills), sumOf(transfers), sumOf(cards), neg(goalTotal));
  const daysRemaining = Math.max(1, daysBetween(ctx.today, windowEnd) + 1);
  const until = income ? "before your next income" : "before the end of this budget month";
  const breakdown: SafeToSpend["breakdown"] = [
    { key: "balance", label: "Cash in bank, savings, cash & wallets", amount: liq.total, items: liq.included.map((a) => ({ label: a.name, amount: a.baseBalance })) },
    { key: "bills", label: `Bills & subscriptions due ${until}`, amount: sumOf(bills), items: bills.map(toItem) },
    { key: "transfers", label: `Scheduled transfers out ${until}`, amount: sumOf(transfers), items: transfers.map(toItem) },
    { key: "cards", label: `Card & loan payments due ${until}`, amount: sumOf(cards), items: cards.map(toItem) },
    {
      key: "goals",
      label: "Goal contributions still planned this month",
      amount: neg(goalTotal),
      items: goalsDue.items.map((g) => ({ label: g.name, amount: neg(g.baseRemaining) })),
    },
  ];
  return {
    kind: "calculation",
    asOf: ctx.today,
    currency: ctx.currency,
    amount,
    perDay: isPositive(amount) ? divInt(amount, daysRemaining) : "0.0000",
    windowEnd: minISO(windowEnd, lookahead),
    daysRemaining,
    basis,
    nextIncome: income ? { date: income.date, name: income.name, amount: income.amount } : null,
    breakdown: breakdown.filter((b) => b.key === "balance" || !isZero(b.amount)),
    method: [
      "Calculated from your current balances and schedules — not a forecast of everyday spending.",
      income
        ? `Covers today through the day before your next scheduled income (${income.name}).`
        : "No income is scheduled in the next two months, so this covers today through the end of the budget month.",
      "Bills paid by credit card are counted because card spending is paid from cash.",
      "Goal amounts use each goal's target contribution, or an even split of what's left before its deadline.",
    ],
    unconvertedCurrencies: [...new Set([...sched.unconverted, ...goalsDue.unconverted, ...liq.unconverted.map((a) => a.currency)])],
  };
}
