/**
 * Web Push delivery (VAPID). Subscriptions are per device; the endpoint is globally unique.
 *
 * Delivery rules (anti-spam):
 * - Only for users with `push_enabled`, never during their quiet hours (evaluated in their timezone).
 * - At most `max_per_day` pushes per local day. In-app notifications are always recorded — only the
 *   push is capped. Several pending notifications are coalesced into one push.
 * - Pending notifications are *claimed* (pushed_at set) before sending so overlapping cron ticks can't
 *   double-send; the claim is released if every device fails.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { z } from "zod";
import { db } from "@/server/db";
import { notifications, pushSubscriptions } from "@/server/db/schema";
import { getNotificationPreferences, getPreferences, updateNotificationPreferences } from "./preferences";
import { timeIn, todayIn } from "@/lib/dates";

export type PushPayload = { title: string; body: string; url?: string | null; tag?: string };

const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** Notifications older than this are never pushed (stale news is worse than none). */
const PUSH_FRESHNESS_MS = 12 * 60 * 60 * 1000;

export function pushConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

function vapidDetails() {
  if (!pushConfigured()) return null;
  return {
    subject: process.env.VAPID_SUBJECT!,
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    privateKey: process.env.VAPID_PRIVATE_KEY!,
  };
}

/* ───────────── Subscriptions ───────────── */

const b64url = z.string().min(8).max(200).regex(/^[A-Za-z0-9_\-=]+$/, "Invalid key");
export const pushSubscriptionInput = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(1000)
    .refine((u) => !/^https:\/\/(localhost|127\.|10\.|192\.168\.|\[)/i.test(u), "Invalid push endpoint"),
  keys: z.object({ p256dh: b64url, auth: b64url }),
});
export type PushSubscriptionInput = z.input<typeof pushSubscriptionInput>;

/**
 * Store (or move) a device subscription. The endpoint+keys are secrets only the browser holds, so
 * whoever presents them owns the device's subscription — when a different user signs in on a shared
 * device and enables push, the device stops receiving the previous user's notifications.
 */
export async function subscribePush(userId: string, raw: PushSubscriptionInput, userAgent?: string | null) {
  const input = pushSubscriptionInput.parse(raw);
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null },
    });
  // Keep the newest N devices.
  const subs = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(desc(pushSubscriptions.createdAt));
  const extra = subs.slice(MAX_SUBSCRIPTIONS_PER_USER).map((s) => s.id);
  if (extra.length) await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), inArray(pushSubscriptions.id, extra)));
  await updateNotificationPreferences(userId, { pushEnabled: true });
}

/** Owner-scoped: a user can only remove their own device subscriptions. */
export async function unsubscribePush(userId: string, endpoint: string) {
  const removed = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint.slice(0, 1000))))
    .returning({ id: pushSubscriptions.id });
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (n === 0) await updateNotificationPreferences(userId, { pushEnabled: false });
  return { removed: removed.length };
}

export async function listPushSubscriptions(userId: string) {
  return db
    .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, userAgent: pushSubscriptions.userAgent, createdAt: pushSubscriptions.createdAt })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(desc(pushSubscriptions.createdAt));
}

/* ───────────── Sending ───────────── */

/** Send to every device of the user. Dead subscriptions (404/410) are removed. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
  const vapid = vapidDetails();
  if (!vapid) return { sent: 0, removed: 0, failed: 0 };
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  const body = JSON.stringify({
    title: payload.title.slice(0, 120),
    body: payload.body.slice(0, 300),
    url: safeLink(payload.url),
    tag: payload.tag?.slice(0, 80),
  });
  let sent = 0;
  let failed = 0;
  const dead: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          vapidDetails: vapid,
          TTL: 12 * 60 * 60,
          urgency: "normal",
          timeout: 10_000,
        });
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) dead.push(s.id);
        else {
          failed++;
          console.warn("[push] delivery failed", status ?? (e instanceof Error ? e.message : "unknown"));
        }
      }
    }),
  );
  if (dead.length) await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), inArray(pushSubscriptions.id, dead)));
  return { sent, removed: dead.length, failed };
}

/** Record that notifications were delivered by push (owner-scoped). */
export async function markPushed(userId: string, ids: string[]) {
  if (!ids.length) return;
  await db
    .update(notifications)
    .set({ pushedAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.pushedAt), inArray(notifications.id, ids)));
}

/** Internal links only ("/path"), never protocol-relative or absolute URLs. */
export function safeLink(link: string | null | undefined): string {
  if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//") || /[\\\s]/.test(link)) return "/dashboard";
  return link.slice(0, 300);
}

/* ───────────── Delivery rules ───────────── */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether local time `t` ("HH:MM") falls inside [start, end), wrapping past midnight. */
export function inQuietHours(t: string, start: string | null | undefined, end: string | null | undefined): boolean {
  if (!start || !end || !HHMM.test(start) || !HHMM.test(end) || start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export type PushDecision = { allowed: true; remaining: number } | { allowed: false; reason: "disabled" | "quiet_hours" | "daily_cap" | "not_configured" };

export function pushDecision(opts: {
  configured: boolean;
  pushEnabled: boolean;
  localTime: string;
  quietStart: string | null;
  quietEnd: string | null;
  maxPerDay: number;
  pushedToday: number;
}): PushDecision {
  if (!opts.configured) return { allowed: false, reason: "not_configured" };
  if (!opts.pushEnabled) return { allowed: false, reason: "disabled" };
  if (inQuietHours(opts.localTime, opts.quietStart, opts.quietEnd)) return { allowed: false, reason: "quiet_hours" };
  const remaining = Math.max(0, opts.maxPerDay) - opts.pushedToday;
  if (remaining <= 0) return { allowed: false, reason: "daily_cap" };
  return { allowed: true, remaining };
}

/** Number of distinct pushes (a coalesced push marks several rows with one timestamp) in the user's local day. */
async function pushesToday(userId: string, timezone: string, today: string) {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT pushed_at)::int AS n FROM notifications
    WHERE user_id = ${userId} AND pushed_at IS NOT NULL
      AND pushed_at > now() - interval '2 days'
      AND (pushed_at AT TIME ZONE ${timezone})::date = ${today}::date`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Push this user's unsent, unread, fresh notifications, respecting preferences, quiet hours and
 * the daily cap. Returns how many notifications were delivered (coalesced pushes count each row).
 */
export async function pushPendingForUser(userId: string, now: Date = new Date()): Promise<{ pushed: number; reason?: string }> {
  const [prefs, np] = await Promise.all([getPreferences(userId), getNotificationPreferences(userId)]);
  const tz = prefs.timezone;
  const pending = await db
    .select({ id: notifications.id, title: notifications.title, body: notifications.body, link: notifications.link, createdAt: notifications.createdAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.pushedAt),
        isNull(notifications.readAt),
        gt(notifications.createdAt, new Date(now.getTime() - PUSH_FRESHNESS_MS)),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(20);
  if (!pending.length) return { pushed: 0 };

  const [{ subs }] = await db.select({ subs: sql<number>`count(*)::int` }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (!subs) return { pushed: 0, reason: "no_devices" };

  const decision = pushDecision({
    configured: pushConfigured(),
    pushEnabled: np.pushEnabled,
    localTime: timeIn(tz, now),
    quietStart: np.quietHoursStart,
    quietEnd: np.quietHoursEnd,
    maxPerDay: np.maxPerDay,
    pushedToday: await pushesToday(userId, tz, todayIn(tz, now)),
  });
  if (!decision.allowed) return { pushed: 0, reason: decision.reason };

  // Claim atomically so a concurrent tick can't push the same rows.
  const claimedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const claimed = await db
    .update(notifications)
    .set({ pushedAt: claimedAt })
    .where(and(eq(notifications.userId, userId), isNull(notifications.pushedAt), inArray(notifications.id, pending.map((p) => p.id))))
    .returning({ id: notifications.id });
  const ids = new Set(claimed.map((c) => c.id));
  const items = pending.filter((p) => ids.has(p.id));
  if (!items.length) return { pushed: 0 };

  const payload: PushPayload =
    items.length === 1
      ? { title: items[0].title, body: items[0].body, url: items[0].link, tag: `kosh-${items[0].id}` }
      : {
          title: `${items.length} new notifications`,
          body: items.slice(0, 4).map((i) => i.title).join(" · ") + (items.length > 4 ? ` · +${items.length - 4} more` : ""),
          url: "/notifications",
          tag: "kosh-digest",
        };
  const r = await sendPushToUser(userId, payload);
  if (r.sent === 0) {
    // Nothing delivered — release the claim so a later run can retry.
    await db.update(notifications).set({ pushedAt: null }).where(and(eq(notifications.userId, userId), inArray(notifications.id, [...ids])));
    return { pushed: 0, reason: "delivery_failed" };
  }
  return { pushed: items.length };
}
