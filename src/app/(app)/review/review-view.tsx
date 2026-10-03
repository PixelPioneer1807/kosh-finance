"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, CalendarCheck, ChevronLeft, ChevronRight, Info, Loader2, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, Progress } from "@/components/ui/misc";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData, useMoney } from "@/components/app/user-context";
import { DeltaLabel, HBarList, StatRow, StatTile, formatPct } from "@/components/analytics/chart-kit";
import { KIND_LABELS } from "@/components/analytics/format";
import { toBarItems } from "../analytics/analytics-view";
import { formatDate } from "@/lib/dates";
import { toNumber } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { MonthlyReview } from "@/server/services/review";

function monthName(m: string, monthStartDay: number) {
  return monthStartDay > 1 ? `From ${formatDate(`${m}-${String(monthStartDay).padStart(2, "0")}`, "d MMM yyyy")}` : formatDate(`${m}-01`, "MMMM yyyy");
}

function SectionCard({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle className="text-[14px] text-foreground">{title}</CardTitle>
          {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="py-4 text-center text-sm text-muted-foreground">{children}</p>;

export function ReviewView({ review: r, months }: { review: MonthlyReview; months: string[] }) {
  const fmt = useMoney();
  const { prefs } = useAppData();
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (m: string) => start(() => router.push(`/review?month=${m}`));
  const idx = months.indexOf(r.month);
  const older = idx >= 0 ? months[idx + 1] : undefined;
  const newer = idx > 0 ? months[idx - 1] : undefined;
  const s = r.summary;
  const avg = r.threeMonthAverage;
  const hasData = s.txCount > 0;

  return (
    <div className={cn("transition-opacity", pending && "opacity-60")}>
      <PageHeader
        title="Monthly review"
        description="A look back at one month — every line below is computed from your data."
        actions={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" disabled={!older} onClick={() => older && go(older)} aria-label="Previous month">
              <ChevronLeft />
            </Button>
            <Label htmlFor="review-month" className="sr-only">
              Month
            </Label>
            <NativeSelect id="review-month" value={r.month} onChange={(e) => go(e.target.value)} className="h-9 w-44">
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthName(m, prefs.monthStartDay)}
                </option>
              ))}
            </NativeSelect>
            <Button variant="outline" size="icon" disabled={!newer} onClick={() => newer && go(newer)} aria-label="Next month">
              <ChevronRight />
            </Button>
            {pending && <Loader2 className="ml-1 size-4 animate-spin text-muted-foreground" aria-label="Loading" />}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <span>
          {formatDate(r.range.from, "d MMM")} – {formatDate(r.range.to, "d MMM yyyy")}
        </span>
        {!r.complete && <Badge variant="info">In progress — figures so far</Badge>}
      </div>

      {!hasData ? (
        <Card>
          <EmptyState icon={<CalendarCheck />} title="Nothing recorded this month" description="Once you add income and expenses for this month, its review appears here." />
        </Card>
      ) : (
        <div className="grid gap-5">
          <StatRow cols={4}>
            <StatTile
              label="Income"
              value={fmt(s.income)}
              delta={s.deltas && <DeltaLabel pct={s.deltas.income.pct} goodWhen="up" suffix="vs last month" />}
              hint={avg.months ? `${avg.months}-month avg ${fmt(avg.income)}` : undefined}
            />
            <StatTile
              label="Spending"
              value={fmt(s.spending)}
              delta={s.deltas && <DeltaLabel pct={s.deltas.spending.pct} goodWhen="down" suffix="vs last month" />}
              hint={avg.months ? <DeltaLabel pct={r.vsAverage.spending.pct} goodWhen="down" suffix={`vs ${avg.months}-month avg`} /> : undefined}
            />
            <StatTile label="Saved" value={<span className={cn(toNumber(s.net) < 0 && "text-negative")}>{fmt(s.net)}</span>} hint={avg.months ? `${avg.months}-month avg ${fmt(avg.net)}` : undefined} />
            <StatTile
              label="Savings rate"
              value={formatPct(s.savingsRate)}
              delta={s.deltas && s.deltas.savingsRate !== null ? <DeltaLabel pct={s.deltas.savingsRate} format="points" goodWhen="up" suffix="vs last month" /> : undefined}
              hint={avg.months && avg.savingsRate !== null ? `${avg.months}-month avg ${formatPct(avg.savingsRate)}` : undefined}
            />
          </StatRow>

          <SectionCard title="The month in numbers" description="Facts computed from your transactions — not advice.">
            <ul className="grid gap-2.5">
              {r.facts.map((f) => {
                const Icon = f.tone === "positive" ? ArrowUpRight : f.tone === "negative" ? ArrowDownRight : Minus;
                return (
                  <li key={f.id} className="flex gap-2.5 text-[14px] leading-snug">
                    <Icon className={cn("mt-0.5 size-4 shrink-0", f.tone === "positive" ? "text-positive" : f.tone === "negative" ? "text-negative" : "text-muted-foreground")} aria-hidden />
                    <span>{f.text}</span>
                  </li>
                );
              })}
            </ul>
          </SectionCard>

          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Largest categories">
              <HBarList items={toBarItems({ range: r.range, previousRange: null, total: s.spending, items: r.categories }, r.range)} limit={6} emptyText="No spending this month." />
            </SectionCard>
            <SectionCard title="Notable changes" description="Categories that moved at least 20% vs last month">
              {r.notableChanges.length === 0 ? (
                <Empty>No big swings — categories were close to last month.</Empty>
              ) : (
                <ul className="divide-y">
                  {r.notableChanges.map((c) => (
                    <li key={c.categoryId ?? "none"} className="flex items-center gap-3 py-2.5">
                      <CategoryBadge icon={c.icon} color={c.color} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px]">{c.name}</p>
                        <p className="text-[12px] text-muted-foreground">
                          <span className="num">{fmt(c.previous)}</span> → <span className="num">{fmt(c.amount)}</span>
                        </p>
                      </div>
                      {c.pct === null ? <Badge variant="outline">New</Badge> : <DeltaLabel pct={c.pct} goodWhen="down" suffix="" />}
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          <SectionCard title="Budgets" description={r.budgets.items.length ? `${r.budgets.under} within · ${r.budgets.near} near the limit · ${r.budgets.over} over` : undefined}>
            {r.budgets.items.length === 0 ? (
              <Empty>
                No monthly budgets.{" "}
                <Link href="/budgets" className="underline underline-offset-2">
                  Set one up
                </Link>
              </Empty>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {r.budgets.items.map((b) => (
                  <li key={b.budgetId}>
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-[13.5px]">
                      <span className="flex min-w-0 items-center gap-2">
                        {b.categoryIcon && <CategoryBadge icon={b.categoryIcon} color={b.categoryColor} size="sm" />}
                        <span className="truncate">{b.name}</span>
                      </span>
                      <span className="num shrink-0">
                        {fmt(b.spent)} <span className="text-muted-foreground">/ {fmt(b.limit)}</span>
                      </span>
                    </div>
                    <Progress value={b.used} tone={b.status === "over" ? "negative" : b.status === "near" ? "warning" : "positive"} label={`${b.name}: ${Math.round(b.used * 100)}% used`} />
                    <p className={cn("mt-1 text-[12px]", b.status === "over" ? "text-negative" : "text-muted-foreground")}>
                      {b.status === "over" ? `Over by ${fmt(b.remaining.replace("-", ""))}` : `${fmt(b.remaining)} left`} · {Math.round(b.used * 100)}% used
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Recurring & subscriptions" description={`Posted from your schedules: ${fmt(r.recurring.total)}`}>
              {r.recurring.items.length === 0 ? (
                <Empty>No recurring payments were recorded this month.</Empty>
              ) : (
                <ul className="divide-y">
                  {r.recurring.items.map((i) => (
                    <li key={i.recurringId} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                      <span className="min-w-0">
                        <Link href={`/recurring?open=${i.recurringId}`} className="block truncate hover:underline">
                          {i.name}
                        </Link>
                        <span className="text-[12px] text-muted-foreground">{KIND_LABELS[i.kind] ?? i.kind}</span>
                      </span>
                      <Money amount={i.amount} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard title="Goal contributions" description={toNumber(r.goals.total) ? `Total ${fmt(r.goals.total)}` : undefined}>
              {r.goals.items.length === 0 ? (
                <Empty>No goal contributions this month.</Empty>
              ) : (
                <ul className="divide-y">
                  {r.goals.items.map((g) => (
                    <li key={g.goalId} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                      <span className="truncate">{g.name}</span>
                      <Money amount={g.amount} currency={g.currency} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Largest expenses">
              {r.largestTransactions.length === 0 ? (
                <Empty>No expenses.</Empty>
              ) : (
                <ul className="divide-y">
                  {r.largestTransactions.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 py-2">
                      <CategoryBadge icon={t.categoryIcon} color={t.categoryColor} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link href={`/transactions?open=${t.id}`} className="block truncate text-[13.5px] hover:underline">
                          {t.merchantName ?? t.notes ?? t.categoryName ?? "Expense"}
                        </Link>
                        <p className="text-[12px] text-muted-foreground">{formatDate(t.date, "EEE d MMM")}</p>
                      </div>
                      <Money amount={t.baseAmount} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard title="Top merchants">
              {r.topMerchants.length === 0 ? (
                <Empty>No merchant spending.</Empty>
              ) : (
                <ul className="divide-y">
                  {r.topMerchants.map((m) => (
                    <li key={m.merchantId} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                      <span className="min-w-0">
                        <Link href={`/analytics/merchants?merchant=${m.merchantId}`} className="block truncate hover:underline">
                          {m.name}
                        </Link>
                        <span className="text-[12px] text-muted-foreground">
                          {m.count} purchase{m.count === 1 ? "" : "s"}
                        </span>
                      </span>
                      <Money amount={m.total} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          <SectionCard title="Days with no spending" description={`${r.noSpendDays.count} of ${r.noSpendDays.ofDays} days`}>
            {r.noSpendDays.count === 0 ? (
              <Empty>Every day this month had some spending.</Empty>
            ) : (
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">{r.noSpendDays.days.map((d) => formatDate(d, "EEE d")).join(" · ")}</p>
            )}
          </SectionCard>

          <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Spending is expenses minus refunds in your base currency. Transfers, balance adjustments and categories excluded from reports aren&apos;t counted.
          </p>
        </div>
      )}
    </div>
  );
}
