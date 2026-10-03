import { NextResponse, after } from "next/server";
import { z } from "zod";
import { userRoute } from "@/server/safe";
import { listNotifications, markRead, unreadCount } from "@/server/services/notifications";
import { maybeRunRemindersForUser } from "@/server/services/reminders";

const noStore = { "Cache-Control": "private, no-store" };

/** List the latest notifications + unread count. Also nudges the (throttled) reminder run. */
export const GET = userRoute(async (req, { userId }) => {
  const limit = z.coerce.number().int().min(1).max(100).catch(30).parse(new URL(req.url).searchParams.get("limit") ?? undefined);
  const [items, unread] = await Promise.all([listNotifications(userId, limit), unreadCount(userId)]);
  try {
    after(() => maybeRunRemindersForUser(userId));
  } catch {
    // Outside a request scope (e.g. unit tests) — reminders also run from cron and the app layout.
  }
  return NextResponse.json(
    {
      unread,
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.readAt?.toISOString() ?? null,
        pushed: Boolean(n.pushedAt),
        createdAt: n.createdAt.toISOString(),
      })),
    },
    { headers: noStore },
  );
});

const markSchema = z.object({ ids: z.array(z.uuid()).max(200).optional() });

/** Mark specific notifications (or all, when `ids` is omitted) as read. Owner-scoped. */
export const POST = userRoute(async (req, { userId }) => {
  const body = markSchema.parse(await req.json().catch(() => ({})));
  await markRead(userId, body.ids);
  return NextResponse.json({ ok: true, unread: await unreadCount(userId) }, { headers: noStore });
});
