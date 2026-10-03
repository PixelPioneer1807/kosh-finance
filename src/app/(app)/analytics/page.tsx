import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import {
  autoBucket,
  boundRange,
  byAccount,
  byPaymentMethod,
  categoryTrends,
  incomeBySource,
  largestTransactions,
  periodSummary,
  recurringVsDiscretionary,
  spendingByCategory,
  timeSeries,
  type AnalyticsCtx,
  type Bucket,
} from "@/server/services/analytics";
import { daysBetween } from "@/lib/dates";
import { AnalyticsView } from "./analytics-view";
import { rangeFromParams, rangeQuery, spStr } from "./range-params";

export const metadata: Metadata = { title: "Analytics" };

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const ctx: AnalyticsCtx = { today: prefs.today, monthStartDay: prefs.monthStartDay, weekStartsOn: prefs.weekStartsOn, currency: prefs.currency, locale: prefs.locale };
  const range = rangeFromParams(sp, prefs, prefs.defaultDateRange);
  const bounded = await boundRange(user.id, range, prefs.today);
  const days = daysBetween(bounded.from, bounded.to) + 1;
  const requested = spStr(sp, "bucket") as Bucket | undefined;
  let bucket: Bucket = requested && ["day", "week", "month"].includes(requested) ? requested : autoBucket(bounded);
  // Keep charts readable: never more than ~120 day bars or ~110 week bars.
  if (bucket === "day" && days > 120) bucket = "week";
  if (bucket === "week" && days > 770) bucket = "month";

  const [summary, series, categories, income, accounts, methods, split, trends, largest] = await Promise.all([
    periodSummary(user.id, range, { ctx }),
    timeSeries(user.id, bounded, bucket, { ctx }),
    spendingByCategory(user.id, range, { ctx }),
    incomeBySource(user.id, range, { ctx }),
    byAccount(user.id, bounded, { ctx }),
    byPaymentMethod(user.id, bounded, { ctx }),
    recurringVsDiscretionary(user.id, bounded, { ctx }),
    categoryTrends(user.id, 6, { ctx }),
    largestTransactions(user.id, bounded, { limit: 5, ctx }),
  ]);

  return (
    <AnalyticsView
      range={{ preset: range.preset, from: bounded.from, to: bounded.to }}
      query={rangeQuery({ preset: range.preset, from: range.from, to: range.to })}
      bucket={bucket}
      summary={summary}
      series={series}
      categories={categories}
      income={income}
      accounts={accounts}
      methods={methods}
      split={split}
      trends={trends}
      largest={largest}
    />
  );
}
