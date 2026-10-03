"use client";

import * as React from "react";
import { formatMoney, type FormatOptions } from "@/lib/money";

export type ClientUser = {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
};
export type ClientPrefs = {
  currency: string;
  locale: string;
  timezone: string;
  today: string;
  weekStartsOn: 0 | 1;
  monthStartDay: number;
  aiEnabled: boolean;
  defaultAccountId: string | null;
  defaultPaymentMethodId: string | null;
};
export type ClientAccount = { id: string; name: string; type: string; currency: string; balance: string; isArchived: boolean; color: string | null };
export type ClientCategory = { id: string; name: string; kind: "expense" | "income"; parentId: string | null; icon: string; color: string; isArchived: boolean };
export type ClientPaymentMethod = { id: string; name: string; type: string; defaultAccountId: string | null };

export type AppData = {
  user: ClientUser;
  prefs: ClientPrefs;
  accounts: ClientAccount[];
  categories: ClientCategory[];
  paymentMethods: ClientPaymentMethod[];
  vapidPublicKey: string | null;
};

const Ctx = React.createContext<AppData | null>(null);

export function AppDataProvider({ value, children }: { value: AppData; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useAppData must be used inside AppDataProvider");
  return v;
}

/** Currency formatter bound to the user's base currency and locale. */
export function useMoney() {
  const { prefs } = useAppData();
  return React.useCallback(
    (amount: string | number | null | undefined, currency?: string | null, opts?: FormatOptions) =>
      formatMoney(amount ?? "0", currency || prefs.currency, { locale: prefs.locale, ...opts }),
    [prefs.currency, prefs.locale],
  );
}
