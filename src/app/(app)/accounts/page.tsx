import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { listAccounts } from "@/server/services/accounts";
import { getPreferences, rateMap, convert } from "@/server/services/preferences";
import { add, neg } from "@/lib/money";
import { AccountsView } from "./accounts-view";

export const metadata: Metadata = { title: "Accounts" };

export default async function AccountsPage({ searchParams }: PageProps<"/accounts">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const [accounts, prefs] = await Promise.all([listAccounts(user.id, { includeArchived: true }), getPreferences(user.id)]);
  const rates = await rateMap(user.id, prefs.currency);
  const unconverted = new Set<string>();
  const assetParts: string[] = [];
  const liabilityParts: string[] = [];
  for (const a of accounts) {
    if (a.isArchived || !a.includeInNetWorth) continue;
    const base = convert(a.balance, a.currency, rates);
    if (base === null) unconverted.add(a.currency);
    // Liabilities are stored as negative balances; report what is owed as a positive amount.
    else if (a.liability) liabilityParts.push(neg(base));
    else assetParts.push(base);
  }
  const assets = add(...assetParts);
  const liabilities = add(...liabilityParts);
  const rows = accounts.map((a) => {
    const base = convert(a.balance, a.currency, rates);
    return {
      id: a.id, name: a.name, type: a.type, currency: a.currency, balance: a.balance, baseBalance: base,
      openingBalance: a.openingBalance, openingDate: a.openingDate, institution: a.institution, notes: a.notes, color: a.color,
      includeInNetWorth: a.includeInNetWorth, isArchived: a.isArchived, liability: a.liability,
      creditLimit: a.creditLimit, statementDay: a.statementDay, dueDay: a.dueDay, minimumPayment: a.minimumPayment,
      annualFee: a.annualFee, interestRate: a.interestRate, availableCredit: a.availableCredit, utilization: a.utilization,
    };
  });
  return (
    <AccountsView
      accounts={rows}
      totals={{ assets, liabilities, unconverted: [...unconverted] }}
      openNew={sp.new === "1"}
    />
  );
}
