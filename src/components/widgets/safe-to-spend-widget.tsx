"use client";

/**
 * Dashboard widget: safe-to-spend hero figure with per-day allowance and an itemised breakdown.
 * Labelled as a calculation (not a forecast).
 *
 * Props (serialisable):
 * - `data`: result of `safeToSpend(userId)` from src/server/services/forecast.ts.
 * - `className`: forwarded to the outer Card.
 */
import * as React from "react";
import { ChevronDown, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMoney } from "@/components/app/user-context";
import { formatDate, relativeDayLabel } from "@/lib/dates";
import { isNegative } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { SafeToSpend } from "@/server/services/forecast";

export type SafeToSpendWidgetProps = { data: SafeToSpend; className?: string };

export function SafeToSpendWidget({ data, className }: SafeToSpendWidgetProps) {
  const fmt = useMoney();
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const negative = isNegative(data.amount);
  const until = data.nextIncome ? `until ${data.nextIncome.name} on ${relativeDayLabel(data.nextIncome.date, data.asOf)}` : `until ${formatDate(data.windowEnd, "d MMM")}`;
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>Safe to spend</CardTitle>
        <Badge variant="outline" title="Calculated from balances and schedules">
          Calculation
        </Badge>
      </CardHeader>
      <CardContent className="flex-1">
        <p className={cn("text-[40px] leading-none font-semibold tracking-tight sm:text-[48px]", negative && "text-negative")}>{fmt(data.amount)}</p>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          {negative ? (
            <>Upcoming commitments are more than your cash {until}.</>
          ) : (
            <>
              About <span className="num font-medium text-foreground">{fmt(data.perDay)}</span> a day for {data.daysRemaining} day{data.daysRemaining === 1 ? "" : "s"} {until}.
            </>
          )}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="mt-3 inline-flex min-h-9 items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          How this is calculated <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        {open && (
          <div id={id} className="mt-1 grid gap-3">
            <ul className="divide-y rounded-lg border px-3 text-[13px]">
              {data.breakdown.map((b) => (
                <li key={b.key} className="py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span>{b.label}</span>
                    <span className="num font-medium">{fmt(b.amount, undefined, { signed: b.key !== "balance" })}</span>
                  </div>
                  {b.key !== "balance" && b.items.length > 0 && (
                    <ul className="mt-1 grid gap-0.5 text-[12px] text-muted-foreground">
                      {b.items.slice(0, 6).map((i, n) => (
                        <li key={n} className="flex justify-between gap-3">
                          <span className="truncate">
                            {i.label}
                            {i.date ? ` · ${formatDate(i.date, "d MMM")}` : ""}
                            {i.status === "overdue" ? " · overdue" : ""}
                          </span>
                          <span className="num">{fmt(i.amount)}</span>
                        </li>
                      ))}
                      {b.items.length > 6 && <li>+{b.items.length - 6} more</li>}
                    </ul>
                  )}
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3 py-2 font-medium">
                <span>Safe to spend</span>
                <span className="num">{fmt(data.amount)}</span>
              </li>
            </ul>
            <ul className="grid gap-1 text-[12px] text-muted-foreground">
              {data.method.map((m) => (
                <li key={m} className="flex gap-1.5">
                  <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                  {m}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.unconvertedCurrencies.length > 0 && (
          <p className="mt-2 text-[12.5px] text-warning">Some {data.unconvertedCurrencies.join(", ")} amounts are left out — add exchange rates in Settings.</p>
        )}
      </CardContent>
    </Card>
  );
}
