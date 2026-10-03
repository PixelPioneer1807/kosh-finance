"use client";

import { cn } from "@/lib/utils";
import { isNegative, isPositive } from "@/lib/money";
import { useMoney } from "./user-context";

/**
 * Renders an amount. `tone="flow"` colours by direction (income/refund green, expense default) —
 * colour is never the only signal: signs are always shown for signed amounts.
 */
export function Money({
  amount,
  currency,
  className,
  signed,
  tone = "none",
  compact,
  direction,
}: {
  amount: string | null | undefined;
  currency?: string | null;
  className?: string;
  signed?: boolean;
  compact?: boolean;
  tone?: "none" | "flow" | "balance";
  /** Explicit direction for unsigned magnitudes (e.g. expense rows). */
  direction?: "in" | "out" | "neutral";
}) {
  const fmt = useMoney();
  let text = fmt(amount, currency, { compact, signed: signed && !direction });
  if (direction === "in") text = "+" + fmt(amount, currency, { compact });
  if (direction === "out") text = "−" + fmt(amount, currency, { compact });
  const color =
    tone === "flow"
      ? direction === "in" || (direction === undefined && isPositive(amount))
        ? "text-positive"
        : ""
      : tone === "balance" && isNegative(amount)
        ? "text-negative"
        : "";
  return <span className={cn("num whitespace-nowrap", color, className)}>{text}</span>;
}
