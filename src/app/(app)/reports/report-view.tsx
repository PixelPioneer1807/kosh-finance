"use client";

import Link from "next/link";
import { Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/misc";
import { useAppData, useMoney } from "@/components/app/user-context";
import { COLORS } from "@/components/charts/palette";
import { ChartCard, DataTable, FlowChart, StatRow, StatTile, ValueBars, ValueLine, formatPct } from "@/components/analytics/chart-kit";
import { RangePicker, useUrlParams } from "@/components/analytics/range-picker";
import { APP_NAME } from "@/lib/config";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { Report, ReportChart, ReportTable, ValueKind } from "@/server/services/reports";

type Props = {
  types: { id: string; label: string; description: string }[];
  report: Report;
  range: { preset: string; from: string; to: string };
  csvHref: string;
  months: string[];
  years: string[];
};

/** Clean print layout: only the report, no app chrome, no controls, cards without shadows. */
const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; }
  main { max-width: none !important; padding: 0 !important; }
  .report-card { box-shadow: none !important; break-inside: avoid; border-color: #ddd !important; }
  .report-table { break-inside: auto; }
  .report-table tr { break-inside: avoid; }
  .print-only { display: block !important; }
}
`;

function useCell() {
  const fmt = useMoney();
  return (v: string | number | null | undefined, kind: ValueKind) => {
    if (v === null || v === undefined || v === "") return "—";
    if (kind === "money") return fmt(String(v));
    if (kind === "percent") return formatPct(typeof v === "number" ? v : Number(v), 1);
    if (kind === "date") return formatDate(String(v), "d MMM yyyy");
    if (kind === "number") return typeof v === "number" ? v.toLocaleString() : v;
    return String(v);
  };
}

function ReportTableView({ t }: { t: ReportTable }) {
  const cell = useCell();
  return (
    <Card className="report-card">
      <CardHeader>
        <div>
          <CardTitle className="text-[14px] text-foreground">{t.title}</CardTitle>
          {t.description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.description}</p>}
        </div>
      </CardHeader>
      <CardContent>
        {t.rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t.empty ?? "Nothing to show."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="report-table w-full min-w-[420px] text-[13px]">
              <caption className="sr-only">{t.title}</caption>
              <thead className="text-[12px] text-muted-foreground">
                <tr className="border-b">
                  {t.columns.map((c, i) => (
                    <th key={c.key} scope="col" className={cn("py-1.5 font-medium", i === 0 ? "text-left" : "pl-3 text-right")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {t.rows.map((r, ri) => (
                  <tr key={ri}>
                    {t.columns.map((c, i) => {
                      const indent = c.indentKey && Number(r[c.indentKey]) > 0;
                      return i === 0 ? (
                        <th key={c.key} scope="row" className={cn("py-1.5 text-left font-normal", indent && "pl-5 text-muted-foreground")}>
                          {cell(r[c.key], c.kind)}
                        </th>
                      ) : (
                        <td key={c.key} className={cn("num py-1.5 pl-3 text-right", indent && "text-muted-foreground")}>
                          {cell(r[c.key], c.kind)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              {t.totals && (
                <tfoot>
                  <tr className="border-t-2 font-medium">
                    {t.columns.map((c, i) =>
                      i === 0 ? (
                        <th key={c.key} scope="row" className="py-1.5 text-left">
                          Total
                        </th>
                      ) : (
                        <td key={c.key} className="num py-1.5 pl-3 text-right">
                          {t.totals![c.key] === undefined ? "" : cell(t.totals![c.key], c.kind)}
                        </td>
                      ),
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const ROLE_COLOR = { income: COLORS.income, spending: COLORS.spending, savings: COLORS.savings, netWorth: COLORS.savings } as const;

function ReportChartView({ chart }: { chart: ReportChart }) {
  const fmt = useMoney();
  const table = (
    <DataTable
      caption={chart.title}
      columns={[{ key: "label", label: "Period" }, ...chart.series.map((s) => ({ key: s.key, label: s.label }))]}
      rows={chart.points.map((p, i) => ({ key: String(i), cells: { label: p.label, ...Object.fromEntries(chart.series.map((s) => [s.key, fmt(p.values[s.key] ?? "0")])) } }))}
    />
  );
  const two = chart.series.length === 2 && chart.series[0].role === "income";
  return (
    <ChartCard title={chart.title} table={table} className="report-card">
      {two ? (
        <FlowChart points={chart.points.map((p, i) => ({ key: String(i), label: p.label, title: p.label, income: p.values.income ?? "0", spending: p.values.spending ?? "0" }))} />
      ) : chart.form === "line" ? (
        <ValueLine
          points={chart.points.map((p, i) => ({ key: String(i), label: p.label, title: p.label, value: p.values[chart.series[0].key] ?? "0" }))}
          color={ROLE_COLOR[chart.series[0].role]}
          seriesLabel={chart.series[0].label}
        />
      ) : (
        <ValueBars
          points={chart.points.map((p, i) => ({ key: String(i), label: p.label, title: p.label, value: p.values[chart.series[0].key] ?? "0" }))}
          color={ROLE_COLOR[chart.series[0].role]}
          seriesLabel={chart.series[0].label}
          height={220}
        />
      )}
    </ChartCard>
  );
}

export function ReportView({ types, report, range, csvHref, months, years }: Props) {
  const cell = useCell();
  const { prefs } = useAppData();
  const { set, pending } = useUrlParams();
  const msd = String(prefs.monthStartDay).padStart(2, "0");
  const chooseType = (t: string) => set({ type: t, range: null, from: null, to: null });

  return (
    <div>
      <style>{PRINT_CSS}</style>
      <div className="no-print">
        <PageHeader
          title="Reports"
          description="Printable summaries of your finances. Download as PDF (print) or CSV."
          actions={
            <>
              <Button variant="outline" size="sm" asChild>
                <a href={csvHref} download>
                  <Download /> Download CSV
                </a>
              </Button>
              <Button size="sm" onClick={() => window.print()}>
                <Printer /> Download PDF
              </Button>
            </>
          }
        />
        <nav aria-label="Report type" className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1 scrollbar-none">
          {types.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.description}
              aria-current={report.type === t.id ? "page" : undefined}
              onClick={() => chooseType(t.id)}
              className={cn(
                "min-h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                report.type === t.id ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {report.type === "monthly" ? (
            <>
              <Label htmlFor="report-month" className="sr-only">
                Month
              </Label>
              <NativeSelect id="report-month" className="h-9 w-48" value={report.range.from.slice(0, 7)} onChange={(e) => set({ range: "custom", from: `${e.target.value}-${msd}`, to: `${e.target.value}-${msd}` })}>
                {(months.includes(report.range.from.slice(0, 7)) ? months : [report.range.from.slice(0, 7), ...months]).map((m) => (
                  <option key={m} value={m}>
                    {formatDate(`${m}-01`, "MMMM yyyy")}
                  </option>
                ))}
              </NativeSelect>
            </>
          ) : report.type === "yearly" ? (
            <>
              <Label htmlFor="report-year" className="sr-only">
                Year
              </Label>
              <NativeSelect id="report-year" className="h-9 w-32" value={report.range.from.slice(0, 4)} onChange={(e) => set({ range: "custom", from: `${e.target.value}-01-01`, to: `${e.target.value}-12-31` })}>
                {(years.includes(report.range.from.slice(0, 4)) ? years : [report.range.from.slice(0, 4), ...years]).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </NativeSelect>
            </>
          ) : (
            <RangePicker preset={range.preset} from={report.range.from} to={report.range.to} />
          )}
          {pending && <span className="text-[12.5px] text-muted-foreground">Updating…</span>}
        </div>
      </div>

      <article className={cn("grid gap-5 transition-opacity", pending && "opacity-60")} aria-labelledby="report-title">
        <header>
          <p className="print-only mb-1 hidden text-[12px] text-muted-foreground">{APP_NAME}</p>
          <h2 id="report-title" className="text-[20px] font-semibold tracking-tight">
            {report.title}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {report.subtitle} · amounts in {report.currency} · generated {formatDate(report.generatedOn)}
          </p>
        </header>

        {report.kpis.length > 0 && (
          <StatRow cols={report.kpis.length >= 5 ? 5 : report.kpis.length === 3 ? 3 : 4} className="report-card">
            {report.kpis.map((k) => (
              <StatTile key={k.label} label={k.label} value={cell(k.value, k.kind)} hint={k.hint} />
            ))}
          </StatRow>
        )}

        {report.chart && report.chart.points.length > 0 && <ReportChartView chart={report.chart} />}

        {report.tables.map((t) => (
          <ReportTableView key={t.id} t={t} />
        ))}

        {report.notes.length > 0 && (
          <Card className="report-card">
            <CardHeader>
              <CardTitle className="text-[14px] text-foreground">{report.type === "monthly" ? "Summary" : "Notes"}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid list-disc gap-1.5 pl-5 text-[13.5px]">
                {report.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
        <p className="no-print text-[12.5px] text-muted-foreground">
          Need everything? A full JSON backup is in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings
          </Link>
          .
        </p>
      </article>
    </div>
  );
}
