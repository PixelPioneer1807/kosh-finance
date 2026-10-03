"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { Segmented, Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { useAppData, useMoney, type ClientCategory } from "@/components/app/user-context";
import { add, cmp, currencySymbol, isZero, normalize, sub, toInputValue } from "@/lib/money";
import { cn } from "@/lib/utils";
import { createRecurringAction, updateRecurringAction } from "./actions";
import { KIND_LABEL, type Deduction, type FrequencyId, type RecurringItem, type RecurringKindId, type UnitId } from "./types";

export type RecurringFormValues = {
  id?: string;
  kind: RecurringKindId;
  name: string;
  amount: string;
  accountId: string;
  toAccountId: string;
  categoryId: string;
  merchant: string;
  paymentMethodId: string;
  notes: string;
  frequency: FrequencyId;
  interval: string;
  intervalUnit: UnitId;
  startDate: string;
  endDate: string;
  autoPost: boolean;
  remindDaysBefore: string;
  status: RecurringItem["status"];
  serviceUrl: string;
  trialEndsAt: string;
  employer: string;
  grossAmount: string;
  deductions: { label: string; amount: string; kind: Deduction["kind"] }[];
};

export function emptyRecurring(
  kind: RecurringKindId,
  prefs: { today: string; defaultAccountId: string | null },
  accounts: { id: string; isArchived: boolean }[],
): RecurringFormValues {
  const active = accounts.filter((a) => !a.isArchived);
  const accountId = prefs.defaultAccountId && active.some((a) => a.id === prefs.defaultAccountId) ? prefs.defaultAccountId : (active[0]?.id ?? "");
  return {
    kind,
    name: "",
    amount: "",
    accountId,
    toAccountId: "",
    categoryId: "",
    merchant: "",
    paymentMethodId: "",
    notes: "",
    frequency: "monthly",
    interval: "1",
    intervalUnit: "month",
    startDate: prefs.today,
    endDate: "",
    autoPost: false,
    remindDaysBefore: "2",
    status: "active",
    serviceUrl: "",
    trialEndsAt: "",
    employer: "",
    grossAmount: "",
    deductions: [],
  };
}

export function itemToValues(i: RecurringItem): RecurringFormValues {
  return {
    id: i.id,
    kind: i.kind,
    name: i.name,
    amount: toInputValue(i.amount),
    accountId: i.accountId ?? "",
    toAccountId: i.toAccountId ?? "",
    categoryId: i.categoryId ?? "",
    merchant: i.merchant ?? "",
    paymentMethodId: i.paymentMethodId ?? "",
    notes: i.notes ?? "",
    frequency: i.frequency,
    interval: String(i.interval),
    intervalUnit: i.intervalUnit,
    // Editing keeps the schedule anchor; the next date is derived from it.
    startDate: i.startDate,
    endDate: i.endDate ?? "",
    autoPost: i.autoPost,
    remindDaysBefore: String(i.remindDaysBefore),
    status: i.status,
    serviceUrl: i.serviceUrl ?? "",
    trialEndsAt: i.trialEndsAt ?? "",
    employer: i.employer ?? "",
    grossAmount: i.grossAmount ? toInputValue(i.grossAmount) : "",
    deductions: i.deductions.map((d) => ({ ...d, amount: toInputValue(d.amount) })),
  };
}

const FREQUENCIES: { value: FrequencyId; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Every 3 months" },
  { value: "yearly", label: "Yearly" },
  { value: "daily", label: "Daily" },
  { value: "custom", label: "Custom…" },
];

const KIND_OPTIONS: { value: RecurringKindId; label: string }[] = [
  { value: "bill", label: "Bill" },
  { value: "subscription", label: "Subscription" },
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
  { value: "transfer", label: "Transfer" },
];

const NAME_PLACEHOLDER: Record<RecurringKindId, string> = {
  bill: "e.g. Electricity, Rent",
  subscription: "e.g. Streaming, Cloud storage",
  income: "e.g. Salary, Freelance retainer",
  expense: "e.g. Gym, Insurance premium",
  transfer: "e.g. Monthly savings",
};

const safeMoney = (v: string) => {
  try {
    return v.trim() ? normalize(v) : null;
  } catch {
    return null;
  }
};

/** Net = gross − taxes − deductions + bonuses. */
export function netFromBreakdown(gross: string, deductions: { amount: string; kind: Deduction["kind"] }[]) {
  const g = safeMoney(gross);
  if (!g) return null;
  let net = g;
  for (const d of deductions) {
    const a = safeMoney(d.amount);
    if (!a) continue;
    net = d.kind === "bonus" ? add(net, a) : sub(net, a);
  }
  return net;
}

function CategoryOptions({ categories, kind }: { categories: ClientCategory[]; kind: "expense" | "income" }) {
  const parents = categories.filter((c) => c.kind === kind && !c.parentId && !c.isArchived);
  return (
    <>
      {parents.map((p) => {
        const kids = categories.filter((c) => c.parentId === p.id && !c.isArchived);
        return kids.length ? (
          <optgroup key={p.id} label={p.name}>
            <option value={p.id}>{p.name}</option>
            {kids.map((c) => (
              <option key={c.id} value={c.id}>
                {p.name} › {c.name}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        );
      })}
    </>
  );
}

export function RecurringDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial: RecurringFormValues }) {
  const editing = Boolean(initial.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={editing ? `Edit ${KIND_LABEL[initial.kind].toLowerCase()}` : "Add recurring item"}
        description={editing ? undefined : "Track it once — Kosh reminds you and records it when it's paid."}
        size="lg"
      >
        {/* Content unmounts when closed, so the form starts fresh from `initial` on every open. */}
        <RecurringFormBody initial={initial} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RecurringFormBody({ initial, onDone }: { initial: RecurringFormValues; onDone: () => void }) {
  const { prefs, accounts: allAccounts, categories, paymentMethods } = useAppData();
  const fmt = useMoney();
  const [v, setV] = React.useState(initial);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const editing = Boolean(initial.id);

  const set = <K extends keyof RecurringFormValues>(k: K, val: RecurringFormValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const accounts = allAccounts.filter((a) => !a.isArchived || a.id === v.accountId || a.id === v.toAccountId);
  const account = accounts.find((a) => a.id === v.accountId);
  const currency = account?.currency ?? prefs.currency;
  const isIncome = v.kind === "income";
  const isTransfer = v.kind === "transfer";
  const isSub = v.kind === "subscription";
  const net = isIncome ? netFromBreakdown(v.grossAmount, v.deductions) : null;
  const usingBreakdown = isIncome && net !== null;
  const err = (k: string) => errors[k]?.[0];

  function submit() {
    setErrors({});
    setFormError(null);
    const amount = usingBreakdown ? net! : v.amount;
    if (usingBreakdown && cmp(net!, "0") <= 0) {
      setErrors({ grossAmount: ["Deductions can't be more than the gross amount"] });
      return;
    }
    const data = {
      kind: v.kind,
      name: v.name,
      amount,
      accountId: v.accountId || null,
      toAccountId: isTransfer ? v.toAccountId || null : null,
      categoryId: isTransfer ? null : v.categoryId || null,
      merchant: isTransfer || isIncome ? null : v.merchant || null,
      paymentMethodId: isTransfer ? null : v.paymentMethodId || null,
      notes: v.notes || null,
      frequency: v.frequency,
      interval: v.frequency === "custom" ? Number(v.interval) || 1 : 1,
      intervalUnit: v.frequency === "custom" ? v.intervalUnit : ("month" as const),
      startDate: v.startDate,
      endDate: v.endDate || null,
      autoPost: v.autoPost,
      remindDaysBefore: Number(v.remindDaysBefore) || 0,
      status: v.status,
      serviceUrl: isSub ? v.serviceUrl.trim() || null : null,
      trialEndsAt: isSub ? v.trialEndsAt || null : null,
      employer: isIncome ? v.employer || null : null,
      grossAmount: isIncome ? v.grossAmount || null : null,
      deductions: isIncome ? v.deductions.filter((d) => d.label.trim() && d.amount.trim()) : [],
      currency: v.accountId ? undefined : prefs.currency,
    };
    start(async () => {
      const r = editing ? await updateRecurringAction({ id: v.id!, data }) : await createRecurringAction(data);
      if (!r.ok) {
        setFormError(r.error);
        setErrors(r.fieldErrors ?? {});
        return;
      }
      toast.success(editing ? `${v.name} updated` : `${KIND_LABEL[v.kind]} “${v.name}” added`);
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
      <div className="-mx-1 overflow-x-auto px-1">
        <Segmented
          ariaLabel="Type"
          size="sm"
          value={v.kind}
          onChange={(k) =>
            setV((s) => ({
              ...s,
              kind: k,
              categoryId: (k === "income") === (s.kind === "income") ? s.categoryId : "",
              autoPost: k === "transfer" ? s.autoPost : s.autoPost,
            }))
          }
          options={KIND_OPTIONS}
          className="w-full min-w-max"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="r-name" error={err("name")}>
          <Input
            id="r-name"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={NAME_PLACEHOLDER[v.kind]}
            maxLength={80}
            required
            aria-invalid={err("name") ? true : undefined}
          />
        </Field>
        {usingBreakdown ? (
          <div className="grid gap-1.5">
            <Label>Net amount received</Label>
            <p className="num flex h-10 items-center rounded-md border border-dashed px-3 text-[15px] font-medium sm:text-sm">{fmt(net!, currency)}</p>
            <p className="text-[13px] text-muted-foreground">Calculated from gross and deductions below.</p>
          </div>
        ) : (
          <Field
            label={isIncome ? `Amount received (${currency})` : `Amount (${currency})`}
            htmlFor="r-amount"
            error={err("amount")}
            hint={v.kind === "bill" ? "For bills that vary, use a typical amount — you can adjust it when you mark it paid." : undefined}
          >
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
                {currencySymbol(currency, prefs.locale)}
              </span>
              <Input
                id="r-amount"
                inputMode="decimal"
                value={v.amount}
                onChange={(e) => set("amount", e.target.value.replace(/[^\d.,]/g, ""))}
                placeholder="0"
                className="num pl-8"
                required
                aria-invalid={err("amount") ? true : undefined}
              />
            </div>
          </Field>
        )}
      </div>

      {isTransfer ? (
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label="From" htmlFor="r-from" error={err("accountId")}>
            <NativeSelect id="r-from" value={v.accountId} onChange={(e) => set("accountId", e.target.value)}>
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <ArrowRight className="mb-3 size-4 text-muted-foreground" aria-hidden />
          <Field label="To" htmlFor="r-to" error={err("toAccountId")}>
            <NativeSelect
              id="r-to"
              value={v.toAccountId}
              onChange={(e) => set("toAccountId", e.target.value)}
              aria-invalid={err("toAccountId") ? true : undefined}
            >
              <option value="">Choose…</option>
              {accounts
                .filter((a) => a.id !== v.accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={isIncome ? "Paid into" : "Paid from"} htmlFor="r-account" error={err("accountId")} optional={!v.autoPost}>
            <NativeSelect
              id="r-account"
              value={v.accountId}
              onChange={(e) => set("accountId", e.target.value)}
              aria-invalid={err("accountId") ? true : undefined}
            >
              <option value="">Decide when it&apos;s paid</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.currency !== prefs.currency ? ` (${a.currency})` : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Category" htmlFor="r-category" error={err("categoryId")} optional>
            <NativeSelect id="r-category" value={v.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
              <option value="">No category</option>
              <CategoryOptions categories={categories} kind={isIncome ? "income" : "expense"} />
            </NativeSelect>
          </Field>
        </div>
      )}

      {isIncome ? (
        <IncomeBreakdown v={v} setV={setV} currency={currency} errors={errors} />
      ) : (
        !isTransfer && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={isSub ? "Service / merchant" : "Payee / merchant"} htmlFor="r-merchant" optional hint="Used to recognise matching charges.">
              <Input id="r-merchant" value={v.merchant} onChange={(e) => set("merchant", e.target.value)} maxLength={80} placeholder={v.name || undefined} />
            </Field>
            {paymentMethods.length > 0 && (
              <Field label="Paid with" htmlFor="r-pm" optional>
                <NativeSelect id="r-pm" value={v.paymentMethodId} onChange={(e) => set("paymentMethodId", e.target.value)}>
                  <option value="">—</option>
                  {paymentMethods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>
        )
      )}

      {isSub && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Manage / cancel URL" htmlFor="r-url" optional error={err("serviceUrl")}>
            <Input id="r-url" type="url" inputMode="url" value={v.serviceUrl} onChange={(e) => set("serviceUrl", e.target.value)} placeholder="https://" />
          </Field>
          <Field label="Free trial ends" htmlFor="r-trial" optional error={err("trialEndsAt")} hint="We'll flag it before you're charged.">
            <Input id="r-trial" type="date" value={v.trialEndsAt} onChange={(e) => set("trialEndsAt", e.target.value)} />
          </Field>
        </div>
      )}

      <fieldset className="grid gap-3 rounded-lg border p-3.5">
        <legend className="px-1 text-[13px] font-medium">Schedule</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Repeats" htmlFor="r-freq" error={err("frequency")}>
            <NativeSelect id="r-freq" value={v.frequency} onChange={(e) => set("frequency", e.target.value as FrequencyId)}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {v.frequency === "custom" && (
            <div className="grid gap-1.5">
              <Label htmlFor="r-interval">Every</Label>
              <div className="grid grid-cols-[5rem_1fr] gap-2">
                <Input
                  id="r-interval"
                  inputMode="numeric"
                  value={v.interval}
                  onChange={(e) => set("interval", e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                  className="num"
                  aria-invalid={err("interval") ? true : undefined}
                />
                <NativeSelect aria-label="Interval unit" value={v.intervalUnit} onChange={(e) => set("intervalUnit", e.target.value as UnitId)}>
                  <option value="day">{Number(v.interval) === 1 ? "day" : "days"}</option>
                  <option value="week">{Number(v.interval) === 1 ? "week" : "weeks"}</option>
                  <option value="month">{Number(v.interval) === 1 ? "month" : "months"}</option>
                  <option value="year">{Number(v.interval) === 1 ? "year" : "years"}</option>
                </NativeSelect>
              </div>
              {err("interval") && <p className="text-[13px] text-negative">{err("interval")}</p>}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={editing ? "Schedule starts" : isIncome ? "First payday" : "First due date"} htmlFor="r-start" error={err("startDate")}>
            <Input id="r-start" type="date" value={v.startDate} onChange={(e) => set("startDate", e.target.value)} required />
          </Field>
          <Field label="Ends" htmlFor="r-end" optional error={err("endDate")}>
            <Input id="r-end" type="date" value={v.endDate} min={v.startDate} onChange={(e) => set("endDate", e.target.value)} />
          </Field>
        </div>
        <Field label="Remind me" htmlFor="r-remind">
          <NativeSelect id="r-remind" value={v.remindDaysBefore} onChange={(e) => set("remindDaysBefore", e.target.value)}>
            <option value="0">On the day</option>
            <option value="1">1 day before</option>
            <option value="2">2 days before</option>
            <option value="3">3 days before</option>
            <option value="5">5 days before</option>
            <option value="7">1 week before</option>
            <option value="14">2 weeks before</option>
          </NativeSelect>
        </Field>
        <label className="flex items-start justify-between gap-3 text-sm">
          <span>
            Record automatically
            <span className="block text-[13px] text-muted-foreground">
              {v.autoPost
                ? `On each due date Kosh adds the ${isIncome ? "income" : isTransfer ? "transfer" : "expense"} to ${account?.name ?? "the chosen account"} for you — no tap needed.`
                : `Off: it waits in Upcoming until you tap “${isIncome ? "Mark received" : "Mark paid"}”, so you can adjust the amount or date.`}
            </span>
          </span>
          <Switch checked={v.autoPost} onCheckedChange={(c) => set("autoPost", c)} aria-label="Record automatically" />
        </label>
      </fieldset>

      <Field label="Notes" htmlFor="r-notes" optional>
        <Textarea id="r-notes" rows={2} value={v.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} />
      </Field>

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
          {editing ? "Save changes" : `Add ${KIND_LABEL[v.kind].toLowerCase()}`}
        </Button>
      </DialogFooter>
    </form>
  );
}

function IncomeBreakdown({
  v,
  setV,
  currency,
  errors,
}: {
  v: RecurringFormValues;
  setV: React.Dispatch<React.SetStateAction<RecurringFormValues>>;
  currency: string;
  errors: Record<string, string[]>;
}) {
  const fmt = useMoney();
  const net = netFromBreakdown(v.grossAmount, v.deductions);
  const setDed = (i: number, patch: Partial<RecurringFormValues["deductions"][number]>) =>
    setV((s) => ({ ...s, deductions: s.deductions.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  return (
    <div className="grid gap-3 rounded-lg border bg-subtle/60 p-3.5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employer / payer" htmlFor="r-employer" optional>
          <Input id="r-employer" value={v.employer} onChange={(e) => setV((s) => ({ ...s, employer: e.target.value }))} maxLength={80} />
        </Field>
        <Field
          label={`Gross amount (${currency})`}
          htmlFor="r-gross"
          optional
          error={errors.grossAmount}
          hint="Add gross and deductions to see your take-home breakdown."
        >
          <Input
            id="r-gross"
            inputMode="decimal"
            className="num"
            value={v.grossAmount}
            onChange={(e) => setV((s) => ({ ...s, grossAmount: e.target.value.replace(/[^\d.,]/g, "") }))}
          />
        </Field>
      </div>
      {v.deductions.length > 0 && (
        <div className="grid gap-2" role="group" aria-label="Deductions and bonuses">
          {v.deductions.map((d, i) => (
            <div key={i} className="grid grid-cols-[1fr_6.5rem] gap-2 sm:grid-cols-[1fr_8rem_7rem_auto]">
              <Input
                aria-label={`Line ${i + 1} label`}
                value={d.label}
                onChange={(e) => setDed(i, { label: e.target.value })}
                placeholder="e.g. Income tax"
                maxLength={60}
              />
              <NativeSelect aria-label={`Line ${i + 1} type`} value={d.kind} onChange={(e) => setDed(i, { kind: e.target.value as Deduction["kind"] })}>
                <option value="tax">Tax</option>
                <option value="deduction">Deduction</option>
                <option value="bonus">Bonus / addition</option>
              </NativeSelect>
              <Input
                aria-label={`Line ${i + 1} amount`}
                inputMode="decimal"
                className="num text-right"
                value={d.amount}
                onChange={(e) => setDed(i, { amount: e.target.value.replace(/[^\d.,]/g, "") })}
                placeholder="0"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove line ${i + 1}`}
                onClick={() => setV((s) => ({ ...s, deductions: s.deductions.filter((_, j) => j !== i) }))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={v.deductions.length >= 20}
          onClick={() => setV((s) => ({ ...s, deductions: [...s.deductions, { label: "", amount: "", kind: "tax" }] }))}
        >
          <Plus /> Add tax, deduction or bonus
        </Button>
        {net !== null && (
          <p className={cn("num text-sm", cmp(net, "0") <= 0 ? "text-negative" : "")} aria-live="polite">
            Net: <strong>{fmt(net, currency)}</strong>
            {!isZero(sub(net, safeMoney(v.grossAmount) ?? "0")) && <span className="text-muted-foreground"> of {fmt(v.grossAmount, currency)} gross</span>}
          </p>
        )}
      </div>
    </div>
  );
}
