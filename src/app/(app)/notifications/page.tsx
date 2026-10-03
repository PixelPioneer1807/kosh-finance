import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { listNotifications, unreadCount } from "@/server/services/notifications";
import { NotificationsView } from "./notifications-view";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const { user } = await requireUserPage();
  const [items, unread] = await Promise.all([listNotifications(user.id, 100), unreadCount(user.id)]);
  return (
    <NotificationsView
      unread={unread}
      items={items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      }))}
    />
  );
}
