import { userRoute, AppError } from "@/server/safe";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { getPreferences } from "@/server/services/preferences";
import { buildReport, defaultReportRange, isReportType } from "@/server/services/reports";
import { reportToCsv } from "@/server/services/exports";
import { fileSlug } from "@/lib/csv";
import { resolveRange } from "@/lib/dates";

/** CSV for a report: `?type=<report type>&range=<preset>|&from=YYYY-MM-DD&to=YYYY-MM-DD`. */
export const GET = userRoute(async (req, { userId }) => {
  await enforceRateLimit(`export:report:${userId}`, 60, 3600, "Too many exports. Try again in a little while.");
  const sp = new URL(req.url).searchParams;
  const type = sp.get("type");
  if (!isReportType(type)) throw new AppError("VALIDATION", "Choose a report type.");
  const prefs = await getPreferences(userId);
  const preset = sp.get("range") ?? (sp.get("from") || sp.get("to") ? "custom" : undefined);
  const range = preset
    ? resolveRange(preset, prefs.today, { weekStartsOn: prefs.weekStartsOn, monthStartDay: prefs.monthStartDay, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined })
    : defaultReportRange(type, prefs.today, prefs.monthStartDay);
  const report = await buildReport(userId, type, { from: range.from, to: range.to });
  const csv = reportToCsv(report);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kosh-${fileSlug(report.type)}-${report.range.from}-to-${report.range.to}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
