"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/controls";
import { RANGE_PRESETS, formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

/** Replace some search params (null deletes) and navigate, keeping the rest of the URL. */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = React.useTransition();
  const set = React.useCallback(
    (patch: Record<string, string | null>, opts: { replace?: boolean; scroll?: boolean } = {}) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      start(() => {
        const href = qs ? `${pathname}?${qs}` : pathname;
        if (opts.replace) router.replace(href, { scroll: opts.scroll ?? false });
        else router.push(href, { scroll: opts.scroll ?? false });
      });
    },
    [pathname, router, sp],
  );
  return { set, pending, params: sp };
}

export function rangeText(from: string, to: string) {
  if (from === to) return formatDate(from, "d MMM yyyy");
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${formatDate(from, sameYear ? "d MMM" : "d MMM yyyy")} – ${formatDate(to, "d MMM yyyy")}`;
}

/**
 * Date-range control: presets as rows (with a check on the selected one) and a custom range in
 * the footer. State lives in the URL (`range`, `from`, `to`) so views are shareable and the
 * server renders the right slice.
 */
export function RangePicker({
  preset,
  from,
  to,
  presets = RANGE_PRESETS,
  className,
  resetKeys = ["offset", "day"],
}: {
  preset: string;
  from: string;
  to: string;
  presets?: readonly { id: string; label: string }[];
  className?: string;
  /** Params cleared when the range changes (e.g. pagination). */
  resetKeys?: string[];
}) {
  const { set, pending } = useUrlParams();
  const [open, setOpen] = React.useState(false);
  const [cFrom, setCFrom] = React.useState(from);
  const [cTo, setCTo] = React.useState(to);
  const id = React.useId();
  const current = presets.find((p) => p.id === preset);
  const clear = Object.fromEntries(resetKeys.map((k) => [k, null]));
  const choose = (p: string) => {
    set({ range: p, from: null, to: null, ...clear });
    setOpen(false);
  };
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(cFrom) && /^\d{4}-\d{2}-\d{2}$/.test(cTo) && cFrom <= cTo;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setCFrom(from);
          setCTo(to);
        }
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn("h-10 justify-between gap-2 sm:h-9", className)} aria-label={`Date range: ${current?.label ?? "Custom"}, ${rangeText(from, to)}`}>
          <span className="truncate">
            <span className="font-medium">{current?.label ?? "Custom"}</span>
            {preset !== "all" && <span className="ml-2 text-muted-foreground">{rangeText(from, to)}</span>}
          </span>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <ChevronDown className="text-muted-foreground" aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1">
        <ul role="listbox" aria-label="Date range presets" className="max-h-72 overflow-y-auto">
          {presets.map((p) => (
            <li key={p.id} role="option" aria-selected={p.id === preset}>
              <button
                type="button"
                onClick={() => choose(p.id)}
                className="flex min-h-9 w-full items-center justify-between rounded-md px-2.5 text-left text-sm hover:bg-muted focus-visible:bg-muted"
              >
                <span className={cn(p.id === preset && "font-semibold")}>{p.label}</span>
                {p.id === preset && <Check className="size-4" strokeWidth={2.5} aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-1 grid gap-2 border-t px-2 pt-2.5 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            set({ range: "custom", from: cFrom, to: cTo, ...clear });
            setOpen(false);
          }}
        >
          <p className="text-[12px] font-medium text-muted-foreground">Custom range</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor={`${id}-from`} className="text-[12px]">
                From
              </Label>
              <Input id={`${id}-from`} type="date" value={cFrom} max={cTo} onChange={(e) => setCFrom(e.target.value)} className="h-9 px-2" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-to`} className="text-[12px]">
                To
              </Label>
              <Input id={`${id}-to`} type="date" value={cTo} min={cFrom} onChange={(e) => setCTo(e.target.value)} className="h-9 px-2" />
            </div>
          </div>
          <Button type="submit" size="sm" disabled={!valid}>
            Apply
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** URL-backed segmented control (e.g. bucket = day/week/month). */
export function ParamSegmented<T extends string>({ param, value, options, ariaLabel }: { param: string; value: T; options: { value: T; label: string }[]; ariaLabel: string }) {
  const { set } = useUrlParams();
  return <Segmented size="sm" ariaLabel={ariaLabel} value={value} onChange={(v) => set({ [param]: v })} options={options} />;
}

/** Sub-navigation for the analytics section. */
export function AnalyticsNav({ active, query }: { active: "overview" | "merchants" | "daily"; query?: string }) {
  const tabs = [
    { id: "overview", label: "Overview", href: "/analytics" },
    { id: "merchants", label: "Merchants", href: "/analytics/merchants" },
    { id: "daily", label: "Daily", href: "/analytics/daily" },
  ] as const;
  return (
    <nav aria-label="Analytics sections" className="no-print -mt-2 mb-5 flex gap-1 overflow-x-auto border-b scrollbar-none">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={query ? `${t.href}?${query}` : t.href}
          aria-current={active === t.id ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex min-h-10 items-center border-b-2 px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors",
            active === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
