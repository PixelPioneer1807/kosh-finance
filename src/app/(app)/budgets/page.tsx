import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { alertEventsFor, listBudgets, listBudgetsWithProgress, summarizeBudgets } from "@/server/services/budgets";
import { BudgetsView } from "./budgets-view";

export const metadata: Metadata = { title: "Budgets" };

export default async function BudgetsPage({ searchParams }: PageProps<"/budgets">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const [budgets, all] = await Promise.all([listBudgetsWithProgress(user.id), listBudgets(user.id, { includeArchived: true })]);
  const fired = await alertEventsFor(
    user.id,
    budgets.map((b) => ({ id: b.id, periodStart: b.periodRange.from })),
  );
  const archived = all
    .filter((b) => b.isArchived)
    .map((b) => ({ id: b.id, name: b.name, period: b.period, categoryId: b.categoryId, amount: b.amount, currency: b.currency }));
  return (
    <BudgetsView
      budgets={budgets.map((b) => ({ ...b, firedThresholds: fired.get(b.id) ?? [] }))}
      archived={archived}
      summary={summarizeBudgets(budgets)}
      openNew={sp.new === "1"}
      newCategoryId={typeof sp.category === "string" && /^[0-9a-f-]{36}$/i.test(sp.category) ? sp.category : null}
    />
  );
}
