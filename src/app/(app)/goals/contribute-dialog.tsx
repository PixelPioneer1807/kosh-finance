"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, ChevronRight, Info, Target } from "lucide-react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Segmented, Switch } from "@/components/ui/controls";
import { EmptyState, ErrorState } from "@/components/ui/misc";
import { Icon } from "@/components/app/icons";
import { useAppData, useMoney } from "@/components/app/user-context";
import { ColorBar } from "@/components/widgets/progress-ring";
import { cn } from "@/lib/utils";
import { addDaysISO } from "@/lib/dates";
import { cmp, currencySymbol, isPositive, toInputValue } from "@/lib/money";
import { evalAmount } from "@/lib/amount-expr";
import type { GoalProgress } from "@/server/services/goals";
import { addContributionAction } from "./actions";

export type ContributeTarget = { goalId: string | null; direction: "contribute" | "withdraw" };

/**
 * Add to / withdraw from a goal. With `goalId: null` it first shows a picker of active goals
 * (used by `?contribute=1` from the dashboard or command palette).
 */
export function ContributeDialog({
  target,
  goals,
  onOpenChange,
}: {
  target: ContributeTarget | null;
  goals: GoalProgress[];
  onOpenChange: (open: boolean) => void;
}) {
  const [picked, setPicked] = React.useState<string | null>(null);
  const goalId = target?.goalId ?? picked;
  const goal = goals.find((g) => g.id === goalId) ?? null;
  const active = goals.filter((g) => g.status === "active");
  const close = (o: boolean) => {
    if (!o) setPicked(null);
    onOpenChange(o);
  };
  const withdrawing = target?.direction === "withdraw";

  return (
    <Dialog open={Boolean(target)} onOpenChange={close}>
      <DialogContent
        title={goal ? `${withdrawing ? "Withdraw from" : "Add to"} ${goal.name}` : "Add to a goal"}
        description={goal ? undefined : "Choose the goal you're putting money towards."}
      >
        {target && !goal && (
          active.length === 0 ? (
            <EmptyState className="py-8" icon={<Target />} title="No active goals" description="Create a goal first, then add money to it here." />
          ) : (
            <ul className="-mx-2 grid gap-0.5">
              {active.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(g.id)}
                    className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-full [&_svg]:size-4" style={{ backgroundColor: `color-mix(in oklab, ${g.color} 16%, transparent)`, color: g.color }}>
                      <Icon name={g.icon} />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="truncate text-sm font-medium">{g.name}</span>
                      <ColorBar value={g.progress} color={g.color} label={`${Math.round(Math.min(1, g.progress) * 100)}% saved`} />
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
        {target && goal && (
          <ContributeForm key={`${goal.id}-${target.direction}`} goal={goal} initialDirection={target.direction} onDone={() => close(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ContributeForm({ goal, initialDirection, onDone }: { goal: GoalProgress; initialDirection: "contribute" | "withdraw"; onDone: () => void }) {
  const { prefs, accounts } = useAppData();
  const fmt = useMoney();
  const [direction, setDirection] = React.useState(initialDirection);
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState(prefs.today);
  const [note, setNote] = React.useState("");
  const usable = accounts.filter((a) => a.currency === goal.currency && !a.isArchived);
  const goalAccounts = usable.filter((a) => a.type !== "credit_card" && a.type !== "loan");
  const [move, setMove] = React.useState(Boolean(goal.linkedAccountId) && usable.length > 1);
  const [goalAccountId, setGoalAccountId] = React.useState(goal.linkedAccountId ?? goalAccounts[0]?.id ?? "");
  const [otherAccountId, setOtherAccountId] = React.useState(
    () => (prefs.defaultAccountId && prefs.defaultAccountId !== goalAccountId && usable.some((a) => a.id === prefs.defaultAccountId) ? prefs.defaultAccountId : usable.find((a) => a.id !== goalAccountId)?.id) ?? "",
  );
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const amountRef = React.useRef<HTMLInputElement>(null);

  const withdrawing = direction === "withdraw";
  const value = evalAmount(amount);
  const goalAccount = usable.find((a) => a.id === goalAccountId);
  const otherAccount = usable.find((a) => a.id === otherAccountId);
  const from = withdrawing ? goalAccount : otherAccount;
  const to = withdrawing ? otherAccount : goalAccount;
  const overdraw = withdrawing && value && cmp(value, goal.current) > 0;

  function submit() {
    setErrors({});
    setFormError(null);
    if (!value || !isPositive(value)) {
      setErrors({ amount: ["Enter an amount"] });
      amountRef.current?.focus();
      return;
    }
    if (move && (!goalAccountId || !otherAccountId)) {
      setErrors({ accountId: ["Choose both accounts"] });
      return;
    }
    start(async () => {
      const r = await addContributionAction({
        goalId: goal.id,
        direction,
        amount: value,
        date,
        note: note || null,
        accountId: move ? otherAccountId : null,
        goalAccountId: move ? goalAccountId : null,
      });
      if (!r.ok) {
        setFormError(r.error);
        setErrors(r.fieldErrors ?? {});
        return;
      }
      const moved = move && from && to ? ` · moved from ${from.name} to ${to.name}` : "";
      if (r.data.completed) toast.success(`Goal reached: ${goal.name}`, { description: `${fmt(value, goal.currency)} added — that's the target.` });
      else toast.success(`${withdrawing ? "Withdrew" : "Added"} ${fmt(value, goal.currency)} ${withdrawing ? "from" : "to"} ${goal.name}${moved}`);
      onDone();
    });
  }

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Segmented
        ariaLabel="Direction"
        className="w-full"
        value={direction}
        onChange={setDirection}
        options={[
          { value: "contribute", label: "Add money" },
          { value: "withdraw", label: "Withdraw" },
        ]}
      />

      <div>
        <label htmlFor="contrib-amount" className="sr-only">
          Amount
        </label>
        <div className={cn("flex items-baseline gap-2 border-b-2 border-border pb-1 transition-colors focus-within:border-foreground", (errors.amount || overdraw) && "border-negative")}>
          <span className="text-2xl font-medium text-muted-foreground">{currencySymbol(goal.currency, prefs.locale)}</span>
          <input
            ref={amountRef}
            id="contrib-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,+\-\s]/g, ""))}
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            placeholder="0"
            aria-invalid={errors.amount || overdraw ? true : undefined}
            aria-describedby="contrib-amount-hint"
            className="num w-full min-w-0 bg-transparent text-[36px] leading-tight font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
          />
        </div>
        <p id="contrib-amount-hint" role={errors.amount || overdraw ? "alert" : undefined} className={cn("mt-1 text-[13px]", errors.amount || overdraw ? "text-negative" : "text-muted-foreground")}>
          {errors.amount?.[0] ??
            (withdrawing
              ? `${overdraw ? "More than" : "Up to"} ${fmt(goal.current, goal.currency)} available in this goal`
              : isPositive(goal.remaining)
                ? `${fmt(goal.remaining, goal.currency)} to go${goal.requiredPerPeriod ? ` · plan is ${fmt(goal.requiredPerPeriod, goal.currency)} per period` : ""}`
                : "This goal has reached its target")}
        </p>
        {!withdrawing && isPositive(goal.remaining) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[goal.requiredPerPeriod, goal.targetContribution, goal.remaining]
              .filter((x, i, arr): x is string => Boolean(x) && arr.indexOf(x) === i)
              .map((x) => (
                <button key={x} type="button" onClick={() => setAmount(toInputValue(x))} className="min-h-8 rounded-full border px-2.5 text-[12.5px] text-muted-foreground hover:text-foreground">
                  {fmt(x, goal.currency)}
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" htmlFor="contrib-date" error={errors.date}>
          <Input id="contrib-date" type="date" value={date} max={prefs.today} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Note" htmlFor="contrib-note" optional>
          <Input id="contrib-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={withdrawing ? "Why?" : "e.g. Bonus"} />
        </Field>
      </div>
      <div className="flex gap-1 -mt-2">
        {[
          { d: prefs.today, l: "Today" },
          { d: addDaysISO(prefs.today, -1), l: "Yesterday" },
        ].map((o) => (
          <button
            key={o.l}
            type="button"
            onClick={() => setDate(o.d)}
            aria-pressed={date === o.d}
            className={cn("min-h-7 rounded-full border px-2 text-[12px] text-muted-foreground", date === o.d && "border-foreground/40 text-foreground")}
          >
            {o.l}
          </button>
        ))}
      </div>

      <div className="grid gap-3 rounded-lg border bg-subtle/60 p-3.5">
        <label className="flex items-start justify-between gap-3">
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">Move money between accounts</span>
            <span className="text-[13px] text-muted-foreground">Records a transfer so your account balances match. Leave off to just track progress.</span>
          </span>
          <Switch checked={move} onCheckedChange={setMove} disabled={usable.length < 2 || goalAccounts.length === 0} aria-label="Move money between accounts" />
        </label>
        {usable.length < 2 && <p className="text-[13px] text-muted-foreground">You need two {goal.currency} accounts to move money.</p>}
        {move && (
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <Field label="From" htmlFor="contrib-from" error={!withdrawing ? errors.accountId : errors.goalAccountId}>
              <NativeSelect
                id="contrib-from"
                value={withdrawing ? goalAccountId : otherAccountId}
                onChange={(e) => (withdrawing ? setGoalAccountId(e.target.value) : setOtherAccountId(e.target.value))}
              >
                {(withdrawing ? goalAccounts : usable).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.id === goal.linkedAccountId ? " (goal account)" : ""}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <ArrowRight className="mb-3 size-4 text-muted-foreground" aria-hidden />
            <Field label="To" htmlFor="contrib-to" error={withdrawing ? errors.accountId : errors.goalAccountId}>
              <NativeSelect
                id="contrib-to"
                value={withdrawing ? otherAccountId : goalAccountId}
                onChange={(e) => (withdrawing ? setOtherAccountId(e.target.value) : setGoalAccountId(e.target.value))}
              >
                {(withdrawing ? usable : goalAccounts).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.id === goal.linkedAccountId ? " (goal account)" : ""}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {from && to && from.id === to.id && <p className="col-span-3 text-[13px] text-negative">Pick two different accounts.</p>}
            {from && to && from.id !== to.id && (
              <p className="col-span-3 flex items-start gap-1.5 text-[13px] text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Creates a transfer of {value ? fmt(value, goal.currency) : "this amount"} from {from.name} to {to.name}. Deleting this entry later removes the transfer too.
              </p>
            )}
          </div>
        )}
      </div>

      {formError && <ErrorState message={formError} />}

      <DialogFooter className="mt-0">
        <Button type="submit" loading={pending} disabled={Boolean(overdraw) || (move && from?.id === to?.id)}>
          {withdrawing ? "Withdraw" : "Add to goal"}
        </Button>
      </DialogFooter>
    </form>
  );
}
