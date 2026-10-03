"use client";

/**
 * Dashboard widget: net worth with change vs one month ago and a 12-month sparkline.
 *
 * Props (all plain serialisable data from src/server/services/networth.ts):
 * - `summary`: the result of `netWorthSummary(userId)` (only currency, netWorth, assets,
 *   liabilities, unconverted and accounts.length are read).
 * - `history` (optional): the result of `netWorthHistory(userId, 12)`. Without it the widget
 *   shows the totals but no sparkline/change.
 * - `className`: forwarded to the outer Card.
 */
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus, Landmark } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { useMoney } from "@/components/app/user-context";
import { cn } from "@/lib/utils";
import { cmp, toNumber } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import type { NetWorthHistory, NetWorthSummary } from "@/server/services/networth";

export type NetWorthWidgetProps = {
  summary: Pick<NetWorthSummary, "currency" | "netWorth" | "assets" | "liabilities" | "unconverted" | "accounts">;
  history?: Pick<NetWorthHistory, "points" | "changes"> | null;
  className?: string;
};

/** Signed change with direction icon + text (colour is never the only cue). Up is good for net worth. */
export function ChangeLabel({ delta, currency, suffix, className }: { delta: string; currency: string; suffix: string; className?: string }) {
  const fmt = useMoney();
  const dir = cmp(delta, "0");
  const Icon = dir > 0 ? ArrowUpRight : dir < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[13px]", dir > 0 ? "text-positive" : dir < 0 ? "text-negative" : "text-muted-foreground", className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="num">{dir === 0 ? "No change" : fmt(delta, currency, { signed: true })}</span>
      <span className="text-muted-foreground">{suffix}</span>
    </span>
  );
}

/** Minimal trend line (single series, muted ink, latest point marked). Decorative — values live in the text. */
export function NetWorthSparkline({ values, className, height = 40 }: { values: number[]; className?: string; height?: number }) {
  if (values.length < 2) return null;
  const w = 160;
  const h = height;
  const pad = 4;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / (values.length - 1), h - pad - ((v - lo) / span) * (h - pad * 2)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("h-10 w-full overflow-visible", className)} aria-hidden>
      <path d={d} fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.55} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r={4} fill="var(--series-1)" stroke="var(--card)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function NetWorthWidget({ summary, history, className }: NetWorthWidgetProps) {
  const fmt = useMoney();
  const c = summary.currency;
  const empty = summary.accounts.length === 0;
  const values = history?.points.map((p) => toNumber(p.netWorth)) ?? [];
  const first = history?.points[0];

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>Net worth</CardTitle>
        <Link href="/net-worth" className="-mr-1 inline-flex min-h-8 items-center gap-0.5 rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground">
          Details <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent className="flex-1">
        {empty ? (
          <EmptyState
            className="py-6"
            icon={<Landmark />}
            title="No accounts yet"
            description="Add your accounts to see what you own and owe."
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/accounts">Add an account</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            <div>
              <p className={cn("text-[28px] leading-tight font-semibold tracking-tight", cmp(summary.netWorth, "0") < 0 && "text-negative")}>{fmt(summary.netWorth, c)}</p>
              {history?.changes.month && <ChangeLabel delta={history.changes.month.delta} currency={c} suffix="vs a month ago" />}
            </div>
            {values.length > 1 && (
              <figure>
                <NetWorthSparkline values={values} />
                <figcaption className="sr-only">
                  Net worth trend from {first ? formatDate(first.date) : "a year ago"} ({first ? fmt(first.netWorth, c) : ""}) to today ({fmt(summary.netWorth, c)}).
                </figcaption>
              </figure>
            )}
            <dl className="grid grid-cols-2 gap-3 border-t pt-3 text-[13px]">
              <div>
                <dt className="text-muted-foreground">Assets</dt>
                <dd className="num font-medium">{fmt(summary.assets, c)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Liabilities</dt>
                <dd className="num font-medium">{fmt(summary.liabilities, c)}</dd>
              </div>
            </dl>
            {summary.unconverted.length > 0 && (
              <p className="text-[12.5px] text-warning">
                {summary.unconverted.length} account{summary.unconverted.length === 1 ? "" : "s"} not included — missing exchange rate.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
