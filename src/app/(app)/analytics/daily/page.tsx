import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { dailyBreakdown, type AnalyticsCtx } from "@/server/services/analytics";
import { DailyView } from "./daily-view";
import { rangeFromParams, rangeQuery } from "../range-params";

export const metadata: Metadata = { title: "Daily view" };

export default async function DailyPage({ searchParams }: PageProps<"/analytics/daily">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const ctx: AnalyticsCtx = { today: prefs.today, monthStartDay: prefs.monthStartDay, weekStartsOn: prefs.weekStartsOn, currency: prefs.currency, locale: prefs.locale };
  const range = rangeFromParams(sp, prefs, "last_30");
  const data = await dailyBreakdown(user.id, range, { maxDays: 92, ctx });
  return <DailyView key={`${data.range.from}:${data.range.to}`} range={{ preset: range.preset, from: data.range.from, to: data.range.to }} query={rangeQuery(range)} data={data} />;
}
