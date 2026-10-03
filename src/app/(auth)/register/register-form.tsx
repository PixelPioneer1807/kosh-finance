"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PasswordInput, PasswordStrength } from "@/components/app/password-input";
import { checkInviteAction, registerAction } from "../actions";

const STATE_TEXT: Record<string, string> = {
  valid: "Invite code is valid",
  invalid: "That code isn't valid",
  revoked: "That code has been revoked",
  expired: "That code has expired",
  used: "That code has already been used",
  email_mismatch: "Reserved for a different email",
};

export function RegisterForm({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = React.useState(initialCode ?? "");
  const [inviteState, setInviteState] = React.useState<{ code: string; state: string } | null>(null);
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();

  const complete = code.replace(/[^A-Za-z0-9]/g, "").length >= 12;
  React.useEffect(() => {
    if (!complete) return;
    const t = setTimeout(async () => {
      const r = await checkInviteAction(code);
      setInviteState(r.ok ? { code, state: r.data.state } : null);
    }, 350);
    return () => clearTimeout(t);
  }, [code, complete]);
  // Only show the result for the code currently typed.
  const inviteStatus = complete && inviteState?.code === code ? inviteState.state : null;

  const formatCode = (v: string) => {
    const c = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    return c.match(/.{1,4}/g)?.join("-") ?? "";
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        setFieldErrors({});
        start(async () => {
          const r = await registerAction({
            inviteCode: code,
            email: String(fd.get("email")),
            name: String(fd.get("name") ?? ""),
            password,
          });
          if (r && !r.ok) {
            setError(r.error);
            setFieldErrors(r.fieldErrors ?? {});
          }
        });
      }}
    >
      <Field label="Invite code" htmlFor="inviteCode" error={fieldErrors.inviteCode && !error ? fieldErrors.inviteCode : null}>
        <div className="relative">
          <Input
            id="inviteCode"
            value={code}
            onChange={(e) => setCode(formatCode(e.target.value))}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            required
            className="pr-9 font-mono tracking-wider uppercase"
            aria-describedby="invite-status"
            aria-invalid={inviteStatus && inviteStatus !== "valid" ? true : undefined}
          />
          {inviteStatus && (
            <span className="absolute inset-y-0 right-3 grid place-items-center">
              {inviteStatus === "valid" ? <CheckCircle2 className="size-4 text-positive" /> : <XCircle className="size-4 text-negative" />}
            </span>
          )}
        </div>
        <p id="invite-status" className={`text-[13px] ${inviteStatus === "valid" ? "text-positive" : inviteStatus ? "text-negative" : "text-muted-foreground"}`} aria-live="polite">
          {inviteStatus ? STATE_TEXT[inviteStatus] : "Registration is invite-only. Ask your administrator for a code."}
        </p>
      </Field>
      <Field label="Your name" htmlFor="name" optional>
        <Input id="name" name="name" autoComplete="name" maxLength={80} />
      </Field>
      <Field label="Email" htmlFor="email" error={fieldErrors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required inputMode="email" />
      </Field>
      <Field label="Password" htmlFor="password" error={fieldErrors.password}>
        <PasswordInput id="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} />
        <PasswordStrength value={password} />
      </Field>
      {error && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" loading={pending} className="mt-1 w-full">
        Create account
      </Button>
    </form>
  );
}
