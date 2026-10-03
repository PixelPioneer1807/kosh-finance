"use client";

/**
 * Dashboard widget: top spending categories for a period as sorted horizontal bars.
 *
 * Props (serialisable):
 * - `data`: result of `spendingByCategory(userId, range)` from src/server/services/analytics.ts.
 * - `limit` (default 5): categories shown; the rest are folded into "Other categories".
 * - `className`: forwarded to the outer Card.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMoney } from "@/components/app/user-context";
import { HBarList, type HBarItem } from "@/components/analytics/chart-kit";
import { add, isZero, ratio } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { CategoryBreakdown } from "@/server/services/analytics";

export type CategoryWidgetProps = { data: CategoryBreakdown; limit?: number; className?: string };

export function CategoryWidget({ data, limit = 5, className }: CategoryWidgetProps) {
  const fmt = useMoney();
  const spent = data.items.filter((c) => !isZero(c.amount));
  const top = spent.slice(0, limit);
  const rest = spent.slice(limit);
  const items: HBarItem[] = top.map((c) => ({
    id: c.categoryId ?? "none",
    label: c.name,
    icon: c.icon,
    color: c.color,
    value: c.amount,
    share: c.share,
    href: c.categoryId ? `/transactions?category=${c.categoryId}&from=${data.range.from}&to=${data.range.to}` : undefined,
  }));
  if (rest.length) {
    const other = add(...rest.map((r) => r.amount));
    items.push({ id: "other", label: `Other categories (${rest.length})`, icon: "circle-dashed", color: "#78716c", value: other, share: isZero(data.total) ? 0 : ratio(other, data.total) });
  }
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>Top categories</CardTitle>
        <Link href="/analytics" className="-mr-1 inline-flex min-h-8 items-center gap-0.5 rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground">
          {fmt(data.total)} <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent className="flex-1">
        <HBarList items={items} expandable={false} emptyText="No spending in this period yet." />
      </CardContent>
    </Card>
  );
}
