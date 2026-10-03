/**
 * Recurrence engine shared by recurring transactions, bills, subscriptions, income schedules
 * and goal contribution plans.
 *
 * Occurrence n is always computed from the start date (start + n × step), never by repeatedly
 * adding to the previous date, so month-end anchors don't drift (Jan 31 → Feb 28 → Mar 31).
 */
import { addDays, addMonths, addWeeks, addYears } from "date-fns";
import { type ISODate, toDate, toISO, daysBetween } from "./dates";

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "custom";
export type Unit = "day" | "week" | "month" | "year";

export type Rule = {
  frequency: Frequency;
  interval?: number | null;
  intervalUnit?: Unit | null;
  startDate: ISODate;
  endDate?: ISODate | null;
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  custom: "Custom",
};

export function step(rule: Pick<Rule, "frequency" | "interval" | "intervalUnit">): { unit: Unit; count: number } {
  switch (rule.frequency) {
    case "daily":
      return { unit: "day", count: 1 };
    case "weekly":
      return { unit: "week", count: 1 };
    case "biweekly":
      return { unit: "week", count: 2 };
    case "monthly":
      return { unit: "month", count: 1 };
    case "quarterly":
      return { unit: "month", count: 3 };
    case "yearly":
      return { unit: "year", count: 1 };
    case "custom":
      return { unit: rule.intervalUnit ?? "month", count: Math.max(1, rule.interval ?? 1) };
  }
}

export function describeRule(rule: Pick<Rule, "frequency" | "interval" | "intervalUnit">): string {
  if (rule.frequency !== "custom") return FREQUENCY_LABELS[rule.frequency];
  const { unit, count } = step(rule);
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

function nth(rule: Rule, n: number): ISODate {
  const { unit, count } = step(rule);
  const start = toDate(rule.startDate);
  const k = n * count;
  const d =
    unit === "day" ? addDays(start, k) : unit === "week" ? addWeeks(start, k) : unit === "month" ? addMonths(start, k) : addYears(start, k);
  return toISO(d);
}

/** Rough lower bound on n for the first occurrence on/after `date`, to avoid iterating from 0. */
function estimateIndex(rule: Rule, date: ISODate): number {
  const days = daysBetween(rule.startDate, date);
  if (days <= 0) return 0;
  const { unit, count } = step(rule);
  const unitDays = unit === "day" ? 1 : unit === "week" ? 7 : unit === "month" ? 31 : 366;
  return Math.max(0, Math.floor(days / (unitDays * count)) - 1);
}

/** First occurrence on or after `date` (inclusive), or null if the rule has ended. */
export function nextOnOrAfter(rule: Rule, date: ISODate): ISODate | null {
  let n = estimateIndex(rule, date);
  for (let guard = 0; guard < 10_000; guard++, n++) {
    const occ = nth(rule, n);
    if (rule.endDate && occ > rule.endDate) return null;
    if (occ >= date) return occ;
  }
  return null;
}

/** First occurrence strictly after `date`. */
export function nextAfter(rule: Rule, date: ISODate): ISODate | null {
  return nextOnOrAfter(rule, toISO(addDays(toDate(date), 1)));
}

/** All occurrences within [from, to] inclusive. */
export function occurrencesBetween(rule: Rule, from: ISODate, to: ISODate, limit = 1000): ISODate[] {
  const out: ISODate[] = [];
  let n = estimateIndex(rule, from);
  for (let guard = 0; guard < 20_000 && out.length < limit; guard++, n++) {
    const occ = nth(rule, n);
    if (occ > to || (rule.endDate && occ > rule.endDate)) break;
    if (occ >= from) out.push(occ);
  }
  return out;
}

/**
 * Average number of occurrences per month — used to normalise subscription cost
 * to monthly/yearly figures. Expressed as a rational (numerator/denominator) so callers can keep
 * money exact: monthlyCost = amount × num / den.
 */
export function perMonthFactor(rule: Pick<Rule, "frequency" | "interval" | "intervalUnit">): { num: number; den: number } {
  const { unit, count } = step(rule);
  switch (unit) {
    case "day":
      // 365.25 days / 12 months = 30.4375 days per month
      return { num: 1461, den: 48 * count };
    case "week":
      // 52.1775 weeks / 12
      return { num: 521775, den: 120000 * count };
    case "month":
      return { num: 1, den: count };
    case "year":
      return { num: 1, den: 12 * count };
  }
}
