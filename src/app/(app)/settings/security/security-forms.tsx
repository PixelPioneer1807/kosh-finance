"use client";

import * as React from "react";
import { toast } from "sonner";
import { LogOut, Monitor, Smartphone, Tablet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/dialog";
import { PasswordInput, PasswordStrength } from "@/components/app/password-input";
import { useAppData } from "@/components/app/user-context";
import { logoutAction } from "@/app/(auth)/actions";
import { changePasswordAction, deleteAccountAction, revokeSessionAction, signOutOtherSessionsAction } from "./actions";
import { SettingsSection } from "../section";

type Session = { id: string; createdAt: string; lastSeenAt: string; ipAddress: string | null; userAgent: string | null };

function describeAgent(ua: string | null) {
  if (!ua) return { label: "Unknown device", icon: Monitor };
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const icon = /iPad|Tablet/.test(ua) ? Tablet : /iPhone|Android.*Mobile|Mobile/.test(ua) ? Smartphone : Monitor;
  return { label: os ? `${browser} on ${os}` : browser, icon };
}

export function SecurityForms({ email, isAdmin, currentSessionId, sessions }: { email: string; isAdmin: boolean; currentSessionId: string; sessions: Session[] }) {
  return (
    <div>
      <PasswordSection email={email} />
      <SessionsSection currentSessionId={currentSessionId} sessions={sessions} />
      <DeleteSection isAdmin={isAdmin} />
    </div>
  );
}

function PasswordSection({ email }: { email: string }) {
  const [v, setV] = React.useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const set = (k: keyof typeof v, val: string) => setV((s) => ({ ...s, [k]: val }));
  const err = (k: string) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `${k}-error` } : {});
  return (
    <SettingsSection id="password" title="Password" description="Changing your password signs you out on every other device.">
      <Card>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            setFormError(null);
            if (v.newPassword !== v.confirmPassword) {
              setErrors({ confirmPassword: ["Passwords don't match"] });
              return;
            }
            start(async () => {
              const r = await changePasswordAction(v);
              if (r.ok) {
                toast.success("Password changed. Other devices were signed out.");
                setV({ currentPassword: "", newPassword: "", confirmPassword: "" });
              } else {
                setErrors(r.fieldErrors ?? {});
                if (!r.fieldErrors) setFormError(r.error);
              }
            });
          }}
        >
          {/* Helps password managers associate the new password with the account. */}
          <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
          <div className="grid gap-4 p-5 sm:max-w-md">
            <Field label="Current password" htmlFor="currentPassword" error={errors.currentPassword}>
              <PasswordInput id="currentPassword" autoComplete="current-password" value={v.currentPassword} onChange={(e) => set("currentPassword", e.target.value)} {...err("currentPassword")} />
            </Field>
            <Field label="New password" htmlFor="newPassword" error={errors.newPassword}>
              <PasswordInput id="newPassword" autoComplete="new-password" value={v.newPassword} onChange={(e) => set("newPassword", e.target.value)} {...err("newPassword")} />
              <PasswordStrength value={v.newPassword} />
            </Field>
            <Field label="Confirm new password" htmlFor="confirmPassword" error={errors.confirmPassword}>
              <PasswordInput id="confirmPassword" autoComplete="new-password" value={v.confirmPassword} onChange={(e) => set("confirmPassword", e.target.value)} {...err("confirmPassword")} />
            </Field>
            {formError && (
              <p role="alert" className="rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
                {formError}
              </p>
            )}
          </div>
          <CardFooter className="justify-end">
            <Button type="submit" loading={pending} disabled={!v.currentPassword || !v.newPassword}>
              Change password
            </Button>
          </CardFooter>
        </form>
      </Card>
    </SettingsSection>
  );
}

function SessionsSection({ currentSessionId, sessions }: { currentSessionId: string; sessions: Session[] }) {
  const { prefs } = useAppData();
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [confirmAll, setConfirmAll] = React.useState(false);
  const [pending, start] = React.useTransition();
  const others = sessions.filter((s) => s.id !== currentSessionId);
  const ordered = [...sessions].sort((a, b) => (a.id === currentSessionId ? -1 : b.id === currentSessionId ? 1 : 0));
  const fmt = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(prefs.locale, { dateStyle: "medium", timeStyle: "short", timeZone: prefs.timezone }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16).replace("T", " ");
    }
  };

  return (
    <SettingsSection
      id="sessions"
      title="Where you're signed in"
      description="Sign out of devices you don't recognise."
      actions={
        <form action={logoutAction}>
          <Button type="submit" variant="outline" size="sm">
            <LogOut /> Sign out
          </Button>
        </form>
      }
    >
      <Card>
        <ul className="divide-y">
          {ordered.map((s) => {
            const d = describeAgent(s.userAgent);
            const current = s.id === currentSessionId;
            return (
              <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <d.icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {d.label}
                    {current && <Badge variant="positive">This device</Badge>}
                  </p>
                  <p className="truncate text-[12.5px] text-muted-foreground">
                    {s.ipAddress && s.ipAddress !== "unknown" ? `${s.ipAddress} · ` : ""}Last active {fmt(s.lastSeenAt)} · Signed in {fmt(s.createdAt)}
                  </p>
                </div>
                {!current && (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(s.id)} aria-label={`Sign out ${d.label}`}>
                    Sign out
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {others.length > 0 && (
          <CardFooter className="justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">
              {others.length} other session{others.length === 1 ? "" : "s"}
            </p>
            <Button variant="outline" size="sm" onClick={() => setConfirmAll(true)}>
              Sign out everywhere else
            </Button>
          </CardFooter>
        )}
      </Card>
      {revoking && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRevoking(null)}
          title="Sign out this device?"
          description="It will need to sign in again to access your account."
          confirmLabel="Sign out device"
          loading={pending}
          onConfirm={() =>
            start(async () => {
              const r = await revokeSessionAction({ id: revoking });
              setRevoking(null);
              if (r.ok) toast.success("Device signed out");
              else toast.error(r.error);
            })
          }
        />
      )}
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out everywhere else?"
        description={`All ${others.length} other session${others.length === 1 ? "" : "s"} will be signed out. You'll stay signed in here.`}
        confirmLabel="Sign out others"
        loading={pending}
        onConfirm={() =>
          start(async () => {
            const r = await signOutOtherSessionsAction({});
            setConfirmAll(false);
            if (r.ok) toast.success("Signed out of all other devices");
            else toast.error(r.error);
          })
        }
      />
    </SettingsSection>
  );
}

function DeleteSection({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <SettingsSection id="delete" title="Delete account" description="Permanently delete your account and all of your data.">
      <Card className="border-negative/30">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13.5px] text-muted-foreground">
            Accounts, transactions, budgets, goals, receipts and settings are erased immediately and can&apos;t be recovered. Consider downloading a backup from Data &amp; backup first.
            {isAdmin && " If you're the only admin, promote someone else first."}
          </p>
          <Button variant="destructive" className="shrink-0" onClick={() => setOpen(true)}>
            Delete account…
          </Button>
        </div>
      </Card>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setPassword("");
            setConfirm("");
            setErrors({});
            setFormError(null);
          }
        }}
        title="Delete your account?"
        description="This erases everything immediately. There is no undo."
        confirmLabel="Delete my account"
        loading={pending}
        onConfirm={() => {
          if (confirm.trim() !== "DELETE") {
            setErrors({ confirm: ["Type DELETE to confirm"] });
            return;
          }
          setErrors({});
          setFormError(null);
          start(async () => {
            const r = await deleteAccountAction({ password, confirm });
            // On success the action redirects; we only get here on failure.
            if (r && !r.ok) {
              setErrors(r.fieldErrors ?? {});
              if (!r.fieldErrors) setFormError(r.error);
            }
          });
        }}
      >
        <div className="mt-4 grid gap-3">
          <Field label="Your password" htmlFor="delete-password" error={errors.password}>
            <PasswordInput id="delete-password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={errors.password ? true : undefined} />
          </Field>
          <Field label="Type DELETE to confirm" htmlFor="delete-confirm" error={errors.confirm}>
            <Input id="delete-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" aria-invalid={errors.confirm ? true : undefined} />
          </Field>
          {formError && (
            <p role="alert" className="rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
              {formError}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </SettingsSection>
  );
}
