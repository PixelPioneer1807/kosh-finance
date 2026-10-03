"use client";

import { AlertTriangle, CalendarX2, CheckCircle2, CircleDashed, Infinity as InfinityIcon, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { GOAL_FREQUENCY_LABELS, GOAL_TRACK_LABELS, type GoalTrack } from "@/lib/goals";
import { formatDate } from "@/lib/dates";
import type { GoalProgress } from "@/server/services/goals";

const TRACK_STYLE: Record<GoalTrack, { variant: "positive" | "warning" | "negative" | "default" | "outline"; Icon: typeof TrendingUp }> = {
  completed: { variant: "positive", Icon: CheckCircle2 },
  on_track: { variant: "positive", Icon: TrendingUp },
  behind: { variant: "warning", Icon: AlertTriangle },
  overdue: { variant: "negative", Icon: CalendarX2 },
  no_deadline: { variant: "default", Icon: InfinityIcon },
  no_pace: { variant: "outline", Icon: CircleDashed },
};

/** Status badge: colour + icon + text (never colour alone). */
export function GoalTrackBadge({ track, className }: { track: GoalTrack; className?: string }) {
  const { variant, Icon } = TRACK_STYLE[track];
  return (
    <Badge variant={variant} className={className}>
      <Icon aria-hidden />
      {GOAL_TRACK_LABELS[track]}
    </Badge>
  );
}

type Fmt = (amount: string, currency?: string | null, opts?: { compact?: boolean; trimZeros?: boolean }) => string;

/** One-line plan, e.g. "Save $166.67 / month to reach it by 30 Jun 2026". */
export function goalPlanLine(g: GoalProgress, fmt: Fmt): string | null {
  if (g.status === "completed" || g.track === "completed") return null;
  const per = GOAL_FREQUENCY_LABELS[g.periodFrequency].per;
  if (g.deadline && g.requiredPerPeriod) {
    if (g.periodsLeft === 0) return `Deadline passed — ${fmt(g.remaining, g.currency)} still to go`;
    return `Save ${fmt(g.requiredPerPeriod, g.currency)} / ${per} to reach it by ${formatDate(g.deadline)}`;
  }
  if (g.targetContribution) return `Plan: ${fmt(g.targetContribution, g.currency)} / ${per}`;
  return null;
}

/** "Projected Mar 2027 at your recent pace" — always labelled as a projection. */
export function goalProjectionLine(g: GoalProgress): string | null {
  if (g.status === "completed" || g.track === "completed") return null;
  if (!g.projectedCompletionDate) return null;
  return `Projected ${formatDate(g.projectedCompletionDate, "d MMM yyyy")} at your recent pace`;
}
