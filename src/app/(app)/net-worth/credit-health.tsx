"use client";

import Link from "next/link";
import { CalendarClock, CircleCheck, CreditCard, OctagonAlert, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAppData, useMoney } from "@/components/app/user-context";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/dates";
import { isPositive } from "@/lib/money";
import type { CreditCardHealth, CreditHealthSummary, UtilizationStatus } from "@/server/services/credit";

const STATUS: Record<UtilizationStatus, { label: string; badge: "positive" | "warning" | "negative"; fill: string; track: string; Icon: typeof CircleCheck }> = {
  good: { label: "Healthy", badge: "positive", fill: "bg-positive", track: "bg-positive-soft", Icon: CircleCheck },
  warning: { label: "Elevated", badge: "warning", fill: "bg-warning", track: "bg-warning-soft", Icon: TriangleAlert },
  serious: { label: "High", badge: "negative", fill: "bg-negative", track: "bg-negative-soft", Icon: OctagonAlert },
  over_limit: { label: "Over limit", badge: "negative", fill: "bg-negative", track: "bg-negative-soft", Icon: OctagonAlert },
};

/** Utilisation meter: severity fill on a lighter track of the same hue, 30% guide tick, label + icon. */
export function UtilizationMeter({ value, status, label }: { value: number; status: UtilizationStatus; label: string }) {
  const s = STATUS[status];
  const pct = Math.round(value * 100);
  return (
    <div className="grid gap-1.5">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
        aria-valuetext={`${pct}% used — ${s.label}`}
        className={cn("relative h-2 w-full overflow-hidden rounded-full", s.track)}
      >
        <div className={cn("h-full rounded-full transition-[width] duration-500", s.fill)} style={{ width: `${Math.min(100, Math.max(value > 0 ? 2 : 0, pct))}%` }} />
        <span className="absolute inset-y-0 left-[30%] w-0.5 bg-card" aria-hidden />
      </div>
      <div className="flex items-center justify-between text-[12.5px]">
        <Badge variant={s.badge}>
          <s.Icon aria-hidden />
          {s.label}
        </Badge>
        <span className="num text-muted-foreground">{pct}% used</span>
      </div>
    </div>
  );
}

function dueText(c: CreditCardHealth) {
  if (!c.nextDueDate) return null;
  const d = c.daysUntilDue ?? 0;
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  return `Due ${formatDate(c.nextDueDate, "EEE, d MMM")} · in ${d} days`;
}

export function CreditHealthSection({ health }: { health: CreditHealthSummary }) {
  const { prefs } = useAppData();
  const fmt = useMoney();
  const upcoming = health.cards
    .filter((c) => c.nextDueDate && isPositive(c.amountDue ?? c.owed))
    .sort((a, b) => (a.nextDueDate! < b.nextDueDate! ? -1 : 1));

  if (health.cards.length === 0) return null;

  return (
    <section id="credit-cards" aria-labelledby="credit-h" className="grid scroll-mt-20 gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="credit-h" className="text-[17px] font-semibold tracking-tight">Credit card health</h2>
          <p className="text-[13px] text-muted-foreground">Keeping utilisation under 30% and paying on time protects your credit score.</p>
        </div>
        {health.overall.utilization !== null && health.overall.utilizationStatus && health.cards.length > 1 && (
          <div className="w-full sm:w-64">
            <p className="mb-1 text-[12.5px] text-muted-foreground">
              Overall · <span className="num">{fmt(health.overall.owed, health.currency)}</span> of <span className="num">{fmt(health.overall.limit, health.currency)}</span>
            </p>
            <UtilizationMeter value={health.overall.utilization} status={health.overall.utilizationStatus} label="Overall credit utilisation" />
          </div>
        )}
      </div>

      {upcoming.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <CalendarClock className="size-3.5" aria-hidden /> Upcoming payments
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-2">
            <ul className="divide-y">
              {upcoming.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    <p className={cn("text-[12.5px]", (c.daysUntilDue ?? 99) <= 5 ? "text-warning" : "text-muted-foreground")}>{dueText(c)}</p>
                  </div>
                  <div className="text-right">
                    <p className="num text-sm font-medium">{fmt(c.amountDue ?? c.owed, c.currency)}</p>
                    {c.minimumPayment && isPositive(c.minimumPayment) && <p className="num text-[12px] text-muted-foreground">Min {fmt(c.minimumPayment, c.currency)}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <ul className="divide-y">
          {health.cards.map((c) => (
            <li key={c.id} className="grid gap-3 px-5 py-4">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4" style={c.color ? { backgroundColor: `color-mix(in oklab, ${c.color} 16%, transparent)`, color: c.color } : undefined}>
                  <CreditCard aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <Link href={`/transactions?account=${c.id}`} className="block truncate text-[15px] font-medium underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                  <p className="text-[12.5px] text-muted-foreground">
                    {[c.institution, c.isArchived ? "Archived" : null].filter(Boolean).join(" · ") || "Credit card"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="num text-[15px] font-semibold">{fmt(c.owed, c.currency)}</p>
                  <p className="text-[12.5px] text-muted-foreground">{isPositive(c.creditBalance) ? `${fmt(c.creditBalance, c.currency)} in credit` : "owed"}</p>
                </div>
              </div>

              {c.utilization !== null && c.utilizationStatus ? (
                <UtilizationMeter value={c.utilization} status={c.utilizationStatus} label={`${c.name} utilisation`} />
              ) : (
                <p className="text-[12.5px] text-muted-foreground">
                  Add a credit limit to{" "}
                  <Link href="/accounts" className="underline underline-offset-4">
                    this card
                  </Link>{" "}
                  to track utilisation.
                </p>
              )}

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
                {c.available !== null && (
                  <div>
                    <dt className="text-muted-foreground">Available</dt>
                    <dd className={cn("num", isPositive(c.available) ? "" : "text-negative")}>{fmt(c.available, c.currency)}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">Next due</dt>
                  <dd>{c.nextDueDate ? `${formatDate(c.nextDueDate, "d MMM")} · ${c.daysUntilDue === 0 ? "today" : `${c.daysUntilDue}d`}` : "Not set"}</dd>
                </div>
                {c.amountDue !== null && (
                  <div>
                    <dt className="text-muted-foreground">Left to pay</dt>
                    <dd className="num">
                      {fmt(c.amountDue, c.currency)}
                      {c.statementBalance !== null && c.lastStatementDate && (
                        <span className="block text-[12px] text-muted-foreground">
                          of {fmt(c.statementBalance, c.currency)} on {formatDate(c.lastStatementDate, "d MMM")} statement
                        </span>
                      )}
                    </dd>
                  </div>
                )}
                {c.minimumPayment && (
                  <div>
                    <dt className="text-muted-foreground">Minimum</dt>
                    <dd className="num">{fmt(c.minimumPayment, c.currency)}</dd>
                  </div>
                )}
                {c.annualFee && isPositive(c.annualFee) && (
                  <div>
                    <dt className="text-muted-foreground">Annual fee</dt>
                    <dd className="num">{fmt(c.annualFee, c.currency)}</dd>
                  </div>
                )}
                {c.interestRate && Number(c.interestRate) > 0 && (
                  <div>
                    <dt className="text-muted-foreground">Interest</dt>
                    <dd className="num">{Number(c.interestRate).toLocaleString(prefs.locale, { maximumFractionDigits: 2 })}% APR</dd>
                  </div>
                )}
              </dl>

              {c.warnings.length > 0 && (
                <ul className="grid gap-1.5">
                  {c.warnings.map((w) => (
                    <li
                      key={w.code}
                      className={cn(
                        "flex items-start gap-2 rounded-md px-3 py-2 text-[13px]",
                        w.level === "serious" ? "bg-negative-soft text-negative" : "bg-warning-soft text-warning",
                      )}
                    >
                      {w.level === "serious" ? <OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                      <span>
                        <span className="sr-only">{w.level === "serious" ? "Serious: " : "Warning: "}</span>
                        {w.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {health.unconverted.length > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          Overall utilisation leaves out cards in {health.unconverted.join(", ")} — add exchange rates in{" "}
          <Link href="/settings" className="underline underline-offset-4">
            Settings
          </Link>
          .
        </p>
      )}
    </section>
  );
}
