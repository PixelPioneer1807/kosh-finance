"use client";

import * as React from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { forgotPasswordAction } from "../actions";

export default function ForgotPasswordPage() {
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  if (sent)
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-positive-soft text-positive">
          <MailCheck className="size-5" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">If an account exists for that address, we&apos;ve sent a link to reset your password. It expires in one hour.</p>
        <p className="mt-2 text-sm text-muted-foreground">No email set up? Your administrator can generate a reset link for you.</p>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1.5 mb-7 text-sm text-muted-foreground">Enter your email and we&apos;ll send you a reset link.</p>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const email = String(new FormData(e.currentTarget).get("email"));
          setError(null);
          start(async () => {
            const r = await forgotPasswordAction({ email });
            if (r.ok) setSent(true);
            else setError(r.error);
          });
        }}
      >
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </Field>
        {error && <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">{error}</p>}
        <Button type="submit" size="lg" loading={pending} className="w-full">
          Send reset link
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link href="/login" className="hover:text-foreground">← Back to sign in</Link>
      </p>
    </div>
  );
}
