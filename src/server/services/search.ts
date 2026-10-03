import { sql } from "drizzle-orm";
import { db } from "@/server/db";

export type SearchResult = { kind: string; id: string; title: string; subtitle?: string; href: string; amount?: string; currency?: string };

const like = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c)}%`;

/** Global search across the user's own records. Every subquery is scoped by user_id. */
export async function globalSearch(userId: string, raw: string, limit = 6): Promise<SearchResult[]> {
  const q = raw.trim().slice(0, 100);
  if (q.length < 2) return [];
  const term = like(q);
  const [merchantsR, categoriesR, accountsR, recurringR, goalsR, tagsR, txR] = await Promise.all([
    db.execute<{ id: string; name: string; uses: number; total: string }>(sql`
      SELECT m.id, m.name, count(t.id)::int AS uses, coalesce(sum(t.base_amount) FILTER (WHERE t.type = 'expense'), 0)::text AS total
      FROM merchants m LEFT JOIN transactions t ON t.merchant_id = m.id AND t.deleted_at IS NULL
      WHERE m.user_id = ${userId} AND (m.normalized_name LIKE ${term} OR similarity(m.normalized_name, ${q.toLowerCase()}) > 0.35)
      GROUP BY m.id ORDER BY uses DESC LIMIT ${limit}`),
    db.execute<{ id: string; name: string; kind: string; parent: string | null }>(sql`
      SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
      WHERE c.user_id = ${userId} AND lower(c.name) LIKE ${term} ORDER BY c.parent_id NULLS FIRST LIMIT ${limit}`),
    db.execute<{ id: string; name: string; type: string; institution: string | null }>(sql`
      SELECT id, name, type, institution FROM accounts WHERE user_id = ${userId}
      AND (lower(name) LIKE ${term} OR lower(coalesce(institution, '')) LIKE ${term} OR lower(coalesce(notes, '')) LIKE ${term}) LIMIT ${limit}`),
    db.execute<{ id: string; name: string; kind: string; amount: string; currency: string; next_date: string | null }>(sql`
      SELECT id, name, kind, amount::text, currency, next_date::text FROM recurring_transactions WHERE user_id = ${userId}
      AND (lower(name) LIKE ${term} OR lower(coalesce(notes, '')) LIKE ${term}) LIMIT ${limit}`),
    db.execute<{ id: string; name: string; target_amount: string; currency: string }>(sql`
      SELECT id, name, target_amount::text, currency FROM goals WHERE user_id = ${userId}
      AND (lower(name) LIKE ${term} OR lower(coalesce(notes, '')) LIKE ${term}) LIMIT ${limit}`),
    db.execute<{ id: string; name: string; uses: number }>(sql`
      SELECT tg.id, tg.name, count(tt.transaction_id)::int AS uses FROM tags tg LEFT JOIN transaction_tags tt ON tt.tag_id = tg.id
      WHERE tg.user_id = ${userId} AND lower(tg.name) LIKE ${term} GROUP BY tg.id LIMIT ${limit}`),
    db.execute<{ id: string; date: string; type: string; amount: string; currency: string; merchant: string | null; notes: string | null; category: string | null }>(sql`
      SELECT t.id, t.date::text, t.type, t.amount::text, t.currency, m.name AS merchant, t.notes, c.name AS category
      FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND (
        lower(coalesce(m.name, '')) LIKE ${term} OR lower(coalesce(t.notes, '')) LIKE ${term} OR lower(coalesce(c.name, '')) LIKE ${term}
        ${/^[\d.,]+$/.test(q) ? sql`OR t.amount = ${q.replace(/,/g, "")}::numeric` : sql``}
      ) ORDER BY t.date DESC, t.created_at DESC LIMIT ${limit}`),
  ]);
  const enc = encodeURIComponent;
  return [
    ...txR.map((t) => ({
      kind: "transaction",
      id: t.id,
      title: t.merchant ?? t.notes ?? t.category ?? t.type,
      subtitle: [t.date, t.category, t.merchant && t.notes ? t.notes : null].filter(Boolean).join(" · "),
      href: `/transactions?open=${t.id}`,
      amount: t.amount,
      currency: t.currency,
    })),
    ...merchantsR.map((m) => ({ kind: "merchant", id: m.id, title: m.name, subtitle: `Merchant · ${m.uses} transaction${m.uses === 1 ? "" : "s"}`, href: `/analytics/merchants?merchant=${m.id}` })),
    ...categoriesR.map((c) => ({ kind: "category", id: c.id, title: c.parent ? `${c.parent} › ${c.name}` : c.name, subtitle: `${c.kind === "income" ? "Income" : "Expense"} category`, href: `/transactions?category=${c.id}` })),
    ...accountsR.map((a) => ({ kind: "account", id: a.id, title: a.name, subtitle: ["Account", a.institution].filter(Boolean).join(" · "), href: `/transactions?account=${a.id}` })),
    ...recurringR.map((r) => ({ kind: r.kind === "subscription" ? "subscription" : "recurring", id: r.id, title: r.name, subtitle: `${r.kind[0].toUpperCase() + r.kind.slice(1)}${r.next_date ? ` · next ${r.next_date}` : ""}`, href: `/recurring?open=${r.id}`, amount: r.amount, currency: r.currency })),
    ...goalsR.map((g) => ({ kind: "goal", id: g.id, title: g.name, subtitle: "Goal", href: `/goals?open=${g.id}`, amount: g.target_amount, currency: g.currency })),
    ...tagsR.map((t) => ({ kind: "tag", id: t.id, title: `#${t.name}`, subtitle: `Tag · ${t.uses} transaction${t.uses === 1 ? "" : "s"}`, href: `/transactions?tag=${enc(t.id)}` })),
  ];
}
