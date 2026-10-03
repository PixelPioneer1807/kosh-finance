"use client";

/**
 * Dashboard widget: cumulative spending this budget month vs last month, by day of month.
 *
 * Props (serialisable):
 * - `data`: result of `cumulativeSpending(userId)` from src/server/services/analytics.ts.
 * - `className`: forwarded to the outer Card.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMoney } from "@/components/app/user-context";
import { CumulativeChart, DeltaLabel } from "@/components/analytics/chart-kit";
import { delta as moneyDelta } from "@/components/widgets/widget-utils";
import { isZero } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { CumulativeSpending } from "@/server/services/analytics";

export type SpendingTrendWidgetProps = { data: CumulativeSpending; className?: string };

export function SpendingTrendWidget({ data, className }: SpendingTrendWidgetProps) {
  const fmt = useMoney();
  const d = moneyDelta(data.currentToDate, data.previousToSameDay);
  const empty = isZero(data.currentToDate) && isZero(data.previousTotal);
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>Spending trend</CardTitle>
        <Link href="/analytics" className="-mr-1 inline-flex min-h-8 items-center gap-0.5 rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground">
          Analytics <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent className="flex-1">
        {empty ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No spending this month or last yet.</p>
        ) : (
          <div className="grid gap-2">
            <div>
              <p className="text-[24px] leading-tight font-semibold tracking-tight">{fmt(data.currentToDate)}</p>
              {!isZero(data.previousToSameDay) ? (
                <DeltaLabel pct={d.pct} goodWhen="down" suffix={`vs ${fmt(data.previousToSameDay)} by this day last month`} />
              ) : (
                <p className="text-[12.5px] text-muted-foreground">spent so far this month</p>
              )}
            </div>
            <figure>
              <CumulativeChart points={data.points} height={150} />
              <figcaption className="sr-only">
                Spent {fmt(data.currentToDate)} so far this month, compared with {fmt(data.previousToSameDay)} by the same day last month and {fmt(data.previousTotal)} for all of last month.
              </figcaption>
            </figure>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
