"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { PasswordInput } from "@/components/app/password-input";
import { loginAction } from "../actions";

export function LoginForm({ next }: { next?: string }) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await loginAction({ email: String(fd.get("email")), password: String(fd.get("password")), next });
          if (r && !r.ok) setError(r.error);
        });
      }}
    >
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus inputMode="email" />
      </Field>
      <Field
        label={
          <span className="flex w-full items-center justify-between">
            Password
            <Link href="/forgot-password" className="text-[13px] font-normal text-muted-foreground hover:text-foreground">
              Forgot?
            </Link>
          </span>
        }
        htmlFor="password"
      >
        <PasswordInput id="password" name="password" autoComplete="current-password" required />
      </Field>
      {error && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" loading={pending} className="mt-1 w-full">
        Sign in
      </Button>
    </form>
  );
}
