"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowUpRight, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/controls";
import { PushToggle } from "@/components/app/push-toggle";
import { cn } from "@/lib/utils";
import { updateNotificationPrefsAction } from "../actions";
import { SettingRow, SettingsSection } from "../section";

type Values = {
  dailyReminderEnabled: boolean;
  dailyReminderTime: string;
  missingEntriesDays: number;
  budgetAlerts: boolean;
  billReminders: boolean;
  subscriptionReminders: boolean;
  creditCardReminders: boolean;
  incomeReminders: boolean;
  goalReminders: boolean;
  maxPerDay: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
};

const TYPES: { key: keyof Values; label: string; description: string }[] = [
  { key: "budgetAlerts", label: "Budget alerts", description: "When a budget crosses one of its thresholds or is projected to overspend." },
  { key: "billReminders", label: "Bill reminders", description: "Before a bill is due." },
  { key: "subscriptionReminders", label: "Subscription renewals", description: "Before a subscription renews or a trial ends." },
  { key: "creditCardReminders", label: "Credit card due dates", description: "Before a card payment is due." },
  { key: "incomeReminders", label: "Expected income", description: "When an expected income hasn't been recorded." },
  { key: "goalReminders", label: "Goal check-ins", description: "Nudges to keep savings goals on track." },
];

type Permission = "default" | "granted" | "denied" | "unsupported" | "checking";

function subscribePermission(cb: () => void) {
  let status: PermissionStatus | null = null;
  let cancelled = false;
  navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((st) => {
      if (cancelled) return;
      status = st;
      st.addEventListener("change", cb);
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    status?.removeEventListener("change", cb);
  };
}

function usePermission(): Permission {
  return React.useSyncExternalStore(
    subscribePermission,
    () => ("Notification" in window ? Notification.permission : "unsupported") as Permission,
    () => "checking" as Permission,
  );
}

const PERMISSION_LABEL: Record<Permission, { text: string; variant: "positive" | "warning" | "negative" | "default" }> = {
  checking: { text: "Checking…", variant: "default" },
  granted: { text: "Allowed", variant: "positive" },
  default: { text: "Not asked yet", variant: "default" },
  denied: { text: "Blocked", variant: "negative" },
  unsupported: { text: "Not supported", variant: "warning" },
};

export function NotificationsForm({ initial, pushEnabled }: { initial: Values; pushEnabled: boolean }) {
  const [v, setV] = React.useState<Values>(initial);
  const [saved, setSaved] = React.useState<Values>(initial);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const permission = usePermission();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((s) => ({ ...s, [k]: val }));
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  const perm = PERMISSION_LABEL[permission];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    start(async () => {
      const r = await updateNotificationPrefsAction(v);
      if (r.ok) {
        setSaved(v);
        toast.success("Notification preferences saved");
      } else {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
      }
    });
  }

  return (
    <div>
      <SettingsSection id="device" title="This device" description="Push notifications are delivered per device. In-app notifications always appear in the bell.">
        <Card>
          <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
            <p className="text-sm">Browser permission</p>
            <Badge variant={perm.variant}>{perm.text}</Badge>
          </div>
          {permission === "denied" && (
            <p className="border-b px-5 py-3 text-[13px] text-muted-foreground">
              Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then reload this page.
            </p>
          )}
          {/* Push subscribe button (owned by the notifications-delivery engineer). */}
          <div className="p-5">
            <PushToggle />
          </div>
          {!pushEnabled && permission === "granted" && <p className="border-t px-5 py-3 text-[13px] text-muted-foreground">Push is allowed but not switched on for your account yet.</p>}
        </Card>
      </SettingsSection>

    <form onSubmit={submit} noValidate>
      <SettingsSection id="types" title="What to notify me about">
        <Card className="divide-y">
          {TYPES.map((t) => (
            <SettingRow key={t.key} label={t.label} description={t.description} htmlFor={`n-${t.key}`}>
              <Switch id={`n-${t.key}`} checked={v[t.key] as boolean} onCheckedChange={(on) => set(t.key, on as never)} />
            </SettingRow>
          ))}
          <div className="flex items-start justify-between gap-3 bg-subtle px-5 py-3 text-[13px] text-muted-foreground">
            <p>How many days before a bill or subscription you&apos;re reminded is set on each item.</p>
            <Link href="/recurring" className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline">
              Bills & recurring <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </Card>
      </SettingsSection>

      <SettingsSection id="habits" title="Logging reminders" description="Gentle nudges to keep your records complete.">
        <Card className="divide-y">
          <SettingRow label="Daily reminder" description="A reminder to log today's spending." htmlFor="dailyReminderEnabled">
            <div className="flex items-center gap-3">
              <Input
                type="time"
                aria-label="Daily reminder time"
                value={v.dailyReminderTime}
                onChange={(e) => set("dailyReminderTime", e.target.value)}
                disabled={!v.dailyReminderEnabled}
                className="num h-9 w-32"
                aria-invalid={errors.dailyReminderTime ? true : undefined}
              />
              <Switch id="dailyReminderEnabled" checked={v.dailyReminderEnabled} onCheckedChange={(on) => set("dailyReminderEnabled", on)} />
            </div>
          </SettingRow>
          {errors.dailyReminderTime && <p role="alert" className="px-5 py-2 text-[13px] text-negative">{errors.dailyReminderTime[0]}</p>}
          <SettingRow label="Missing entries" description="Remind me if nothing has been logged for a while." htmlFor="missingEntriesDays">
            <NativeSelect id="missingEntriesDays" value={v.missingEntriesDays} onChange={(e) => set("missingEntriesDays", Number(e.target.value))} className="h-9 w-44">
              <option value={0}>Off</option>
              {[1, 2, 3, 4, 5, 7, 10, 14].map((d) => (
                <option key={d} value={d}>
                  After {d} day{d === 1 ? "" : "s"}
                </option>
              ))}
            </NativeSelect>
          </SettingRow>
        </Card>
      </SettingsSection>

      <SettingsSection id="limits" title="Limits & quiet hours" description="Kosh never sends more than you allow.">
        <Card className="divide-y">
          <SettingRow label="Maximum per day" description="Across all notification types." htmlFor="maxPerDay">
            <NativeSelect id="maxPerDay" value={v.maxPerDay} onChange={(e) => set("maxPerDay", Number(e.target.value))} className="h-9 w-32">
              {[1, 2, 3, 4, 5, 6, 8, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </SettingRow>
          <SettingRow label="Quiet hours" description="No push notifications during this window (in your time zone)." htmlFor="quietHoursEnabled">
            <Switch id="quietHoursEnabled" checked={v.quietHoursEnabled} onCheckedChange={(on) => set("quietHoursEnabled", on)} />
          </SettingRow>
          <div className={cn("flex flex-wrap items-end gap-3 px-5 py-4", !v.quietHoursEnabled && "opacity-50")}>
            <Moon className="mb-2.5 size-4 text-muted-foreground" aria-hidden />
            <div className="grid gap-1.5">
              <label htmlFor="quietHoursStart" className="text-[13px] font-medium">
                From
              </label>
              <Input id="quietHoursStart" type="time" className="num h-9 w-32" value={v.quietHoursStart} disabled={!v.quietHoursEnabled} onChange={(e) => set("quietHoursStart", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="quietHoursEnd" className="text-[13px] font-medium">
                Until
              </label>
              <Input
                id="quietHoursEnd"
                type="time"
                className="num h-9 w-32"
                value={v.quietHoursEnd}
                disabled={!v.quietHoursEnabled}
                onChange={(e) => set("quietHoursEnd", e.target.value)}
                aria-invalid={errors.quietHoursEnd ? true : undefined}
                aria-describedby={errors.quietHoursEnd ? "quietHoursEnd-error" : undefined}
              />
            </div>
            {errors.quietHoursEnd && (
              <p id="quietHoursEnd-error" role="alert" className="w-full text-[13px] text-negative">
                {errors.quietHoursEnd[0]}
              </p>
            )}
          </div>
          <CardFooter className="justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">{dirty ? "You have unsaved changes." : "All changes saved."}</p>
            <Button type="submit" loading={pending} disabled={!dirty}>
              Save preferences
            </Button>
          </CardFooter>
        </Card>
      </SettingsSection>
    </form>
    </div>
  );
}
