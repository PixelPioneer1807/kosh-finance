"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { COLORS } from "@/components/charts/palette";
import { useMoney } from "@/components/app/user-context";
import { cmp, sub, toNumber } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

export type HistoryPoint = { from: string; to: string; spent: string; amount: string; current: boolean };

export function periodLabel(p: { from: string; to: string }, period: string) {
  if (period === "yearly") return formatDate(p.from, "yyyy");
  if (period === "monthly") return p.from.endsWith("-01") ? formatDate(p.from, "MMM") : `${formatDate(p.from, "d MMM")}`;
  return formatDate(p.from, "d MMM");
}

/** Spending per period (bars) against the budget line. One series → no legend; the title names it. */
export function BudgetHistoryChart({ points, period }: { points: HistoryPoint[]; period: string }) {
  const fmt = useMoney();
  const data = points.map((p) => ({
    ...p,
    label: periodLabel(p, period) + (p.current ? " (so far)" : ""),
    value: toNumber(p.spent),
    budget: toNumber(p.amount),
  }));
  const budget = data[data.length - 1]?.budget ?? 0;
  const max = Math.max(budget, ...data.map((d) => d.value));
  return (
    <div className="grid gap-3">
      <div className="h-44 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: COLORS.axis, fontSize: 11.5 }}
              interval={0}
              tickFormatter={(l: string) => l.replace(" (so far)", "")}
            />
            <YAxis
              width={56}
              tickLine={false}
              axisLine={false}
              tick={{ fill: COLORS.axis, fontSize: 11.5 }}
              domain={[0, Math.ceil(max * 1.1) || 1]}
              tickFormatter={(v: number) => fmt(String(v), undefined, { compact: true })}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.6 }}
              content={({ active, payload }) => {
                const d = active && payload?.[0]?.payload;
                if (!d) return null;
                const diff = sub(d.spent, d.amount);
                const over = cmp(diff, "0") > 0;
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-[12.5px] shadow-md">
                    <p className="font-medium">
                      {formatDate(d.from, "d MMM")} – {formatDate(d.to, "d MMM yyyy")}
                      {d.current ? " · so far" : ""}
                    </p>
                    <p className="num mt-1">Spent {fmt(d.spent)}</p>
                    <p className="num text-muted-foreground">
                      {over ? `${fmt(diff)} over` : `${fmt(sub(d.amount, d.spent))} under`} {fmt(d.amount)}
                    </p>
                  </div>
                );
              }}
            />
            <ReferenceLine
              y={budget}
              stroke={COLORS.text}
              strokeOpacity={0.55}
              strokeWidth={1}
              label={{ value: "Budget", position: "insideTopRight", fill: COLORS.axis, fontSize: 11 }}
            />
            <Bar dataKey="value" fill={COLORS.spending} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="w-full text-[13px]">
        <caption className="sr-only">Spending per period compared with the budget</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Spent</th>
            <th scope="col">Difference</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {[...points].reverse().map((p) => {
            const diff = sub(p.spent, p.amount);
            const over = cmp(diff, "0") > 0;
            return (
              <tr key={p.from}>
                <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                  {formatDate(p.from, "d MMM")} – {formatDate(p.to, "d MMM yyyy")}
                  {p.current ? " · so far" : ""}
                </th>
                <td className="num py-1.5 text-right">{fmt(p.spent)}</td>
                <td className={cn("num w-28 py-1.5 text-right", over ? "text-negative" : "text-muted-foreground")}>
                  {over ? `+${fmt(diff)} over` : `${fmt(sub(p.amount, p.spent))} left`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
