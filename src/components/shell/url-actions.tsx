"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useShell } from "./shell-context";

/** Opens the quick-add sheet for deep links like /dashboard?add=expense (PWA shortcuts, reminder pushes). */
export function UrlActions() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { openQuickAdd } = useShell();
  React.useEffect(() => {
    const add = params.get("add");
    if (add !== "expense" && add !== "income" && add !== "transfer") return;
    openQuickAdd({ type: add });
    const next = new URLSearchParams(params.toString());
    next.delete("add");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [params, pathname, router, openQuickAdd]);
  return null;
}
