"use client";

import * as React from "react";
import { toast } from "sonner";
import { Bell, Check, PiggyBank, Plus, Receipt, Target, Trash2, User, Wallet, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/controls";
import { Logo } from "@/components/app/logo";
import { CategoryBadge } from "@/components/app/icons";
import { CURRENCIES, currencySymbol } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  finishOnboarding,
  saveAccountsStep,
  saveBudgetsStep,
  saveGoalsStep,
  saveIncomeStep,
  saveNotificationsStep,
  saveProfileStep,
  saveRecurringStep,
} from "./actions";

type Cat = { id: string; name: string; icon: string; color: string };
type Result = { ok: true } | { ok: false; error: string };

const STEPS = [
  { id: "profile", label: "You", icon: User },
  { id: "income", label: "Income", icon: Briefcase },
  { id: "accounts", label: "Accounts", icon: Wallet },
  { id: "recurring", label: "Bills", icon: Receipt },
  { id: "budgets", label: "Budgets", icon: PiggyBank },
  { id: "goals", label: "Goals", icon: Target },
  { id: "notifications", label: "Reminders", icon: Bell },
] as const;

function useTimezones() {
  return React.useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return ["UTC"];
    }
  }, []);
}

function StepShell({
  title,
  description,
  children,
  onContinue,
  onSkip,
  pending,
  continueLabel = "Continue",
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onContinue: () => void;
  onSkip?: () => void;
  pending: boolean;
  continueLabel?: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onContinue();
      }}
      className="animate-in"
    >
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 mb-6 text-sm text-muted-foreground">{description}</p>
      <div className="grid gap-4">{children}</div>
      <div className="mt-8 flex items-center gap-2">
        {onSkip && (
          <Button type="button" variant="ghost" onClick={onSkip} disabled={pending}>
            Skip for now
          </Button>
        )}
        <Button type="submit" size="lg" className="ml-auto min-w-32" loading={pending}>
          {continueLabel}
        </Button>
      </div>
    </form>
  );
}

function RowList<T>({
  rows,
  setRows,
  empty,
  render,
  addLabel,
  max = 10,
}: {
  rows: T[];
  setRows: (r: T[]) => void;
  empty: () => T;
  render: (row: T, update: (patch: Partial<T>) => void, i: number) => React.ReactNode;
  addLabel: string;
  max?: number;
}) {
  return (
    <div className="grid gap-2.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-end gap-2 rounded-lg border bg-card p-3">
          <div className="grid flex-1 gap-2">{render(r, (patch) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}</div>
          <Button type="button" variant="ghost" size="icon" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      {rows.length < max && (
        <Button type="button" variant="outline" className="justify-self-start" onClick={() => setRows([...rows, empty()])}>
          <Plus /> {addLabel}
        </Button>
      )}
    </div>
  );
}

export function OnboardingWizard({ name: initialName, currency: initialCurrency, timezone: initialTz, expenseCategories }: { name: string; currency: string; timezone: string; expenseCategories: Cat[] }) {
  const [step, setStep] = React.useState(0);
  const [pending, start] = React.useTransition();
  const timezones = useTimezones();

  // Step state
  const [name, setName] = React.useState(initialName);
  const [currency, setCurrency] = React.useState(initialCurrency === "USD" ? "" : initialCurrency);
  const [tz, setTz] = React.useState(initialTz === "UTC" ? "" : initialTz);
  const [income, setIncome] = React.useState({ amount: "", frequency: "monthly", payDay: "", employer: "", budgetFromPayday: false });
  const [accounts, setAccounts] = React.useState<{ name: string; type: string; balance: string }[]>([]);
  const [bills, setBills] = React.useState<{ name: string; amount: string; kind: "bill" | "subscription" | "expense"; day: string }[]>([]);
  const [overall, setOverall] = React.useState("");
  const [catBudgets, setCatBudgets] = React.useState<Record<string, string>>({});
  const [goals, setGoals] = React.useState<{ name: string; targetAmount: string; deadline: string; startingAmount: string }[]>([]);
  const [notif, setNotif] = React.useState({ dailyReminderEnabled: true, dailyReminderTime: "20:30", billReminders: true, budgetAlerts: true });

  React.useEffect(() => {
    // Sensible, non-financial defaults detected from the browser. Must run after hydration
    // (the server can't know the browser's timezone/locale), so state is set once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!tz) setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    if (!currency) {
      try {
        const region = new Intl.Locale(navigator.language).maximize().region;
        const guess: Record<string, string> = { IN: "INR", US: "USD", GB: "GBP", DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", IE: "EUR", CA: "CAD", AU: "AUD", JP: "JPY", SG: "SGD", AE: "AED", NZ: "NZD", CH: "CHF", BR: "BRL", MX: "MXN", ZA: "ZAR" };
        setCurrency(guess[region ?? ""] ?? initialCurrency);
      } catch {
        setCurrency(initialCurrency);
      }
    }
  }, [tz, currency, initialCurrency]);

  const sym = currencySymbol(currency || initialCurrency);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length));
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error);
      else next();
    });
  const finish = () => start(() => finishOnboarding());

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-5 py-6 sm:py-10">
      <div className="mb-8 flex items-center justify-between">
        <Logo />
        <Button variant="ghost" size="sm" onClick={finish} disabled={pending}>
          Skip setup
        </Button>
      </div>
      <ol className="mb-10 flex items-center gap-1.5" aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex-1">
            <button
              type="button"
              onClick={() => i < step && setStep(i)}
              disabled={i >= step}
              aria-current={i === step ? "step" : undefined}
              aria-label={`${s.label}${i < step ? " (done)" : ""}`}
              className={cn("block h-1 w-full rounded-full transition-colors", i < step ? "bg-foreground" : i === step ? "bg-foreground/50" : "bg-border")}
            />
          </li>
        ))}
      </ol>

      <div className="flex-1">
        {step === 0 && (
          <StepShell
            title="Let's set things up"
            description="A few optional questions so everything is in your currency and timezone. You can change any of this later in Settings."
            pending={pending}
            onContinue={() => run(() => saveProfileStep({ name, currency: currency || initialCurrency, timezone: tz || "UTC", locale: navigator.language }))}
          >
            <Field label="What should we call you?" htmlFor="o-name" optional>
              <Input id="o-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
            </Field>
            <Field label="Main currency" htmlFor="o-cur" hint="Totals, budgets and reports use this currency. Accounts can still use others.">
              <NativeSelect id="o-cur" value={currency || initialCurrency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Timezone" htmlFor="o-tz" hint="Decides what “today” means for your transactions and reminders.">
              <NativeSelect id="o-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                {timezones.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </StepShell>
        )}

        {step === 1 && (
          <StepShell
            title="Your income"
            description="Optional. Helps with savings rate, safe-to-spend and payday reminders. Nothing is shared."
            pending={pending}
            onSkip={next}
            onContinue={() =>
              income.amount
                ? run(() =>
                    saveIncomeStep({
                      amount: income.amount,
                      frequency: income.frequency as "monthly",
                      payDay: income.payDay ? Number(income.payDay) : undefined,
                      employer: income.employer || undefined,
                      budgetFromPayday: income.budgetFromPayday,
                    }),
                  )
                : next()
            }
          >
            <div className="grid grid-cols-[1fr_9rem] gap-3">
              <Field label="Take-home pay (after tax)" htmlFor="o-inc">
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">{sym}</span>
                  <Input id="o-inc" inputMode="decimal" className="pl-8" value={income.amount} onChange={(e) => setIncome({ ...income, amount: e.target.value })} />
                </div>
              </Field>
              <Field label="How often" htmlFor="o-freq">
                <NativeSelect id="o-freq" value={income.frequency} onChange={(e) => setIncome({ ...income, frequency: e.target.value })}>
                  <option value="monthly">Monthly</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="weekly">Weekly</option>
                </NativeSelect>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={income.frequency === "monthly" ? "Payday (day of month)" : "Day of month of next payday"} htmlFor="o-day" optional>
                <Input id="o-day" type="number" min={1} max={31} value={income.payDay} onChange={(e) => setIncome({ ...income, payDay: e.target.value })} />
              </Field>
              <Field label="Employer / source" htmlFor="o-emp" optional>
                <Input id="o-emp" value={income.employer} onChange={(e) => setIncome({ ...income, employer: e.target.value })} maxLength={80} />
              </Field>
            </div>
            {income.frequency === "monthly" && income.payDay && Number(income.payDay) > 1 && Number(income.payDay) <= 28 && (
              <label className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm">
                <span>
                  Run my monthly budgets from payday to payday
                  <span className="block text-[13px] text-muted-foreground">Months start on the {income.payDay}th instead of the 1st.</span>
                </span>
                <Switch checked={income.budgetFromPayday} onCheckedChange={(c) => setIncome({ ...income, budgetFromPayday: c })} aria-label="Payday budgeting" />
              </label>
            )}
          </StepShell>
        )}

        {step === 2 && (
          <StepShell
            title="Where's your money?"
            description="Add the accounts you use — bank, cash, cards, wallets. Balances are optional; you can add more anytime."
            pending={pending}
            onSkip={next}
            onContinue={() => {
              const list = accounts.filter((a) => a.name.trim());
              if (!list.length) return next();
              run(() =>
                saveAccountsStep(
                  list.map((a) => ({ name: a.name, type: a.type as "checking", currency: currency || initialCurrency, openingBalance: a.balance || "0" })),
                ),
              );
            }}
          >
            {accounts.length < 10 && (
              <div className="flex flex-wrap gap-2">
                {[
                  { name: "Bank account", type: "checking" },
                  { name: "Cash", type: "cash" },
                  { name: "Credit card", type: "credit_card" },
                  { name: "Savings", type: "savings" },
                ].filter((s) => !accounts.some((a) => a.name === s.name)).map((s) => (
                  <Button key={s.name} type="button" variant="outline" size="sm" onClick={() => setAccounts((a) => [...a, { ...s, balance: "" }])}>
                    <Plus /> {s.name}
                  </Button>
                ))}
              </div>
            )}
            <RowList
              rows={accounts}
              setRows={setAccounts}
              empty={() => ({ name: "", type: "checking", balance: "" })}
              addLabel="Add account"
              render={(r, u, i) => (
                <div className="grid grid-cols-[1fr_8rem] gap-2 sm:grid-cols-[1fr_9rem_8rem]">
                  <Input aria-label={`Account ${i + 1} name`} placeholder="Name" value={r.name} onChange={(e) => u({ name: e.target.value })} maxLength={60} />
                  <NativeSelect aria-label={`Account ${i + 1} type`} value={r.type} onChange={(e) => u({ type: e.target.value })}>
                    <option value="checking">Bank</option>
                    <option value="savings">Savings</option>
                    <option value="cash">Cash</option>
                    <option value="wallet">Wallet</option>
                    <option value="credit_card">Credit card</option>
                    <option value="investment">Investment</option>
                    <option value="loan">Loan</option>
                  </NativeSelect>
                  <Input
                    aria-label={`Account ${i + 1} ${r.type === "credit_card" || r.type === "loan" ? "amount owed" : "balance"}`}
                    placeholder={r.type === "credit_card" || r.type === "loan" ? "Owed" : "Balance"}
                    inputMode="decimal"
                    value={r.balance}
                    onChange={(e) => u({ balance: e.target.value })}
                    className="col-span-2 sm:col-span-1"
                  />
                </div>
              )}
            />
          </StepShell>
        )}

        {step === 3 && (
          <StepShell
            title="Regular bills & subscriptions"
            description="Rent, utilities, phone, streaming, insurance, EMIs… We'll remind you before they're due. Enter your own amounts."
            pending={pending}
            onSkip={next}
            onContinue={() => {
              const list = bills.filter((b) => b.name.trim() && b.amount && b.day);
              if (!list.length) return next();
              run(() => saveRecurringStep(list.map((b) => ({ name: b.name, amount: b.amount, kind: b.kind, day: Number(b.day) }))));
            }}
          >
            <div className="flex flex-wrap gap-2">
              {["Rent", "Electricity", "Internet", "Phone", "Insurance", "Streaming", "Gym"].filter((n) => !bills.some((b) => b.name === n)).map((n) => (
                <Button
                  key={n}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setBills((b) => [...b, { name: n, amount: "", kind: ["Streaming", "Gym"].includes(n) ? "subscription" : "bill", day: "" }])}
                >
                  <Plus /> {n}
                </Button>
              ))}
            </div>
            <RowList
              rows={bills}
              setRows={setBills}
              max={20}
              empty={() => ({ name: "", amount: "", kind: "bill" as const, day: "" })}
              addLabel="Add another"
              render={(r, u, i) => (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_7rem_7.5rem_5rem]">
                  <Input aria-label={`Item ${i + 1} name`} placeholder="Name" value={r.name} onChange={(e) => u({ name: e.target.value })} className="col-span-2 sm:col-span-1" />
                  <Input aria-label={`Item ${i + 1} amount`} placeholder="Amount" inputMode="decimal" value={r.amount} onChange={(e) => u({ amount: e.target.value })} />
                  <NativeSelect aria-label={`Item ${i + 1} type`} value={r.kind} onChange={(e) => u({ kind: e.target.value as "bill" })}>
                    <option value="bill">Bill</option>
                    <option value="subscription">Subscription</option>
                    <option value="expense">Other</option>
                  </NativeSelect>
                  <Input aria-label={`Item ${i + 1} due day of month`} placeholder="Day" type="number" min={1} max={31} value={r.day} onChange={(e) => u({ day: e.target.value })} />
                </div>
              )}
            />
            {bills.length > 0 && <p className="text-[13px] text-muted-foreground">“Day” is the day of the month it&apos;s due. You can change frequency (weekly, yearly…) later.</p>}
          </StepShell>
        )}

        {step === 4 && (
          <StepShell
            title="Set a few budgets"
            description="Optional. Start with an overall monthly limit, or limits for the categories you care about."
            pending={pending}
            onSkip={next}
            onContinue={() => {
              const categories = Object.entries(catBudgets)
                .filter(([, v]) => v.trim())
                .map(([categoryId, amount]) => ({ categoryId, amount }));
              if (!overall && !categories.length) return next();
              run(() => saveBudgetsStep({ overall: overall || null, categories }));
            }}
          >
            <Field label="Overall monthly spending limit" htmlFor="o-overall" optional>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">{sym}</span>
                <Input id="o-overall" inputMode="decimal" className="pl-8" value={overall} onChange={(e) => setOverall(e.target.value)} />
              </div>
            </Field>
            <div className="grid gap-1.5">
              <p className="text-[13px] font-medium">By category</p>
              <div className="divide-y rounded-lg border bg-card">
                {expenseCategories.slice(0, 10).map((c) => (
                  <label key={c.id} className="flex items-center gap-3 px-3 py-2">
                    <CategoryBadge icon={c.icon} color={c.color} size="sm" />
                    <span className="flex-1 text-sm">{c.name}</span>
                    <Input
                      aria-label={`${c.name} monthly budget`}
                      inputMode="decimal"
                      placeholder="—"
                      className="h-8 w-28 text-right"
                      value={catBudgets[c.id] ?? ""}
                      onChange={(e) => setCatBudgets((b) => ({ ...b, [c.id]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>
          </StepShell>
        )}

        {step === 5 && (
          <StepShell
            title="Saving for something?"
            description="Emergency fund, trip, a new laptop… We'll track progress and tell you what to set aside."
            pending={pending}
            onSkip={next}
            onContinue={() => {
              const list = goals.filter((g) => g.name.trim() && g.targetAmount);
              if (!list.length) return next();
              run(() => saveGoalsStep(list.map((g) => ({ name: g.name, targetAmount: g.targetAmount, deadline: g.deadline || null, startingAmount: g.startingAmount || null }))));
            }}
          >
            {goals.length < 10 && (
              <div className="flex flex-wrap gap-2">
                {["Emergency fund", "Vacation", "New phone", "Car", "Education"].filter((n) => !goals.some((g) => g.name === n)).map((n) => (
                  <Button key={n} type="button" variant="outline" size="sm" onClick={() => setGoals((g) => [...g, { name: n, targetAmount: "", deadline: "", startingAmount: "" }])}>
                    <Plus /> {n}
                  </Button>
                ))}
              </div>
            )}
            <RowList
              rows={goals}
              setRows={setGoals}
              empty={() => ({ name: "", targetAmount: "", deadline: "", startingAmount: "" })}
              addLabel="Add goal"
              render={(r, u, i) => (
                <div className="grid grid-cols-2 gap-2">
                  <Input aria-label={`Goal ${i + 1} name`} placeholder="Goal" value={r.name} onChange={(e) => u({ name: e.target.value })} className="col-span-2" />
                  <Input aria-label={`Goal ${i + 1} target`} placeholder="Target amount" inputMode="decimal" value={r.targetAmount} onChange={(e) => u({ targetAmount: e.target.value })} />
                  <Input aria-label={`Goal ${i + 1} saved so far`} placeholder="Saved so far" inputMode="decimal" value={r.startingAmount} onChange={(e) => u({ startingAmount: e.target.value })} />
                  <Field label="Target date" htmlFor={`g-d-${i}`} optional className="col-span-2">
                    <Input id={`g-d-${i}`} type="date" value={r.deadline} onChange={(e) => u({ deadline: e.target.value })} />
                  </Field>
                </div>
              )}
            />
          </StepShell>
        )}

        {step === 6 && (
          <StepShell
            title="Gentle reminders"
            description="A nudge to log the day's spending and a heads-up before bills are due. No spam — at most a few a day, never during quiet hours."
            pending={pending}
            continueLabel="Save"
            onSkip={next}
            onContinue={() => run(() => saveNotificationsStep(notif))}
          >
            <div className="divide-y rounded-lg border bg-card">
              <label className="flex items-center justify-between gap-3 p-3 text-sm">
                <span>
                  Daily check-in
                  <span className="block text-[13px] text-muted-foreground">“Have you tracked today&apos;s expenses?” — skipped if you already have.</span>
                </span>
                <Switch checked={notif.dailyReminderEnabled} onCheckedChange={(c) => setNotif({ ...notif, dailyReminderEnabled: c })} aria-label="Daily check-in" />
              </label>
              {notif.dailyReminderEnabled && (
                <label className="flex items-center justify-between gap-3 p-3 text-sm">
                  Reminder time
                  <Input type="time" className="w-32" value={notif.dailyReminderTime} onChange={(e) => setNotif({ ...notif, dailyReminderTime: e.target.value })} aria-label="Reminder time" />
                </label>
              )}
              <label className="flex items-center justify-between gap-3 p-3 text-sm">
                Upcoming bills & subscriptions
                <Switch checked={notif.billReminders} onCheckedChange={(c) => setNotif({ ...notif, billReminders: c })} aria-label="Bill reminders" />
              </label>
              <label className="flex items-center justify-between gap-3 p-3 text-sm">
                Budget alerts
                <Switch checked={notif.budgetAlerts} onCheckedChange={(c) => setNotif({ ...notif, budgetAlerts: c })} aria-label="Budget alerts" />
              </label>
            </div>
            <p className="text-[13px] text-muted-foreground">You can turn on browser/phone notifications in Settings → Notifications.</p>
          </StepShell>
        )}

        {step >= STEPS.length && (
          <div className="animate-in text-center">
            <div className="mx-auto mb-5 grid size-14 place-items-center rounded-full bg-positive-soft text-positive">
              <Check className="size-6" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">You&apos;re all set</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              The fastest habit: open the app, tap <strong>+</strong>, type the amount, pick a category. That&apos;s it.
            </p>
            <Button size="lg" className="mt-8 min-w-48" onClick={finish} loading={pending}>
              Go to dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
