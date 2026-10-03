"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRightLeft, History, Minus, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, ConfirmDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Icon } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData, useMoney } from "@/components/app/user-context";
import { ProgressRing } from "@/components/widgets/progress-ring";
import { GoalTrackBadge, goalPlanLine } from "@/components/widgets/goal-bits";
import { daysBetween, formatDate, relativeDayLabel } from "@/lib/dates";
import { GOAL_FREQUENCY_LABELS, goalKindMeta } from "@/lib/goals";
import { isNegative, isPositive } from "@/lib/money";
import type { ContributionRow, GoalProgress } from "@/server/services/goals";
import { deleteContributionAction, listContributionsAction } from "./actions";

type HistoryState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; rows: ContributionRow[] };

export function GoalDetailDialog({
  goal,
  onOpenChange,
  onContribute,
  actions,
}: {
  goal: GoalProgress | null;
  onOpenChange: (open: boolean) => void;
  onContribute: (direction: "contribute" | "withdraw") => void;
  /** Edit / status / delete controls rendered in the header row. */
  actions: React.ReactNode;
}) {
  return (
    <Dialog open={Boolean(goal)} onOpenChange={onOpenChange}>
      <DialogContent title={goal?.name ?? "Goal"} description={goal ? goalKindMeta(goal.kind).label : undefined} size="lg">
        {goal && <GoalDetail goal={goal} onContribute={onContribute} actions={actions} />}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
      {hint && <dd className="text-[12px] text-muted-foreground">{hint}</dd>}
    </div>
  );
}

function GoalDetail({ goal, onContribute, actions }: { goal: GoalProgress; onContribute: (d: "contribute" | "withdraw") => void; actions: React.ReactNode }) {
  const { prefs } = useAppData();
  const fmt = useMoney();
  const pct = Math.round(goal.progress * 100);
  const plan = goalPlanLine(goal, fmt);
  const per = GOAL_FREQUENCY_LABELS[goal.periodFrequency].per;
  const done = goal.status === "completed" || goal.track === "completed";
  const daysLeft = goal.deadline ? daysBetween(prefs.today, goal.deadline) : null;

  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-4">
        <ProgressRing value={goal.progress} color={goal.color} size={88} stroke={7} label={`${pct}% saved`}>
          <span className="grid justify-items-center">
            <span className="grid size-7 place-items-center [&_svg]:size-5" style={{ color: goal.color }}>
              <Icon name={goal.icon} />
            </span>
            <span className="num text-[13px] font-semibold">{pct}%</span>
          </span>
        </ProgressRing>
        <div className="grid min-w-0 gap-1">
          <p className="text-[26px] leading-tight font-semibold tracking-tight">{fmt(goal.current, goal.currency)}</p>
          <p className="text-[13px] text-muted-foreground">
            of <span className="num">{fmt(goal.targetAmount, goal.currency)}</span>
            {!done && isPositive(goal.remaining) && (
              <>
                {" "}· <span className="num">{fmt(goal.remaining, goal.currency)}</span> to go
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <GoalTrackBadge track={goal.track} />
            {goal.status === "archived" && <Badge variant="outline">Archived</Badge>}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {goal.status !== "archived" && (
          <>
            <Button size="sm" onClick={() => onContribute("contribute")}>
              <Plus /> Add money
            </Button>
            <Button size="sm" variant="outline" onClick={() => onContribute("withdraw")} disabled={!isPositive(goal.current)}>
              <Minus /> Withdraw
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border p-4 sm:grid-cols-3">
        <Stat label="Deadline" hint={daysLeft !== null ? (daysLeft < 0 ? `${-daysLeft} days ago` : daysLeft === 0 ? "Today" : `${daysLeft} days left`) : undefined}>
          {goal.deadline ? formatDate(goal.deadline) : "None"}
        </Stat>
        <Stat label={`Needed per ${per}`} hint={goal.periodsLeft ? `${goal.periodsLeft} ${goal.periodsLeft === 1 ? "period" : "periods"} left` : undefined}>
          {goal.requiredPerPeriod ? <Money amount={goal.requiredPerPeriod} currency={goal.currency} /> : done ? "—" : "Set a deadline"}
        </Stat>
        <Stat label={`Recent pace per ${per}`} hint={`Net saving, last ${goal.paceWindowDays} days`}>
          {goal.pacePerPeriod ? <Money amount={goal.pacePerPeriod} currency={goal.currency} /> : "No recent saving"}
        </Stat>
        <Stat label="Projected completion" hint={goal.projectedCompletionDate ? "Projection at recent pace — not a guarantee" : undefined}>
          {done ? (goal.completedAt ? `Reached ${formatDate(goal.completedAt.slice(0, 10))}` : "Reached") : goal.projectedCompletionDate ? formatDate(goal.projectedCompletionDate) : "—"}
        </Stat>
        <Stat label="Plan">{goal.targetContribution ? `${fmt(goal.targetContribution, goal.currency)} / ${per}` : goal.contributionFrequency ? GOAL_FREQUENCY_LABELS[goal.contributionFrequency].label : "Flexible"}</Stat>
        <Stat label="Kept in">
          {goal.linkedAccountId && goal.linkedAccountName ? (
            <Link href={`/transactions?account=${goal.linkedAccountId}`} className="underline-offset-4 hover:underline">
              {goal.linkedAccountName}
            </Link>
          ) : (
            "Not linked"
          )}
        </Stat>
      </dl>

      {plan && <p className="-mt-2 text-[13px] text-muted-foreground">{plan}.</p>}
      {goal.notes && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{goal.notes}</p>}

      <ContributionHistory goal={goal} />
    </div>
  );
}

function ContributionHistory({ goal }: { goal: GoalProgress }) {
  const { prefs } = useAppData();
  const fmt = useMoney();
  const [state, setState] = React.useState<HistoryState>({ status: "loading" });
  const [retry, setRetry] = React.useState(0);
  const [confirm, setConfirm] = React.useState<ContributionRow | null>(null);
  const [deleteTransfer, setDeleteTransfer] = React.useState(true);
  const [deleting, setDeleting] = React.useState(false);
  // Refetch whenever the goal's totals change (after a contribution or delete + refresh()).
  const version = `${goal.id}:${goal.contributionCount}:${goal.contributed}:${retry}`;

  React.useEffect(() => {
    let cancelled = false;
    listContributionsAction({ goalId: goal.id }).then(
      (r) => {
        if (cancelled) return;
        setState(r.ok ? { status: "ok", rows: r.data } : { status: "error", message: r.error });
      },
      () => !cancelled && setState({ status: "error", message: "Couldn't load the history. Check your connection." }),
    );
    return () => {
      cancelled = true;
    };
  }, [goal.id, version]);

  async function remove() {
    if (!confirm) return;
    setDeleting(true);
    const r = await deleteContributionAction({ id: confirm.id, keepTransfer: confirm.transfer ? !deleteTransfer : false });
    setDeleting(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(confirm.transfer && deleteTransfer ? "Entry and its transfer removed" : "Entry removed");
    setConfirm(null);
  }

  return (
    <section aria-labelledby="goal-history-h" className="grid gap-2">
      <h3 id="goal-history-h" className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <History className="size-3.5" aria-hidden /> History
      </h3>
      {state.status === "loading" && (
        <div className="grid gap-2" aria-busy="true" aria-label="Loading history">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      )}
      {state.status === "error" && (
        <ErrorState
          message={state.message}
          retry={
            <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      )}
      {state.status === "ok" &&
        (state.rows.length === 0 ? (
          <EmptyState className="rounded-lg border border-dashed py-8" title="No contributions yet" description={isPositive(goal.startingAmount) ? `Started with ${fmt(goal.startingAmount, goal.currency)}.` : "Add money to see it here."} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {state.rows.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <p className="truncate text-sm">{c.note ?? (isNegative(c.amount) ? "Withdrawal" : "Contribution")}</p>
                  <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
                    <span>{relativeDayLabel(c.date, prefs.today)}</span>
                    {c.transfer && (
                      <span className="inline-flex items-center gap-1">
                        <ArrowRightLeft className="size-3" aria-hidden />
                        {c.transfer.fromAccountName} → {c.transfer.toAccountName}
                      </span>
                    )}
                  </p>
                </div>
                <Money amount={c.amount} currency={goal.currency} signed tone="flow" className="text-sm" />
                <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={`Delete entry from ${formatDate(c.date)}`} onClick={() => { setDeleteTransfer(true); setConfirm(c); }}>
                  <Trash2 />
                </Button>
              </li>
            ))}
            {isPositive(goal.startingAmount) && (
              <li className="flex items-center gap-3 px-3 py-2.5 text-muted-foreground">
                <p className="flex-1 text-sm">Starting amount</p>
                <Money amount={goal.startingAmount} currency={goal.currency} className="text-sm" />
                <span className="size-9" aria-hidden />
              </li>
            )}
          </ul>
        ))}

      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this entry?"
        description={confirm ? `${fmt(confirm.amount, goal.currency, { signed: true })} on ${formatDate(confirm.date)} will be removed from ${goal.name}.` : undefined}
        onConfirm={remove}
        loading={deleting}
      >
        {confirm?.transfer && (
          <label className="mt-4 flex items-start gap-2.5 text-sm">
            <Checkbox checked={deleteTransfer} onCheckedChange={(v) => setDeleteTransfer(v === true)} className="mt-0.5" />
            <span>
              Also delete the transfer from {confirm.transfer.fromAccountName} to {confirm.transfer.toAccountName}
              <span className="block text-[13px] text-muted-foreground">Account balances go back to how they were. You can restore it from Transactions.</span>
            </span>
          </label>
        )}
      </ConfirmDialog>
    </section>
  );
}
