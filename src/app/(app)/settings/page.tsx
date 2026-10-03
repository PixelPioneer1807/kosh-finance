import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences, listExchangeRates } from "@/server/services/preferences";
import { listAccounts } from "@/server/services/accounts";
import { listPaymentMethods } from "@/server/services/taxonomy";
import { dataCounts } from "@/server/services/backup";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Profile & preferences" };

export default async function SettingsProfilePage() {
  const { user } = await requireUserPage();
  const [prefs, accounts, paymentMethods, rates, counts] = await Promise.all([
    getPreferences(user.id),
    listAccounts(user.id),
    listPaymentMethods(user.id),
    listExchangeRates(user.id),
    dataCounts(user.id),
  ]);
  return (
    <ProfileForm
      user={{ name: user.name, email: user.email }}
      prefs={{
        currency: prefs.currency,
        timezone: prefs.timezone,
        locale: prefs.locale,
        weekStartsOn: prefs.weekStartsOn,
        monthStartDay: prefs.monthStartDay,
        defaultAccountId: prefs.defaultAccountId,
        defaultPaymentMethodId: prefs.defaultPaymentMethodId,
        expectedMonthlyIncome: prefs.expectedMonthlyIncome,
      }}
      accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
      paymentMethods={paymentMethods.map((p) => ({ id: p.id, name: p.name }))}
      rates={rates.map((r) => ({ currency: r.currency, rate: r.rate }))}
      transactionCount={counts.transactions}
    />
  );
}
