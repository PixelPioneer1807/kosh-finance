"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/misc";
import { NotificationItem, safeInternalLink, type ClientNotification } from "@/components/app/notification-item";
import { cn } from "@/lib/utils";

const POLL_MS = 60_000;
/** While the tab is hidden, check less often (only to surface a system notification). */
const HIDDEN_EVERY_N_TICKS = 5;

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: ClientNotification[]; unread: number };

async function fetchNotifications(): Promise<{ items: ClientNotification[]; unread: number }> {
  const r = await fetch("/api/notifications?limit=20", { cache: "no-store", headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** Show new items as system notifications when the tab is in the background (via the SW, so clicks route back in). */
async function showSystemNotifications(items: ClientNotification[]) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  for (const n of items.slice(0, 3)) {
    const opts: NotificationOptions = {
      body: n.body,
      tag: `kosh-${n.id}`,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      data: { url: safeInternalLink(n.link) ?? "/notifications" },
    };
    try {
      if (reg) await reg.showNotification(n.title, opts);
      else new Notification(n.title, opts);
    } catch {
      /* some browsers only allow SW notifications */
    }
  }
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<State>({ status: "loading" });
  const newestSeen = React.useRef<string | null>(null);
  const tick = React.useRef(0);

  const load = React.useCallback(async () => {
    try {
      const data = await fetchNotifications();
      const prev = newestSeen.current;
      const newest = data.items[0]?.createdAt ?? prev;
      if (prev && document.visibilityState === "hidden") {
        const fresh = data.items.filter((n) => n.createdAt > prev && !n.readAt && !n.pushed);
        if (fresh.length) void showSystemNotifications(fresh);
      }
      newestSeen.current = newest ?? null;
      setState({ status: "ready", items: data.items, unread: data.unread });
    } catch {
      setState((s) => (s.status === "ready" ? s : { status: "error" }));
    }
  }, []);

  React.useEffect(() => {
    // Initial fetch, then poll: every minute while visible, every few minutes while hidden.
    const first = setTimeout(load, 0);
    const id = setInterval(() => {
      tick.current++;
      if (document.visibilityState === "visible" || tick.current % HIDDEN_EVERY_N_TICKS === 0) void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const markRead = React.useCallback(async (ids?: string[]) => {
    setState((s) => {
      if (s.status !== "ready") return s;
      const now = new Date().toISOString();
      const items = s.items.map((n) => (!ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n));
      const cleared = ids ? s.items.filter((n) => ids.includes(n.id) && !n.readAt).length : s.unread;
      return { ...s, items, unread: Math.max(0, s.unread - cleared) };
    });
    try {
      const r = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids ? { ids } : {}),
      });
      if (!r.ok) throw new Error();
    } catch {
      void load();
    }
  }, [load]);

  const onOpenItem = (n: ClientNotification) => {
    if (!n.readAt) void markRead([n.id]);
    const href = safeInternalLink(n.link);
    setOpen(false);
    if (href) router.push(href);
  };

  const unread = state.status === "ready" ? state.unread : 0;
  const label = unread ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void load();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label}>
          <Bell className="size-[18px]" />
          {unread > 0 && (
            <span
              aria-hidden
              className="num absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-negative px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-background"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(380px,calc(100vw-1.5rem))] overflow-hidden p-0" aria-label="Notifications">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground" disabled={!unread} onClick={() => markRead()}>
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <div className="max-h-[min(65vh,460px)] overflow-y-auto overscroll-contain" aria-live="polite">
          {state.status === "loading" ? (
            <div className="space-y-3 p-4" aria-label="Loading notifications">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : state.status === "error" ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground" role="alert">
              <p>Couldn&apos;t load notifications.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => load()}>
                Try again
              </Button>
            </div>
          ) : state.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                <BellOff className="size-[18px]" />
              </span>
              <p className="text-sm font-medium">You&apos;re all caught up</p>
              <p className="text-[13px] text-muted-foreground">Reminders about bills, budgets and goals will show up here.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {state.items.map((n) => (
                <li key={n.id} className={cn(!n.readAt && "bg-accent-soft/30")}>
                  <NotificationItem n={n} onOpen={onOpenItem} compact />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t px-4 py-2 text-center">
          <Link href="/notifications" onClick={() => setOpen(false)} className="text-[13px] font-medium text-muted-foreground hover:text-foreground">
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
