import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import {
  detectRecurringCandidates,
  lastPostings,
  listRecurring,
  normalizedCost,
  priceChanges,
  recurringCostSummary,
  upcomingOccurrences,
} from "@/server/services/recurring";
import { listMerchants } from "@/server/services/taxonomy";
import { addDaysISO } from "@/lib/dates";
import { RecurringView } from "./recurring-view";
import type { RecurringItem } from "./types";

export const metadata: Metadata = { title: "Bills & recurring" };

const NEW_KINDS = ["bill", "subscription", "income", "expense", "transfer"] as const;

export default async function RecurringPage({ searchParams }: PageProps<"/recurring">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const horizon = addDaysISO(prefs.today, 30);
  const [items, upcoming, subs, bills, income, changes, suggestions, posted, merchants] = await Promise.all([
    listRecurring(user.id, { includeInactive: true }),
    upcomingOccurrences(user.id, prefs.today, horizon),
    recurringCostSummary(user.id, ["subscription"]),
    recurringCostSummary(user.id, ["bill"]),
    recurringCostSummary(user.id, ["income"]),
    priceChanges(user.id),
    detectRecurringCandidates(user.id, prefs.today),
    lastPostings(user.id),
    listMerchants(user.id),
  ]);
  const merchantName = new Map(merchants.map((m) => [m.id, m.name]));

  const rows: RecurringItem[] = items.map((i) => {
    const cost = normalizedCost(i);
    const last = posted.get(i.id);
    return {
      id: i.id,
      kind: i.kind,
      name: i.name,
      amount: i.amount,
      currency: i.currency,
      accountId: i.accountId,
      toAccountId: i.toAccountId,
      categoryId: i.categoryId,
      paymentMethodId: i.paymentMethodId,
      merchant: i.merchantId ? (merchantName.get(i.merchantId) ?? null) : null,
      notes: i.notes,
      frequency: i.frequency,
      interval: i.interval,
      intervalUnit: i.intervalUnit,
      startDate: i.startDate,
      endDate: i.endDate,
      nextDate: i.nextDate,
      autoPost: i.autoPost,
      remindDaysBefore: i.remindDaysBefore,
      status: i.status,
      serviceUrl: i.serviceUrl,
      trialEndsAt: i.trialEndsAt,
      cancelledAt: i.cancelledAt,
      employer: i.employer,
      grossAmount: i.grossAmount,
      deductions: i.deductions ?? [],
      monthly: cost.monthly,
      yearly: cost.yearly,
      lastPaid: last ? { date: last.date, amount: last.amount } : null,
    };
  });

  const newKind = NEW_KINDS.find((k) => k === sp.new) ?? null;
  const openId = typeof sp.open === "string" && /^[0-9a-f-]{36}$/i.test(sp.open) ? sp.open : null;
  const tab = typeof sp.tab === "string" ? sp.tab : null;

  return (
    <RecurringView
      items={rows}
      upcoming={upcoming}
      costs={{ subscriptions: subs, bills, income }}
      priceChanges={changes}
      suggestions={suggestions}
      newKind={newKind}
      openId={openId}
      initialTab={tab}
    />
  );
}
