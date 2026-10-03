/**
 * Split-aware spending queries (base currency) shared by the AI tools and insights.
 * Spending = expenses − refunds; transfers and adjustments are excluded, as are categories
 * marked "exclude from reports". Every query is scoped by user_id.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/server/db";
import { add, normalize } from "@/lib/money";
import type { ISODate } from "@/lib/dates";

const SIGNED = sql`CASE WHEN t.type = 'refund' THEN -COALESCE(s.base_amount, t.base_amount) ELSE COALESCE(s.base_amount, t.base_amount) END`;

function joins(userId: string) {
  return sql`FROM transactions t
    LEFT JOIN transaction_splits s ON s.transaction_id = t.id AND s.user_id = ${userId}
    LEFT JOIN categories c ON c.id = COALESCE(s.category_id, t.category_id) AND c.user_id = ${userId}`;
}

/** Spending per (leaf) category id in [from, to]. `categoryId` null = uncategorised. */
export async function spendingByCategoryId(userId: string, from: ISODate, to: ISODate) {
  const rows = await db.execute<{ category_id: string | null; amount: string; count: number }>(sql`
    SELECT COALESCE(s.category_id, t.category_id) AS category_id, SUM(${SIGNED})::text AS amount, COUNT(DISTINCT t.id)::int AS count
    ${joins(userId)}
    WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.type IN ('expense', 'refund')
      AND t.date BETWEEN ${from} AND ${to} AND COALESCE(c.exclude_from_reports, false) = false
    GROUP BY 1`);
  return rows.map((r) => ({ categoryId: r.category_id, amount: normalize(r.amount), count: Number(r.count) }));
}

/** Daily spending, optionally restricted to category ids (pass already-expanded ids). */
export async function dailySpending(userId: string, from: ISODate, to: ISODate, categoryIds: string[] | null, opts: { excludeRecurring?: boolean } = {}) {
  const catFilter: SQL = categoryIds
    ? categoryIds.length
      ? sql`AND COALESCE(s.category_id, t.category_id) IN (${sql.join(categoryIds.map((i) => sql`${i}`), sql`, `)})`
      : sql`AND false`
    : sql`AND COALESCE(c.exclude_from_reports, false) = false`;
  const rows = await db.execute<{ d: string; amount: string }>(sql`
    SELECT t.date::text AS d, SUM(${SIGNED})::text AS amount
    ${joins(userId)}
    WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND t.type IN ('expense', 'refund')
      AND t.date BETWEEN ${from} AND ${to} ${catFilter}
      ${opts.excludeRecurring ? sql`AND t.recurring_id IS NULL` : sql``}
    GROUP BY t.date ORDER BY t.date`);
  return rows.map((r) => ({ date: r.d, amount: normalize(r.amount) }));
}

export async function spendingTotal(userId: string, from: ISODate, to: ISODate, categoryIds: string[] | null, opts: { excludeRecurring?: boolean } = {}) {
  const days = await dailySpending(userId, from, to, categoryIds, opts);
  return add(...days.map((d) => d.amount));
}
