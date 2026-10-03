"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { PasswordInput, PasswordStrength } from "@/components/app/password-input";
import { resetPasswordAction } from "../actions";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = React.useState("");
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  if (!token) return <p className="text-sm text-muted-foreground">This reset link is incomplete. <Link className="underline" href="/forgot-password">Request a new one</Link>.</p>;
  if (done)
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Password updated</h1>
        <p className="mt-2 text-sm text-muted-foreground">For your security, you&apos;ve been signed out on all devices.</p>
        <Button asChild size="lg" className="mt-6 w-full"><Link href="/login">Sign in</Link></Button>
      </div>
    );
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1.5 mb-7 text-sm text-muted-foreground">This will sign you out everywhere else.</p>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await resetPasswordAction({ token, password });
            if (r.ok) setDone(true);
            else setError(r.error);
          });
        }}
      >
        <Field label="New password" htmlFor="password">
          <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoFocus />
          <PasswordStrength value={password} />
        </Field>
        {error && <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">{error}</p>}
        <Button type="submit" size="lg" loading={pending} className="w-full">Update password</Button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <React.Suspense>
      <ResetForm />
    </React.Suspense>
  );
}
