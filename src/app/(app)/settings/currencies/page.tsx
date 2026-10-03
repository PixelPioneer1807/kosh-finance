import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences, listExchangeRates } from "@/server/services/preferences";
import { listAccounts } from "@/server/services/accounts";
import { CurrenciesManager } from "./currencies-manager";

export const metadata: Metadata = { title: "Currencies" };

export default async function CurrenciesPage() {
  const { user } = await requireUserPage();
  const [prefs, rates, accounts] = await Promise.all([getPreferences(user.id), listExchangeRates(user.id), listAccounts(user.id, { includeArchived: true })]);
  const used = [...new Set(accounts.map((a) => a.currency))].filter((c) => c !== prefs.currency);
  return (
    <CurrenciesManager
      base={prefs.currency}
      locale={prefs.locale}
      rates={rates.map((r) => ({ currency: r.currency, rate: r.rate, updatedAt: r.updatedAt.toISOString() }))}
      usedCurrencies={used}
    />
  );
}
