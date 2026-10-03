/**
 * Financial calendar: for a calendar month, actual daily totals and transactions alongside
 * scheduled items (bills, subscriptions, income, recurring transfers, card/loan due days, goal
 * contributions and deadlines) and — for days ahead — the projected balance from the forecast.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { goals } from "@/server/db/schema";
import { add, neg, isNegative, normalize } from "@/lib/money";
import { addDaysISO, daysBetween, minISO, toDate, toISO, weekRange, type DateRange, type ISODate } from "@/lib/dates";
import { occurrencesBetween } from "@/lib/recurrence";
import { AppError } from "@/server/errors";
import { dailyBreakdown, type DayTxn } from "./analytics";
import { isLiabilityType, listAccounts } from "./accounts";
import { getPreferences, rateMap, convert } from "./preferences";
import { upcomingOccurrences } from "./recurring";
import { cashFlowForecast } from "./forecast";

export type CalendarItemKind = "income" | "expense" | "bill" | "subscription" | "transfer" | "card_due" | "loan_due" | "goal_contribution" | "goal_deadline";

export type CalendarItem = {
  id: string;
  date: ISODate;
  kind: CalendarItemKind;
  name: string;
  /** Signed amount in base currency (+ money in, − money out); null when unknown. */
  amount: string | null;
  /** Original amount and currency, for display. */
  nativeAmount: string | null;
  currency: string | null;
  status: "overdue" | "due" | "upcoming" | "past";
  recurringId: string | null;
  accountId: string | null;
  goalId: string | null;
};

export type CalendarDay = { date: ISODate; inMonth: boolean; isToday: boolean; isFuture: boolean; income: string; spending: string; count: number };

export type CalendarMonth = {
  month: string;
  monthRange: DateRange;
  grid: DateRange;
  today: ISODate;
  currency: string;
  weekStartsOn: 0 | 1;
  days: CalendarDay[];
  transactions: Record<ISODate, DayTxn[]>;
  scheduled: CalendarItem[];
  /** Projected end-of-day balance (forecast) for today and future days in the grid. */
  projected: Record<ISODate, string> | null;
  totals: { income: string; spending: string; scheduledIn: string; scheduledOut: string };
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function dayInMonth(year: number, monthIndex: number, day: number): ISODate {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  return toISO(new Date(year, monthIndex, Math.min(day, last)));
}

export async function calendarMonth(userId: string, month: string): Promise<CalendarMonth> {
  if (!MONTH_RE.test(month)) throw new AppError("VALIDATION", "Choose a month as YYYY-MM.");
  const prefs = await getPreferences(userId);
  const first = `${month}-01`;
  const d0 = toDate(first);
  const monthR: DateRange = { from: first, to: toISO(new Date(d0.getFullYear(), d0.getMonth() + 1, 0)) };
  const grid: DateRange = { from: weekRange(monthR.from, prefs.weekStartsOn).from, to: weekRange(monthR.to, prefs.weekStartsOn).to };
  const today = prefs.today;

  const [daily, occ, accounts, rates, goalRows] = await Promise.all([
    grid.from <= today ? dailyBreakdown(userId, grid, { maxDays: 42, txLimit: 3000 }) : Promise.resolve(null),
    grid.to >= today ? upcomingOccurrences(userId, grid.from, grid.to) : Promise.resolve([]),
    listAccounts(userId),
    rateMap(userId, prefs.currency),
    db.select().from(goals).where(and(eq(goals.userId, userId), eq(goals.status, "active"))),
  ]);

  const scheduled: CalendarItem[] = [];
  for (const o of occ) {
    if (o.date < grid.from || o.date > grid.to) continue;
    const signed = o.baseAmount === null ? null : o.kind === "income" ? o.baseAmount : o.kind === "transfer" ? null : neg(o.baseAmount);
    scheduled.push({
      id: `r:${o.recurringId}:${o.date}`,
      date: o.date,
      kind: o.kind,
      name: o.name,
      amount: signed,
      nativeAmount: o.amount,
      currency: o.currency,
      status: o.status,
      recurringId: o.recurringId,
      accountId: o.accountId,
      goalId: null,
    });
  }

  // Credit-card and loan due days.
  for (const a of accounts) {
    if (!a.dueDay || !isLiabilityType(a.type)) continue;
    const owed = isNegative(a.balance) ? neg(a.balance) : null;
    let nextMarked = false;
    for (const ref of [grid.from, monthR.from, grid.to]) {
      const r = toDate(ref);
      const date = dayInMonth(r.getFullYear(), r.getMonth(), a.dueDay);
      if (date < grid.from || date > grid.to || scheduled.some((s) => s.id === `a:${a.id}:${date}`)) continue;
      const upcoming = date >= today;
      const amount = upcoming && !nextMarked && owed ? (a.type === "loan" && a.minimumPayment ? normalize(a.minimumPayment) : owed) : null;
      if (amount) nextMarked = true;
      const base = amount ? convert(amount, a.currency, rates) : null;
      scheduled.push({
        id: `a:${a.id}:${date}`,
        date,
        kind: a.type === "credit_card" ? "card_due" : "loan_due",
        name: `${a.name} due`,
        amount: base ? neg(base) : null,
        nativeAmount: amount,
        currency: a.currency,
        status: date < today ? "past" : date === today ? "due" : "upcoming",
        recurringId: null,
        accountId: a.id,
        goalId: null,
      });
    }
  }

  // Goal deadlines and planned contributions (anchored on the goal's start date).
  for (const g of goalRows) {
    if (g.deadline && g.deadline >= grid.from && g.deadline <= grid.to)
      scheduled.push({ id: `gd:${g.id}`, date: g.deadline, kind: "goal_deadline", name: `${g.name} target date`, amount: null, nativeAmount: g.targetAmount, currency: g.currency, status: g.deadline < today ? "past" : g.deadline === today ? "due" : "upcoming", recurringId: null, accountId: null, goalId: g.id });
    if (g.contributionFrequency && g.targetContribution) {
      const start = toISO(g.createdAt);
      const from = grid.from > today ? grid.from : today;
      const dates = occurrencesBetween({ frequency: g.contributionFrequency, interval: 1, intervalUnit: "month", startDate: start, endDate: g.deadline }, from, grid.to, 62);
      const base = convert(g.targetContribution, g.currency, rates);
      for (const date of dates)
        scheduled.push({ id: `gc:${g.id}:${date}`, date, kind: "goal_contribution", name: `${g.name} contribution`, amount: base ? neg(base) : null, nativeAmount: normalize(g.targetContribution), currency: g.currency, status: date === today ? "due" : "upcoming", recurringId: null, accountId: g.linkedAccountId, goalId: g.id });
    }
  }
  scheduled.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.name.localeCompare(y.name)));

  let projected: Record<ISODate, string> | null = null;
  if (grid.to >= today) {
    const horizon = Math.min(120, Math.max(7, daysBetween(today, grid.to)));
    const f = await cashFlowForecast(userId, horizon);
    projected = {};
    for (const p of f.points) if (p.date >= grid.from && p.date <= grid.to) projected[p.date] = p.balance;
  }

  const byDay = new Map((daily?.days ?? []).map((d) => [d.date, d]));
  const transactions: Record<ISODate, DayTxn[]> = {};
  const days: CalendarDay[] = [];
  let income = "0";
  let spending = "0";
  for (let d = grid.from; d <= grid.to; d = addDaysISO(d, 1)) {
    const a = byDay.get(d);
    const inMonth = d >= monthR.from && d <= monthR.to;
    if (a?.transactions.length) transactions[d] = a.transactions;
    if (inMonth && a) {
      income = add(income, a.income);
      spending = add(spending, a.spending);
    }
    days.push({ date: d, inMonth, isToday: d === today, isFuture: d > today, income: a?.income ?? "0.0000", spending: a?.spending ?? "0.0000", count: a?.count ?? 0 });
  }
  const inMonthItems = scheduled.filter((s) => s.date >= monthR.from && s.date <= minISO(monthR.to, grid.to) && s.amount);
  return {
    month,
    monthRange: monthR,
    grid,
    today,
    currency: prefs.currency,
    weekStartsOn: prefs.weekStartsOn,
    days,
    transactions,
    scheduled,
    projected,
    totals: {
      income: normalize(income),
      spending: normalize(spending),
      scheduledIn: sumWhere(inMonthItems, (v) => !isNegative(v)),
      scheduledOut: neg(sumWhere(inMonthItems, (v) => isNegative(v))),
    },
  };
}

function sumWhere(items: CalendarItem[], pred: (v: string) => boolean) {
  return add(...items.filter((i) => i.amount && pred(i.amount)).map((i) => i.amount));
}
