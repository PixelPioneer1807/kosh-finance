"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Info, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Segmented } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CURRENCIES, formatMoney, toInputValue } from "@/lib/money";
import { formatDate, todayIn } from "@/lib/dates";
import { changeBaseCurrencyAction, updatePreferencesAction, updateProfileAction } from "./actions";
import { SettingsSection } from "./section";
import { SearchableSelect } from "./searchable-select";

const LOCALES = [
  ["en-US", "English (United States)"],
  ["en-GB", "English (United Kingdom)"],
  ["en-IN", "English (India)"],
  ["en-AU", "English (Australia)"],
  ["en-CA", "English (Canada)"],
  ["en-SG", "English (Singapore)"],
  ["hi-IN", "हिन्दी (भारत)"],
  ["de-DE", "Deutsch (Deutschland)"],
  ["de-CH", "Deutsch (Schweiz)"],
  ["fr-FR", "Français (France)"],
  ["es-ES", "Español (España)"],
  ["es-MX", "Español (México)"],
  ["it-IT", "Italiano (Italia)"],
  ["nl-NL", "Nederlands (Nederland)"],
  ["pt-BR", "Português (Brasil)"],
  ["sv-SE", "Svenska (Sverige)"],
  ["pl-PL", "Polski (Polska)"],
  ["tr-TR", "Türkçe (Türkiye)"],
  ["ja-JP", "日本語 (日本)"],
  ["zh-CN", "中文 (中国)"],
  ["ko-KR", "한국어 (대한민국)"],
  ["ar-AE", "العربية (الإمارات)"],
] as const;

function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    list = [];
  }
  if (!list.length) list = ["UTC", "Europe/London", "America/New_York", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
  if (!list.includes("UTC")) list = ["UTC", ...list];
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

function offsetLabel(tz: string) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value.replace("GMT", "UTC") ?? "";
  } catch {
    return "";
  }
}

type Props = {
  user: { name: string | null; email: string };
  prefs: {
    currency: string;
    timezone: string;
    locale: string;
    weekStartsOn: 0 | 1;
    monthStartDay: number;
    defaultAccountId: string | null;
    defaultPaymentMethodId: string | null;
    expectedMonthlyIncome: string | null;
  };
  accounts: { id: string; name: string; currency: string }[];
  paymentMethods: { id: string; name: string }[];
  rates: { currency: string; rate: string }[];
  transactionCount: number;
};

export function ProfileForm(props: Props) {
  return (
    <div>
      <ProfileSection user={props.user} />
      <BaseCurrencySection {...props} />
      <PreferencesSection {...props} />
    </div>
  );
}

/* ───────────── Profile ───────────── */

function ProfileSection({ user }: { user: Props["user"] }) {
  const [name, setName] = React.useState(user.name ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const dirty = name.trim() !== (user.name ?? "");
  return (
    <SettingsSection id="profile" title="Profile" description="How you appear in Kosh.">
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const r = await updateProfileAction({ name });
              if (r.ok) toast.success("Profile saved");
              else setError(r.fieldErrors?.name?.[0] ?? r.error);
            });
          }}
        >
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Name" htmlFor="name" error={error}>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" aria-invalid={error ? true : undefined} aria-describedby={error ? "name-error" : undefined} />
            </Field>
            <Field label="Email" htmlFor="email" hint="Contact your administrator to change your sign-in email.">
              <Input id="email" value={user.email} readOnly disabled aria-readonly />
            </Field>
          </div>
          <CardFooter className="justify-end">
            <Button type="submit" loading={pending} disabled={!dirty}>
              Save profile
            </Button>
          </CardFooter>
        </form>
      </Card>
    </SettingsSection>
  );
}

/* ───────────── Base currency ───────────── */

function BaseCurrencySection({ prefs, rates, transactionCount }: Props) {
  const [next, setNext] = React.useState(prefs.currency);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, start] = React.useTransition();
  const rate = rates.find((r) => r.currency === next);
  const changing = next !== prefs.currency;
  const blocked = changing && !rate && (transactionCount > 0 || rates.length > 0);
  const options = CURRENCIES.some((c) => c.code === prefs.currency) ? CURRENCIES : [{ code: prefs.currency, name: prefs.currency }, ...CURRENCIES];
  return (
    <SettingsSection id="currency" title="Base currency" description="Totals, budgets and reports are shown in this currency.">
      <Card>
        <div className="grid gap-4 p-5">
          <Field label="Base currency" htmlFor="base-currency">
            <NativeSelect id="base-currency" value={next} onChange={(e) => setNext(e.target.value)} className="sm:max-w-xs">
              {options.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {changing && (
            <div role="status" className={blocked ? "rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning" : "rounded-lg bg-subtle px-4 py-3 text-[13px] text-muted-foreground"}>
              {blocked ? (
                <p>
                  To switch to {next}, first add an exchange rate for {next} in{" "}
                  <Link href="/settings/currencies" className="font-medium underline underline-offset-2">
                    Currencies
                  </Link>{" "}
                  so your existing amounts can be converted.
                </p>
              ) : (
                <p className="flex gap-2">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Switching recalculates the {next} value of {transactionCount.toLocaleString()} transaction{transactionCount === 1 ? "" : "s"}
                    {rate ? (
                      <>
                        {" "}
                        using each transaction&apos;s original rate re-expressed against {next} (1 {next} = {rate.rate.replace(/\.?0+$/, "")} {prefs.currency})
                      </>
                    ) : null}
                    . Your exchange rates, budgets in {prefs.currency} and expected income are converted too. Account balances in their own currencies don&apos;t change.
                  </span>
                </p>
              )}
            </div>
          )}
        </div>
        <CardFooter className="justify-end">
          <Button type="button" disabled={!changing || blocked} onClick={() => setConfirmOpen(true)}>
            Change base currency
          </Button>
        </CardFooter>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Switch base currency to ${next}?`}
        description={`All ${transactionCount.toLocaleString()} transaction base amounts, your exchange rates and ${prefs.currency} budgets will be recalculated in one step. You can switch back later; small rounding differences (≤ 0.0001) may appear.`}
        confirmLabel={`Switch to ${next}`}
        destructive={false}
        loading={pending}
        onConfirm={() =>
          start(async () => {
            const r = await changeBaseCurrencyAction({ currency: next, confirm: true });
            setConfirmOpen(false);
            if (r.ok) toast.success(`Base currency is now ${next}`);
            else toast.error(r.error);
          })
        }
      />
    </SettingsSection>
  );
}

/* ───────────── Regional & defaults ───────────── */

function PreferencesSection({ prefs, accounts, paymentMethods }: Props) {
  const [v, setV] = React.useState({
    timezone: prefs.timezone,
    locale: prefs.locale,
    weekStartsOn: prefs.weekStartsOn,
    monthStartDay: prefs.monthStartDay,
    defaultAccountId: prefs.defaultAccountId ?? "",
    defaultPaymentMethodId: prefs.defaultPaymentMethodId ?? "",
    expectedMonthlyIncome: prefs.expectedMonthlyIncome ? toInputValue(prefs.expectedMonthlyIncome) : "",
  });
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((s) => ({ ...s, [k]: val }));
  const zones = React.useMemo(() => timeZones(prefs.timezone).map((z) => ({ value: z, label: z.replace(/_/g, " "), hint: offsetLabel(z) })), [prefs.timezone]);
  const today = todayIn(v.timezone);
  let sample = "";
  try {
    sample = `${formatMoney("1234567.89", prefs.currency, { locale: v.locale })} · ${new Intl.DateTimeFormat(v.locale, { dateStyle: "medium" }).format(new Date(2026, 9, 3))}`;
  } catch {
    sample = "";
  }

  function detect() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      set("timezone", tz);
      toast(`Detected ${tz.replace(/_/g, " ")}`);
    }
  }

  return (
    <SettingsSection id="prefs" title="Regional & defaults" description="Dates, numbers and the defaults used when you add a transaction.">
      <Card>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            start(async () => {
              const r = await updatePreferencesAction({
                ...v,
                defaultAccountId: v.defaultAccountId || null,
                defaultPaymentMethodId: v.defaultPaymentMethodId || null,
                expectedMonthlyIncome: v.expectedMonthlyIncome.trim() || null,
              });
              if (r.ok) toast.success("Preferences saved");
              else {
                setErrors(r.fieldErrors ?? {});
                toast.error(r.error);
              }
            });
          }}
        >
          <div className="grid gap-5 p-5 sm:grid-cols-2">
            <Field label="Time zone" htmlFor="timezone" error={errors.timezone} hint={`It’s ${formatDate(today, "EEE, d MMM yyyy")} there now.`}>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <SearchableSelect id="timezone" label="Time zone" value={v.timezone} onChange={(z) => set("timezone", z)} options={zones} placeholder="Search cities or regions…" invalid={Boolean(errors.timezone)} />
                </div>
                <Button type="button" variant="outline" size="icon" className="size-10" onClick={detect} aria-label="Detect my time zone">
                  <LocateFixed />
                </Button>
              </div>
            </Field>
            <Field label="Language & number format" htmlFor="locale" error={errors.locale} hint={sample || undefined}>
              <NativeSelect id="locale" value={v.locale} onChange={(e) => set("locale", e.target.value)}>
                {!LOCALES.some(([l]) => l === v.locale) && <option value={v.locale}>{v.locale}</option>}
                {LOCALES.map(([l, label]) => (
                  <option key={l} value={l}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="grid gap-1.5">
              <span id="week-start-label" className="text-[13px] font-medium">
                Week starts on
              </span>
              <Segmented
                ariaLabel="Week starts on"
                value={String(v.weekStartsOn) as "0" | "1"}
                onChange={(x) => set("weekStartsOn", x === "0" ? 0 : 1)}
                options={[
                  { value: "1", label: "Monday" },
                  { value: "0", label: "Sunday" },
                ]}
                className="w-full sm:w-64"
              />
            </div>
            <Field
              label="Month starts on day"
              htmlFor="monthStartDay"
              error={errors.monthStartDay}
              hint={v.monthStartDay === 1 ? "Calendar months (1st to end of month)." : `Payday budgeting: “this month” runs from the ${ordinal(v.monthStartDay)} to the ${ordinal(v.monthStartDay - 1)} of the next month.`}
            >
              <NativeSelect id="monthStartDay" value={v.monthStartDay} onChange={(e) => set("monthStartDay", Number(e.target.value))} className="sm:max-w-40">
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-5 border-t p-5 sm:grid-cols-2">
            <Field label="Default account" htmlFor="defaultAccountId" hint="Pre-selected when you add a transaction.">
              <NativeSelect id="defaultAccountId" value={v.defaultAccountId} onChange={(e) => set("defaultAccountId", e.target.value)}>
                <option value="">First account in the list</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Default payment method" htmlFor="defaultPaymentMethodId" optional>
              <NativeSelect id="defaultPaymentMethodId" value={v.defaultPaymentMethodId} onChange={(e) => set("defaultPaymentMethodId", e.target.value)}>
                <option value="">None</option>
                {paymentMethods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label={`Expected monthly income (${prefs.currency})`}
              htmlFor="expectedMonthlyIncome"
              optional
              error={errors.expectedMonthlyIncome}
              hint="Used for safe-to-spend and forecasts when you haven't set up a recurring income."
            >
              <Input
                id="expectedMonthlyIncome"
                inputMode="decimal"
                className="num sm:max-w-56"
                value={v.expectedMonthlyIncome}
                onChange={(e) => set("expectedMonthlyIncome", e.target.value.replace(/[^\d.,]/g, ""))}
                placeholder="0.00"
                aria-invalid={errors.expectedMonthlyIncome ? true : undefined}
              />
            </Field>
          </div>
          <CardFooter className="justify-end">
            <Button type="submit" loading={pending}>
              Save preferences
            </Button>
          </CardFooter>
        </form>
      </Card>
    </SettingsSection>
  );
}

function ordinal(n: number) {
  if (n < 1) n += 28;
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
