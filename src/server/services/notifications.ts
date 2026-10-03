import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { notifications } from "@/server/db/schema";

export type NotifyInput = {
  type: "daily_reminder" | "missing_entries" | "budget" | "bill" | "subscription" | "credit_card" | "income" | "goal" | "insight" | "system";
  title: string;
  body: string;
  link?: string | null;
  /** Same key → never created twice (e.g. `bill:<id>:<date>`). */
  dedupeKey: string;
};

/** Create an in-app notification once. Returns the id when newly created, null if it already existed. */
export async function notify(userId: string, n: NotifyInput): Promise<string | null> {
  const [row] = await db
    .insert(notifications)
    .values({ userId, type: n.type, title: n.title.slice(0, 140), body: n.body.slice(0, 500), link: n.link ?? null, dedupeKey: n.dedupeKey.slice(0, 200) })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return row?.id ?? null;
}

export async function listNotifications(userId: string, limit = 30) {
  return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit);
}

export async function unreadCount(userId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r.n;
}

/** Mark the given notifications (or all when `ids` is undefined) read. Owner-scoped. */
export async function markRead(userId: string, ids?: string[]) {
  if (ids && ids.length === 0) return;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));
}
