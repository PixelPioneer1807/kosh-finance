"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { ArrowLeftRight, Coins, CreditCard, Landmark, Loader2, Minus, Plus, Receipt, Repeat, Search, Sparkles, Tag, Target, Wallet } from "lucide-react";
import { useAppData, useMoney } from "@/components/app/user-context";
import { NAV, NAV_FOOTER } from "./nav";
import { useShell } from "./shell-context";
import { formatDate } from "@/lib/dates";

type SearchHit = { kind: string; id: string; title: string; subtitle?: string; href: string; amount?: string; currency?: string };

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  transaction: Receipt,
  merchant: Coins,
  category: Tag,
  account: Landmark,
  subscription: Repeat,
  recurring: Repeat,
  goal: Target,
  tag: Tag,
};

export function CommandPalette() {
  const router = useRouter();
  const { paletteOpen, setPaletteOpen, openQuickAdd } = useShell();
  const { user, prefs } = useAppData();
  const fmt = useMoney();
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (q.trim().length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        if (r.ok) setHits((await r.json()).results ?? []);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = (href: string) => {
    setPaletteOpen(false);
    setQ("");
    router.push(href);
  };
  // Results only apply to queries long enough to have been searched.
  const shownHits = q.trim().length < 2 ? [] : hits;
  const looksLikeEntry = /\d/.test(q) && q.trim().split(/\s+/).length >= 2;

  return (
    <D.Root
      open={paletteOpen}
      onOpenChange={(o) => {
        setPaletteOpen(o);
        if (!o) setQ("");
      }}
    >
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <D.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover shadow-lg animate-in">
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">Search or run a command</D.Description>
          <Command label="Command palette" shouldFilter={true} loop>
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search, jump to a page, or type “120 uber”…"
                className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
              />
              {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{loading ? "Searching…" : "No results."}</Command.Empty>
              {looksLikeEntry && (
                <Command.Group heading="Quick entry" forceMount>
                  <PaletteItem value={`add-entry ${q}`} onSelect={() => {
                      openQuickAdd({ text: q });
                      setQ("");
                    }} icon={Sparkles} forceMount>
                    Add “{q}”
                  </PaletteItem>
                </Command.Group>
              )}
              {shownHits.length > 0 && (
                <Command.Group heading="Results" forceMount>
                  {shownHits.map((h) => {
                    const I = KIND_ICON[h.kind] ?? Search;
                    return (
                      <PaletteItem key={`${h.kind}-${h.id}`} value={`${h.kind} ${h.id} ${h.title} ${h.subtitle ?? ""} ${q}`} onSelect={() => go(h.href)} icon={I} forceMount>
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block truncate">{h.title}</span>
                            {h.subtitle && <span className="block truncate text-[12px] text-muted-foreground">{h.subtitle}</span>}
                          </span>
                          {h.amount && <span className="num shrink-0 text-[13px] text-muted-foreground">{fmt(h.amount, h.currency)}</span>}
                        </span>
                      </PaletteItem>
                    );
                  })}
                </Command.Group>
              )}
              <Command.Group heading="Actions">
                <PaletteItem value="add expense new" onSelect={() => openQuickAdd({ type: "expense" })} icon={Minus} shortcut="N">
                  Add expense
                </PaletteItem>
                <PaletteItem value="add income salary" onSelect={() => openQuickAdd({ type: "income" })} icon={Plus}>
                  Add income
                </PaletteItem>
                <PaletteItem value="transfer money between accounts" onSelect={() => openQuickAdd({ type: "transfer" })} icon={ArrowLeftRight}>
                  Transfer money
                </PaletteItem>
                <PaletteItem value="search transactions" onSelect={() => go(`/transactions${q ? `?q=${encodeURIComponent(q)}` : ""}`)} icon={Search}>
                  Search transactions{q ? ` for “${q}”` : ""}
                </PaletteItem>
                <PaletteItem value="add budget create" onSelect={() => go("/budgets?new=1")} icon={Wallet}>
                  Add budget
                </PaletteItem>
                <PaletteItem value="add goal savings create" onSelect={() => go("/goals?new=1")} icon={Target}>
                  Add goal
                </PaletteItem>
                <PaletteItem value="contribute goal" onSelect={() => go("/goals?contribute=1")} icon={Target}>
                  Goal contribution
                </PaletteItem>
                <PaletteItem value="add bill" onSelect={() => go("/recurring?new=bill")} icon={Receipt}>
                  Add bill
                </PaletteItem>
                <PaletteItem value="add subscription" onSelect={() => go("/recurring?new=subscription")} icon={Repeat}>
                  Add subscription
                </PaletteItem>
                <PaletteItem value="add account" onSelect={() => go("/accounts?new=1")} icon={CreditCard}>
                  Add account
                </PaletteItem>
                {prefs.aiEnabled && (
                  <PaletteItem value="ai assistant ask" onSelect={() => go(`/assistant${q ? `?q=${encodeURIComponent(q)}` : ""}`)} icon={Sparkles}>
                    Ask the assistant{q ? ` “${q}”` : ""}
                  </PaletteItem>
                )}
              </Command.Group>
              <Command.Group heading="Go to">
                {[...NAV.flatMap((g) => g.items), ...NAV_FOOTER]
                  .filter((i) => (!i.adminOnly || user.role === "admin") && (!i.ai || prefs.aiEnabled))
                  .map((i) => (
                    <PaletteItem key={i.href} value={`go ${i.label}`} onSelect={() => go(i.href)} icon={i.icon}>
                      {i.label}
                    </PaletteItem>
                  ))}
              </Command.Group>
            </Command.List>
            <div className="flex items-center justify-between border-t px-3 py-2 text-[11.5px] text-muted-foreground">
              <span>Today is {formatDate(prefs.today, "EEE d MMM")}</span>
              <span>↑↓ navigate · ↵ select · esc close</span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function PaletteItem({
  value,
  onSelect,
  icon: I,
  children,
  shortcut,
  forceMount,
}: {
  value: string;
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  shortcut?: string;
  forceMount?: boolean;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      forceMount={forceMount}
      className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-sm outline-none select-none data-[selected=true]:bg-muted"
    >
      <I className="size-4 shrink-0 text-muted-foreground" />
      {children}
      {shortcut && <kbd className="ml-auto rounded border px-1 font-mono text-[11px] text-muted-foreground">{shortcut}</kbd>}
    </Command.Item>
  );
}
