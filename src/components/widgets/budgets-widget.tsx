"use client";

/**
 * Dashboard widget: active budgets with progress for the current period.
 * Props: `budgets` = listBudgetsWithProgress(userId) (src/server/services/budgets.ts).
 */
import Link from "next/link";
import { AlertTriangle, PieChart, Plus } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Progress } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/app/icons";
import { useAppData, useMoney } from "@/components/app/user-context";
import { cn } from "@/lib/utils";
import type { BudgetProgress } from "@/server/services/budgets";

const tone = (s: BudgetProgress["status"]) => (s === "over" ? "negative" : s === "warning" || s === "projected_over" ? "warning" : "positive");

export function BudgetsWidget({ budgets, limit = 5, className }: { budgets: BudgetProgress[]; limit?: number; className?: string }) {
  const fmt = useMoney();
  const { categories } = useAppData();
  const sorted = [...budgets].sort((a, b) => b.pct - a.pct).slice(0, limit);
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <CardTitle>Budgets</CardTitle>
        <Link href="/budgets" className="text-[13px] text-muted-foreground hover:text-foreground">
          All budgets
        </Link>
      </CardHeader>
      {sorted.length === 0 ? (
        <EmptyState
          icon={<PieChart />}
          title="No budgets yet"
          description="Set a monthly limit for your spending or a category."
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/budgets?new=1">
                <Plus /> Create budget
              </Link>
            </Button>
          }
          className="py-8"
        />
      ) : (
        <ul className="divide-y">
          {sorted.map((b) => {
            const cat = categories.find((c) => c.id === b.categoryId);
            return (
              <li key={b.id}>
                <Link href="/budgets" className="block px-5 py-3 transition-colors hover:bg-subtle">
                  <div className="mb-1.5 flex items-center gap-2.5">
                    {cat ? <CategoryBadge icon={cat.icon} color={cat.color} size="sm" /> : <span className="grid size-6 place-items-center rounded-full bg-muted"><PieChart className="size-3.5 text-muted-foreground" /></span>}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.name}</span>
                    {b.status !== "ok" && <AlertTriangle className={cn("size-3.5", b.status === "over" ? "text-negative" : "text-warning")} aria-label={b.status.replace("_", " ")} />}
                    <span className="num text-[13px] text-muted-foreground">
                      {fmt(b.spent, null, { trimZeros: true })} / {fmt(b.available, null, { trimZeros: true })}
                    </span>
                  </div>
                  <Progress value={b.pct} tone={tone(b.status)} label={`${b.name}: ${Math.round(b.pct * 100)}% used`} />
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {b.status === "over"
                      ? `Over by ${fmt(b.remaining.replace("-", ""), null, { trimZeros: true })}`
                      : `${fmt(b.remaining, null, { trimZeros: true })} left · ${b.daysLeft} day${b.daysLeft === 1 ? "" : "s"} to go`}
                    {b.status === "projected_over" && " · on pace to exceed (forecast)"}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
