"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarDays, ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { useAppData, useMoney } from "@/components/app/user-context";
import { useShell } from "@/components/shell/shell-context";
import { HeatStrip, StatRow, StatTile } from "@/components/analytics/chart-kit";
import { TxnLine } from "@/components/analytics/txn-line";
import { AnalyticsNav, RangePicker } from "@/components/analytics/range-picker";
import { relativeDayLabel } from "@/lib/dates";
import { isZero, toNumber } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { DailyBreakdown } from "@/server/services/analytics";

const TXN_PREVIEW = 30;

export function DailyView({ range, query, data }: { range: { preset: string; from: string; to: string }; query: string; data: DailyBreakdown }) {
  const fmt = useMoney();
  const { prefs } = useAppData();
  const { openQuickAdd } = useShell();
  const [onlyActive, setOnlyActive] = React.useState(true);
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(data.days.filter((d) => d.count > 0).slice(0, 1).map((d) => d.date)));
  const [selected, setSelected] = React.useState<string | null>(null);
  const days = onlyActive ? data.days.filter((d) => d.count > 0) : data.days;
  const toggle = (date: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(date)) n.delete(date);
      else n.add(date);
      return n;
    });
  const jump = (date: string) => {
    setSelected(date);
    setOnlyActive(false);
    setOpen((s) => new Set(s).add(date));
    requestAnimationFrame(() => document.getElementById(`day-${date}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div>
      <PageHeader title="Analytics" description="Day-by-day income and spending." />
      <AnalyticsNav active="daily" query={query} />
      <div className="no-print mb-5 flex flex-wrap items-center gap-2">
        <RangePicker preset={range.preset} from={range.from} to={range.to} />
        {data.truncated && <p className="text-[12.5px] text-muted-foreground">Showing the most recent {data.days.length} days.</p>}
      </div>

      <div className="grid gap-5">
        <StatRow cols={4}>
          <StatTile label="Spending" value={fmt(data.totals.spending)} hint={`${fmt(data.totals.avgDailySpend)} a day on average`} />
          <StatTile label="Income" value={fmt(data.totals.income)} />
          <StatTile label="Transactions" value={data.totals.count} />
          <StatTile label="Days with no spending" value={`${data.totals.noSpendDays} of ${data.days.length}`} />
        </StatRow>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="text-[14px] text-foreground">Daily spending</CardTitle>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">Darker means more spent that day. Select a day to see its transactions.</p>
            </div>
          </CardHeader>
          <CardContent>
            <HeatStrip days={data.days} weekStartsOn={prefs.weekStartsOn} onSelect={jump} selected={selected} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="items-center">
            <CardTitle className="text-[14px] text-foreground">Days</CardTitle>
            <div className="no-print flex items-center gap-2">
              <Switch id="only-active" checked={onlyActive} onCheckedChange={setOnlyActive} />
              <Label htmlFor="only-active" className="text-[13px] font-normal text-muted-foreground">
                Only days with activity
              </Label>
            </div>
          </CardHeader>
          {days.length === 0 ? (
            <EmptyState
              icon={<CalendarDays />}
              title="No transactions in this range"
              action={
                <Button onClick={() => openQuickAdd()}>
                  <Plus /> Add transaction
                </Button>
              }
            />
          ) : (
            <ul className="divide-y border-t">
              {days.map((d) => {
                const isOpen = open.has(d.date);
                const shown = d.transactions.slice(0, TXN_PREVIEW);
                return (
                  <li key={d.date} id={`day-${d.date}`} className={cn("scroll-mt-20", selected === d.date && "bg-subtle")}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`day-${d.date}-list`}
                      onClick={() => toggle(d.date)}
                      disabled={d.count === 0}
                      className="flex min-h-14 w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-subtle disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-medium">{relativeDayLabel(d.date, prefs.today)}</p>
                        <p className="text-[12px] text-muted-foreground">
                          {d.count === 0 ? "No transactions" : `${d.count} transaction${d.count === 1 ? "" : "s"}`}
                          {!isZero(d.income) && (
                            <>
                              {" · "}
                              <span className="num text-positive">+{fmt(d.income)}</span> in
                            </>
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="num text-[14px] font-medium">{toNumber(d.spending) === 0 ? "—" : fmt(d.spending)}</p>
                        <p className={cn("num text-[12px]", toNumber(d.net) < 0 ? "text-muted-foreground" : "text-positive")}>net {fmt(d.net, undefined, { signed: true })}</p>
                      </div>
                      {d.count > 0 && <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} aria-hidden />}
                    </button>
                    {isOpen && d.count > 0 && (
                      <div id={`day-${d.date}-list`} className="px-5 pb-3">
                        <ul className="divide-y rounded-lg border px-3">
                          {shown.map((t) => (
                            <TxnLine key={t.id} t={t} />
                          ))}
                        </ul>
                        <div className="mt-2 flex flex-wrap gap-3 text-[13px]">
                          {(d.transactions.length > TXN_PREVIEW || (data.transactionsTruncated && d.transactions.length < d.count)) && (
                            <Link href={`/transactions?from=${d.date}&to=${d.date}`} className="text-muted-foreground hover:text-foreground">
                              See all {d.count} →
                            </Link>
                          )}
                          <button type="button" className="no-print min-h-8 text-muted-foreground hover:text-foreground" onClick={() => openQuickAdd({ date: d.date })}>
                            + Add for this day
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
