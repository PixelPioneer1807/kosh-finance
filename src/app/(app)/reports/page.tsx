import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { buildReport, isReportType, REPORT_TYPES, type ReportType } from "@/server/services/reports";
import { reviewableMonths } from "@/server/services/review";
import { rangeFromParams, rangeQuery, spStr } from "../analytics/range-params";
import { ReportView } from "./report-view";

export const metadata: Metadata = { title: "Reports" };

const FALLBACK: Record<ReportType, string> = {
  monthly: "this_month",
  yearly: "this_year",
  spending: "this_month",
  income: "this_year",
  budget: "this_year",
  savings: "last_12_months",
  net_worth: "last_12_months",
};

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const rawType = spStr(sp, "type");
  const type: ReportType = isReportType(rawType) ? rawType : "monthly";
  const range = rangeFromParams(sp, prefs, FALLBACK[type]);
  const [report, months] = await Promise.all([buildReport(user.id, type, range), reviewableMonths(user.id, 60)]);
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  return (
    <ReportView
      types={REPORT_TYPES.map((t) => ({ id: t.id, label: t.label, description: t.description }))}
      report={report}
      range={{ preset: range.preset, from: range.from, to: range.to }}
      csvHref={`/api/export/report?type=${type}&${rangeQuery(range)}`}
      months={months}
      years={years.length ? years : [prefs.today.slice(0, 4)]}
    />
  );
}
