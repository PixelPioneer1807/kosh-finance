"use client";

/**
 * Dashboard widget: progress on active savings goals.
 *
 * Props
 * - `goals`: the array returned by `listGoalsWithProgress(userId)` (src/server/services/goals.ts).
 *   Plain serialisable data; pass it straight from a Server Component. Completed/archived goals
 *   are ignored here (they're counted in the footer only).
 * - `limit` (default 4): how many active goals to show, soonest deadline first.
 * - `className`: forwarded to the outer Card.
 */
import Link from "next/link";
import { ChevronRight, Plus, Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Icon } from "@/components/app/icons";
import { useMoney } from "@/components/app/user-context";
import { cn } from "@/lib/utils";
import type { GoalProgress } from "@/server/services/goals";
import { ColorBar } from "./progress-ring";
import { GoalTrackBadge, goalPlanLine } from "./goal-bits";

export type GoalsWidgetProps = { goals: GoalProgress[]; limit?: number; className?: string };

export function GoalsWidget({ goals, limit = 4, className }: GoalsWidgetProps) {
  const fmt = useMoney();
  const active = goals
    .filter((g) => g.status === "active")
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || b.progress - a.progress)
    .slice(0, limit);
  const completed = goals.filter((g) => g.status === "completed").length;
  const totalActive = goals.filter((g) => g.status === "active").length;

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>Goals</CardTitle>
        <Link href="/goals" className="-mr-1 inline-flex min-h-8 items-center gap-0.5 rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground">
          View all <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent className="flex-1">
        {active.length === 0 ? (
          <EmptyState
            className="py-6"
            icon={<Target />}
            title={completed ? "All goals reached" : "No goals yet"}
            description={completed ? "Set your next target whenever you're ready." : "Saving for something? Give it a target and track progress."}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/goals?new=1">
                  <Plus /> New goal
                </Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y">
            {active.map((g) => {
              const plan = goalPlanLine(g, fmt);
              const pct = Math.round(Math.min(1, g.progress) * 100);
              return (
                <li key={g.id}>
                  <Link href={`/goals?open=${g.id}`} className="-mx-2 grid gap-1.5 rounded-md px-2 py-3 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="grid size-7 shrink-0 place-items-center rounded-full [&_svg]:size-3.5"
                        style={{ backgroundColor: `color-mix(in oklab, ${g.color} 16%, transparent)`, color: g.color }}
                      >
                        <Icon name={g.icon} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
                      <span className="num text-[13px] text-muted-foreground">{pct}%</span>
                    </div>
                    <ColorBar value={g.progress} color={g.color} label={`${g.name}: ${pct}% saved`} />
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
                      <span className="num">
                        <span className="text-foreground">{fmt(g.current, g.currency, { trimZeros: true })}</span> of {fmt(g.targetAmount, g.currency, { trimZeros: true })}
                      </span>
                      {g.track !== "no_deadline" && <GoalTrackBadge track={g.track} />}
                    </div>
                    {plan && <p className="text-[12.5px] text-muted-foreground">{plan}</p>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {(totalActive > active.length || completed > 0) && active.length > 0 && (
        <p className="border-t px-5 py-2.5 text-[12.5px] text-muted-foreground">
          {totalActive > active.length && <>{totalActive - active.length} more active · </>}
          {completed} reached
        </p>
      )}
    </Card>
  );
}
