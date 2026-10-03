/**
 * Calendar-date helpers. Financial dates are plain "YYYY-MM-DD" strings in the user's timezone.
 * All arithmetic goes through date-fns on local-midnight Date objects created from those strings,
 * then is formatted back, so results do not depend on the server's timezone.
 */
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";

export type ISODate = string; // YYYY-MM-DD

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string" || !ISO_RE.test(s)) return false;
  return isValid(parse(s, "yyyy-MM-dd", new Date()));
}

export function toDate(iso: ISODate): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(d: Date): ISODate {
  return format(d, "yyyy-MM-dd");
}

/** Today's date in an IANA timezone. */
export function todayIn(timezone: string, now: Date = new Date()): ISODate {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Current local time "HH:MM" in an IANA timezone. */
export function timeIn(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  } catch {
    return now.toISOString().slice(11, 16);
  }
}

export const addDaysISO = (iso: ISODate, n: number) => toISO(addDays(toDate(iso), n));
export const addMonthsISO = (iso: ISODate, n: number) => toISO(addMonths(toDate(iso), n));
export const daysBetween = (from: ISODate, to: ISODate) => differenceInCalendarDays(toDate(to), toDate(from));
export const compareISO = (a: ISODate, b: ISODate) => (a < b ? -1 : a > b ? 1 : 0);
export const minISO = (a: ISODate, b: ISODate) => (a <= b ? a : b);
export const maxISO = (a: ISODate, b: ISODate) => (a >= b ? a : b);

export type DateRange = { from: ISODate; to: ISODate };

/** Month window that starts on `startDay` (1-28), e.g. payday-to-payday budgeting. */
export function monthRange(ref: ISODate, startDay = 1): DateRange {
  const d = toDate(ref);
  if (startDay <= 1) return { from: toISO(startOfMonth(d)), to: toISO(endOfMonth(d)) };
  let start = new Date(d.getFullYear(), d.getMonth(), startDay);
  if (d < start) start = subMonths(start, 1);
  const end = subDays(addMonths(start, 1), 1);
  return { from: toISO(start), to: toISO(end) };
}

export function weekRange(ref: ISODate, weekStartsOn: 0 | 1 = 1): DateRange {
  const d = toDate(ref);
  return { from: toISO(startOfWeek(d, { weekStartsOn })), to: toISO(endOfWeek(d, { weekStartsOn })) };
}

export function yearRange(ref: ISODate): DateRange {
  const d = toDate(ref);
  return { from: toISO(startOfYear(d)), to: toISO(endOfYear(d)) };
}

export function previousRange(r: DateRange): DateRange {
  const len = daysBetween(r.from, r.to);
  const to = addDaysISO(r.from, -1);
  return { from: addDaysISO(to, -len), to };
}

/** Same-shaped previous calendar period: for a full month, the previous full month. */
export function previousPeriod(r: DateRange, startDay = 1): DateRange {
  const m = monthRange(r.from, startDay);
  if (m.from === r.from && m.to === r.to) return monthRange(addDaysISO(r.from, -1), startDay);
  return previousRange(r);
}

export const RANGE_PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "last_30", label: "Last 30 days" },
  { id: "last_90", label: "Last 90 days" },
  { id: "this_year", label: "This year" },
  { id: "last_year", label: "Last year" },
  { id: "last_12_months", label: "Last 12 months" },
  { id: "all", label: "All time" },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["id"] | "custom";

export function resolveRange(
  preset: string | undefined,
  today: ISODate,
  opts: { weekStartsOn?: 0 | 1; monthStartDay?: number; from?: string; to?: string } = {},
): DateRange & { preset: RangePreset } {
  const ws = opts.weekStartsOn ?? 1;
  const ms = opts.monthStartDay ?? 1;
  switch (preset) {
    case "today":
      return { from: today, to: today, preset };
    case "yesterday": {
      const y = addDaysISO(today, -1);
      return { from: y, to: y, preset };
    }
    case "this_week":
      return { ...weekRange(today, ws), preset };
    case "last_week":
      return { ...weekRange(addDaysISO(today, -7), ws), preset };
    case "last_month":
      return { ...monthRange(addDaysISO(monthRange(today, ms).from, -1), ms), preset };
    case "last_30":
      return { from: addDaysISO(today, -29), to: today, preset };
    case "last_90":
      return { from: addDaysISO(today, -89), to: today, preset };
    case "this_year":
      return { ...yearRange(today), preset };
    case "last_year":
      return { ...yearRange(toISO(addYears(toDate(today), -1))), preset };
    case "last_12_months":
      return { from: toISO(addDays(addMonths(toDate(today), -12), 1)), to: today, preset };
    case "all":
      return { from: "1970-01-01", to: "2999-12-31", preset };
    case "custom":
      if (isISODate(opts.from) && isISODate(opts.to) && opts.from <= opts.to)
        return { from: opts.from, to: opts.to, preset: "custom" };
      return { ...monthRange(today, ms), preset: "this_month" };
    case "this_month":
    default:
      return { ...monthRange(today, ms), preset: "this_month" };
  }
}

/** Every date in a range (inclusive). Guarded against huge ranges. */
export function eachDay(r: DateRange, limit = 1200): ISODate[] {
  const out: ISODate[] = [];
  let d = r.from;
  while (d <= r.to && out.length < limit) {
    out.push(d);
    d = addDaysISO(d, 1);
  }
  return out;
}

export function formatDate(iso: ISODate, pattern = "d MMM yyyy"): string {
  if (!isISODate(iso)) return iso;
  return format(toDate(iso), pattern);
}

export function relativeDayLabel(iso: ISODate, today: ISODate): string {
  const diff = daysBetween(today, iso);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return format(toDate(iso), "EEEE");
  return formatDate(iso, toDate(iso).getFullYear() === toDate(today).getFullYear() ? "EEE, d MMM" : "d MMM yyyy");
}

export { addWeeks, addMonths, addYears };
