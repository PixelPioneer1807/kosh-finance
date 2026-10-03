"use client";

/**
 * Dashboard insights widget.
 *
 * Usage (server component):
 *   const insights = await computeInsights(userId);            // src/server/services/insights.ts
 *   <InsightsWidget insights={insights} aiAvailable={prefs.aiEnabled && prefs.aiInsightsEnabled && aiConfigured()} />
 *
 * Props
 * - insights     Insight[] from computeInsights (serialisable; already sorted by severity).
 * - aiAvailable  Show the "Explain with AI" button (default false). The button sends ONLY the
 *                computed insights to the model and shows the reply labelled "AI interpretation".
 * - limit        How many insights to show before "Show all" (default 5).
 * - title        Card title (default "Insights").
 * - className    Extra classes for the card.
 */
import * as React from "react";
import Link from "next/link";
import { AlertOctagon, ChevronRight, CircleCheck, Info, Sparkles, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { Insight } from "@/server/services/insights";
import { explainInsightsAction } from "@/app/(app)/assistant/actions";

export type InsightsWidgetProps = {
  insights: Insight[];
  aiAvailable?: boolean;
  limit?: number;
  title?: string;
  className?: string;
};

const SEVERITY = {
  critical: { icon: AlertOctagon, cls: "bg-negative-soft text-negative", label: "Needs attention" },
  warning: { icon: TrendingUp, cls: "bg-warning-soft text-warning", label: "Heads up" },
  positive: { icon: CircleCheck, cls: "bg-positive-soft text-positive", label: "Good news" },
  info: { icon: Info, cls: "bg-muted text-muted-foreground", label: "Info" },
} as const;

const KIND_LABEL = { fact: "Fact", calculation: "Calculation", forecast: "Forecast" } as const;

export function InsightsWidget({ insights, aiAvailable = false, limit = 5, title = "Insights", className }: InsightsWidgetProps) {
  const [showAll, setShowAll] = React.useState(false);
  const [ai, setAi] = React.useState<{ text: string | null } | null>(null);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const shown = showAll ? insights : insights.slice(0, limit);

  const explain = () =>
    start(async () => {
      setAiError(null);
      const r = await explainInsightsAction({});
      if (r.ok) setAi({ text: r.data.text });
      else setAiError(r.error);
    });

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {aiAvailable && insights.length > 0 && (
          <Button size="sm" variant="ghost" className="-mt-1 -mr-2 h-8 text-accent" onClick={explain} loading={pending} disabled={pending}>
            {!pending && <Sparkles />}
            {ai ? "Explain again" : "Explain with AI"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-2">
        {insights.length === 0 ? (
          <EmptyState className="py-8" icon={<Sparkles />} title="No insights yet" description="As you add transactions, budgets and bills, notable changes will show up here." />
        ) : (
          <>
            {(ai || aiError || pending) && (
              <div className="mx-5 mb-3 rounded-lg border border-accent/25 bg-accent-soft/60 px-3.5 py-2.5" aria-live="polite">
                <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-accent uppercase">
                  <Sparkles className="size-3" /> AI interpretation
                </p>
                {pending ? (
                  <p className="text-[13.5px] text-muted-foreground">Reading your insights…</p>
                ) : aiError ? (
                  <p role="alert" className="text-[13.5px] text-negative">
                    {aiError}
                  </p>
                ) : (
                  <>
                    <p className="text-[13.5px] leading-relaxed">{ai?.text ?? "Nothing notable to summarise right now."}</p>
                    <p className="mt-1 text-[11.5px] text-muted-foreground">Written by AI from the facts below only — it can be wrong.</p>
                  </>
                )}
              </div>
            )}
            <ul className="divide-y">
              {shown.map((i) => {
                const s = SEVERITY[i.severity];
                const Icon = s.icon;
                const body = (
                  <>
                    <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", s.cls)}>
                      <Icon className="size-3.5" aria-hidden />
                      <span className="sr-only">{s.label}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-[14px] font-medium">{i.title}</span>
                        <Badge variant="outline" className={cn(i.kind === "forecast" && "border-dashed")}>
                          {KIND_LABEL[i.kind]}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block text-[13px] text-muted-foreground">{i.body}</span>
                    </span>
                    {i.link && <ChevronRight className="mt-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  </>
                );
                return (
                  <li key={i.id}>
                    {i.link ? (
                      <Link href={i.link} className="flex items-start gap-3 px-5 py-3 transition hover:bg-subtle">
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-start gap-3 px-5 py-3">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {insights.length > limit && (
              <div className="px-5 pt-1">
                <Button variant="link" size="sm" className="text-[13px] text-muted-foreground" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show fewer" : `Show all ${insights.length}`}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
