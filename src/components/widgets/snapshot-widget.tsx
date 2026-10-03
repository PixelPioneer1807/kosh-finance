"use client";

/**
 * Dashboard widget: income, spending, saved and savings rate for a period, with change vs the
 * previous period.
 *
 * Props (serialisable):
 * - `summary`: result of `periodSummary(userId, range)` from src/server/services/analytics.ts.
 * - `title` (default "This month").
 * - `className`: forwarded to the outer Card.
 */
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useMoney } from "@/components/app/user-context";
import { DeltaLabel, StatTile, formatPct } from "@/components/analytics/chart-kit";
import { formatDate } from "@/lib/dates";
import { toNumber } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PeriodSummary } from "@/server/services/analytics";

export type SnapshotWidgetProps = { summary: PeriodSummary; title?: string; className?: string };

export function SnapshotWidget({ summary: s, title = "This month", className }: SnapshotWidgetProps) {
  const fmt = useMoney();
  const suffix = s.previous ? "vs last period" : "";
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <span className="text-[12.5px] text-muted-foreground">
          {formatDate(s.range.from, "d MMM")} – {formatDate(s.range.to, "d MMM")}
        </span>
      </CardHeader>
      <div className="grid grid-cols-2 gap-px border-t bg-border [&>*]:bg-card">
        <StatTile label="Income" value={fmt(s.income)} delta={s.deltas && <DeltaLabel pct={s.deltas.income.pct} goodWhen="up" suffix={suffix} />} />
        <StatTile label="Spending" value={fmt(s.spending)} delta={s.deltas && <DeltaLabel pct={s.deltas.spending.pct} goodWhen="down" suffix={suffix} />} />
        <StatTile label="Saved" value={<span className={cn(toNumber(s.net) < 0 && "text-negative")}>{fmt(s.net)}</span>} />
        <StatTile
          label="Savings rate"
          value={formatPct(s.savingsRate)}
          delta={s.deltas && s.deltas.savingsRate !== null ? <DeltaLabel pct={s.deltas.savingsRate} format="points" goodWhen="up" suffix={suffix} /> : undefined}
        />
      </div>
    </Card>
  );
}
