"use client";

/** Dashboard widget: latest transactions. Props: `items` = recentTransactions(userId, n). */
import Link from "next/link";
import { ArrowLeftRight, Plus, Receipt } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData } from "@/components/app/user-context";
import { useShell } from "@/components/shell/shell-context";
import { relativeDayLabel } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { TransactionRow } from "@/server/services/transactions";

export function RecentWidget({ items, className }: { items: TransactionRow[]; className?: string }) {
  const { prefs } = useAppData();
  const { openQuickAdd } = useShell();
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <CardTitle>Recent transactions</CardTitle>
        <Link href="/transactions" className="text-[13px] text-muted-foreground hover:text-foreground">
          View all
        </Link>
      </CardHeader>
      {items.length === 0 ? (
        <EmptyState
          icon={<Receipt />}
          title="Nothing logged yet"
          description="Your latest expenses and income will show up here."
          action={
            <Button size="sm" onClick={() => openQuickAdd()}>
              <Plus /> Add expense
            </Button>
          }
          className="py-8"
        />
      ) : (
        <ul className="divide-y">
          {items.map((t) => {
            const title =
              t.type === "transfer" ? `${t.accountName} → ${t.toAccountName ?? ""}` : t.merchantName || t.notes || t.categoryName || (t.type === "income" ? "Income" : "Expense");
            return (
              <li key={t.id}>
                <Link href={`/transactions?open=${t.id}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-subtle">
                  {t.type === "transfer" ? (
                    <span className="grid size-6 place-items-center rounded-full bg-muted text-muted-foreground">
                      <ArrowLeftRight className="size-3.5" />
                    </span>
                  ) : (
                    <CategoryBadge icon={t.categoryIcon ?? "circle-dashed"} color={t.categoryColor} size="sm" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{title}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {relativeDayLabel(t.date, prefs.today)}
                      {t.categoryName && t.type !== "transfer" ? ` · ${t.categoryName}` : ""}
                    </span>
                  </span>
                  <Money
                    amount={t.amount}
                    currency={t.currency}
                    direction={t.type === "income" || t.type === "refund" ? "in" : t.type === "expense" ? "out" : undefined}
                    signed={t.type === "adjustment"}
                    tone="flow"
                    className="text-sm"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
