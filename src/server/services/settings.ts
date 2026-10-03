/** Settings-area helpers that sit on top of preferences/taxonomy (validation schemas, usage, FX fetch). */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { aiUsage, categories, merchants, tags, transactions } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { RANGE_PRESETS } from "@/lib/dates";
import { currencyCode, optionalId, optionalMoney, timeOfDay, timezone } from "@/lib/validation";
import { assertOwned } from "./ownership";
import { DASHBOARD_WIDGETS, updateNotificationPreferences, updatePreferences } from "./preferences";
import { reorderCategories } from "./taxonomy";

/* ───────────── Preferences ───────────── */

const locale = z
  .string()
  .trim()
  .max(35)
  .refine((l) => {
    try {
      return Intl.NumberFormat.supportedLocalesOf([l]).length > 0;
    } catch {
      return false;
    }
  }, "Unsupported locale");

export const generalPrefsInput = z.object({
  timezone,
  locale,
  weekStartsOn: z.union([z.literal(0), z.literal(1)]),
  monthStartDay: z.coerce.number().int().min(1, "Pick a day from 1 to 28").max(28, "Pick a day from 1 to 28"),
  defaultAccountId: optionalId,
  defaultPaymentMethodId: optionalId,
  expectedMonthlyIncome: optionalMoney,
});

export async function updateGeneralPreferences(userId: string, raw: z.input<typeof generalPrefsInput>) {
  const input = generalPrefsInput.parse(raw);
  await assertOwned(userId, { account: input.defaultAccountId, paymentMethod: input.defaultPaymentMethodId });
  await updatePreferences(userId, input);
}

const widgetIds = new Set(DASHBOARD_WIDGETS.map((w) => w.id));
export const appearanceInput = z.object({
  theme: z.enum(["light", "dark", "system"]),
  dashboardWidgets: z
    .array(z.object({ id: z.string().refine((id) => widgetIds.has(id), "Unknown widget"), visible: z.boolean() }))
    .max(DASHBOARD_WIDGETS.length)
    .refine((ws) => new Set(ws.map((w) => w.id)).size === ws.length, "Each widget can appear once"),
  defaultDateRange: z.enum(RANGE_PRESETS.map((r) => r.id) as [string, ...string[]]),
});

export async function updateAppearance(userId: string, raw: z.input<typeof appearanceInput>) {
  await updatePreferences(userId, appearanceInput.parse(raw));
}

export const notificationPrefsInput = z
  .object({
    dailyReminderEnabled: z.boolean(),
    dailyReminderTime: timeOfDay,
    missingEntriesDays: z.coerce.number().int().min(0).max(30),
    budgetAlerts: z.boolean(),
    billReminders: z.boolean(),
    subscriptionReminders: z.boolean(),
    creditCardReminders: z.boolean(),
    incomeReminders: z.boolean(),
    goalReminders: z.boolean(),
    maxPerDay: z.coerce.number().int().min(1, "At least 1").max(20, "At most 20"),
    quietHoursEnabled: z.boolean(),
    quietHoursStart: timeOfDay,
    quietHoursEnd: timeOfDay,
  })
  .refine((v) => !v.quietHoursEnabled || v.quietHoursStart !== v.quietHoursEnd, { path: ["quietHoursEnd"], message: "Start and end can't be the same" });

export async function saveNotificationPreferences(userId: string, raw: z.input<typeof notificationPrefsInput>) {
  const { quietHoursEnabled, quietHoursStart, quietHoursEnd, ...rest } = notificationPrefsInput.parse(raw);
  await updateNotificationPreferences(userId, {
    ...rest,
    quietHoursStart: quietHoursEnabled ? quietHoursStart : null,
    quietHoursEnd: quietHoursEnabled ? quietHoursEnd : null,
  });
}

export const aiPrefsInput = z.object({ aiEnabled: z.boolean(), aiInsightsEnabled: z.boolean() });
export async function updateAiPreferences(userId: string, raw: z.input<typeof aiPrefsInput>) {
  await updatePreferences(userId, aiPrefsInput.parse(raw));
}

export async function getAiUsage(userId: string, days = 7) {
  const rows = await db
    .select({
      day: aiUsage.day,
      requests: aiUsage.requests,
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      isToday: sql<boolean>`${aiUsage.day} = current_date`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), sql`${aiUsage.day} >= current_date - ${days - 1}::int`))
    .orderBy(asc(aiUsage.day));
  const today = rows.find((r) => r.isToday);
  return { today: today ?? { requests: 0, inputTokens: 0, outputTokens: 0 }, recent: rows, dailyLimit: Number(process.env.AI_DAILY_REQUEST_LIMIT ?? 300) };
}

/* ───────────── Categories ───────────── */

export async function setCategoryArchived(userId: string, id: string, archived: boolean) {
  const [row] = await db
    .update(categories)
    .set({ isArchived: archived })
    .where(and(eq(categories.id, id), eq(categories.userId, userId)))
    .returning({ id: categories.id });
  if (!row) throw notFound("Category");
  if (archived) await db.update(categories).set({ isArchived: true }).where(and(eq(categories.userId, userId), eq(categories.parentId, id)));
}

/** Move a category one step up/down among its siblings (same kind and parent). */
export async function moveCategory(userId: string, id: string, direction: "up" | "down") {
  const [cat] = await db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId))).limit(1);
  if (!cat) throw notFound("Category");
  const siblings = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.kind, cat.kind), cat.parentId ? eq(categories.parentId, cat.parentId) : isNull(categories.parentId)))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  const ids = siblings.map((s) => s.id);
  const i = ids.indexOf(id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await reorderCategories(userId, ids);
}

export async function categoryUsage(userId: string) {
  const rows = await db.execute<{ category_id: string; n: number }>(sql`
    SELECT COALESCE(s.category_id, t.category_id) AS category_id, count(DISTINCT t.id)::int AS n
    FROM transactions t LEFT JOIN transaction_splits s ON s.transaction_id = t.id
    WHERE t.user_id = ${userId} AND t.deleted_at IS NULL AND COALESCE(s.category_id, t.category_id) IS NOT NULL
    GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.category_id, r.n])) as Record<string, number>;
}

/* ───────────── Merchants & tags ───────────── */

export async function listMerchantsWithUsage(userId: string) {
  return db
    .select({ id: merchants.id, name: merchants.name, uses: sql<number>`count(${transactions.id})::int` })
    .from(merchants)
    .leftJoin(transactions, and(eq(transactions.merchantId, merchants.id), eq(transactions.userId, userId), isNull(transactions.deletedAt)))
    .where(eq(merchants.userId, userId))
    .groupBy(merchants.id)
    .orderBy(asc(merchants.name));
}

export async function listTagsWithUsage(userId: string) {
  return db
    .select({ id: tags.id, name: tags.name, uses: sql<number>`(SELECT count(*)::int FROM transaction_tags tt WHERE tt.tag_id = ${tags.id} AND tt.user_id = ${userId})` })
    .from(tags)
    .where(eq(tags.userId, userId))
    .orderBy(asc(tags.name));
}

/** Delete a merchant that's no longer wanted; its transactions keep their data but lose the merchant link. */
export async function deleteMerchant(userId: string, id: string) {
  const [row] = await db.delete(merchants).where(and(eq(merchants.id, id), eq(merchants.userId, userId))).returning({ id: merchants.id });
  if (!row) throw notFound("Merchant");
}

/* ───────────── Exchange rates ───────────── */

export const exchangeRateInput = z.object({
  currency: currencyCode,
  rate: z
    .string()
    .trim()
    .regex(/^\d{1,10}(\.\d{1,10})?$/, "Enter a positive number (up to 10 decimals)")
    .refine((r) => Number(r) > 0, "Rate must be greater than zero"),
});

const FX_ENDPOINT = "https://api.frankfurter.dev/v1/latest";

/**
 * Fetch reference rates (ECB data via Frankfurter, free, no key). Returns "1 X = r base" for each
 * requested currency it knows. Server-side only, with a timeout; never saves — the user reviews first.
 */
export async function fetchLatestRates(base: string, currencies: string[], fetchImpl: typeof fetch = fetch) {
  const symbols = [...new Set(currencies.filter((c) => c !== base && /^[A-Z]{3}$/.test(c)))];
  if (!symbols.length) return { date: null as string | null, rates: {} as Record<string, string>, missing: [] as string[] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `${FX_ENDPOINT}?base=${encodeURIComponent(base)}&symbols=${symbols.map(encodeURIComponent).join(",")}`;
    const r = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { date?: string; rates?: Record<string, number> };
    const out: Record<string, string> = {};
    for (const c of symbols) {
      const perBase = j.rates?.[c];
      // API gives "1 base = perBase X"; we store "1 X = rate base".
      if (typeof perBase === "number" && perBase > 0) out[c] = (1 / perBase).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
    }
    return { date: typeof j.date === "string" ? j.date : null, rates: out, missing: symbols.filter((c) => !out[c]) };
  } catch {
    throw new AppError("UNAVAILABLE", "Couldn't reach the exchange-rate service. Enter rates manually or try again later.");
  } finally {
    clearTimeout(timer);
  }
}
