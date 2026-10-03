"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Lock, Send, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Progress } from "@/components/ui/misc";
import { updateAiPrefsAction } from "../actions";
import { SettingRow, SettingsSection } from "../section";

export function AiForm({
  configured,
  aiEnabled,
  aiInsightsEnabled,
  usage,
}: {
  configured: boolean;
  aiEnabled: boolean;
  aiInsightsEnabled: boolean;
  usage: { today: { requests: number; inputTokens: number; outputTokens: number }; dailyLimit: number; recent: { day: string; requests: number }[] };
}) {
  const [v, setV] = React.useState({ aiEnabled, aiInsightsEnabled });
  const [pending, start] = React.useTransition();

  function save(next: typeof v) {
    const prev = v;
    setV(next);
    start(async () => {
      const r = await updateAiPrefsAction(next);
      if (r.ok) toast.success(next.aiEnabled ? "AI preferences saved" : "AI features turned off");
      else {
        setV(prev);
        toast.error(r.error);
      }
    });
  }

  const pct = usage.dailyLimit > 0 ? usage.today.requests / usage.dailyLimit : 0;
  return (
    <div>
      {!configured && (
        <div role="status" className="mb-6 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>AI isn&apos;t configured on this server, so AI features are unavailable regardless of these settings. Everything else works without it.</p>
        </div>
      )}
      <SettingsSection id="ai" title="AI features" description="Optional. Kosh works fully without AI.">
        <Card className="divide-y">
          <SettingRow label="Enable AI" description="Natural-language entry, receipt understanding and the assistant." htmlFor="aiEnabled">
            <Switch id="aiEnabled" checked={v.aiEnabled} disabled={pending} onCheckedChange={(on) => save({ ...v, aiEnabled: on })} />
          </SettingRow>
          <SettingRow label="AI-written insights" description="Short summaries on your dashboard and monthly review. Off means only computed facts are shown." htmlFor="aiInsightsEnabled">
            <Switch id="aiInsightsEnabled" checked={v.aiEnabled && v.aiInsightsEnabled} disabled={pending || !v.aiEnabled} onCheckedChange={(on) => save({ ...v, aiInsightsEnabled: on })} />
          </SettingRow>
        </Card>
      </SettingsSection>

      <SettingsSection id="privacy" title="What's sent, and where" description="Your data is only sent when you use an AI feature.">
        <Card>
          <ul className="divide-y text-[13.5px]">
            <li className="flex gap-3 px-5 py-4">
              <Send className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p>
                Requests go from our server to <strong className="font-medium">Groq</strong>, which runs the language model. Your browser never talks to Groq directly and the API key never leaves the server.
              </p>
            </li>
            <li className="flex gap-3 px-5 py-4">
              <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p>
                Only what a request needs is sent: the text you typed (or text read from a receipt), your category and account <em>names</em>, today&apos;s date and currency, and — for the assistant and insights — the totals and transactions it looks up for your question. Your email, password and other users&apos; data are never sent.
              </p>
            </li>
            <li className="flex gap-3 px-5 py-4">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p>Nothing is changed without your confirmation: AI suggestions always come back to you as a draft or a proposed action.</p>
            </li>
          </ul>
        </Card>
      </SettingsSection>

      <SettingsSection id="usage" title="Today's usage">
        <Card className="p-5">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="text-sm">
              <span className="num text-[22px] font-semibold tracking-tight">{usage.today.requests.toLocaleString()}</span>
              <span className="text-muted-foreground"> of {usage.dailyLimit.toLocaleString()} requests</span>
            </p>
            <p className="num text-[12.5px] text-muted-foreground">
              {(usage.today.inputTokens + usage.today.outputTokens).toLocaleString()} tokens
            </p>
          </div>
          <Progress value={pct} tone={pct >= 0.9 ? "warning" : "default"} label="AI requests used today" />
          <p className="mt-2 text-[12.5px] text-muted-foreground">The daily limit resets at midnight (server time).</p>
          {usage.recent.length > 1 && (
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Last {usage.recent.length} active days: {usage.recent.reduce((n, r) => n + r.requests, 0).toLocaleString()} requests.
            </p>
          )}
        </Card>
      </SettingsSection>
    </div>
  );
}
