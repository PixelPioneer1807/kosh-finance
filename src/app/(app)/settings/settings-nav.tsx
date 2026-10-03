"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Bot, Coins, CreditCard, Database, Palette, Shapes, ShieldCheck, Store, UserRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const SETTINGS_NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/settings", label: "Profile & preferences", icon: UserRound },
  { href: "/settings/appearance", label: "Appearance", icon: Palette },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/settings/categories", label: "Categories", icon: Shapes },
  { href: "/settings/payment-methods", label: "Payment methods", icon: CreditCard },
  { href: "/settings/currencies", label: "Currencies", icon: Coins },
  { href: "/settings/merchants", label: "Merchants & tags", icon: Store },
  { href: "/settings/ai", label: "AI", icon: Bot },
  { href: "/settings/data", label: "Data & backup", icon: Database },
  { href: "/settings/security", label: "Security", icon: ShieldCheck },
];

/** Desktop: vertical list. Mobile: horizontally scrolling tabs. */
export function SettingsNav() {
  const pathname = usePathname();
  const active = (href: string) => (href === "/settings" ? pathname === "/settings" : pathname === href || pathname.startsWith(href + "/"));
  return (
    <nav aria-label="Settings" className="-mx-4 lg:mx-0">
      <ul className="flex gap-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden overflow-x-auto px-4 pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0">
        {SETTINGS_NAV.map(({ href, label, icon: I }) => {
          const on = active(href);
          return (
            <li key={href} className="shrink-0">
              <Link
                href={href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-2.5 rounded-lg px-3 text-[13.5px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-9",
                  on ? "bg-muted font-medium text-foreground" : "border border-border lg:border-transparent",
                )}
              >
                <I className="size-4 shrink-0" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
