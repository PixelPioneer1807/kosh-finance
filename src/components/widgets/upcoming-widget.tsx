"use client";

/**
 * Dashboard widget: scheduled bills, subscriptions, income and transfers for the next 14 days.
 *
 * Props (serialisable):
 * - `items`: result of `upcomingOccurrences(userId, today, addDaysISO(today, 14))` from
 *   src/server/services/recurring.ts (overdue unpaid items are included and flagged).
 * - `today`: the user's today (`prefs.today`).
 * - `limit` (default 6): rows shown before "View all".
 * - `className`: forwarded to the outer Card.
 */
import Link from "next/link";
import { ArrowDownLeft, ArrowLeftRight, CalendarClock, ChevronRight, Receipt, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { useMoney } from "@/components/app/user-context";
import { relativeDayLabel } from "@/lib/dates";
import { add, isZero } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Occurrence } from "@/server/services/recurring";

export type UpcomingWidgetProps = { items: Occurrence[]; today: string; limit?: number; className?: string };

const ICON = { income: ArrowDownLeft, bill: Receipt, subscription: Repeat, expense: Repeat, transfer: ArrowLeftRight } as const;
const LABEL = { income: "Income", bill: "Bill", subscription: "Subscription", expense: "Recurring", transfer: "Transfer" } as const;

export function UpcomingWidget({ items, today, limit = 6, className }: UpcomingWidgetProps) {
  const fmt = useMoney();
  const shown = items.slice(0, limit);
  const out = add(...items.filter((i) => i.kind !== "income" && i.kind !== "transfer").map((i) => i.baseAmount ?? "0"));
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>Upcoming · 14 days</CardTitle>
        <Link href="/calendar" className="-mr-1 inline-flex min-h-8 items-center gap-0.5 rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground">
          Calendar <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent className="flex-1">
        {items.length === 0 ? (
          <EmptyState
            className="py-6"
            icon={<CalendarClock />}
            title="Nothing due in the next two weeks"
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/recurring">Add a bill or income</Link>
              </Button>
            }
          />
        ) : (
          <>
            {!isZero(out) && (
              <p className="mb-2 text-[12.5px] text-muted-foreground">
                <span className="num font-medium text-foreground">{fmt(out)}</span> in bills and subscriptions due
              </p>
            )}
            <ul className="divide-y">
              {shown.map((o) => {
                const Icon = ICON[o.kind];
                const isIncome = o.kind === "income";
                return (
                  <li key={`${o.recurringId}-${o.date}`} className="flex items-center gap-3 py-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground" aria-hidden>
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link href={`/recurring?open=${o.recurringId}`} className="block truncate text-[13.5px] hover:underline">
                        {o.name}
                      </Link>
                      <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        {relativeDayLabel(o.date, today)} · {LABEL[o.kind]}
                        {o.status === "overdue" && <Badge variant="negative">Overdue</Badge>}
                      </p>
                    </div>
                    <span className={cn("num text-[13.5px]", isIncome && "text-positive")}>
                      {isIncome ? "+" : o.kind === "transfer" ? "" : "−"}
                      {fmt(o.amount, o.currency)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {items.length > limit && (
              <Link href="/recurring" className="mt-1 inline-flex min-h-9 items-center text-[13px] text-muted-foreground hover:text-foreground">
                View all {items.length}
              </Link>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
