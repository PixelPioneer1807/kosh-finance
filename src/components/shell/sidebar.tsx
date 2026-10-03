"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/app/logo";
import { Kbd } from "@/components/ui/misc";
import { useAppData } from "@/components/app/user-context";
import { NAV, NAV_FOOTER, isActive, type NavItem } from "./nav";
import { useShell } from "./shell-context";

function Item({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        active && "bg-card text-foreground shadow-xs ring-1 ring-border",
      )}
    >
      <item.icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground/80 group-hover:text-foreground")} aria-hidden />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function Sidebar() {
  const { user, prefs } = useAppData();
  const { openQuickAdd, openPalette } = useShell();
  const visible = (i: NavItem) => (!i.adminOnly || user.role === "admin") && (!i.ai || prefs.aiEnabled);
  return (
    <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-subtle px-3 py-4 lg:flex" aria-label="Main navigation">
      <Link href="/dashboard" className="mb-5 px-2">
        <Logo />
      </Link>
      <div className="mb-4 grid gap-2 px-0.5">
        <button
          onClick={() => openQuickAdd()}
          className="flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 active:scale-[0.98]"
        >
          <Plus className="size-4" /> Add transaction
          <Kbd className="ml-auto border-white/15 bg-white/10 text-primary-foreground/70 dark:border-black/10 dark:bg-black/5">N</Kbd>
        </button>
        <button
          onClick={openPalette}
          className="flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm text-muted-foreground shadow-xs transition hover:text-foreground"
        >
          <Search className="size-4" /> Search
          <Kbd className="ml-auto">⌘K</Kbd>
        </button>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto scrollbar-none">
        {NAV.map((g, i) => (
          <div key={i}>
            {g.label && <p className="mb-1 px-2.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">{g.label}</p>}
            <div className="grid gap-0.5">
              {g.items.filter(visible).map((it) => (
                <Item key={it.href} item={it} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="mt-4 grid gap-0.5 border-t pt-3">
        {NAV_FOOTER.filter(visible).map((it) => (
          <Item key={it.href} item={it} />
        ))}
      </div>
    </aside>
  );
}
