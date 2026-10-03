"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import type { DayTxn } from "@/server/services/analytics";

export function txnTitle(t: DayTxn) {
  if (t.type === "transfer") return `${t.accountName} → ${t.toAccountName ?? "account"}`;
  if (t.type === "adjustment") return "Balance adjustment";
  return t.merchantName ?? t.notes ?? t.categoryName ?? (t.hasSplits ? "Split" : t.type === "income" ? "Income" : "Expense");
}

export function TxnLine({ t }: { t: DayTxn }) {
  const dir = t.type === "expense" ? "out" : t.type === "income" || t.type === "refund" ? "in" : "neutral";
  return (
    <li className="flex items-center gap-3 py-2">
      <CategoryBadge icon={t.type === "transfer" ? "repeat" : (t.categoryIcon ?? "circle")} color={t.type === "transfer" ? "#64748b" : t.categoryColor} size="sm" />
      <div className="min-w-0 flex-1">
        <Link href={`/transactions?open=${t.id}`} className="block truncate text-[13.5px] hover:underline">
          {txnTitle(t)}
        </Link>
        <p className="flex items-center gap-1.5 truncate text-[12px] text-muted-foreground">
          <span className="truncate">{t.type === "transfer" ? "Transfer" : (t.categoryName ?? (t.hasSplits ? "Split" : "Uncategorized"))}</span>
          {t.type !== "transfer" && <span aria-hidden>·</span>}
          {t.type !== "transfer" && <span className="truncate">{t.accountName}</span>}
          {t.isPending && <Badge variant="warning">Pending</Badge>}
          {t.recurringId && <Badge variant="outline">Recurring</Badge>}
        </p>
      </div>
      <Money amount={t.amount} currency={t.currency} direction={dir} tone="flow" className="text-[13.5px]" />
    </li>
  );
}
