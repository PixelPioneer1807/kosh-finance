"use client";

import Link from "next/link";
import { ChevronRight, Info, Landmark, Plus, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Icon } from "@/components/app/icons";
import { useMoney } from "@/components/app/user-context";
import { ChangeLabel } from "@/components/widgets/net-worth-widget";
import { cn } from "@/lib/utils";
import { abs, cmp, isNegative, ratio } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import type { NetWorthAccount, NetWorthBreakdown, NetWorthHistory, NetWorthSummary } from "@/server/services/networth";
import type { CreditHealthSummary } from "@/server/services/credit";
import { NetWorthChart } from "./net-worth-chart";
import { CreditHealthSection } from "./credit-health";

export function NetWorthView({ summary, history, credit }: { summary: NetWorthSummary; history: NetWorthHistory; credit: CreditHealthSummary }) {
  const fmt = useMoney();
  const c = summary.currency;

  if (summary.accounts.length === 0 && summary.unconverted.length === 0) {
    return (
      <>
        <PageHeader title="Net worth" description="Everything you own minus everything you owe." />
        <Card>
          <EmptyState
            icon={<Landmark />}
            title={summary.excludedCount ? "Your accounts are excluded from net worth" : "Add your accounts to see your net worth"}
            description={
              summary.excludedCount
                ? "Turn on “Include in net worth” for the accounts you want counted."
                : "Bank accounts, cash, investments, credit cards and loans all count. Balances come from your transactions."
            }
            action={
              <Button asChild>
                <Link href="/accounts">
                  {summary.excludedCount ? (
                    "Manage accounts"
                  ) : (
                    <>
                      <Plus /> Add an account
                    </>
                  )}
                </Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const assetsList = summary.accounts.filter((a) => !a.liability);
  const liabilitiesList = summary.accounts.filter((a) => a.liability);
  const assetTypes = summary.breakdown.filter((b) => !b.liability);
  const liabilityTypes = summary.breakdown.filter((b) => b.liability);
  const missingRates = [...new Set([...summary.unconverted.map((u) => u.currency), ...history.unconvertedCurrencies])];

  return (
    <>
      <PageHeader title="Net worth" description="Everything you own minus everything you owe, in your base currency." />

      <div className="grid gap-6">
        {missingRates.length > 0 && (
          <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">Not included: no exchange rate for {missingRates.join(", ")}</p>
              <p className="mt-0.5">
                {summary.unconverted.map((u) => `${u.name} (${fmt(u.balance, u.currency)})`).join(", ")}
                {summary.unconverted.length > 0 ? " — " : ""}
                <Link href="/settings" className="underline underline-offset-4">
                  add a rate in Settings → Currencies
                </Link>{" "}
                to count {summary.unconverted.length === 1 ? "it" : "them"}.
              </p>
            </div>
          </div>
        )}

        <Card>
          <CardContent className="grid gap-6 pt-5 lg:grid-cols-[1fr_1.4fr] lg:items-start">
            <div className="grid gap-2">
              <p className="text-[13px] font-medium text-muted-foreground">Net worth today</p>
              <p className={cn("text-[40px] leading-none font-semibold tracking-tight sm:text-5xl", isNegative(summary.netWorth) && "text-negative")}>{fmt(summary.netWorth, c)}</p>
              <div className="mt-1 grid gap-1">
                {history.changes.month && <ChangeLabel delta={history.changes.month.delta} currency={c} suffix={`since ${formatDate(history.changes.month.date, "d MMM")}`} />}
                {history.changes.year && <ChangeLabel delta={history.changes.year.delta} currency={c} suffix={`since ${formatDate(history.changes.year.date, "d MMM yyyy")}`} />}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 border-t pt-3">
                <div>
                  <dt className="text-[12.5px] text-muted-foreground">Assets</dt>
                  <dd className="num text-[17px] font-semibold">{fmt(summary.assets, c)}</dd>
                </div>
                <div>
                  <dt className="text-[12.5px] text-muted-foreground">Liabilities</dt>
                  <dd className="num text-[17px] font-semibold">{fmt(summary.liabilities, c)}</dd>
                </div>
              </dl>
            </div>
            <div>
              <h2 className="mb-2 text-[13px] font-medium text-muted-foreground">History</h2>
              {history.points.length > 1 ? (
                <NetWorthChart points={history.points} currency={c} />
              ) : (
                <p className="text-sm text-muted-foreground">Not enough history yet.</p>
              )}
              <p className="mt-2 text-[12px] text-muted-foreground">Month-end balances from your transactions, converted at today&apos;s exchange rates.</p>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <BreakdownCard title="What you own" total={summary.assets} items={assetTypes} currency={c} emptyText="No asset accounts yet." />
          <BreakdownCard title="What you owe" total={summary.liabilities} items={liabilityTypes} currency={c} emptyText="No credit cards or loans — nothing owed." />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <AccountsCard title="Assets" accounts={assetsList} baseCurrency={c} />
          <AccountsCard title="Liabilities" accounts={liabilitiesList} baseCurrency={c} />
        </div>
        {summary.excludedCount > 0 && (
          <p className="-mt-3 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Info className="size-3.5" aria-hidden />
            {summary.excludedCount} account{summary.excludedCount === 1 ? " is" : "s are"} excluded from net worth.{" "}
            <Link href="/accounts" className="underline underline-offset-4">
              Manage accounts
            </Link>
          </p>
        )}

        <CreditHealthSection health={credit} />
      </div>
    </>
  );
}

function BreakdownCard({ title, total, items, currency, emptyText }: { title: string; total: string; items: NetWorthBreakdown[]; currency: string; emptyText: string }) {
  const fmt = useMoney();
  const maxItem = items.reduce<string>((m, b) => (cmp(b.total, m) > 0 ? b.total : m), "0");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <span className="num text-[13px] font-medium">{fmt(total, currency)}</span>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="grid gap-3">
            {items.map((b) => {
              const share = cmp(maxItem, "0") > 0 ? Math.max(0, ratio(b.total, maxItem)) : 0;
              const ofTotal = cmp(total, "0") > 0 ? Math.round(ratio(b.total, total) * 100) : null;
              return (
                <li key={b.type} className="grid gap-1.5">
                  <div className="flex items-center gap-2.5 text-sm">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-3.5">
                      <Icon name={b.icon} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {b.label}
                      <span className="ml-1.5 text-[12.5px] text-muted-foreground">{b.count}</span>
                    </span>
                    <span className="num font-medium">{fmt(b.total, currency)}</span>
                    {ofTotal !== null && <span className="num w-10 text-right text-[12.5px] text-muted-foreground">{ofTotal}%</span>}
                  </div>
                  <div className="ml-[38px] h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div className="h-full rounded-full" style={{ width: `${share * 100}%`, backgroundColor: "var(--series-1)" }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AccountsCard({ title, accounts, baseCurrency }: { title: string; accounts: NetWorthAccount[]; baseCurrency: string }) {
  const fmt = useMoney();
  if (!accounts.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <ul className="divide-y border-t">
        {accounts.map((a) => {
          const owed = a.owed ?? "0";
          const inCredit = a.liability && isNegative(owed);
          const shown = a.liability ? abs(owed) : a.balance;
          return (
            <li key={a.id}>
              <Link href={`/transactions?account=${a.id}`} className="flex min-h-14 items-center gap-3 px-5 py-2.5 hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4"
                  style={a.color ? { backgroundColor: `color-mix(in oklab, ${a.color} 16%, transparent)`, color: a.color } : undefined}
                >
                  <Icon name={a.icon} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    {a.isArchived && <Badge variant="outline">Archived</Badge>}
                  </span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">{[a.typeLabel, a.institution].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="text-right">
                  <span className={cn("num block text-sm font-medium", !a.liability && isNegative(a.balance) && "text-negative")}>{fmt(shown, a.currency)}</span>
                  {a.currency !== baseCurrency && (
                    <span className="num block text-[12px] text-muted-foreground">
                      {a.baseBalance !== null ? `≈ ${fmt(a.liability ? abs(a.baseBalance) : a.baseBalance, baseCurrency)}` : "No exchange rate"}
                    </span>
                  )}
                  {a.liability && <span className="block text-[12px] text-muted-foreground">{inCredit ? "in credit" : "owed"}</span>}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
