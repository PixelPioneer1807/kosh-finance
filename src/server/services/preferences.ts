import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/server/db";
import { exchangeRates, notificationPreferences, userPreferences, users, type DashboardWidget } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { todayIn } from "@/lib/dates";
import { mul } from "@/lib/money";

export const DASHBOARD_WIDGETS: { id: string; label: string; description: string }[] = [
  { id: "snapshot", label: "Monthly snapshot", description: "Income, spending, savings and savings rate" },
  { id: "safe_to_spend", label: "Safe to spend", description: "What's left after upcoming bills and goals" },
  { id: "insights", label: "Insights", description: "Facts and trends computed from your data" },
  { id: "budgets", label: "Budgets", description: "Progress on your active budgets" },
  { id: "spending_trend", label: "Spending trend", description: "Cumulative spending this month vs last" },
  { id: "categories", label: "Top categories", description: "Where your money went" },
  { id: "upcoming", label: "Upcoming", description: "Bills, subscriptions and income due soon" },
  { id: "recent", label: "Recent transactions", description: "Your latest activity" },
  { id: "accounts", label: "Accounts", description: "Balances across your accounts" },
  { id: "goals", label: "Goals", description: "Savings goal progress" },
  { id: "net_worth", label: "Net worth", description: "Assets minus liabilities over time" },
];

export const DEFAULT_WIDGETS: DashboardWidget[] = DASHBOARD_WIDGETS.map((w) => ({ id: w.id, visible: true }));

export type Prefs = Awaited<ReturnType<typeof getPreferences>>;

export async function getPreferences(userId: string, dbx: DbOrTx = db) {
  let [prefs] = await dbx.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  if (!prefs) {
    [prefs] = await dbx.insert(userPreferences).values({ userId }).onConflictDoNothing().returning();
    if (!prefs) [prefs] = await dbx.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  }
  const known = new Set(DASHBOARD_WIDGETS.map((w) => w.id));
  const saved = (prefs.dashboardWidgets ?? []).filter((w) => known.has(w.id));
  const missing = DEFAULT_WIDGETS.filter((d) => !saved.some((s) => s.id === d.id));
  return {
    ...prefs,
    weekStartsOn: (prefs.weekStartsOn === 0 ? 0 : 1) as 0 | 1,
    dashboardWidgets: [...saved, ...missing],
    today: todayIn(prefs.timezone),
  };
}

export async function getNotificationPreferences(userId: string) {
  const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).limit(1);
  if (row) return row;
  const [created] = await db.insert(notificationPreferences).values({ userId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)))[0];
}

export async function updatePreferences(userId: string, patch: Partial<typeof userPreferences.$inferInsert>) {
  delete (patch as Record<string, unknown>).userId;
  await getPreferences(userId);
  await db.update(userPreferences).set(patch).where(eq(userPreferences.userId, userId));
}

export async function updateNotificationPreferences(userId: string, patch: Partial<typeof notificationPreferences.$inferInsert>) {
  delete (patch as Record<string, unknown>).userId;
  await getNotificationPreferences(userId);
  await db.update(notificationPreferences).set(patch).where(eq(notificationPreferences.userId, userId));
}

export async function updateProfile(userId: string, patch: { name?: string | null }) {
  await db.update(users).set(patch).where(eq(users.id, userId));
}

/* ───────────── Exchange rates ───────────── */

export async function listExchangeRates(userId: string) {
  return db.select().from(exchangeRates).where(eq(exchangeRates.userId, userId)).orderBy(exchangeRates.currency);
}

export async function upsertExchangeRate(userId: string, currency: string, rate: string) {
  await db
    .insert(exchangeRates)
    .values({ userId, currency, rate })
    .onConflictDoUpdate({ target: [exchangeRates.userId, exchangeRates.currency], set: { rate, updatedAt: new Date() } });
}

export async function deleteExchangeRate(userId: string, currency: string) {
  await db.delete(exchangeRates).where(and(eq(exchangeRates.userId, userId), eq(exchangeRates.currency, currency)));
}

/** Rate converting 1 unit of `currency` into the user's base currency. */
export async function getRate(userId: string, currency: string, baseCurrency: string, dbx: DbOrTx = db): Promise<string | null> {
  if (currency === baseCurrency) return "1";
  const [row] = await dbx
    .select({ rate: exchangeRates.rate })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.userId, userId), eq(exchangeRates.currency, currency)))
    .limit(1);
  return row?.rate ?? null;
}

export async function requireRate(userId: string, currency: string, baseCurrency: string, dbx: DbOrTx = db) {
  const r = await getRate(userId, currency, baseCurrency, dbx);
  if (!r)
    throw new AppError(
      "VALIDATION",
      `Add an exchange rate for ${currency} → ${baseCurrency} in Settings → Currencies first.`,
      { fxRate: ["Missing exchange rate"] },
    );
  return r;
}

/** Map of currency → rate-to-base for converting balances. */
export async function rateMap(userId: string, baseCurrency: string) {
  const rows = await listExchangeRates(userId);
  const m = new Map<string, string>(rows.map((r) => [r.currency, r.rate]));
  m.set(baseCurrency, "1");
  return m;
}

export function convert(amount: string, currency: string, rates: Map<string, string>): string | null {
  const r = rates.get(currency);
  return r ? mul(amount, r) : null;
}

/**
 * Changing base currency re-derives every stored base_amount from the user's rates.
 * Runs in one transaction so analytics are never half-converted.
 *
 * Settings engineer fixes (2026-10): rates are divided at full 10-dp precision (divRate used to
 * round its inputs to 4 dp), a stray rate row for the old base currency no longer causes a PK
 * clash, split base amounts are re-balanced so they still add up exactly to their transaction,
 * existing rates are never left expressed against the old base, and budgets / expected income
 * held in the old base currency are converted too.
 */
export async function changeBaseCurrency(userId: string, newCurrency: string) {
  const prefs = await getPreferences(userId);
  if (prefs.currency === newCurrency) return;
  const rates = await rateMap(userId, prefs.currency);
  const newRate = rates.get(newCurrency);
  const { sql } = await import("drizzle-orm");
  const used = await db.execute<{ currency: string }>(sql`
    SELECT DISTINCT currency FROM transactions WHERE user_id = ${userId}
    UNION SELECT DISTINCT currency FROM accounts WHERE user_id = ${userId}`);
  const hasData = used.length > 0 || rates.size > 1;
  if (hasData && !newRate)
    throw new AppError("VALIDATION", `To switch to ${newCurrency}, first add an exchange rate for ${newCurrency} in Settings → Currencies.`);
  await db.transaction(async (tx) => {
    if (newRate) {
      // new_rate_X = old_rate_X / old_rate_new
      const all = await tx.select().from(exchangeRates).where(eq(exchangeRates.userId, userId));
      await tx.delete(exchangeRates).where(eq(exchangeRates.userId, userId));
      const next = [...all.filter((r) => r.currency !== newCurrency && r.currency !== prefs.currency), { currency: prefs.currency, rate: "1" }]
        .map((r) => ({ userId, currency: r.currency, rate: divRate(r.rate, newRate) }));
      if (next.length) await tx.insert(exchangeRates).values(next);
      // Keep each transaction's historical rate, re-expressed against the new base:
      // rate_new = rate_old / (value of 1 new-base unit in old base).
      await tx.execute(sql`
        UPDATE transactions SET
          fx_rate = CASE WHEN currency = ${newCurrency} THEN 1 ELSE round(fx_rate / ${newRate}::numeric, 10) END,
          base_amount = round(amount * CASE WHEN currency = ${newCurrency} THEN 1 ELSE round(fx_rate / ${newRate}::numeric, 10) END, 4)
        WHERE user_id = ${userId}`);
      await tx.execute(sql`
        UPDATE transaction_splits s SET base_amount = round(s.amount * t.fx_rate, 4)
        FROM transactions t WHERE s.transaction_id = t.id AND s.user_id = ${userId} AND t.user_id = ${userId}`);
      // Put any rounding remainder on the last split so splits add up exactly to the transaction.
      await tx.execute(sql`
        UPDATE transaction_splits s SET base_amount = s.base_amount + d.drift
        FROM (
          SELECT t.id AS txn_id, t.base_amount - sum(x.base_amount) AS drift,
                 (array_agg(x.id ORDER BY x.sort_order DESC, x.id DESC))[1] AS last_id
          FROM transactions t JOIN transaction_splits x ON x.transaction_id = t.id
          WHERE t.user_id = ${userId} AND x.user_id = ${userId}
          GROUP BY t.id, t.base_amount
        ) d
        WHERE s.id = d.last_id AND d.drift <> 0`);
      // Amounts the user entered in the old base currency.
      await tx.execute(sql`
        UPDATE budgets SET amount = GREATEST(round(amount / ${newRate}::numeric, 4), 0.0001), currency = ${newCurrency}
        WHERE user_id = ${userId} AND currency = ${prefs.currency}`);
      await tx.execute(sql`
        UPDATE user_preferences SET expected_monthly_income = round(expected_monthly_income / ${newRate}::numeric, 4)
        WHERE user_id = ${userId} AND expected_monthly_income IS NOT NULL`);
    }
    await tx.update(userPreferences).set({ currency: newCurrency }).where(eq(userPreferences.userId, userId));
  });
}

/** a ÷ b for rates, exact to 10 dp (rounded half-up), via BigInt. */
export function divRate(a: string, b: string): string {
  const SCALE = 10;
  const toBig = (s: string) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
    if (!m) throw new AppError("VALIDATION", `Invalid rate: ${s}`);
    const frac = (m[2] ?? "").padEnd(SCALE, "0").slice(0, SCALE);
    return BigInt(m[1] + frac);
  };
  const scale = BigInt(10) ** BigInt(SCALE);
  const num = toBig(a) * scale;
  const den = toBig(b);
  if (den === BigInt(0)) throw new AppError("VALIDATION", "Rate can't be zero");
  let q = num / den;
  if ((num % den) * BigInt(2) >= den) q += BigInt(1);
  const str = q.toString().padStart(SCALE + 1, "0");
  return `${str.slice(0, -SCALE)}.${str.slice(-SCALE)}`;
}
