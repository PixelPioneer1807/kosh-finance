"use client";

/** Dashboard widget: balances of active accounts (from the app data context — no extra queries). */
import Link from "next/link";
import { Plus, Wallet } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData } from "@/components/app/user-context";
import { isNegative, neg } from "@/lib/money";
import { cn } from "@/lib/utils";

const ICON: Record<string, string> = { checking: "landmark", savings: "piggy-bank", cash: "banknote", wallet: "wallet", credit_card: "credit-card", investment: "trending-up", loan: "hand-coins", asset: "gem", other: "circle-dashed" };

export function AccountsWidget({ className }: { className?: string }) {
  const { accounts } = useAppData();
  const active = accounts.filter((a) => !a.isArchived);
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <Link href="/accounts" className="text-[13px] text-muted-foreground hover:text-foreground">
          Manage
        </Link>
      </CardHeader>
      {active.length === 0 ? (
        <EmptyState
          icon={<Wallet />}
          title="No accounts yet"
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/accounts?new=1">
                <Plus /> Add account
              </Link>
            </Button>
          }
          className="py-8"
        />
      ) : (
        <ul className="divide-y">
          {active.slice(0, 6).map((a) => {
            const liability = a.type === "credit_card" || a.type === "loan";
            return (
              <li key={a.id}>
                <Link href={`/transactions?account=${a.id}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-subtle">
                  <Icon name={ICON[a.type] ?? "circle"} className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                  <span className="text-right">
                    <Money amount={liability && isNegative(a.balance) ? neg(a.balance) : a.balance} currency={a.currency} tone={liability ? "none" : "balance"} className="text-sm font-medium" />
                    {liability && isNegative(a.balance) && <span className="block text-[11px] text-muted-foreground">owed</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
