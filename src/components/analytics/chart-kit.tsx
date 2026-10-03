"use client";

/**
 * Chart building blocks for analytics, calendar, review and reports.
 *
 * Follows the dataviz rules in docs/CONVENTIONS.md: colours from `palette.ts` by role, one y-axis,
 * thin marks (≤24px bars with 4px rounded data-ends, 2px lines), hairline solid grid, text in text
 * tokens, a legend for ≥2 series, forecasts dashed in the forecast grey, a hover tooltip on every
 * chart, and a table view for every chart.
 */
import * as React from "react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { COLORS } from "@/components/charts/palette";
import { CategoryBadge } from "@/components/app/icons";
import { useMoney } from "@/components/app/user-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { Tooltip as Tip } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { toNumber } from "@/lib/money";
import { formatDate, toDate } from "@/lib/dates";

/* ───────────── Frame: chart ⇄ table ───────────── */

/**
 * Card with a title and a Chart/Table switch. The chart is hidden from screen readers (the table
 * is the accessible equivalent and is always in the DOM, visually hidden while the chart shows).
 */
export function ChartCard({
  title,
  description,
  actions,
  table,
  children,
  className,
  summary,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  table: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** One-sentence summary read by screen readers in place of the chart. */
  summary?: string;
}) {
  const [view, setView] = React.useState<"chart" | "table">("chart");
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex-wrap">
        <div className="min-w-0">
          <CardTitle className="text-[14px] font-medium text-foreground">{title}</CardTitle>
          {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
        <div className="no-print flex items-center gap-2">
          {actions}
          <Segmented
            size="sm"
            ariaLabel="Display as"
            value={view}
            onChange={setView}
            options={[
              { value: "chart", label: "Chart" },
              { value: "table", label: "Table" },
            ]}
          />
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {summary && <p className="sr-only">{summary}</p>}
        <div className={cn(view === "table" && "hidden")} aria-hidden>
          {children}
        </div>
        <div className={cn(view === "chart" && "sr-only")}>{table}</div>
      </CardContent>
    </Card>
  );
}

/** Plain data table used as the accessible twin of a chart. */
export function DataTable({
  caption,
  columns,
  rows,
  className,
}: {
  caption: string;
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: { key: string; cells: Record<string, React.ReactNode> }[];
  className?: string;
}) {
  return (
    <div className={cn("max-h-80 overflow-auto", className)}>
      <table className="w-full text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card text-[12px] text-muted-foreground">
          <tr className="border-b">
            {columns.map((c, i) => (
              <th key={c.key} scope="col" className={cn("py-1.5 font-medium", (c.align ?? (i === 0 ? "left" : "right")) === "right" ? "text-right" : "text-left", i > 0 && "pl-3")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.key}>
              {columns.map((c, i) =>
                i === 0 ? (
                  <th key={c.key} scope="row" className="py-1.5 text-left font-normal">
                    {r.cells[c.key]}
                  </th>
                ) : (
                  <td key={c.key} className={cn("num py-1.5 pl-3", (c.align ?? "right") === "right" ? "text-right" : "text-left")}>
                    {r.cells[c.key]}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────── Tooltip ───────────── */

type TipRow = { label: string; value: string; color?: string; dashed?: boolean };

/** Tooltip body: values lead (strong), series names follow, keyed by a short line in the series colour. */
export function TooltipBox({ title, rows, note }: { title: React.ReactNode; rows: TipRow[]; note?: React.ReactNode }) {
  return (
    <div className="min-w-36 rounded-lg border bg-popover px-3 py-2 text-[12.5px] shadow-md">
      <p className="mb-1 text-muted-foreground">{title}</p>
      <ul className="grid gap-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.color && (
              <svg width="12" height="4" aria-hidden className="shrink-0">
                <line x1="0" y1="2" x2="12" y2="2" stroke={r.color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={r.dashed ? "3 2" : undefined} />
              </svg>
            )}
            <span className="num font-semibold text-foreground">{r.value}</span>
            <span className="text-muted-foreground">{r.label}</span>
          </li>
        ))}
      </ul>
      {note && <p className="mt-1 text-[11.5px] text-muted-foreground">{note}</p>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; kind?: "bar" | "line" | "dashed" }[] }) {
  return (
    <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground" aria-hidden>
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          {i.kind === "bar" || !i.kind ? (
            <span className="inline-block size-2.5 rounded-[3px]" style={{ background: i.color }} />
          ) : (
            <svg width="14" height="4">
              <line x1="0" y1="2" x2="14" y2="2" stroke={i.color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={i.kind === "dashed" ? "3 2" : undefined} />
            </svg>
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

const axisTick = { fill: COLORS.axis, fontSize: 11.5 };

function useCompact() {
  const fmt = useMoney();
  return React.useCallback((v: number) => fmt(String(v), undefined, { compact: true }), [fmt]);
}

/* ───────────── Income vs spending (grouped bars, one axis) ───────────── */

export type FlowPoint = { key: string; label: string; title: string; income: string; spending: string };

export function FlowChart({ points, height = 240 }: { points: FlowPoint[]; height?: number }) {
  const fmt = useMoney();
  const compact = useCompact();
  const data = points.map((p) => ({ ...p, inc: toNumber(p.income), spd: Math.max(0, toNumber(p.spending)) }));
  return (
    <>
      <Legend
        items={[
          { label: "Income", color: COLORS.income },
          { label: "Spending", color: COLORS.spending },
        ]}
      />
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barGap={2} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: COLORS.grid }} tick={axisTick} minTickGap={12} />
            <YAxis width={56} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={compact} />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.6 }}
              content={({ active, payload }) => {
                const d = active && (payload?.[0]?.payload as (typeof data)[number] | undefined);
                if (!d) return null;
                return (
                  <TooltipBox
                    title={d.title}
                    rows={[
                      { label: "Income", value: fmt(d.income), color: COLORS.income },
                      { label: "Spending", value: fmt(d.spending), color: COLORS.spending },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="inc" name="Income" fill={COLORS.income} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
            <Bar dataKey="spd" name="Spending" fill={COLORS.spending} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/* ───────────── Single series bars (savings, merchant months…) ───────────── */

export type ValuePoint = { key: string; label: string; title: string; value: string; note?: string };

export function ValueBars({ points, color, seriesLabel, height = 200 }: { points: ValuePoint[]; color: string; seriesLabel: string; height?: number }) {
  const fmt = useMoney();
  const compact = useCompact();
  const data = points.map((p) => ({ ...p, v: toNumber(p.value) }));
  const hasNegative = data.some((d) => d.v < 0);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={COLORS.grid} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: COLORS.grid }} tick={axisTick} minTickGap={12} />
          <YAxis width={56} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={compact} />
          {hasNegative && <ReferenceLine y={0} stroke={COLORS.axis} strokeOpacity={0.6} />}
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.6 }}
            content={({ active, payload }) => {
              const d = active && (payload?.[0]?.payload as (typeof data)[number] | undefined);
              if (!d) return null;
              return <TooltipBox title={d.title} rows={[{ label: seriesLabel, value: fmt(d.value), color }]} note={d.note} />;
            }}
          />
          <Bar dataKey="v" name={seriesLabel} fill={color} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ───────────── Single series line (net worth…) ───────────── */

export function ValueLine({ points, color, seriesLabel, height = 220 }: { points: ValuePoint[]; color: string; seriesLabel: string; height?: number }) {
  const fmt = useMoney();
  const compact = useCompact();
  const data = points.map((p) => ({ ...p, v: toNumber(p.value) }));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={COLORS.grid} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: COLORS.grid }} tick={axisTick} minTickGap={16} />
          <YAxis width={56} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={compact} domain={["auto", "auto"]} />
          <Tooltip
            cursor={{ stroke: COLORS.axis, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const d = active && (payload?.[0]?.payload as (typeof data)[number] | undefined);
              if (!d) return null;
              return <TooltipBox title={d.title} rows={[{ label: seriesLabel, value: fmt(d.value), color }]} note={d.note} />;
            }}
          />
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={data.length <= 24 ? { r: 4, fill: color, stroke: "var(--card)", strokeWidth: 2 } : false} activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ───────────── Rate line (savings rate %) ───────────── */

export function RateLine({ points, color, seriesLabel, height = 160 }: { points: { key: string; label: string; title: string; rate: number | null }[]; color: string; seriesLabel: string; height?: number }) {
  const data = points.map((p) => ({ ...p, pct: p.rate === null ? null : Math.round(p.rate * 1000) / 10 }));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={COLORS.grid} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: COLORS.grid }} tick={axisTick} minTickGap={12} />
          <YAxis width={44} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={(v: number) => `${v}%`} />
          <ReferenceLine y={0} stroke={COLORS.axis} strokeOpacity={0.5} />
          <Tooltip
            cursor={{ stroke: COLORS.axis, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const d = active && (payload?.[0]?.payload as (typeof data)[number] | undefined);
              if (!d) return null;
              return <TooltipBox title={d.title} rows={[{ label: seriesLabel, value: d.pct === null ? "No income" : `${d.pct}%`, color }]} />;
            }}
          />
          <Line type="monotone" dataKey="pct" stroke={color} strokeWidth={2} dot={{ r: 4, fill: color, stroke: "var(--card)", strokeWidth: 2 }} activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ───────────── Cumulative spending: this period vs last (emphasis) ───────────── */

export type CumulativeChartPoint = { day: number; date: string | null; previousDate: string | null; current: string | null; previous: string | null };

export function CumulativeChart({ points, height = 180, currentLabel = "This month", previousLabel = "Last month" }: { points: CumulativeChartPoint[]; height?: number; currentLabel?: string; previousLabel?: string }) {
  const fmt = useMoney();
  const compact = useCompact();
  const data = points.map((p) => ({ ...p, cur: p.current === null ? null : toNumber(p.current), prev: p.previous === null ? null : toNumber(p.previous) }));
  const previousColor = "var(--muted-foreground)";
  return (
    <>
      <Legend
        items={[
          { label: currentLabel, color: COLORS.spending, kind: "line" },
          { label: previousLabel, color: previousColor, kind: "line" },
        ]}
      />
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="day" tickLine={false} axisLine={{ stroke: COLORS.grid }} tick={axisTick} minTickGap={16} />
            <YAxis width={56} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={compact} />
            <Tooltip
              cursor={{ stroke: COLORS.axis, strokeWidth: 1 }}
              content={({ active, payload }) => {
                const d = active && (payload?.[0]?.payload as (typeof data)[number] | undefined);
                if (!d) return null;
                return (
                  <TooltipBox
                    title={`Day ${d.day}`}
                    rows={[
                      ...(d.current !== null ? [{ label: `${currentLabel}${d.date ? ` · ${formatDate(d.date, "d MMM")}` : ""}`, value: fmt(d.current), color: COLORS.spending }] : []),
                      ...(d.previous !== null ? [{ label: `${previousLabel}${d.previousDate ? ` · ${formatDate(d.previousDate, "d MMM")}` : ""}`, value: fmt(d.previous), color: previousColor }] : []),
                    ]}
                  />
                );
              }}
            />
            <Line type="monotone" dataKey="prev" stroke={previousColor} strokeOpacity={0.55} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="cur" stroke={COLORS.spending} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

/* ───────────── Forecast balance (dashed, forecast grey) ───────────── */

export function ForecastChart({ points, height = 200 }: { points: { date: string; balance: string }[]; height?: number }) {
  const fmt = useMoney();
  const compact = useCompact();
  const data = points.map((p) => ({ ...p, b: toNumber(p.balance), label: formatDate(p.date, "d MMM") }));
  const min = Math.min(...data.map((d) => d.b));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={COLORS.grid} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: COLORS.grid }} tick={axisTick} minTickGap={24} />
          <YAxis width={56} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={compact} />
          {min < 0 && <ReferenceLine y={0} stroke={COLORS.negative} strokeOpacity={0.7} label={{ value: "0", position: "insideLeft", fill: COLORS.axis, fontSize: 11 }} />}
          <Tooltip
            cursor={{ stroke: COLORS.axis, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const d = active && (payload?.[0]?.payload as (typeof data)[number] | undefined);
              if (!d) return null;
              return <TooltipBox title={formatDate(d.date, "EEE, d MMM")} rows={[{ label: "Projected balance", value: fmt(d.balance), color: COLORS.forecast, dashed: true }]} note="Forecast" />;
            }}
          />
          <Line type="monotone" dataKey="b" stroke={COLORS.forecast} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ───────────── Horizontal bars with category badge (HTML) ───────────── */

export type HBarItem = {
  id: string;
  label: string;
  icon?: string | null;
  color?: string | null;
  value: string;
  /** 0..1 share of the total (shown as a percentage). */
  share?: number;
  sub?: React.ReactNode;
  href?: string;
  children?: HBarItem[];
};

/**
 * Sorted horizontal bars. One series → one bar colour; identity comes from the category badge.
 * Values are always printed, so no tooltip is needed to read them.
 */
export function HBarList({ items, barColor = COLORS.spending, limit, emptyText = "Nothing to show.", expandable = true }: { items: HBarItem[]; barColor?: string; limit?: number; emptyText?: string; expandable?: boolean }) {
  const fmt = useMoney();
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [showAll, setShowAll] = React.useState(false);
  const visible = limit && !showAll ? items.slice(0, limit) : items;
  const max = Math.max(...items.map((i) => Math.abs(toNumber(i.value))), 0) || 1;
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  const row = (i: HBarItem, child = false) => {
    const pct = Math.max(0, (toNumber(i.value) / max) * 100);
    const hasKids = expandable && !child && (i.children?.length ?? 0) > 0;
    const isOpen = open.has(i.id);
    const label = i.href ? (
      <Link href={i.href} className="truncate hover:underline">
        {i.label}
      </Link>
    ) : (
      <span className="truncate">{i.label}</span>
    );
    return (
      <li key={i.id} className={cn("py-2", child && "py-1.5 pl-10")}>
        <div className="flex items-center gap-3">
          {!child && <CategoryBadge icon={i.icon} color={i.color} size="sm" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="flex min-w-0 items-center gap-1.5">
                {hasKids ? (
                  <button
                    type="button"
                    className="truncate text-left hover:underline"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((s) => {
                      const n = new Set(s);
                      if (n.has(i.id)) n.delete(i.id);
                      else n.add(i.id);
                      return n;
                    })}
                  >
                    {i.label}
                    <span className="sr-only">, show {i.children!.length} subcategories</span>
                  </button>
                ) : (
                  label
                )}
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="num font-medium">{fmt(i.value)}</span>
                {i.share !== undefined && <span className="num w-10 text-right text-[12px] text-muted-foreground">{Math.round(i.share * 100)}%</span>}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor, opacity: child ? 0.6 : 1 }} />
            </div>
            {i.sub && <div className="mt-1 text-[12px] text-muted-foreground">{i.sub}</div>}
          </div>
        </div>
        {hasKids && isOpen && <ul className="mt-1">{i.children!.map((c) => row(c, true))}</ul>}
      </li>
    );
  };
  return (
    <div>
      <ul className="divide-y">{visible.map((i) => row(i))}</ul>
      {limit && items.length > limit && (
        <button type="button" className="no-print mt-2 min-h-10 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/* ───────────── Heat strip (daily spend calendar) ───────────── */

/** Sequential single-hue scale (light → dark) by quantile of non-zero days; zero days stay neutral. */
export function heatScale(values: number[]) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const steps = ["var(--seq-200)", "color-mix(in oklab, var(--seq-200), var(--seq-400))", "var(--seq-400)", "var(--seq-600)"];
  return (v: number) => {
    if (v <= 0) return { bg: "var(--muted)", level: 0 };
    const idx = v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3;
    return { bg: steps[idx], level: idx + 1 };
  };
}

export function HeatStrip({
  days,
  weekStartsOn,
  onSelect,
  selected,
}: {
  days: { date: string; spending: string; count: number }[];
  weekStartsOn: 0 | 1;
  onSelect?: (date: string) => void;
  selected?: string | null;
}) {
  const fmt = useMoney();
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!sorted.length) return null;
  const scale = heatScale(sorted.map((d) => toNumber(d.spending)));
  const firstDow = (toDate(sorted[0].date).getDay() - weekStartsOn + 7) % 7;
  const cells: ({ date: string; spending: string; count: number } | null)[] = [...Array(firstDow).fill(null), ...sorted];
  const weeks: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const dayNames = weekStartsOn === 1 ? ["Mon", "", "Wed", "", "Fri", "", ""] : ["Sun", "", "Tue", "", "Thu", "", "Sat"];
  return (
    <div>
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none" role="group" aria-label="Daily spending heat map">
        <div className="grid grid-rows-7 gap-1 pr-1 text-[10.5px] leading-none text-muted-foreground" aria-hidden>
          {dayNames.map((n, i) => (
            <span key={i} className="flex h-4 items-center">
              {n}
            </span>
          ))}
        </div>
        {weeks.map((w, wi) => (
          <div key={wi} className="grid grid-rows-7 gap-1">
            {Array.from({ length: 7 }, (_, di) => {
              const d = w[di];
              if (!d) return <span key={di} className="size-4" aria-hidden />;
              const s = scale(toNumber(d.spending));
              const label = `${formatDate(d.date, "EEE d MMM")}: ${toNumber(d.spending) > 0 ? `${fmt(d.spending)} spent` : "no spending"}, ${d.count} transaction${d.count === 1 ? "" : "s"}`;
              return (
                <Tip key={di} content={label}>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={selected === d.date}
                    onClick={() => onSelect?.(d.date)}
                    className={cn("size-4 rounded-[4px] outline-offset-1 transition-transform hover:scale-125 focus-visible:scale-125", selected === d.date && "ring-2 ring-foreground ring-offset-1 ring-offset-card")}
                    style={{ background: s.bg }}
                  />
                </Tip>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground" aria-hidden>
        <span>Less</span>
        {["var(--muted)", "var(--seq-200)", "color-mix(in oklab, var(--seq-200), var(--seq-400))", "var(--seq-400)", "var(--seq-600)"].map((c) => (
          <span key={c} className="size-3 rounded-[3px]" style={{ background: c }} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/* ───────────── Stat tiles & deltas ───────────── */

/**
 * Signed change vs a named period. `goodWhen` sets whether up is good (income, savings) or bad
 * (spending). Direction is carried by an icon and words, not colour alone.
 */
export function DeltaLabel({
  pct,
  change,
  goodWhen,
  suffix,
  format = "pct",
  className,
}: {
  pct: number | null;
  change?: string;
  goodWhen: "up" | "down";
  suffix: string;
  format?: "pct" | "money" | "points";
  className?: string;
}) {
  const fmt = useMoney();
  const num = format === "money" ? toNumber(change ?? "0") : (pct ?? 0);
  if (format !== "money" && pct === null) return <span className={cn("text-[12.5px] text-muted-foreground", className)}>No data {suffix}</span>;
  const dir = num > 0.0005 ? 1 : num < -0.0005 ? -1 : 0;
  const Icon = dir > 0 ? ArrowUpRight : dir < 0 ? ArrowDownRight : Minus;
  const good = dir === 0 ? null : (dir > 0) === (goodWhen === "up");
  const text =
    format === "money"
      ? fmt(change ?? "0", undefined, { signed: true })
      : format === "points"
        ? `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${Math.abs(Math.round(num * 1000) / 10)} pts`
        : `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${Math.abs(Math.round(num * 100))}%`;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[12.5px]", good === null ? "text-muted-foreground" : good ? "text-positive" : "text-negative", className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="num">{dir === 0 ? "No change" : text}</span>
      <span className="text-muted-foreground">{suffix}</span>
    </span>
  );
}

export function StatTile({ label, value, delta, hint, className }: { label: string; value: React.ReactNode; delta?: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 px-4 py-3.5", className)}>
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-[20px] leading-tight font-semibold tracking-tight">{value}</p>
      {delta && <div className="mt-1">{delta}</div>}
      {hint && <p className="mt-0.5 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A KPI row inside one card, divided by hairlines — reads as one unit instead of many small cards. */
export function StatRow({ children, cols = 4, className }: { children: React.ReactNode; cols?: 3 | 4 | 5; className?: string }) {
  const lg = { 3: "sm:grid-cols-3", 4: "lg:grid-cols-4", 5: "sm:grid-cols-3 lg:grid-cols-5" }[cols];
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className={cn("grid grid-cols-2 gap-px bg-border [&>*]:bg-card [&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1", lg)}>{children}</div>
    </Card>
  );
}

export const formatPct = (r: number | null, digits = 0) => (r === null ? "—" : `${(r * 100).toFixed(digits)}%`);
