"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellOff, CheckCheck, Settings } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { NotificationItem, safeInternalLink, type ClientNotification } from "@/components/app/notification-item";
import { cn } from "@/lib/utils";
import { markNotificationsReadAction } from "./actions";

export function NotificationsView({ items, unread }: { items: ClientNotification[]; unread: number }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();

  const markAll = () =>
    start(async () => {
      const r = await markNotificationsReadAction({});
      if (!r.ok) toast.error(r.error);
    });

  const open = (n: ClientNotification) => {
    if (!n.readAt) void markNotificationsReadAction({ ids: [n.id] });
    const href = safeInternalLink(n.link);
    if (href) router.push(href);
    else router.refresh();
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Notifications"
        description={unread ? `${unread} unread` : "Reminders and alerts about your money."}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/settings/notifications">
                <Settings /> Preferences
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={markAll} loading={pending} disabled={!unread}>
              <CheckCheck /> Mark all read
            </Button>
          </>
        }
      />
      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState icon={<BellOff />} title="You're all caught up" description="Reminders about bills, budgets, goals and daily tracking will appear here." />
        ) : (
          <ul className="divide-y">
            {items.map((n) => (
              <li key={n.id} className={cn(!n.readAt && "bg-accent-soft/30")}>
                <NotificationItem n={n} onOpen={open} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
