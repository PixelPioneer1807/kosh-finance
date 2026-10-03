"use client";

import * as React from "react";
import { useTheme } from "next-themes";

/** Applies the theme saved on the user's profile once per device, so it follows them across devices. */
export function ThemeSync({ theme }: { theme: string }) {
  const { setTheme } = useTheme();
  React.useEffect(() => {
    const key = "kosh-theme-synced";
    try {
      if (localStorage.getItem(key) === theme) return;
      localStorage.setItem(key, theme);
    } catch {
      /* storage unavailable */
    }
    setTheme(theme);
  }, [theme, setTheme]);
  return null;
}
