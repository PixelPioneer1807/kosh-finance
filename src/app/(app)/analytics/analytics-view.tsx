"use client";

import Link from "next/link";
import { BarChart3, Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData, useMoney } from "@/components/app/user-context";
import { useShell } from "@/components/shell/shell-context";
import { COLORS, SERIES } from "@/components/charts/palette";
import {
  ChartCard,
  DataTable,
  DeltaLabel,
  FlowChart,
  HBarList,
  RateLine,
  StatRow,
  StatTile,
  ValueBars,
  formatPct,
  type HBarItem,
} from "@/components/analytics/chart-kit";
import { AnalyticsNav, ParamSegmented, RangePicker } from "@/components/analytics/range-picker";
import { bucketLabel, bucketTitle, KIND_LABELS, type BucketKind } from "@/components/analytics/format";
import { formatDate } from "@/lib/dates";
import { isZero, toNumber } from "@/lib/money";
import { cn } from "@/lib/utils";
import type {
  AccountFlow,
  CategoryBreakdown,
  CategoryTrend,
  LargeTxn,
  MethodSpend,
  PeriodSummary,
  RecurringSplit,
  SeriesPoint,
} from "@/server/services/analytics";

export type AnalyticsViewProps = {
  range: { preset: string; from: string; to: string };
  query: string;
  bucket: BucketKind;
  summary: PeriodSummary;
  series: SeriesPoint[];
  categories: CategoryBreakdown;
  income: CategoryBreakdown;
  accounts: AccountFlow[];
  methods: { total: string; items: MethodSpend[] };
  split: RecurringSplit;
  trends: { months: { key: string; from: string; to: string }[]; categories: CategoryTrend[] };
  largest: LargeTxn[];
};

export function toBarItems(b: CategoryBreakdown, linkRange?: { from: string; to: string }): HBarItem[] {
  const href = (id: string | null) =>
    linkRange ? (id ? `/transactions?category=${id}&from=${linkRange.from}&to=${linkRange.to}` : `/transactions?uncategorized=1&from=${linkRange.from}&to=${linkRange.to}`) : undefined;
  // Categories only present for the period comparison (zero this period) are left out of the bars.
  return b.items.filter((c) => !isZero(c.amount)).map((c) => ({
    id: c.categoryId ?? "none",
    label: c.name,
    icon: c.icon,
    color: c.color,
    value: c.amount,
    share: c.share,
    href: c.children.length ? undefined : href(c.categoryId),
    children: c.children.map((ch) => ({ id: `${c.categoryId}-${ch.categoryId}-${ch.direct ? "d" : ""}`, label: ch.name, value: ch.amount, share: ch.share, href: href(ch.categoryId) })),
  }));
}

export function AnalyticsView(p: AnalyticsViewProps) {
  const fmt = useMoney();
  const { prefs } = useAppData();
  const { openQuickAdd } = useShell();
  const s = p.summary;
  const prevLabel = s.previous ? "vs previous period" : "";
  const empty = s.txCount === 0 && !s.previous?.txCount;
  const exportHref = `/api/export/transactions?${p.range.preset === "all" ? "" : `from=${p.range.from}&to=${p.range.to}`}`;
  const msd = prefs.monthStartDay;
  const flowPoints = p.series.map((x) => ({ key: x.key, label: bucketLabel(x, p.bucket, msd), title: bucketTitle(x, p.bucket, msd), income: x.income, spending: x.spending }));

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Where your money comes from and goes, computed from your transactions."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={exportHref} download>
              <Download /> Export CSV
            </a>
          </Button>
        }
      />
      <AnalyticsNav active="overview" query={p.query} />

      <div className="no-print mb-5 flex flex-wrap items-center gap-2">
        <RangePicker preset={p.range.preset} from={p.range.from} to={p.range.to} />
        <ParamSegmented
          param="bucket"
          ariaLabel="Group by"
          value={p.bucket}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
      </div>

      {empty ? (
        <Card>
          <EmptyState
            icon={<BarChart3 />}
            title="No activity in this range"
            description="Analytics appear once you've recorded income or spending. Try a wider range or add a transaction."
            action={
              <Button onClick={() => openQuickAdd()}>
                <Plus /> Add transaction
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-5">
          <StatRow cols={5}>
            <StatTile label="Income" value={fmt(s.income)} delta={s.deltas && <DeltaLabel pct={s.deltas.income.pct} goodWhen="up" suffix={prevLabel} />} />
            <StatTile
              label="Spending"
              value={fmt(s.spending)}
              delta={s.deltas && <DeltaLabel pct={s.deltas.spending.pct} goodWhen="down" suffix={prevLabel} />}
              hint={toNumber(s.refunds) > 0 ? `after ${fmt(s.refunds)} refunds` : undefined}
            />
            <StatTile label="Saved" value={<span className={cn(toNumber(s.net) < 0 && "text-negative")}>{fmt(s.net)}</span>} delta={s.deltas && <DeltaLabel pct={null} change={s.deltas.net.change} format="money" goodWhen="up" suffix={prevLabel} />} />
            <StatTile label="Savings rate" value={formatPct(s.savingsRate)} delta={s.deltas && s.deltas.savingsRate !== null ? <DeltaLabel pct={s.deltas.savingsRate} format="points" goodWhen="up" suffix={prevLabel} /> : undefined} />
            <StatTile label="Average daily spend" value={fmt(s.avgDailySpend)} hint={`${s.txCount} transactions over ${s.days} day${s.days === 1 ? "" : "s"}`} />
          </StatRow>

          <ChartCard
            title="Income vs spending"
            description={`Per ${p.bucket}. Spending is expenses minus refunds; transfers are excluded.`}
            summary={`Income ${fmt(s.income)} and spending ${fmt(s.spending)} over ${p.series.length} ${p.bucket}s.`}
            table={
              <DataTable
                caption="Income and spending by period"
                columns={[
                  { key: "period", label: "Period" },
                  { key: "income", label: "Income" },
                  { key: "spending", label: "Spending" },
                  { key: "net", label: "Saved" },
                ]}
                rows={p.series.map((x) => ({
                  key: x.key,
                  cells: { period: bucketTitle(x, p.bucket, msd), income: fmt(x.income), spending: fmt(x.spending), net: fmt(x.net) },
                }))}
              />
            }
          >
            <FlowChart points={flowPoints} />
          </ChartCard>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="text-[14px] text-foreground">Spending by category</CardTitle>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">Tap a category with subcategories to expand it.</p>
                </div>
                <span className="num text-[13px] text-muted-foreground">{fmt(p.categories.total)}</span>
              </CardHeader>
              <CardContent>
                <HBarList items={toBarItems(p.categories, p.range)} limit={8} emptyText="No spending in this range." />
              </CardContent>
            </Card>

            <SavingsCard series={p.series} bucket={p.bucket} monthStartDay={msd} rate={s.savingsRate} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <RecurringCard split={p.split} />
            <Card>
              <CardHeader>
                <CardTitle className="text-[14px] text-foreground">By payment method</CardTitle>
              </CardHeader>
              <CardContent>
                <HBarList
                  expandable={false}
                  items={p.methods.items.map((m) => ({ id: m.paymentMethodId ?? "none", label: m.name, icon: methodIcon(m.type), color: "#64748b", value: m.amount, share: m.share, sub: `${m.count} transaction${m.count === 1 ? "" : "s"}` }))}
                  emptyText="No spending in this range."
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-[14px] text-foreground">By account</CardTitle>
              </CardHeader>
              <CardContent>
                {p.accounts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No income or spending in this range.</p>
                ) : (
                  <table className="w-full text-[13px]">
                    <caption className="sr-only">Income and spending per account</caption>
                    <thead className="text-[12px] text-muted-foreground">
                      <tr className="border-b">
                        <th scope="col" className="py-1.5 text-left font-medium">Account</th>
                        <th scope="col" className="py-1.5 text-right font-medium">Income</th>
                        <th scope="col" className="py-1.5 pl-3 text-right font-medium">Spending</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {p.accounts.map((a) => (
                        <tr key={a.accountId}>
                          <th scope="row" className="py-2 text-left font-normal">
                            <Link href={`/transactions?account=${a.accountId}&from=${p.range.from}&to=${p.range.to}`} className="hover:underline">
                              {a.name}
                            </Link>
                            <span className="ml-1.5 text-[12px] text-muted-foreground">{a.count}</span>
                          </th>
                          <td className="num py-2 text-right">{fmt(a.income)}</td>
                          <td className="num py-2 pl-3 text-right">{fmt(a.spending)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-[14px] text-foreground">Income by source</CardTitle>
                <span className="num text-[13px] text-muted-foreground">{fmt(p.income.total)}</span>
              </CardHeader>
              <CardContent>
                <HBarList items={toBarItems(p.income, p.range)} barColor={COLORS.income} limit={6} emptyText="No income in this range." />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <TrendsCard trends={p.trends} monthStartDay={msd} />
            <Card>
              <CardHeader>
                <CardTitle className="text-[14px] text-foreground">Largest expenses</CardTitle>
              </CardHeader>
              <CardContent>
                {p.largest.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No expenses in this range.</p>
                ) : (
                  <ul className="divide-y">
                    {p.largest.map((t) => (
                      <li key={t.id} className="flex items-center gap-3 py-2.5">
                        <CategoryBadge icon={t.categoryIcon} color={t.categoryColor} size="sm" />
                        <div className="min-w-0 flex-1">
                          <Link href={`/transactions?open=${t.id}`} className="block truncate text-[13.5px] hover:underline">
                            {t.merchantName ?? t.notes ?? t.categoryName ?? "Expense"}
                          </Link>
                          <p className="truncate text-[12px] text-muted-foreground">
                            {formatDate(t.date, "d MMM yyyy")} · {t.categoryName ?? "Uncategorized"}
                          </p>
                        </div>
                        <Money amount={t.baseAmount} className="text-[13.5px] font-medium" />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function methodIcon(type: string | null) {
  return { cash: "banknote", credit_card: "credit-card", debit_card: "credit-card", bank_transfer: "landmark", upi: "smartphone", wallet: "wallet" }[type ?? ""] ?? "circle-dashed";
}

function SavingsCard({ series, bucket, monthStartDay, rate }: { series: SeriesPoint[]; bucket: BucketKind; monthStartDay: number; rate: number | null }) {
  const fmt = useMoney();
  const points = series.map((x) => ({ key: x.key, label: bucketLabel(x, bucket, monthStartDay), title: bucketTitle(x, bucket, monthStartDay), value: x.net, rate: x.savingsRate }));
  const showRate = bucket === "month" && points.length >= 2;
  return (
    <ChartCard
      title="Savings"
      description={showRate ? "Saved per month (income − spending) and savings rate" : `Saved per ${bucket} (income − spending). Savings rate: ${formatPct(rate)} for the range.`}
      table={
        <DataTable
          caption="Savings by period"
          columns={[
            { key: "period", label: "Period" },
            { key: "net", label: "Saved" },
            { key: "rate", label: "Rate" },
          ]}
          rows={points.map((x) => ({ key: x.key, cells: { period: x.title, net: fmt(x.value), rate: formatPct(x.rate) } }))}
        />
      }
    >
      <ValueBars points={points} color={COLORS.savings} seriesLabel="Saved" height={showRate ? 160 : 230} />
      {showRate && (
        <div className="mt-3 border-t pt-3">
          <p className="mb-1 text-[12.5px] text-muted-foreground">Savings rate</p>
          <RateLine points={points} color={COLORS.savings} seriesLabel="Savings rate" height={120} />
        </div>
      )}
    </ChartCard>
  );
}

function RecurringCard({ split }: { split: RecurringSplit }) {
  const fmt = useMoney();
  const total = toNumber(split.total);
  const rec = Math.max(0, toNumber(split.recurring));
  const dis = Math.max(0, toNumber(split.discretionary));
  const sum = rec + dis || 1;
  const segs = [
    { label: "Recurring", value: split.recurring, n: rec, count: split.recurringCount, color: SERIES[0] },
    { label: "Discretionary", value: split.discretionary, n: dis, count: split.discretionaryCount, color: SERIES[1] },
  ];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="text-[14px] text-foreground">Recurring vs discretionary</CardTitle>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">Recurring = posted from a bill, subscription or schedule.</p>
        </div>
      </CardHeader>
      <CardContent>
        {total <= 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No spending in this range.</p>
        ) : (
          <>
            <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`Recurring ${fmt(split.recurring)}, discretionary ${fmt(split.discretionary)}`}>
              {segs.map((s) => s.n > 0 && <div key={s.label} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(s.n / sum) * 100}%`, background: s.color }} />)}
            </div>
            <ul className="mt-4 grid gap-2.5">
              {segs.map((s) => (
                <li key={s.label} className="flex items-center gap-2.5 text-[13.5px]">
                  <span className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} aria-hidden />
                  <span className="flex-1">
                    {s.label} <span className="text-[12px] text-muted-foreground">· {s.count}</span>
                  </span>
                  <span className="num font-medium">{fmt(s.value)}</span>
                  <span className="num w-10 text-right text-[12px] text-muted-foreground">{Math.round((s.n / sum) * 100)}%</span>
                </li>
              ))}
            </ul>
            {split.byKind.length > 0 && (
              <p className="mt-3 border-t pt-3 text-[12.5px] text-muted-foreground">
                {split.byKind.map((k) => `${KIND_LABELS[k.kind] ?? k.kind}s ${fmt(k.amount)}`).join(" · ")}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MiniBars({ values, label }: { values: string[]; label: string }) {
  const nums = values.map((v) => Math.max(0, toNumber(v)));
  const max = Math.max(...nums, 0) || 1;
  return (
    <svg viewBox={`0 0 ${values.length * 8} 20`} className="h-5 w-14 shrink-0" role="img" aria-label={label}>
      {nums.map((n, i) => {
        const h = Math.max(1, (n / max) * 20);
        return <rect key={i} x={i * 8 + 1} y={20 - h} width={6} height={h} rx={1.5} fill={i === nums.length - 1 ? COLORS.spending : "var(--muted-foreground)"} fillOpacity={i === nums.length - 1 ? 1 : 0.35} />;
      })}
    </svg>
  );
}

function TrendsCard({ trends, monthStartDay }: { trends: AnalyticsViewProps["trends"]; monthStartDay: number }) {
  const fmt = useMoney();
  const last = trends.months[trends.months.length - 1];
  const up = trends.categories.filter((c) => c.direction === "up").slice(0, 5);
  const down = trends.categories.filter((c) => c.direction === "down").sort((a, b) => toNumber(a.change) - toNumber(b.change)).slice(0, 3);
  const monthName = last ? bucketTitle(last, "month", monthStartDay) : "";
  const row = (c: CategoryTrend) => (
    <li key={c.categoryId ?? "none"} className="flex items-center gap-3 py-2">
      <CategoryBadge icon={c.icon} color={c.color} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px]">{c.name}</p>
        <p className="text-[12px] text-muted-foreground">
          <span className="num">{fmt(c.latest)}</span> vs avg <span className="num">{fmt(c.baseline)}</span>
        </p>
      </div>
      <MiniBars values={c.values} label={`${c.name}, last ${c.values.length} months: ${c.values.map((v) => fmt(v)).join(", ")}`} />
      <DeltaLabel pct={c.changePct} goodWhen="down" suffix="" className="w-16 justify-end" />
    </li>
  );
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="text-[14px] text-foreground">Category trends</CardTitle>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{monthName ? `${monthName} vs the ${trends.months.length - 1} months before` : "Last complete months"}</p>
        </div>
      </CardHeader>
      <CardContent>
        {up.length + down.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No notable changes — spending by category has been steady.</p>
        ) : (
          <>
            {up.length > 0 && (
              <>
                <p className="text-[12px] font-medium text-muted-foreground">Increasing</p>
                <ul className="divide-y">{up.map(row)}</ul>
              </>
            )}
            {down.length > 0 && (
              <>
                <p className="mt-3 text-[12px] font-medium text-muted-foreground">Decreasing</p>
                <ul className="divide-y">{down.map(row)}</ul>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
