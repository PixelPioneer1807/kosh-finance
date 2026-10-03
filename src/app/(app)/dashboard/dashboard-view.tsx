"use client";

import * as React from "react";
import Link from "next/link";
import { Check, LayoutGrid, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/misc";
import { useAppData } from "@/components/app/user-context";
import { useShell } from "@/components/shell/shell-context";
import { formatDate, RANGE_PRESETS } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { SnapshotWidget } from "@/components/widgets/snapshot-widget";
import { SafeToSpendWidget } from "@/components/widgets/safe-to-spend-widget";
import { InsightsWidget } from "@/components/widgets/insights-widget";
import { BudgetsWidget } from "@/components/widgets/budgets-widget";
import { SpendingTrendWidget } from "@/components/widgets/spending-trend-widget";
import { CategoryWidget } from "@/components/widgets/category-widget";
import { UpcomingWidget } from "@/components/widgets/upcoming-widget";
import { RecentWidget } from "@/components/widgets/recent-widget";
import { AccountsWidget } from "@/components/widgets/accounts-widget";
import { GoalsWidget } from "@/components/widgets/goals-widget";
import { NetWorthWidget } from "@/components/widgets/net-worth-widget";
import type { PeriodSummary, CumulativeSpending, CategoryBreakdown } from "@/server/services/analytics";
import type { SafeToSpend } from "@/server/services/forecast";
import type { Insight } from "@/server/services/insights";
import type { BudgetProgress } from "@/server/services/budgets";
import type { Occurrence } from "@/server/services/recurring";
import type { TransactionRow } from "@/server/services/transactions";
import type { GoalProgress } from "@/server/services/goals";
import type { NetWorthHistory, NetWorthSummary } from "@/server/services/networth";

type Loaded<T> = { ok: true; data: T } | { ok: false } | undefined;

export type DashboardData = {
  order: string[];
  rangeLabel: string;
  snapshot: Loaded<PeriodSummary>;
  safeSpend: Loaded<SafeToSpend>;
  insights: Loaded<Insight[]>;
  budgets: Loaded<BudgetProgress[]>;
  trend: Loaded<CumulativeSpending>;
  categories: Loaded<CategoryBreakdown>;
  upcoming: Loaded<Occurrence[]>;
  recent: Loaded<TransactionRow[]>;
  goals: Loaded<GoalProgress[]>;
  netWorth: Loaded<{ summary: NetWorthSummary; history: NetWorthHistory }>;
  aiAvailable: boolean;
  setup: { transactions: number; budgets: number; recurring: number };
};

/** Column span per widget on large screens (3-column grid, dense packing so reordering never leaves holes). */
const SPAN: Record<string, string> = {
  snapshot: "lg:col-span-2",
  safe_to_spend: "",
  insights: "lg:col-span-2",
  budgets: "",
  spending_trend: "lg:col-span-2",
  categories: "",
  upcoming: "",
  recent: "lg:col-span-2",
  accounts: "",
  goals: "",
  net_worth: "",
};

function Failed({ what }: { what: string }) {
  return (
    <Card className="p-4">
      <ErrorState message={`Couldn't load ${what}. Refresh to try again.`} />
    </Card>
  );
}

function render<T>(loaded: Loaded<T>, what: string, fn: (d: T) => React.ReactNode) {
  if (!loaded) return null;
  if (!loaded.ok) return <Failed what={what} />;
  return fn(loaded.data);
}

function GettingStarted({ setup }: { setup: DashboardData["setup"] }) {
  const { accounts } = useAppData();
  const { openQuickAdd } = useShell();
  const steps = [
    { done: accounts.length > 0, label: "Add an account", href: "/accounts?new=1" },
    { done: setup.transactions > 0, label: "Log your first expense", onClick: () => openQuickAdd() },
    { done: setup.recurring > 0, label: "Add a bill or subscription", href: "/recurring?new=bill" },
    { done: setup.budgets > 0, label: "Set a budget", href: "/budgets?new=1" },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null;
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">Get set up</h2>
        <span className="text-[12.5px] text-muted-foreground">
          {steps.length - remaining} of {steps.length} done
        </span>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => {
          const inner = (
            <>
              <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border", s.done ? "border-positive bg-positive text-white" : "border-border-strong")}>
                {s.done && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className={cn("text-sm", s.done && "text-muted-foreground line-through")}>{s.label}</span>
            </>
          );
          const cls = "flex w-full items-center gap-2.5 rounded-lg border bg-subtle px-3 py-2.5 text-left transition hover:bg-muted";
          return (
            <li key={s.label}>
              {s.done ? (
                <div className={cls}>{inner}</div>
              ) : s.href ? (
                <Link href={s.href} className={cls}>
                  {inner}
                </Link>
              ) : (
                <button type="button" onClick={s.onClick} className={cls}>
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export function DashboardView({ name, data }: { name: string | null; data: DashboardData }) {
  const { prefs } = useAppData();
  const { openQuickAdd } = useShell();
  const [greeting, setGreeting] = React.useState("Hello");
  React.useEffect(() => {
    // Time-of-day greeting uses the browser clock, so compute it after hydration.
    const h = new Date().getHours();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGreeting(h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, []);
  const rangeName = RANGE_PRESETS.find((p) => p.id === data.rangeLabel)?.label ?? "This month";

  const widgets: Record<string, React.ReactNode> = {
    snapshot: render(data.snapshot, "your summary", (d) => <SnapshotWidget summary={d} title={rangeName} />),
    safe_to_spend: render(data.safeSpend, "safe to spend", (d) => <SafeToSpendWidget data={d} />),
    insights: render(data.insights, "insights", (d) => <InsightsWidget insights={d} aiAvailable={data.aiAvailable} />),
    budgets: render(data.budgets, "budgets", (d) => <BudgetsWidget budgets={d} />),
    spending_trend: render(data.trend, "spending trend", (d) => <SpendingTrendWidget data={d} />),
    categories: render(data.categories, "categories", (d) => <CategoryWidget data={d} />),
    upcoming: render(data.upcoming, "upcoming payments", (d) => <UpcomingWidget items={d} today={prefs.today} />),
    recent: render(data.recent, "recent transactions", (d) => <RecentWidget items={d} />),
    accounts: <AccountsWidget />,
    goals: render(data.goals, "goals", (d) => <GoalsWidget goals={d} />),
    net_worth: render(data.netWorth, "net worth", (d) => <NetWorthWidget summary={d.summary} history={d.history} />),
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{formatDate(prefs.today, "EEEE, d MMMM")}</p>
          <h1 className="text-[22px] font-semibold tracking-tight sm:text-2xl">
            {greeting}
            {name ? `, ${name.split(" ")[0]}` : ""}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/settings/appearance" aria-label="Customise dashboard">
              <LayoutGrid /> <span className="hidden sm:inline">Customise</span>
            </Link>
          </Button>
          <Button onClick={() => openQuickAdd()} className="hidden sm:inline-flex">
            <Plus /> Add expense
          </Button>
        </div>
      </div>

      <GettingStarted setup={data.setup} />

      {data.order.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          All widgets are hidden. <Link href="/settings/appearance" className="underline">Choose what to show</Link>.
        </Card>
      ) : (
        <div className="grid grid-flow-row-dense grid-cols-1 items-start gap-5 lg:grid-cols-3">
          {data.order.map((id) =>
            widgets[id] ? (
              <section key={id} aria-label={id.replace(/_/g, " ")} className={cn("min-w-0", SPAN[id])}>
                {widgets[id]}
              </section>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
