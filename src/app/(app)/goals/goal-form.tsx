"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { ErrorState } from "@/components/ui/misc";
import { CATEGORY_COLORS, Icon } from "@/components/app/icons";
import { useAppData, useMoney } from "@/components/app/user-context";
import { cn } from "@/lib/utils";
import { addDaysISO, formatDate } from "@/lib/dates";
import { CURRENCIES, currencySymbol, isPositive, sub, toInputValue } from "@/lib/money";
import { evalAmount } from "@/lib/amount-expr";
import { occurrencesBetween } from "@/lib/recurrence";
import {
  GOAL_FREQUENCIES,
  GOAL_FREQUENCY_LABELS,
  GOAL_ICONS,
  GOAL_KINDS,
  ceilDivCents,
  goalKindMeta,
  type GoalFrequency,
  type GoalKind,
} from "@/lib/goals";
import type { GoalProgress } from "@/server/services/goals";
import { createGoalAction, updateGoalAction } from "./actions";

type Values = {
  name: string;
  kind: GoalKind;
  icon: string;
  color: string;
  targetAmount: string;
  startingAmount: string;
  currency: string;
  deadline: string;
  contributionFrequency: GoalFrequency | "";
  targetContribution: string;
  linkedAccountId: string;
  notes: string;
};

const SWATCHES = CATEGORY_COLORS.filter((_, i) => i % 2 === 0 || i >= 18).slice(0, 12);

function initialValues(goal: GoalProgress | null, kind: GoalKind | undefined, baseCurrency: string): Values {
  if (goal)
    return {
      name: goal.name,
      kind: goal.kind,
      icon: goal.icon,
      color: goal.color,
      targetAmount: toInputValue(goal.targetAmount),
      startingAmount: toInputValue(goal.startingAmount) === "0" ? "" : toInputValue(goal.startingAmount),
      currency: goal.currency,
      deadline: goal.deadline ?? "",
      contributionFrequency: goal.contributionFrequency ?? "",
      targetContribution: goal.targetContribution ? toInputValue(goal.targetContribution) : "",
      linkedAccountId: goal.linkedAccountId ?? "",
      notes: goal.notes ?? "",
    };
  const meta = goalKindMeta(kind ?? "custom");
  return {
    name: kind && kind !== "custom" ? meta.label : "",
    kind: meta.id,
    icon: meta.icon,
    color: meta.color,
    targetAmount: "",
    startingAmount: "",
    currency: baseCurrency,
    deadline: "",
    contributionFrequency: "monthly",
    targetContribution: "",
    linkedAccountId: "",
    notes: "",
  };
}

export function GoalFormDialog({
  open,
  onOpenChange,
  goal,
  initialKind,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  goal: GoalProgress | null;
  initialKind?: GoalKind;
  onSaved?: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={goal ? "Edit goal" : "New goal"}
        description={goal ? undefined : "Give it a target, and optionally a date — we'll work out what to put aside."}
        size="lg"
      >
        {open && <GoalForm key={goal?.id ?? `new-${initialKind ?? ""}`} goal={goal} initialKind={initialKind} onDone={(id) => { onOpenChange(false); onSaved?.(id); }} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function GoalForm({ goal, initialKind, onDone, onCancel }: { goal: GoalProgress | null; initialKind?: GoalKind; onDone: (id: string) => void; onCancel: () => void }) {
  const { prefs, accounts } = useAppData();
  const fmt = useMoney();
  const [v, setV] = React.useState<Values>(() => initialValues(goal, initialKind, prefs.currency));
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((s) => ({ ...s, [k]: val }));
  const err = (k: string) => errors[k]?.[0];

  const linkable = accounts.filter(
    (a) => a.currency === v.currency && a.type !== "credit_card" && a.type !== "loan" && (!a.isArchived || a.id === v.linkedAccountId),
  );
  const currencyOptions = React.useMemo(() => {
    const used = new Set([prefs.currency, ...accounts.map((a) => a.currency), v.currency]);
    return [...CURRENCIES.filter((c) => used.has(c.code)), ...CURRENCIES.filter((c) => !used.has(c.code))];
  }, [accounts, prefs.currency, v.currency]);

  // Live preview of the required contribution (same rule as the server: current period counts).
  const target = evalAmount(v.targetAmount);
  const starting = evalAmount(v.startingAmount || "0") ?? "0";
  const remaining = target ? sub(target, starting) : null;
  const freq = (v.contributionFrequency || "monthly") as GoalFrequency;
  let preview: string | null = null;
  if (remaining && isPositive(remaining) && v.deadline && v.deadline > prefs.today) {
    const periods = Math.max(1, occurrencesBetween({ frequency: freq, startDate: prefs.today }, prefs.today, v.deadline).length);
    preview = `About ${fmt(ceilDivCents(remaining, periods), v.currency)} / ${GOAL_FREQUENCY_LABELS[freq].per} over ${periods} ${periods === 1 ? GOAL_FREQUENCY_LABELS[freq].noun : GOAL_FREQUENCY_LABELS[freq].noun + "s"}`;
  }

  function pickKind(kind: GoalKind) {
    const prev = goalKindMeta(v.kind);
    const next = goalKindMeta(kind);
    setV((s) => ({
      ...s,
      kind,
      // Follow the preset unless the user customised these fields.
      icon: s.icon === prev.icon ? next.icon : s.icon,
      color: s.color === prev.color ? next.color : s.color,
      name: !s.name || s.name === prev.label ? (kind === "custom" ? "" : next.label) : s.name,
    }));
  }

  function submit() {
    setErrors({});
    setFormError(null);
    const targetAmount = evalAmount(v.targetAmount);
    if (!targetAmount || !isPositive(targetAmount)) {
      setErrors({ targetAmount: ["Enter a target amount"] });
      return;
    }
    const payload = {
      name: v.name,
      kind: v.kind,
      icon: v.icon,
      color: v.color,
      targetAmount,
      startingAmount: evalAmount(v.startingAmount || "0") ?? v.startingAmount,
      currency: v.currency,
      deadline: v.deadline || null,
      contributionFrequency: v.contributionFrequency || null,
      targetContribution: v.targetContribution ? (evalAmount(v.targetContribution) ?? v.targetContribution) : null,
      linkedAccountId: v.linkedAccountId || null,
      notes: v.notes || null,
    };
    start(async () => {
      const r = goal ? await updateGoalAction({ id: goal.id, data: payload }) : await createGoalAction(payload);
      if (!r.ok) {
        setFormError(r.error);
        setErrors(r.fieldErrors ?? {});
        return;
      }
      toast.success(goal ? "Goal updated" : `Goal "${v.name.trim()}" created`);
      onDone(r.data.id);
    });
  }

  return (
    <form
      className="grid gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-[13px] font-medium">What are you saving for?</legend>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
          {GOAL_KINDS.map((k) => {
            const active = v.kind === k.id;
            return (
              <button
                key={k.id}
                type="button"
                aria-pressed={active}
                onClick={() => pickKind(k.id)}
                className={cn(
                  "flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border border-transparent px-1 py-2 text-center text-[12px] leading-tight text-muted-foreground transition hover:bg-muted",
                  active && "border-border-strong bg-muted text-foreground",
                )}
              >
                <span className="grid size-8 place-items-center rounded-full [&_svg]:size-4" style={{ backgroundColor: `color-mix(in oklab, ${k.color} 16%, transparent)`, color: k.color }}>
                  <Icon name={k.icon} />
                </span>
                {k.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <Field label="Name" htmlFor="goal-name" error={err("name")}>
        <Input id="goal-name" value={v.name} onChange={(e) => set("name", e.target.value)} maxLength={60} placeholder="e.g. Trip to Japan" aria-invalid={err("name") ? true : undefined} required />
      </Field>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem]">
        <Field label="Target amount" htmlFor="goal-target" error={err("targetAmount")}>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">{currencySymbol(v.currency, prefs.locale)}</span>
            <Input id="goal-target" inputMode="decimal" className="num pl-8" value={v.targetAmount} onChange={(e) => set("targetAmount", e.target.value)} placeholder="0" aria-invalid={err("targetAmount") ? true : undefined} />
          </div>
        </Field>
        <Field label="Already saved" htmlFor="goal-start" error={err("startingAmount")} optional>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">{currencySymbol(v.currency, prefs.locale)}</span>
            <Input id="goal-start" inputMode="decimal" className="num pl-8" value={v.startingAmount} onChange={(e) => set("startingAmount", e.target.value)} placeholder="0" />
          </div>
        </Field>
        <Field label="Currency" htmlFor="goal-currency" error={err("currency")}>
          <NativeSelect
            id="goal-currency"
            value={v.currency}
            disabled={Boolean(goal && goal.contributionCount > 0)}
            onChange={(e) => setV((s) => ({ ...s, currency: e.target.value, linkedAccountId: "" }))}
          >
            {currencyOptions.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Target date" htmlFor="goal-deadline" error={err("deadline")} optional>
          <Input id="goal-deadline" type="date" min={addDaysISO(prefs.today, 1)} value={v.deadline} onChange={(e) => set("deadline", e.target.value)} />
        </Field>
        <Field label="Save" htmlFor="goal-frequency" error={err("contributionFrequency")} hint={v.contributionFrequency ? "We'll remind you if a period passes with nothing added." : undefined}>
          <NativeSelect id="goal-frequency" value={v.contributionFrequency} onChange={(e) => set("contributionFrequency", e.target.value as GoalFrequency | "")}>
            <option value="">Whenever I can</option>
            {GOAL_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {GOAL_FREQUENCY_LABELS[f].label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      {preview && (
        <p role="status" className="-mt-2 rounded-lg bg-subtle px-3 py-2 text-[13px] text-muted-foreground">
          {preview} to reach it by {formatDate(v.deadline)}.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={`Planned amount${v.contributionFrequency ? ` per ${GOAL_FREQUENCY_LABELS[v.contributionFrequency].per}` : ""}`}
          htmlFor="goal-plan"
          error={err("targetContribution")}
          optional
          hint={!v.deadline ? "Used to judge whether you're on track when there's no date." : undefined}
        >
          <Input id="goal-plan" inputMode="decimal" className="num" value={v.targetContribution} onChange={(e) => set("targetContribution", e.target.value)} placeholder="0" />
        </Field>
        <Field
          label="Kept in account"
          htmlFor="goal-account"
          error={err("linkedAccountId")}
          optional
          hint={linkable.length ? "Lets you move real money into it when you contribute." : `No ${v.currency} savings accounts yet.`}
        >
          <NativeSelect id="goal-account" value={v.linkedAccountId} onChange={(e) => set("linkedAccountId", e.target.value)} aria-invalid={err("linkedAccountId") ? true : undefined}>
            <option value="">Not linked</option>
            {linkable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label id="goal-colour-label">Colour</Label>
          <div role="radiogroup" aria-labelledby="goal-colour-label" className="flex flex-wrap gap-1.5">
            {[...new Set([v.color, ...SWATCHES])].map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={v.color === c}
                aria-label={c}
                onClick={() => set("color", c)}
                className="grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-popover aria-checked:ring-2 aria-checked:ring-foreground/60"
                style={{ backgroundColor: c }}
              >
                {v.color === c && <Check className="size-4 text-white" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label id="goal-icon-label">Icon</Label>
          <div role="radiogroup" aria-labelledby="goal-icon-label" className="flex flex-wrap gap-1">
            {GOAL_ICONS.map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={v.icon === i}
                aria-label={i.replace(/-/g, " ")}
                onClick={() => set("icon", i)}
                className={cn("grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted [&_svg]:size-4", v.icon === i && "bg-muted text-foreground ring-1 ring-border-strong")}
              >
                <Icon name={i} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <Field label="Notes" htmlFor="goal-notes" optional>
        <Textarea id="goal-notes" rows={2} maxLength={500} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>

      {formError && <ErrorState message={formError} />}

      <DialogFooter className="mt-0">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {goal ? "Save changes" : "Create goal"}
        </Button>
      </DialogFooter>
    </form>
  );
}
