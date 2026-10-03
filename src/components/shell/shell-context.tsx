"use client";

import * as React from "react";

export type QuickAddPreset = {
  type?: "expense" | "income" | "transfer";
  amount?: string;
  categoryId?: string | null;
  accountId?: string | null;
  merchant?: string | null;
  date?: string;
  notes?: string | null;
  text?: string;
  paymentMethodId?: string | null;
  /** A receipt already uploaded (e.g. by the receipt scanner) to attach on save. */
  receipt?: { id: string; filename: string } | null;
};

type ShellCtx = {
  quickAdd: { open: boolean; preset: QuickAddPreset | null; nonce: number };
  openQuickAdd: (preset?: QuickAddPreset) => void;
  closeQuickAdd: () => void;
  paletteOpen: boolean;
  openPalette: () => void;
  setPaletteOpen: (o: boolean) => void;
};

const Ctx = React.createContext<ShellCtx | null>(null);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [quickAdd, setQuickAdd] = React.useState<ShellCtx["quickAdd"]>({ open: false, preset: null, nonce: 0 });
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const value = React.useMemo<ShellCtx>(
    () => ({
      quickAdd,
      openQuickAdd: (preset) => {
        setPaletteOpen(false);
        setQuickAdd((q) => ({ open: true, preset: preset ?? null, nonce: q.nonce + 1 }));
      },
      closeQuickAdd: () => setQuickAdd((q) => ({ ...q, open: false })),
      paletteOpen,
      openPalette: () => setPaletteOpen(true),
      setPaletteOpen,
    }),
    [quickAdd, paletteOpen],
  );

  // Global shortcuts: ⌘K / Ctrl+K palette, "n" new transaction (when not typing).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
        if (document.querySelector("[role=dialog]")) return;
        e.preventDefault();
        setQuickAdd((q) => ({ open: true, preset: null, nonce: q.nonce + 1 }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Like useShell, but returns null outside the shell (for components that work in both). */
export function useShellOptional() {
  return React.useContext(Ctx);
}

export function useShell() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useShell must be used inside ShellProvider");
  return v;
}
