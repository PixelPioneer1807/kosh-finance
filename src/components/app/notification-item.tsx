"use client";

import * as React from "react";
import {
  Bell,
  CalendarClock,
  CreditCard,
  HandCoins,
  PencilLine,
  PieChart,
  Receipt,
  Repeat,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ClientNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  pushed?: boolean;
};

const ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  daily_reminder: { icon: PencilLine, tone: "bg-muted text-foreground" },
  missing_entries: { icon: CalendarClock, tone: "bg-warning-soft text-warning" },
  budget: { icon: PieChart, tone: "bg-warning-soft text-warning" },
  bill: { icon: Receipt, tone: "bg-info-soft text-info" },
  subscription: { icon: Repeat, tone: "bg-info-soft text-info" },
  credit_card: { icon: CreditCard, tone: "bg-info-soft text-info" },
  income: { icon: HandCoins, tone: "bg-positive-soft text-positive" },
  goal: { icon: Target, tone: "bg-accent-soft text-accent" },
  insight: { icon: Sparkles, tone: "bg-accent-soft text-accent" },
  system: { icon: Bell, tone: "bg-muted text-foreground" },
};

/** Internal, same-origin paths only. */
export function safeInternalLink(link: string | null | undefined): string | null {
  if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//") || /[\\\s]/.test(link)) return null;
  return link;
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" }) : null;
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 3600 ? [diff / 60, "minute"] : abs < 86400 ? [diff / 3600, "hour"] : abs < 7 * 86400 ? [diff / 86400, "day"] : [diff / (7 * 86400), "week"];
  return rtf ? rtf.format(Math.round(value), unit) : new Date(iso).toLocaleDateString();
}

export function NotificationItem({
  n,
  onOpen,
  compact,
}: {
  n: ClientNotification;
  onOpen: (n: ClientNotification) => void;
  compact?: boolean;
}) {
  const meta = ICONS[n.type] ?? ICONS.system;
  const Icon = meta.icon;
  const unread = !n.readAt;
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={cn(
        "flex w-full items-start gap-3 px-4 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
        compact ? "py-3" : "py-3.5",
      )}
    >
      <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full [&_svg]:size-4", meta.tone)} aria-hidden>
        <Icon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <span className={cn("min-w-0 flex-1 text-[13.5px] leading-snug", unread ? "font-medium text-foreground" : "text-foreground/85")}>{n.title}</span>
          {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
        </span>
        <span className={cn("mt-0.5 block text-[13px] leading-snug text-muted-foreground", compact && "line-clamp-2")}>{n.body}</span>
        <time dateTime={n.createdAt} className="mt-1 block text-[12px] text-muted-foreground/80" suppressHydrationWarning>
          {relativeTime(n.createdAt)}
        </time>
      </span>
    </button>
  );
}
