import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-[13px] font-medium leading-none text-foreground select-none", className)} {...props} />;
}

/** Label + control + hint/error, wired up for screen readers. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
  optional,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  error?: string | string[] | null;
  hint?: React.ReactNode;
  className?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const msg = Array.isArray(error) ? error[0] : error;
  return (
    <div className={cn("grid gap-1.5", className)}>
      {label && (
        <Label htmlFor={htmlFor} className="flex items-center gap-1.5">
          {label}
          {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
        </Label>
      )}
      {children}
      {msg ? (
        <p role="alert" id={htmlFor ? `${htmlFor}-error` : undefined} className="text-[13px] text-negative">
          {msg}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
