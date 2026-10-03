/**
 * Net worth = assets − liabilities, in the user's base currency.
 *
 * Decisions
 * - Only accounts with `include_in_net_worth` count.
 * - Archived accounts still count: archiving hides an account from day-to-day lists, but money
 *   it still holds (or still owes) is real. An archived account with a zero balance contributes
 *   nothing and is omitted from the account list.
 * - Assets are non-liability accounts at their signed balance (an overdrawn bank account reduces
 *   assets rather than becoming a liability). Liabilities are credit cards and loans; owed = −balance
 *   (a card in credit therefore reduces liabilities).
 * - Conversion uses the user's *current* exchange rates (Settings → Currencies), also for history.
 *   Accounts whose currency has no rate are reported as `unconverted` and excluded from totals —
 *   never silently dropped.
 * - History is recomputed from the ledger (opening balance + transactions up to each date) so
 *   back-dated entries land in the right month. An account only counts from the earliest of its
 *   opening date (or creation date) and its first transaction.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { accounts, financialSnapshots } from "@/server/db/schema";
import { add, cmp, isZero, neg, normalize, sub } from "@/lib/money";
import { addMonthsISO, toDate, toISO, type ISODate } from "@/lib/dates";
import { endOfMonth } from "date-fns";
import { ACCOUNT_TYPES, accountBalances, isLiabilityType, type AccountTypeId } from "./accounts";
import { convert, getPreferences, rateMap } from "./preferences";

export type NetWorthAccount = {
  id: string;
  name: string;
  type: AccountTypeId;
  typeLabel: string;
  /** Icon name from components/app/icons (the account's own icon, else the type's). */
  icon: string;
  institution: string | null;
  color: string | null;
  currency: string;
  /** Signed ledger balance in the account's currency (liabilities are negative). */
  balance: string;
  /** Liabilities: amount owed (positive) in the account's currency; assets: null. */
  owed: string | null;
  /** Signed balance in base currency; null when no exchange rate exists. */
  baseBalance: string | null;
  liability: boolean;
  isArchived: boolean;
};

export type NetWorthBreakdown = {
  type: AccountTypeId;
  label: string;
  icon: string;
  liability: boolean;
  /** Assets: Σ balances. Liabilities: Σ owed. Base currency. */
  total: string;
  count: number;
};

export type NetWorthSummary = {
  currency: string;
  asOf: ISODate;
  assets: string;
  liabilities: string;
  netWorth: string;
  breakdown: NetWorthBreakdown[];
  accounts: NetWorthAccount[];
  /** Accounts left out of the totals because their currency has no exchange rate. */
  unconverted: { accountId: string; name: string; currency: string; balance: string }[];
  /** Accounts the user excluded from net worth (shown for transparency, never totalled). */
  excludedCount: number;
};

const TYPE_META = new Map(ACCOUNT_TYPES.map((t) => [t.id as string, t]));

type AccountRow = typeof accounts.$inferSelect;

function totals(rows: AccountRow[], balances: Map<string, string>, rates: Map<string, string>) {
  let assets = "0";
  let liabilities = "0";
  const unconverted: NetWorthSummary["unconverted"] = [];
  const perAccount = new Map<string, string | null>();
  for (const a of rows) {
    const balance = balances.get(a.id) ?? normalize(a.openingBalance);
    const base = convert(balance, a.currency, rates);
    perAccount.set(a.id, base);
    if (base === null) {
      if (!isZero(balance)) unconverted.push({ accountId: a.id, name: a.name, currency: a.currency, balance });
      continue;
    }
    if (isLiabilityType(a.type)) liabilities = add(liabilities, neg(base));
    else assets = add(assets, base);
  }
  return { assets, liabilities, netWorth: sub(assets, liabilities), unconverted, perAccount };
}

async function netWorthAccounts(userId: string) {
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.includeInNetWorth, true)))
    .orderBy(accounts.sortOrder, accounts.createdAt);
}

export async function netWorthSummary(userId: string): Promise<NetWorthSummary> {
  const prefs = await getPreferences(userId);
  const [rows, balances, rates, [{ excluded }]] = await Promise.all([
    netWorthAccounts(userId),
    accountBalances(userId),
    rateMap(userId, prefs.currency),
    db
      .select({ excluded: sql<number>`count(*)::int` })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.includeInNetWorth, false), eq(accounts.isArchived, false))),
  ]);
  const t = totals(rows, balances, rates);

  const list: NetWorthAccount[] = [];
  const byType = new Map<string, NetWorthBreakdown>();
  for (const a of rows) {
    const balance = balances.get(a.id) ?? normalize(a.openingBalance);
    if (a.isArchived && isZero(balance)) continue;
    const liability = isLiabilityType(a.type);
    const base = t.perAccount.get(a.id) ?? null;
    const meta = TYPE_META.get(a.type)!;
    list.push({
      id: a.id,
      name: a.name,
      type: a.type,
      typeLabel: meta.label,
      icon: a.icon ?? meta.icon,
      institution: a.institution,
      color: a.color,
      currency: a.currency,
      balance,
      owed: liability ? neg(balance) : null,
      baseBalance: base,
      liability,
      isArchived: a.isArchived,
    });
    if (base === null) continue;
    const b = byType.get(a.type) ?? { type: a.type, label: meta.label, icon: meta.icon, liability, total: "0.0000", count: 0 };
    b.total = add(b.total, liability ? neg(base) : base);
    b.count++;
    byType.set(a.type, b);
  }
  const breakdown = [...byType.values()].sort((x, y) => (x.liability === y.liability ? cmp(y.total, x.total) : x.liability ? 1 : -1));

  return {
    currency: prefs.currency,
    asOf: prefs.today,
    assets: t.assets,
    liabilities: t.liabilities,
    netWorth: t.netWorth,
    breakdown,
    accounts: list,
    unconverted: t.unconverted,
    excludedCount: excluded,
  };
}

export type NetWorthPoint = { date: ISODate; assets: string; liabilities: string; netWorth: string };

export type NetWorthHistory = {
  currency: string;
  /** Month-end points oldest → newest, ending with today. */
  points: NetWorthPoint[];
  /** Comparisons for the hero: exact dates one month and twelve months before today. */
  changes: {
    month: { date: ISODate; netWorth: string; delta: string } | null;
    year: { date: ISODate; netWorth: string; delta: string } | null;
  };
  /** Currencies left out of every point (no exchange rate). */
  unconvertedCurrencies: string[];
  /** False when the user has no net-worth accounts at all. */
  hasData: boolean;
};

/** Balance-sheet totals as of each date, from the ledger. */
async function netWorthAt(userId: string, dates: ISODate[], timezone: string, baseCurrency: string) {
  const [rows, rates, starts] = await Promise.all([
    netWorthAccounts(userId),
    rateMap(userId, baseCurrency),
    db.execute<{ id: string; since: string }>(sql`
      SELECT a.id,
             LEAST(COALESCE(a.opening_date, (a.created_at AT TIME ZONE ${timezone})::date),
                   (SELECT min(t.date) FROM transactions t
                     WHERE t.user_id = ${userId} AND t.deleted_at IS NULL
                       AND (t.account_id = a.id OR t.to_account_id = a.id)))::text AS since
        FROM accounts a
       WHERE a.user_id = ${userId} AND a.include_in_net_worth`),
  ]);
  const since = new Map(starts.map((s) => [s.id, s.since]));
  const unconverted = new Set<string>();
  const out: NetWorthPoint[] = [];
  const allBalances = await Promise.all(dates.map((d) => accountBalances(userId, d)));
  for (const [i, date] of dates.entries()) {
    const balances = allBalances[i];
    const live = rows.filter((a) => (since.get(a.id) ?? date) <= date);
    const t = totals(live, balances, rates);
    t.unconverted.forEach((u) => unconverted.add(u.currency));
    out.push({ date, assets: t.assets, liabilities: t.liabilities, netWorth: t.netWorth });
  }
  return { points: out, unconverted: [...unconverted], anyAccount: rows.length > 0 };
}

export async function netWorthHistory(userId: string, months = 12): Promise<NetWorthHistory> {
  const prefs = await getPreferences(userId);
  const today = prefs.today;
  const n = Math.max(1, Math.min(120, Math.trunc(months)));
  const dates: ISODate[] = [];
  for (let i = n; i >= 1; i--) dates.push(toISO(endOfMonth(toDate(addMonthsISO(today, -i)))));
  dates.push(today);
  const monthAgo = addMonthsISO(today, -1);
  const yearAgo = addMonthsISO(today, -12);
  const { points, unconverted, anyAccount } = await netWorthAt(userId, [...dates, monthAgo, yearAgo], prefs.timezone, prefs.currency);
  const series = points.slice(0, dates.length);
  const now = series[series.length - 1];
  const [m, y] = points.slice(dates.length);
  const cmpTo = (p: NetWorthPoint) => ({ date: p.date, netWorth: p.netWorth, delta: sub(now.netWorth, p.netWorth) });
  return {
    currency: prefs.currency,
    points: series,
    changes: { month: anyAccount ? cmpTo(m) : null, year: anyAccount ? cmpTo(y) : null },
    unconvertedCurrencies: unconverted,
    hasData: anyAccount,
  };
}

/** Upserts today's snapshot (for the daily cron). */
export async function recordSnapshot(userId: string) {
  const s = await netWorthSummary(userId);
  const values = { userId, date: s.asOf, currency: s.currency, assets: s.assets, liabilities: s.liabilities, netWorth: s.netWorth };
  const [row] = await db
    .insert(financialSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [financialSnapshots.userId, financialSnapshots.date],
      set: { currency: values.currency, assets: values.assets, liabilities: values.liabilities, netWorth: values.netWorth },
    })
    .returning();
  return row;
}
