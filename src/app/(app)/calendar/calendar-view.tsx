"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Flag,
  Plus,
  Receipt,
  Repeat,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/misc";
import { useAppData, useMoney } from "@/components/app/user-context";
import { useShell } from "@/components/shell/shell-context";
import { COLORS } from "@/components/charts/palette";
import { TxnLine } from "@/components/analytics/txn-line";
import { KIND_LABELS } from "@/components/analytics/format";
import { addMonthsISO, formatDate, relativeDayLabel } from "@/lib/dates";
import { isZero, toNumber } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { CalendarDay, CalendarItem, CalendarMonth } from "@/server/services/calendar";

const KIND_ICON: Record<CalendarItem["kind"], LucideIcon> = {
  income: ArrowDownLeft,
  expense: Repeat,
  bill: Receipt,
  subscription: Repeat,
  transfer: ArrowLeftRight,
  card_due: CreditCard,
  loan_due: CreditCard,
  goal_contribution: Target,
  goal_deadline: Flag,
};

function itemHref(i: CalendarItem) {
  if (i.recurringId) return `/recurring?open=${i.recurringId}`;
  if (i.goalId) return "/goals";
  if (i.accountId) return "/accounts";
  return null;
}

export function CalendarView({ data, initialDay }: { data: CalendarMonth; initialDay: string | null }) {
  const fmt = useMoney();
  const { prefs } = useAppData();
  const { openQuickAdd } = useShell();
  const inMonthToday = data.today >= data.monthRange.from && data.today <= data.monthRange.to;
  const [selected, setSelected] = React.useState<string>(initialDay ?? (inMonthToday ? data.today : data.monthRange.from));
  const panelRef = React.useRef<HTMLDivElement>(null);

  const itemsByDay = React.useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const s of data.scheduled) m.set(s.date, [...(m.get(s.date) ?? []), s]);
    return m;
  }, [data.scheduled]);

  const select = (date: string) => {
    setSelected(date);
    const url = new URL(window.location.href);
    url.searchParams.set("day", date);
    window.history.replaceState(null, "", url.toString());
    if (window.matchMedia("(max-width: 1023px)").matches) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const prevMonth = addMonthsISO(data.monthRange.from, -1).slice(0, 7);
  const nextMonth = addMonthsISO(data.monthRange.from, 1).slice(0, 7);
  const weekdays = Array.from({ length: 7 }, (_, i) => formatDate(data.days[i].date, "EEE"));
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < data.days.length; i += 7) weeks.push(data.days.slice(i, i + 7));
  const selectedDay = data.days.find((d) => d.date === selected) ?? data.days[0];
  const upcoming = data.scheduled.filter((s) => s.date >= data.today && s.date >= data.monthRange.from && s.date <= data.monthRange.to);

  return (
    <div>
      <PageHeader
        title="Calendar"
        description="What happened each day, and what's scheduled next."
        actions={
          <div className="flex items-center gap-1">
            <Button asChild variant="outline" size="icon" aria-label={`Previous month, ${formatDate(`${prevMonth}-01`, "MMMM yyyy")}`}>
              <Link href={`/calendar?month=${prevMonth}`}>
                <ChevronLeft />
              </Link>
            </Button>
            <h2 className="min-w-32 text-center text-[15px] font-semibold" aria-live="polite">
              {formatDate(data.monthRange.from, "MMMM yyyy")}
            </h2>
            <Button asChild variant="outline" size="icon" aria-label={`Next month, ${formatDate(`${nextMonth}-01`, "MMMM yyyy")}`}>
              <Link href={`/calendar?month=${nextMonth}`}>
                <ChevronRight />
              </Link>
            </Button>
            {!inMonthToday && (
              <Button asChild variant="ghost" size="sm" className="ml-1">
                <Link href="/calendar">Today</Link>
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
        <span>
          <span className="text-muted-foreground">Spent </span>
          <span className="num font-medium">{fmt(data.totals.spending)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Received </span>
          <span className="num font-medium">{fmt(data.totals.income)}</span>
        </span>
        {(!isZero(data.totals.scheduledOut) || !isZero(data.totals.scheduledIn)) && (
          <span className="text-muted-foreground">
            Scheduled <span className="num text-foreground">{fmt(data.totals.scheduledIn)}</span> in · <span className="num text-foreground">{fmt(data.totals.scheduledOut)}</span> out
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: COLORS.spending }} /> Spent
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: COLORS.income }} /> Received
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border border-dashed border-muted-foreground" /> Scheduled
          </span>
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="overflow-hidden">
          <div role="grid" aria-label={`${formatDate(data.monthRange.from, "MMMM yyyy")} calendar`}>
            <div role="row" className="grid grid-cols-7 border-b bg-subtle text-center text-[11.5px] font-medium text-muted-foreground">
              {weekdays.map((w) => (
                <div key={w} role="columnheader" className="py-2">
                  <span className="sm:hidden">{w.slice(0, 1)}</span>
                  <span className="hidden sm:inline">{w}</span>
                </div>
              ))}
            </div>
            {weeks.map((w, wi) => (
              <div key={wi} role="row" className="grid grid-cols-7 divide-x border-b last:border-b-0">
                {w.map((d) => (
                  <DayCell key={d.date} d={d} items={itemsByDay.get(d.date) ?? []} selected={d.date === selected} onSelect={select} />
                ))}
              </div>
            ))}
          </div>
        </Card>

        <div ref={panelRef} className="scroll-mt-20 lg:sticky lg:top-4 lg:self-start">
          <DayPanel
            day={selectedDay}
            txns={data.transactions[selectedDay.date] ?? []}
            items={itemsByDay.get(selectedDay.date) ?? []}
            projected={data.projected?.[selectedDay.date] ?? null}
            today={prefs.today}
            onAdd={() => openQuickAdd({ date: selectedDay.date })}
          />
        </div>
      </div>

      <Card className="mt-5 lg:hidden">
        <CardHeader>
          <CardTitle className="text-[14px] text-foreground">Coming up this month</CardTitle>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Nothing scheduled for the rest of this month.</p>
          ) : (
            <ul className="divide-y">
              {upcoming.map((i) => (
                <ScheduledRow key={i.id} i={i} showDate today={data.today} onSelect={() => select(i.date)} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DayCell({ d, items, selected, onSelect }: { d: CalendarDay; items: CalendarItem[]; selected: boolean; onSelect: (date: string) => void }) {
  const fmt = useMoney();
  const spent = toNumber(d.spending) > 0;
  const got = toNumber(d.income) > 0;
  const label = [
    formatDate(d.date, "EEEE d MMMM"),
    spent ? `spent ${fmt(d.spending)}` : null,
    got ? `received ${fmt(d.income)}` : null,
    items.length ? `${items.length} scheduled: ${items.map((i) => i.name).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div role="gridcell" aria-selected={selected} className={cn(!d.inMonth && "bg-subtle/70")}>
      <button
        type="button"
        onClick={() => onSelect(d.date)}
        aria-label={label}
        aria-pressed={selected}
        className={cn(
          "flex h-full min-h-14 w-full flex-col items-stretch gap-0.5 p-1 text-left transition-colors hover:bg-muted/60 focus-visible:relative focus-visible:z-10 sm:min-h-24 sm:p-1.5",
          selected && "bg-accent-soft hover:bg-accent-soft",
        )}
      >
        <span
          className={cn(
            "num grid size-6 place-items-center self-center rounded-full text-[12.5px] sm:self-start",
            !d.inMonth && "text-muted-foreground/70",
            d.isToday && "bg-primary font-semibold text-primary-foreground",
          )}
        >
          {Number(d.date.slice(8))}
        </span>
        {/* Phones: dots only */}
        <span className="flex justify-center gap-1 sm:hidden" aria-hidden>
          {spent && <span className="size-1.5 rounded-full" style={{ background: COLORS.spending }} />}
          {got && <span className="size-1.5 rounded-full" style={{ background: COLORS.income }} />}
          {items.length > 0 && <span className="size-1.5 rounded-full border border-dashed border-muted-foreground" />}
        </span>
        {/* Larger screens: amounts and scheduled chips */}
        <span className="hidden min-w-0 flex-col gap-0.5 sm:flex" aria-hidden>
          {spent && <span className="num truncate text-[11.5px]">−{fmt(d.spending, undefined, { compact: true })}</span>}
          {got && <span className="num truncate text-[11.5px] text-positive">+{fmt(d.income, undefined, { compact: true })}</span>}
          {items.slice(0, 2).map((i) => {
            const Icon = KIND_ICON[i.kind];
            return (
              <span key={i.id} className={cn("flex min-w-0 items-center gap-1 rounded border border-dashed px-1 py-px text-[11px] text-muted-foreground", i.status === "overdue" && "border-negative/60 text-negative")}>
                <Icon className="size-3 shrink-0" />
                <span className="truncate">{i.name}</span>
              </span>
            );
          })}
          {items.length > 2 && <span className="text-[11px] text-muted-foreground">+{items.length - 2} more</span>}
        </span>
      </button>
    </div>
  );
}

function ScheduledRow({ i, showDate, today, onSelect }: { i: CalendarItem; showDate?: boolean; today: string; onSelect?: () => void }) {
  const fmt = useMoney();
  const Icon = KIND_ICON[i.kind];
  const href = itemHref(i);
  const amount = i.amount ? fmt(i.amount, undefined, { signed: true }) : i.nativeAmount && i.currency ? fmt(i.nativeAmount, i.currency) : null;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground" aria-hidden>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {onSelect ? (
          <button type="button" onClick={onSelect} className="block max-w-full truncate text-left text-[13.5px] hover:underline">
            {i.name}
          </button>
        ) : (
          <p className="truncate text-[13.5px]">{i.name}</p>
        )}
        <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          {showDate && <span>{relativeDayLabel(i.date, today)} ·</span>}
          <span>{KIND_LABELS[i.kind] ?? i.kind}</span>
          {i.status === "overdue" && <Badge variant="negative">Overdue</Badge>}
          {i.status === "due" && <Badge variant="warning">Due today</Badge>}
          <span className="sr-only">(scheduled)</span>
        </p>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        {amount && <span className={cn("num text-[13.5px]", i.amount && toNumber(i.amount) > 0 && "text-positive")}>{amount}</span>}
        {href && i.recurringId && (i.status === "overdue" || i.status === "due" || i.status === "upcoming") && (
          <Link href={href} className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {i.kind === "income" ? "Mark received" : "Mark paid"}
          </Link>
        )}
        {href && !i.recurringId && (
          <Link href={href} className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Open
          </Link>
        )}
      </div>
    </li>
  );
}

function DayPanel({ day, txns, items, projected, today, onAdd }: { day: CalendarDay; txns: CalendarMonth["transactions"][string]; items: CalendarItem[]; projected: string | null; today: string; onAdd: () => void }) {
  const fmt = useMoney();
  return (
    <Card>
      <CardHeader className="items-center">
        <div>
          <h3 className="text-[15px] font-semibold">{relativeDayLabel(day.date, today)}</h3>
          <p className="text-[12.5px] text-muted-foreground">{formatDate(day.date, "EEEE, d MMMM yyyy")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onAdd} className="no-print">
          <Plus /> Add
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!day.isFuture && (
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
              <span className="font-medium text-muted-foreground">Actual</span>
              <span className="num text-muted-foreground">
                {toNumber(day.spending) !== 0 && <>Spent {fmt(day.spending)}</>}
                {toNumber(day.spending) !== 0 && toNumber(day.income) > 0 && " · "}
                {toNumber(day.income) > 0 && <span className="text-positive">+{fmt(day.income)}</span>}
              </span>
            </div>
            {txns.length === 0 ? (
              <p className="py-2 text-[13px] text-muted-foreground">{day.count > 0 ? `${day.count} transactions` : "No transactions."}</p>
            ) : (
              <ul className="divide-y">
                {txns.map((t) => (
                  <TxnLine key={t.id} t={t} />
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <p className="mb-1 text-[12.5px] font-medium text-muted-foreground">Scheduled</p>
          {items.length === 0 ? (
            <p className="py-2 text-[13px] text-muted-foreground">Nothing scheduled.</p>
          ) : (
            <ul className="divide-y">
              {items.map((i) => (
                <ScheduledRow key={i.id} i={i} today={today} />
              ))}
            </ul>
          )}
        </div>
        {projected && (
          <div className="rounded-lg border border-dashed px-3 py-2.5 text-[13px]">
            <p className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Projected cash balance</span>
              <span className={cn("num font-medium", toNumber(projected) < 0 && "text-negative")}>{fmt(projected)}</span>
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">Forecast — end of day, from schedules and your average everyday spending.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
