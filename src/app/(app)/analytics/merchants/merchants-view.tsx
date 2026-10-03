"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Search, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/misc";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useMoney } from "@/components/app/user-context";
import { COLORS } from "@/components/charts/palette";
import { ChartCard, DataTable, DeltaLabel, StatRow, StatTile, ValueBars } from "@/components/analytics/chart-kit";
import { AnalyticsNav, RangePicker, useUrlParams } from "@/components/analytics/range-picker";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { MerchantDetail, MerchantStat } from "@/server/services/analytics";

type Props = {
  range: { preset: string; from: string; to: string };
  query: string;
  q: string;
  sort: string;
  offset: number;
  pageSize: number;
  stats: { rows: MerchantStat[]; total: number; hasMore: boolean; previousRange: { from: string; to: string } | null };
  detail: MerchantDetail | null;
  detailMissing: boolean;
};

export function MerchantsView(p: Props) {
  const fmt = useMoney();
  const { set, pending } = useUrlParams();
  const [q, setQ] = React.useState(p.q);
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => set({ q: q.trim() || null, offset: null }, { replace: true }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const open = (id: string) => set({ merchant: id }, { scroll: false });
  const trendSuffix = p.stats.previousRange ? "vs previous" : "";

  return (
    <div>
      <PageHeader title="Analytics" description="Where you spend most, how often, and how it's changing." />
      <AnalyticsNav active="merchants" query={p.query} />

      <div className="no-print mb-5 flex flex-wrap items-end gap-2">
        <RangePicker preset={p.range.preset} from={p.range.from} to={p.range.to} resetKeys={["offset", "merchant"]} />
        <div className="relative min-w-48 flex-1 sm:max-w-72">
          <Label htmlFor="merchant-q" className="sr-only">
            Search merchants
          </Label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="merchant-q" type="search" placeholder="Search merchants" value={q} onChange={(e) => setQ(e.target.value)} className="h-10 pl-9 sm:h-9" />
        </div>
        <div className="w-40">
          <Label htmlFor="merchant-sort" className="sr-only">
            Sort by
          </Label>
          <NativeSelect id="merchant-sort" value={p.sort} onChange={(e) => set({ sort: e.target.value, offset: null })} className="h-10 sm:h-9">
            <option value="total">Most spent</option>
            <option value="count">Most visits</option>
            <option value="recent">Most recent</option>
            <option value="change">Biggest increase</option>
          </NativeSelect>
        </div>
      </div>

      <Card className={cn("transition-opacity", pending && "opacity-60")}>
        {p.stats.rows.length === 0 ? (
          <EmptyState
            icon={<Store />}
            title={p.q ? "No merchants match your search" : "No merchant spending in this range"}
            description={p.q ? "Try a different name or a wider date range." : "Add a merchant when you record expenses to see where you spend most."}
          />
        ) : (
          <>
            <table className="w-full text-[13.5px]">
              <caption className="sr-only">Spending by merchant</caption>
              <thead className="hidden text-[12px] text-muted-foreground sm:table-header-group">
                <tr className="border-b">
                  <th scope="col" className="px-5 py-2.5 text-left font-medium">Merchant</th>
                  <th scope="col" className="py-2.5 pl-3 text-right font-medium">Visits</th>
                  <th scope="col" className="py-2.5 pl-3 text-right font-medium">Average</th>
                  <th scope="col" className="py-2.5 pl-3 text-right font-medium">Last</th>
                  <th scope="col" className="py-2.5 pl-3 text-right font-medium">Change</th>
                  <th scope="col" className="py-2.5 pr-5 pl-3 text-right font-medium">Spent</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {p.stats.rows.map((m) => (
                  <tr key={m.merchantId} className="cursor-pointer hover:bg-subtle" onClick={() => open(m.merchantId)}>
                    <th scope="row" className="px-5 py-2.5 text-left font-normal">
                      <div className="flex items-center gap-3">
                        <CategoryBadge icon={m.categoryIcon ?? "store"} color={m.categoryColor} size="sm" />
                        <div className="min-w-0">
                          <button
                            type="button"
                            className="block max-w-[40vw] truncate text-left font-medium hover:underline sm:max-w-64"
                            onClick={(e) => {
                              e.stopPropagation();
                              open(m.merchantId);
                            }}
                          >
                            {m.name}
                          </button>
                          <p className="text-[12px] text-muted-foreground sm:hidden">
                            {m.count} visit{m.count === 1 ? "" : "s"} · avg {fmt(m.avg)}
                          </p>
                        </div>
                      </div>
                    </th>
                    <td className="num hidden py-2.5 pl-3 text-right sm:table-cell">{m.count}</td>
                    <td className="num hidden py-2.5 pl-3 text-right sm:table-cell">{fmt(m.avg)}</td>
                    <td className="hidden py-2.5 pl-3 text-right text-muted-foreground sm:table-cell">{m.lastDate ? formatDate(m.lastDate, "d MMM") : "—"}</td>
                    <td className="hidden py-2.5 pl-3 text-right sm:table-cell">
                      <DeltaLabel pct={m.delta.pct} goodWhen="down" suffix="" className="justify-end" />
                    </td>
                    <td className="py-2.5 pr-5 pl-3 text-right">
                      <Money amount={m.total} className="font-medium" />
                      <div className="sm:hidden">
                        <DeltaLabel pct={m.delta.pct} goodWhen="down" suffix={trendSuffix} className="justify-end text-[11.5px]" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(p.offset > 0 || p.stats.hasMore) && (
              <div className="no-print flex items-center justify-between border-t px-5 py-3 text-[13px] text-muted-foreground">
                <span>
                  {p.offset + 1}–{p.offset + p.stats.rows.length} of {p.stats.total}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={p.offset === 0} onClick={() => set({ offset: String(Math.max(0, p.offset - p.pageSize)) })}>
                    Previous
                  </Button>
                  <Button size="sm" variant="outline" disabled={!p.stats.hasMore} onClick={() => set({ offset: String(p.offset + p.pageSize) })}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Dialog open={Boolean(p.detail) || p.detailMissing} onOpenChange={(o) => !o && set({ merchant: null })}>
        {p.detail ? (
          <DialogContent size="lg" title={p.detail.merchant.name} description={p.detail.merchant.defaultCategoryName ? `Usually ${p.detail.merchant.defaultCategoryName}` : undefined}>
            <MerchantDetailBody d={p.detail} />
          </DialogContent>
        ) : p.detailMissing ? (
          <DialogContent size="sm" title="Merchant not found">
            <ErrorState message="This merchant doesn't exist or isn't yours." />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function MerchantDetailBody({ d }: { d: MerchantDetail }) {
  const fmt = useMoney();
  const points = d.monthly.map((m) => ({
    key: m.key,
    label: formatDate(m.key, "MMM"),
    title: `${formatDate(m.from, "d MMM")} – ${formatDate(m.to, "d MMM yyyy")}`,
    value: m.total,
    note: `${m.count} visit${m.count === 1 ? "" : "s"}`,
  }));
  return (
    <div className="grid gap-4">
      <StatRow cols={4}>
        <StatTile label="Total spent" value={fmt(d.lifetime.total)} />
        <StatTile label="Visits" value={d.lifetime.count} />
        <StatTile label="Average" value={fmt(d.lifetime.avg)} />
        <StatTile label="Last visit" value={d.lifetime.lastDate ? formatDate(d.lifetime.lastDate, "d MMM yyyy") : "—"} />
      </StatRow>
      <ChartCard
        title="Monthly spending"
        description="Last 12 months"
        table={
          <DataTable
            caption={`Monthly spending at ${d.merchant.name}`}
            columns={[
              { key: "m", label: "Month" },
              { key: "n", label: "Visits" },
              { key: "v", label: "Spent" },
            ]}
            rows={points.map((x) => ({ key: x.key, cells: { m: x.title, n: x.note, v: fmt(x.value) } }))}
          />
        }
      >
        <ValueBars points={points} color={COLORS.spending} seriesLabel="Spent" height={180} />
      </ChartCard>
      {d.categories.length > 0 && (
        <div>
          <p className="mb-1 text-[12.5px] font-medium text-muted-foreground">Categories</p>
          <ul className="divide-y">
            {d.categories.map((c) => (
              <li key={c.categoryId ?? "none"} className="flex items-center gap-3 py-2 text-[13.5px]">
                <CategoryBadge icon={c.icon} color={c.color} size="sm" />
                <span className="flex-1 truncate">{c.name}</span>
                <Money amount={c.amount} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[12.5px] font-medium text-muted-foreground">Recent transactions</p>
          <Link href={`/transactions?merchant=${d.merchant.id}`} className="inline-flex min-h-8 items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
            View all <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
        <ul className="divide-y">
          {d.recent.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2 text-[13.5px]">
              <span className="w-20 shrink-0 text-muted-foreground">{formatDate(t.date, "d MMM yy")}</span>
              <span className="min-w-0 flex-1 truncate">{t.categoryName ?? (t.hasSplits ? "Split" : "Uncategorized")}</span>
              <Money amount={t.amount} currency={t.currency} direction={t.type === "expense" ? "out" : t.type === "refund" || t.type === "income" ? "in" : "neutral"} tone="flow" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
