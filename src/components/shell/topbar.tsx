"use client";

import * as React from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { LogOut, Monitor, Moon, Search, Settings, Sun, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { LogoMark } from "@/components/app/logo";
import { useAppData } from "@/components/app/user-context";
import { initials } from "@/lib/utils";
import { logoutAction } from "@/app/(auth)/actions";
import { useShell } from "./shell-context";
import { NotificationBell } from "./notification-bell";

/** Detach this device's push subscription so a shared device stops receiving this user's alerts. */
async function detachPushSubscription() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await Promise.race([
      fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    await sub.unsubscribe().catch(() => {});
  } catch {
    /* best effort — never block signing out */
  }
}

export function Topbar() {
  const { user } = useAppData();
  const [, startSignOut] = React.useTransition();
  const { openPalette } = useShell();
  const { theme, setTheme } = useTheme();
  return (
    <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur-xl lg:border-none lg:bg-transparent lg:px-8 lg:backdrop-blur-none">
      <Link href="/dashboard" className="lg:hidden" aria-label="Dashboard">
        <LogoMark />
      </Link>
      <div className="flex-1" />
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={openPalette} aria-label="Search">
        <Search className="size-[18px]" />
      </Button>
      <NotificationBell />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="grid size-8 place-items-center rounded-full bg-muted text-[12px] font-semibold ring-1 ring-border transition hover:ring-border-strong" aria-label="Account menu">
            {initials(user.name, user.email)}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60">
          <DropdownMenuLabel className="font-normal">
            <p className="truncate text-sm font-medium text-foreground">{user.name || "Your account"}</p>
            <p className="truncate text-xs">{user.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <User /> Profile & preferences
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/settings/security">
              <Settings /> Security
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="flex items-center gap-1 px-1 py-1" role="radiogroup" aria-label="Theme">
            {[
              { v: "light", I: Sun, l: "Light" },
              { v: "dark", I: Moon, l: "Dark" },
              { v: "system", I: Monitor, l: "System" },
            ].map(({ v, I, l }) => (
              <button
                key={v}
                role="radio"
                aria-checked={theme === v}
                onClick={() => setTheme(v)}
                className="flex flex-1 flex-col items-center gap-1 rounded-md py-1.5 text-[11px] text-muted-foreground aria-checked:bg-muted aria-checked:text-foreground"
              >
                <I className="size-4" />
                {l}
              </button>
            ))}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              startSignOut(async () => {
                await detachPushSubscription();
                await logoutAction();
              });
            }}
          >
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
