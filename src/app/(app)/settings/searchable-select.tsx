"use client";

import * as React from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Accessible searchable select (combobox) for long option lists such as time zones. */
export function SearchableSelect({
  id,
  value,
  onChange,
  options,
  placeholder = "Search…",
  label,
  invalid,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  label: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);
  const listId = React.useId();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={cn(inputClass, "items-center justify-between gap-2 text-left")}
        >
          <span className="truncate">{selected?.label ?? value ?? "Choose…"}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
        <Command label={label} loop>
          <Command.Input placeholder={placeholder} className="h-10 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground" />
          <Command.List id={listId} className="max-h-72 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</Command.Empty>
            {options.map((o) => (
              <Command.Item
                key={o.value}
                value={`${o.label} ${o.value}`}
                onSelect={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-muted"
              >
                <Check className={cn("size-3.5 shrink-0", o.value === value ? "opacity-100" : "opacity-0")} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="num shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
