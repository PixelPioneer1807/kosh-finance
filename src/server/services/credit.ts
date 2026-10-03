/**
 * Credit-card health: utilisation, upcoming due dates, statement amounts and warnings.
 *
 * - owed = −balance (a card in credit has owed 0 and a `creditBalance`).
 * - Utilisation thresholds: ≥30% warning, ≥70% serious, > limit "over limit" (serious).
 * - Next due date = the next `due_day` on/after today in the user's timezone (clamped to the month's
 *   length, e.g. day 31 → 30 Apr). Same for statement dates.
 * - Statement amount (when a statement day is set): owed at the last statement close, minus money
 *   credited to the card since (payments, refunds). This is what's due; minimum payment is the
 *   user-entered figure.
 */
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { getDaysInMonth } from "date-fns";
import { db } from "@/server/db";
import { accounts, transactions } from "@/server/db/schema";
import { add, cmp, isNegative, isPositive, min, neg, normalize, ratio, sub, formatMoney, toUnits } from "@/lib/money";
import { addMonthsISO, daysBetween, formatDate, toDate, toISO, type ISODate } from "@/lib/dates";
import { accountBalances } from "./accounts";
import { convert, getNotificationPreferences, getPreferences, rateMap } from "./preferences";
import { notify } from "./notifications";

export type CardWarning = {
  code: "over_limit" | "utilization_serious" | "utilization_warning" | "due_soon" | "due_today";
  level: "warning" | "serious";
  message: string;
};

export type UtilizationStatus = "good" | "warning" | "serious" | "over_limit";

export type CreditCardHealth = {
  id: string;
  name: string;
  institution: string | null;
  color: string | null;
  currency: string;
  isArchived: boolean;
  /** Amount owed (≥ 0). */
  owed: string;
  /** Money held on the card when it's in credit (≥ 0). */
  creditBalance: string;
  limit: string | null;
  available: string | null;
  /** owed ÷ limit; null without a limit. */
  utilization: number | null;
  utilizationStatus: UtilizationStatus | null;
  statementDay: number | null;
  dueDay: number | null;
  lastStatementDate: ISODate | null;
  nextStatementDate: ISODate | null;
  nextDueDate: ISODate | null;
  daysUntilDue: number | null;
  /** Owed at the last statement close (null without a statement day). */
  statementBalance: string | null;
  /** Statement balance minus credits since the statement (what's left to pay). */
  amountDue: string | null;
  minimumPayment: string | null;
  annualFee: string | null;
  interestRate: string | null;
  warnings: CardWarning[];
};

export type CreditHealthSummary = {
  currency: string;
  cards: CreditCardHealth[];
  /** Totals over cards with a limit and a known exchange rate (base currency). */
  overall: { owed: string; limit: string; utilization: number | null; utilizationStatus: UtilizationStatus | null; cardCount: number };
  /** Cards left out of `overall` because their currency has no exchange rate. */
  unconverted: string[];
};

export const DUE_SOON_DAYS = 5;

/** The given day-of-month in the month of `ref`, clamped to that month's length. */
function dayInMonth(ref: ISODate, day: number): ISODate {
  const d = toDate(ref);
  return toISO(new Date(d.getFullYear(), d.getMonth(), Math.min(day, getDaysInMonth(d))));
}

/** Next date on/after `today` falling on `day` (clamped). */
export function nextDayOfMonth(today: ISODate, day: number): ISODate {
  const thisMonth = dayInMonth(today, day);
  return thisMonth >= today ? thisMonth : dayInMonth(addMonthsISO(today.slice(0, 8) + "01", 1), day);
}

/** Most recent date on/before `today` falling on `day` (clamped). */
export function prevDayOfMonth(today: ISODate, day: number): ISODate {
  const thisMonth = dayInMonth(today, day);
  return thisMonth <= today ? thisMonth : dayInMonth(addMonthsISO(today.slice(0, 8) + "01", -1), day);
}

export function utilizationStatus(u: number | null): UtilizationStatus | null {
  if (u === null) return null;
  if (u > 1) return "over_limit";
  if (u >= 0.7) return "serious";
  if (u >= 0.3) return "warning";
  return "good";
}

export async function creditCardHealth(userId: string): Promise<CreditHealthSummary> {
  const prefs = await getPreferences(userId);
  const today = prefs.today;
  const fmt = (v: string, c: string) => formatMoney(v, c, { locale: prefs.locale });
  const [cards, balances, rates] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.type, "credit_card")))
      .orderBy(accounts.sortOrder, accounts.createdAt),
    accountBalances(userId),
    rateMap(userId, prefs.currency),
  ]);

  // Statement balances: one ledger pass per distinct statement date.
  const stmtDates = new Map<string, ISODate>();
  for (const c of cards) if (c.statementDay) stmtDates.set(c.id, prevDayOfMonth(today, c.statementDay));
  const balancesAt = new Map<ISODate, Map<string, string>>();
  for (const d of new Set(stmtDates.values())) balancesAt.set(d, await accountBalances(userId, d));

  // Credits to each card since its last statement (payments arrive as transfers in; refunds/income credit it).
  const credits = new Map<string, string>();
  for (const [cardId, since] of stmtDates) {
    const [r] = await db
      .select({
        total: sql<string>`coalesce(sum(CASE WHEN ${transactions.toAccountId} = ${cardId} THEN ${transactions.toAmount}
                                             WHEN ${transactions.type} IN ('income','refund') THEN ${transactions.amount}
                                             WHEN ${transactions.type} = 'adjustment' AND ${transactions.amount} > 0 THEN ${transactions.amount}
                                             ELSE 0 END), 0)::text`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNull(transactions.deletedAt),
          or(eq(transactions.accountId, cardId), eq(transactions.toAccountId, cardId)),
          gt(transactions.date, since),
          lte(transactions.date, today),
        ),
      );
    credits.set(cardId, normalize(r?.total ?? "0"));
  }

  const out: CreditCardHealth[] = [];
  let totalOwed = "0";
  let totalLimit = "0";
  let counted = 0;
  const unconverted = new Set<string>();

  for (const c of cards) {
    const balance = balances.get(c.id) ?? normalize(c.openingBalance);
    const owed = isNegative(balance) ? neg(balance) : "0.0000";
    if (c.isArchived && !isPositive(owed)) continue;
    const creditBalance = isPositive(balance) ? balance : "0.0000";
    const hasLimit = c.creditLimit !== null && toUnits(c.creditLimit) > BigInt(0);
    const limit = hasLimit ? normalize(c.creditLimit) : null;
    const utilization = limit ? ratio(owed, limit) : null;
    const uStatus = utilizationStatus(utilization);

    const lastStatementDate = stmtDates.get(c.id) ?? null;
    const nextStatementDate = c.statementDay ? nextDayOfMonth(today, c.statementDay) : null;
    let statementBalance: string | null = null;
    let amountDue: string | null = null;
    if (lastStatementDate) {
      const at = balancesAt.get(lastStatementDate)?.get(c.id) ?? "0";
      statementBalance = isNegative(at) ? neg(at) : "0.0000";
      const left = sub(statementBalance, credits.get(c.id) ?? "0");
      amountDue = isPositive(left) ? min(left, owed) : "0.0000";
    }
    const nextDueDate = c.dueDay ? nextDayOfMonth(today, c.dueDay) : null;
    const daysUntilDue = nextDueDate ? daysBetween(today, nextDueDate) : null;
    const toPay = amountDue ?? owed;

    const warnings: CardWarning[] = [];
    if (uStatus === "over_limit") warnings.push({ code: "over_limit", level: "serious", message: `Over the limit by ${fmt(sub(owed, limit!), c.currency)}.` });
    else if (uStatus === "serious")
      warnings.push({ code: "utilization_serious", level: "serious", message: `${Math.round(utilization! * 100)}% of the limit is used — high utilisation can hurt your credit score.` });
    else if (uStatus === "warning")
      warnings.push({ code: "utilization_warning", level: "warning", message: `${Math.round(utilization! * 100)}% of the limit is used — keeping it under 30% is healthier.` });
    if (daysUntilDue !== null && isPositive(toPay)) {
      if (daysUntilDue === 0) warnings.push({ code: "due_today", level: "serious", message: `Payment of ${fmt(toPay, c.currency)} is due today.` });
      else if (daysUntilDue <= DUE_SOON_DAYS)
        warnings.push({ code: "due_soon", level: "warning", message: `Payment of ${fmt(toPay, c.currency)} is due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}.` });
    }

    if (limit) {
      const o = convert(owed, c.currency, rates);
      const l = convert(limit, c.currency, rates);
      if (o !== null && l !== null) {
        totalOwed = add(totalOwed, o);
        totalLimit = add(totalLimit, l);
        counted++;
      } else unconverted.add(c.currency);
    }

    out.push({
      id: c.id,
      name: c.name,
      institution: c.institution,
      color: c.color,
      currency: c.currency,
      isArchived: c.isArchived,
      owed,
      creditBalance,
      limit,
      available: limit ? sub(limit, owed) : null,
      utilization,
      utilizationStatus: uStatus,
      statementDay: c.statementDay,
      dueDay: c.dueDay,
      lastStatementDate,
      nextStatementDate,
      nextDueDate,
      daysUntilDue,
      statementBalance,
      amountDue,
      minimumPayment: c.minimumPayment ? normalize(c.minimumPayment) : null,
      annualFee: c.annualFee ? normalize(c.annualFee) : null,
      interestRate: c.interestRate,
      warnings,
    });
  }

  const overallU = counted ? ratio(totalOwed, totalLimit) : null;
  return {
    currency: prefs.currency,
    cards: out,
    overall: { owed: normalize(totalOwed), limit: normalize(totalLimit), utilization: overallU, utilizationStatus: utilizationStatus(overallU), cardCount: counted },
    unconverted: [...unconverted],
  };
}

/**
 * Payment-due reminders for the daily cron: one per card + due date, sent when the due date is
 * within DUE_SOON_DAYS and something is owed. Respects notification_preferences.credit_card_reminders.
 */
export async function generateCreditCardReminders(userId: string): Promise<number> {
  const np = await getNotificationPreferences(userId);
  if (!np?.creditCardReminders) return 0;
  const prefs = await getPreferences(userId);
  const { cards } = await creditCardHealth(userId);
  let created = 0;
  for (const c of cards) {
    if (!c.nextDueDate || c.daysUntilDue === null || c.daysUntilDue > DUE_SOON_DAYS) continue;
    const toPay = c.amountDue ?? c.owed;
    if (!isPositive(toPay)) continue;
    const fmt = (v: string) => formatMoney(v, c.currency, { locale: prefs.locale });
    const when = c.daysUntilDue === 0 ? "today" : c.daysUntilDue === 1 ? "tomorrow" : `in ${c.daysUntilDue} days`;
    const minimum = c.minimumPayment && isPositive(c.minimumPayment) ? ` Minimum payment: ${fmt(cmp(c.minimumPayment, toPay) > 0 ? toPay : c.minimumPayment)}.` : "";
    const id = await notify(userId, {
      type: "credit_card",
      title: `${c.name} payment due ${when}`,
      body: `${fmt(toPay)} is due on ${formatDate(c.nextDueDate, "EEE, d MMM")}.${minimum}`,
      link: `/net-worth#credit-cards`,
      dedupeKey: `cc:${c.id}:${c.nextDueDate}`,
    });
    if (id) created++;
  }
  return created;
}
