"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, LayoutDashboard, Menu, PieChart, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useAppData } from "@/components/app/user-context";
import { NAV, NAV_FOOTER, isActive } from "./nav";
import { useShell } from "./shell-context";

const TABS = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/transactions", label: "Activity", icon: ArrowLeftRight },
  null,
  { href: "/budgets", label: "Budgets", icon: PieChart },
];

/** Thumb-friendly bottom bar with a centred add button — the core mobile workflow is one tap away. */
export function MobileNav() {
  const pathname = usePathname();
  const { openQuickAdd } = useShell();
  const { user, prefs } = useAppData();
  const [more, setMore] = React.useState(false);
  return (
    <>
      <nav
        aria-label="Primary"
        className="no-print fixed inset-x-0 bottom-0 z-40 border-t bg-card/90 pb-safe backdrop-blur-xl lg:hidden"
      >
        <div className="mx-auto grid h-16 max-w-md grid-cols-5 items-center px-2">
          {TABS.map((t, i) =>
            t ? (
              <Link
                key={t.href}
                href={t.href}
                aria-current={isActive(pathname, t.href) ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-1 text-[11px] font-medium text-muted-foreground",
                  isActive(pathname, t.href) && "text-foreground",
                )}
              >
                <t.icon className="size-5" aria-hidden />
                {t.label}
              </Link>
            ) : (
              <div key={i} className="flex justify-center">
                <button
                  onClick={() => openQuickAdd()}
                  aria-label="Add transaction"
                  className="-mt-5 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background transition active:scale-95"
                >
                  <Plus className="size-6" strokeWidth={2.5} />
                </button>
              </div>
            ),
          )}
          <button onClick={() => setMore(true)} className="flex flex-col items-center gap-1 text-[11px] font-medium text-muted-foreground" aria-haspopup="dialog">
            <Menu className="size-5" aria-hidden />
            More
          </button>
        </div>
      </nav>
      <Dialog open={more} onOpenChange={setMore}>
        <DialogContent title="Menu">
          <div className="grid gap-5">
            {[...NAV, { label: "More", items: NAV_FOOTER }].map((g, i) => (
              <div key={i}>
                {g.label && <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{g.label}</p>}
                <div className="grid grid-cols-3 gap-2">
                  {g.items
                    .filter((it) => (!it.adminOnly || user.role === "admin") && (!it.ai || prefs.aiEnabled))
                    .map((it) => (
                      <Link
                        key={it.href}
                        href={it.href}
                        onClick={() => setMore(false)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-lg border bg-card px-2 py-3 text-center text-[12px] font-medium",
                          isActive(pathname, it.href) && "border-foreground/30 bg-muted",
                        )}
                      >
                        <it.icon className="size-5 text-muted-foreground" aria-hidden />
                        {it.label}
                      </Link>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
