"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { Segmented, Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { CategoryBadge } from "@/components/app/icons";
import { useAppData, useMoney } from "@/components/app/user-context";
import { addDaysISO, monthRange } from "@/lib/dates";
import { currencySymbol, toInputValue } from "@/lib/money";
import { cn } from "@/lib/utils";
import { createBudgetAction, updateBudgetAction } from "./actions";

export type BudgetFormValues = {
  id?: string;
  name: string;
  period: "weekly" | "monthly" | "yearly" | "custom";
  categoryId: string;
  includeSubcategories: boolean;
  amount: string;
  startDate: string;
  endDate: string;
  rollover: boolean;
  alertsEnabled: boolean;
  alertThresholds: number[];
  alertOnProjected: boolean;
};

const DEFAULT_THRESHOLDS = [50, 75, 90, 100];

export function emptyBudget(today: string, categoryId?: string | null): BudgetFormValues {
  const m = monthRange(today);
  return {
    name: "",
    period: "monthly",
    categoryId: categoryId ?? "",
    includeSubcategories: true,
    amount: "",
    startDate: today,
    endDate: m.to > today ? m.to : addDaysISO(today, 30),
    rollover: false,
    alertsEnabled: true,
    alertThresholds: DEFAULT_THRESHOLDS,
    alertOnProjected: true,
  };
}

const PERIOD_OPTIONS = [
  { value: "weekly" as const, label: "Weekly" },
  { value: "monthly" as const, label: "Monthly" },
  { value: "yearly" as const, label: "Yearly" },
  { value: "custom" as const, label: "Custom" },
];

function ThresholdChips({ value, onChange, disabled }: { value: number[]; onChange: (v: number[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const addOne = () => {
    const n = Number(draft);
    if (!draft.trim()) return;
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      setErr("Use a whole number from 1 to 200");
      return;
    }
    if (value.length >= 10) {
      setErr("Up to 10 thresholds");
      return;
    }
    onChange([...new Set([...value, n])].sort((a, b) => a - b));
    setDraft("");
    setErr(null);
  };
  return (
    <div className={cn("grid gap-1.5", disabled && "pointer-events-none opacity-50")} aria-disabled={disabled || undefined}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((t) => (
          <span key={t} className="num inline-flex h-8 items-center gap-1 rounded-full border bg-card pr-1 pl-3 text-[13px]">
            {t}%
            <button
              type="button"
              className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Remove ${t}% alert`}
              onClick={() => onChange(value.filter((x) => x !== t))}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <Input
            aria-label="Add alert threshold (percent)"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOne();
              }
            }}
            placeholder="%"
            className="num h-8 w-16 text-center"
          />
          <Button type="button" variant="ghost" size="icon-sm" onClick={addOne} aria-label="Add threshold" disabled={!draft}>
            <Plus />
          </Button>
        </div>
      </div>
      {err ? (
        <p role="alert" className="text-[13px] text-negative">
          {err}
        </p>
      ) : value.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No % alerts — add one, e.g. 80.</p>
      ) : null}
    </div>
  );
}

export function BudgetDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial: BudgetFormValues }) {
  const editing = Boolean(initial.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={editing ? "Edit budget" : "New budget"}
        description={editing ? undefined : "Set a spending limit for a category, or for everything you spend."}
      >
        {/* Content unmounts when closed, so the form starts fresh from `initial` on every open. */}
        <BudgetFormBody initial={initial} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function BudgetFormBody({ initial, onDone }: { initial: BudgetFormValues; onDone: () => void }) {
  const { prefs, categories } = useAppData();
  const fmt = useMoney();
  const [v, setV] = React.useState<BudgetFormValues>(initial);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const editing = Boolean(initial.id);

  const set = <K extends keyof BudgetFormValues>(k: K, val: BudgetFormValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const expenseParents = categories.filter((c) => c.kind === "expense" && !c.parentId && (!c.isArchived || c.id === v.categoryId));
  const selected = categories.find((c) => c.id === v.categoryId);
  const hasChildren = Boolean(selected && !selected.parentId && categories.some((c) => c.parentId === selected.id));
  const custom = v.period === "custom";
  const placeholderName = selected ? selected.name : "Overall spending";

  function submit() {
    setErrors({});
    setFormError(null);
    const data = {
      name: v.name.trim() || null,
      period: v.period,
      categoryId: v.categoryId || null,
      includeSubcategories: v.includeSubcategories,
      amount: v.amount,
      startDate: custom ? v.startDate : null,
      endDate: custom ? v.endDate : null,
      rollover: custom ? false : v.rollover,
      alertsEnabled: v.alertsEnabled,
      alertThresholds: v.alertThresholds,
      alertOnProjected: v.alertOnProjected,
    };
    start(async () => {
      const r = editing ? await updateBudgetAction({ id: v.id!, data }) : await createBudgetAction(data);
      if (!r.ok) {
        setFormError(r.error);
        setErrors(r.fieldErrors ?? {});
        return;
      }
      toast.success(editing ? "Budget updated" : `Budget of ${fmt(v.amount || "0")} created`);
      onDone();
    });
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="What to budget" htmlFor="b-category" error={errors.categoryId}>
        <div className="flex items-center gap-2">
          {selected ? <CategoryBadge icon={selected.icon} color={selected.color} size="md" /> : null}
          <div className="flex-1">
            <NativeSelect
              id="b-category"
              value={v.categoryId}
              onChange={(e) => set("categoryId", e.target.value)}
              aria-invalid={errors.categoryId ? true : undefined}
            >
              <option value="">Overall spending (all categories)</option>
              {expenseParents.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  <option value={p.id}>{p.name}</option>
                  {categories
                    .filter((c) => c.parentId === p.id && (!c.isArchived || c.id === v.categoryId))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {p.name} › {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </NativeSelect>
          </div>
        </div>
      </Field>

      {hasChildren && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Include subcategories
            <span className="block text-[13px] text-muted-foreground">Count everything under {selected?.name}.</span>
          </span>
          <Switch checked={v.includeSubcategories} onCheckedChange={(c) => set("includeSubcategories", c)} aria-label="Include subcategories" />
        </label>
      )}

      <div className="grid gap-1.5">
        <Label>Period</Label>
        <Segmented ariaLabel="Budget period" value={v.period} onChange={(p) => set("period", p)} options={PERIOD_OPTIONS} className="w-full" />
        <p className="text-[13px] text-muted-foreground">
          {v.period === "monthly" && (prefs.monthStartDay > 1 ? `Months start on day ${prefs.monthStartDay} (Settings).` : "Resets on the 1st of each month.")}
          {v.period === "weekly" && `Resets every ${prefs.weekStartsOn === 0 ? "Sunday" : "Monday"}.`}
          {v.period === "yearly" && "Resets on 1 January."}
          {v.period === "custom" && "A one-off budget for a date range, like a trip or a project."}
        </p>
      </div>

      {custom && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" htmlFor="b-start" error={errors.startDate}>
            <Input id="b-start" type="date" value={v.startDate} onChange={(e) => set("startDate", e.target.value)} required />
          </Field>
          <Field label="Ends" htmlFor="b-end" error={errors.endDate}>
            <Input id="b-end" type="date" value={v.endDate} min={v.startDate} onChange={(e) => set("endDate", e.target.value)} required />
          </Field>
        </div>
      )}

      <div className="grid grid-cols-[1fr_1fr] gap-3">
        <Field label={`Amount (${prefs.currency})`} htmlFor="b-amount" error={errors.amount}>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
              {currencySymbol(prefs.currency, prefs.locale)}
            </span>
            <Input
              id="b-amount"
              inputMode="decimal"
              value={v.amount}
              onChange={(e) => set("amount", e.target.value.replace(/[^\d.,]/g, ""))}
              placeholder="0"
              className="num pl-8"
              aria-invalid={errors.amount ? true : undefined}
              required
            />
          </div>
        </Field>
        <Field label="Name" htmlFor="b-name" optional error={errors.name}>
          <Input id="b-name" value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={placeholderName} maxLength={60} />
        </Field>
      </div>

      {!custom && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Roll over leftovers
            <span className="block text-[13px] text-muted-foreground">Unspent money (or overspending) carries into the next period.</span>
          </span>
          <Switch checked={v.rollover} onCheckedChange={(c) => set("rollover", c)} aria-label="Roll over leftovers" />
        </label>
      )}

      <div className="grid gap-3 rounded-lg border bg-subtle/60 p-3.5">
        <label className="flex items-center justify-between gap-3 text-sm font-medium">
          Alerts
          <Switch checked={v.alertsEnabled} onCheckedChange={(c) => set("alertsEnabled", c)} aria-label="Budget alerts" />
        </label>
        <div className="grid gap-1.5">
          <span className="text-[13px] text-muted-foreground" id="b-thresholds">
            Notify me once per period when spending reaches
          </span>
          <ThresholdChips value={v.alertThresholds} onChange={(t) => set("alertThresholds", t)} disabled={!v.alertsEnabled} />
          {errors.alertThresholds && <p className="text-[13px] text-negative">{errors.alertThresholds[0]}</p>}
        </div>
        <label className={cn("flex items-center justify-between gap-3 text-sm", !v.alertsEnabled && "opacity-50")}>
          <span>
            Warn when I&apos;m on pace to go over
            <span className="block text-[13px] text-muted-foreground">Based on a forecast of your spending pace so far.</span>
          </span>
          <Switch
            checked={v.alertOnProjected}
            disabled={!v.alertsEnabled}
            onCheckedChange={(c) => set("alertOnProjected", c)}
            aria-label="Warn when on pace to go over"
          />
        </label>
      </div>

      {formError && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {formError}
        </p>
      )}
      <DialogFooter className="mt-1">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {editing ? "Save changes" : "Create budget"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function toFormValues(
  b: {
    id: string;
    name: string;
    period: BudgetFormValues["period"];
    categoryId: string | null;
    includeSubcategories: boolean;
    amount: string;
    startDate: string | null;
    endDate: string | null;
    rollover: boolean;
    alertsEnabled: boolean;
    alertThresholds: number[];
    alertOnProjected: boolean;
  },
  today: string,
): BudgetFormValues {
  const base = emptyBudget(today, b.categoryId);
  return {
    id: b.id,
    name: b.name,
    period: b.period,
    categoryId: b.categoryId ?? "",
    includeSubcategories: b.includeSubcategories,
    amount: toInputValue(b.amount),
    startDate: b.startDate ?? base.startDate,
    endDate: b.endDate ?? base.endDate,
    rollover: b.rollover,
    alertsEnabled: b.alertsEnabled,
    alertThresholds: b.alertThresholds,
    alertOnProjected: b.alertOnProjected,
  };
}
