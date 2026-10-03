"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";

export function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <Input {...props} type={show ? "text" : "password"} className="pr-10" />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** Lightweight strength hint. The server enforces the actual policy. */
export function PasswordStrength({ value }: { value: string }) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  const score = value.length === 0 ? 0 : value.length < 10 ? 1 : value.length >= 16 || classes >= 3 ? 3 : classes >= 2 ? 2 : 1;
  const labels = ["", "Too short or simple", "Good", "Strong"];
  const colors = ["bg-muted", "bg-negative", "bg-warning", "bg-positive"];
  return (
    <div className="mt-1.5" aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className={`h-1 flex-1 rounded-full ${score >= i ? colors[score] : "bg-muted"}`} />
        ))}
      </div>
      {value && <p className="mt-1 text-xs text-muted-foreground">{labels[score]} · at least 10 characters, mix letters & numbers</p>}
    </div>
  );
}
