"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { Segmented } from "@/components/ui/controls";
import { useAppData, useMoney } from "@/components/app/user-context";
import { COLORS, SERIES } from "@/components/charts/palette";
import { formatDate } from "@/lib/dates";
import { sub, toNumber } from "@/lib/money";
import type { NetWorthPoint } from "@/server/services/networth";

type Row = NetWorthPoint & { x: number; y: number; label: string };

/**
 * Net worth over time — one series (no legend; the card title names it), 2px line over a ~10%
 * wash, hairline horizontal grid, crosshair tooltip listing net worth, assets and liabilities.
 * A table view carries every value for keyboard/screen-reader users.
 */
export function NetWorthChart({ points, currency }: { points: NetWorthPoint[]; currency: string }) {
  const fmt = useMoney();
  const { prefs } = useAppData();
  const [view, setView] = React.useState<"chart" | "table">("chart");
  const rows: Row[] = points.map((p, i) => ({
    ...p,
    x: i,
    y: toNumber(p.netWorth),
    label: p.date === prefs.today ? "Today" : formatDate(p.date, "MMM yy"),
  }));
  const first = points[0];
  const last = points[points.length - 1];
  const min = Math.min(...rows.map((r) => r.y));
  const max = Math.max(...rows.map((r) => r.y));
  const tableId = React.useId();

  const tooltip = ({ active, payload }: TooltipContentProps<ValueType, NameType>) => {
    const row = active && payload?.[0]?.payload ? (payload[0].payload as Row) : null;
    if (!row) return null;
    return (
      <div className="min-w-44 rounded-lg border bg-popover px-3 py-2 text-[12.5px] shadow-md">
        <p className="mb-1.5 text-muted-foreground">{row.date === prefs.today ? "Today" : formatDate(row.date)}</p>
        <div className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: SERIES[0] }} aria-hidden />
          <span className="num flex-1 text-right text-sm font-semibold">{fmt(row.netWorth, currency)}</span>
        </div>
        <p className="text-right text-muted-foreground">Net worth</p>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 border-t pt-1.5">
          <dt className="text-muted-foreground">Assets</dt>
          <dd className="num text-right">{fmt(row.assets, currency)}</dd>
          <dt className="text-muted-foreground">Liabilities</dt>
          <dd className="num text-right">{fmt(row.liabilities, currency)}</dd>
        </dl>
      </div>
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          {first && last && (
            <>
              {formatDate(first.date, "MMM yyyy")} → today ·{" "}
              <span className="num text-foreground">{fmt(sub(last.netWorth, first.netWorth), currency, { signed: true })}</span>
            </>
          )}
        </p>
        <Segmented
          size="sm"
          ariaLabel="Show history as"
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]}
        />
      </div>

      {view === "chart" ? (
        <figure aria-describedby={`${tableId}-summary`}>
          <div className="h-64 w-full sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={COLORS.grid} strokeWidth={1} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: COLORS.grid }}
                  tick={{ fill: COLORS.axis, fontSize: 12 }}
                  interval="preserveStartEnd"
                  minTickGap={16}
                  height={28}
                />
                <YAxis
                  width={64}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: COLORS.axis, fontSize: 12 }}
                  tickFormatter={(v: number) => fmt(v, currency, { compact: true })}
                  domain={[min >= 0 ? 0 : "auto", max <= 0 ? 0 : "auto"]}
                  tickCount={5}
                />
                <Tooltip content={tooltip} cursor={{ stroke: COLORS.axis, strokeWidth: 1, strokeOpacity: 0.5 }} isAnimationActive={false} />
                <Area
                  type="monotone"
                  dataKey="y"
                  name="Net worth"
                  stroke={SERIES[0]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  fill={SERIES[0]}
                  fillOpacity={0.1}
                  dot={false}
                  activeDot={{ r: 5, fill: SERIES[0], stroke: "var(--card)", strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <figcaption id={`${tableId}-summary`} className="sr-only">
            Net worth at each month end{first ? ` from ${formatDate(first.date)}` : ""} to today: {first ? fmt(first.netWorth, currency) : ""} to {last ? fmt(last.netWorth, currency) : ""}.
            Lowest {fmt(min, currency)}, highest {fmt(max, currency)}. Switch to the table view for every value.
          </figcaption>
        </figure>
      ) : (
        <div className="-mx-5 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[480px] text-[13px]">
            <caption className="sr-only">Net worth by month end, in {currency}</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="px-5 py-2 font-medium sm:px-2">Date</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Assets</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Liabilities</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Net worth</th>
                <th scope="col" className="px-5 py-2 text-right font-medium sm:px-2">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...points].reverse().map((p, i, arr) => {
                const prev = arr[i + 1];
                return (
                  <tr key={p.date}>
                    <th scope="row" className="px-5 py-2 text-left font-normal sm:px-2">
                      {p.date === prefs.today ? "Today" : formatDate(p.date)}
                    </th>
                    <td className="num px-2 py-2 text-right">{fmt(p.assets, currency)}</td>
                    <td className="num px-2 py-2 text-right">{fmt(p.liabilities, currency)}</td>
                    <td className="num px-2 py-2 text-right font-medium">{fmt(p.netWorth, currency)}</td>
                    <td className="num px-5 py-2 text-right text-muted-foreground sm:px-2">{prev ? fmt(sub(p.netWorth, prev.netWorth), currency, { signed: true }) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
