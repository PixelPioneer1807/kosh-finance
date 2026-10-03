import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, CircleAlert, CircleMinus } from "lucide-react";
import { requireAdminPage } from "@/server/auth/current";
import { getMetrics, getSystemHealth } from "@/server/services/admin";
import { getPreferences } from "@/server/services/preferences";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/menu";
import { adminFormatters } from "./format";

export const metadata: Metadata = { title: "Admin" };

type Tone = "ok" | "warn" | "off";

function HealthRow({ label, value, tone, hint }: { label: string; value: string; tone: Tone; hint?: string }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "warn" ? CircleAlert : CircleMinus;
  const badge = tone === "ok" ? "positive" : tone === "warn" ? "warning" : "outline";
  const word = tone === "ok" ? "OK" : tone === "warn" ? "Attention" : "Off";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
      </div>
      <span className="num text-[13px] text-muted-foreground">{value}</span>
      <Badge variant={badge}>
        <Icon aria-hidden />
        {word}
      </Badge>
    </li>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="num mt-1 text-2xl font-semibold tracking-tight">{value.toLocaleString()}</dd>
      {sub && <dd className="mt-0.5 text-[12.5px] text-muted-foreground">{sub}</dd>}
    </div>
  );
}

export default async function AdminOverviewPage() {
  const { user } = await requireAdminPage();
  const [health, m, prefs] = await Promise.all([getSystemHealth(user.id), getMetrics(user.id), getPreferences(user.id)]);
  const f = adminFormatters(prefs.locale, prefs.timezone);
  const cronAt = health.cron.lastRunAt ? new Date(health.cron.lastRunAt) : null;
  const maxWeek = Math.max(1, ...m.newUsersPerWeek.map((w) => w.count));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden lg:col-span-2">
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <span className="text-[12.5px] text-muted-foreground">Counts only — never amounts or anyone&apos;s details</span>
        </CardHeader>
        <dl className="grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Users" value={m.users.total} sub={`${m.users.active} active · ${m.users.disabled} disabled`} />
          <Stat label="Active, 7 days" value={m.users.active7d} sub={`${m.users.active30d} in 30 days`} />
          <Stat label="Signed-in sessions" value={m.sessions.active} />
          <Stat label="Transactions recorded" value={m.transactions.total} sub="Across all users" />
          <Stat label="AI requests today" value={m.ai.requestsToday} />
          <Stat label="Push devices" value={m.push.devices} sub={`${m.notifications.last24h} notifications in 24h`} />
        </dl>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System health</CardTitle>
        </CardHeader>
        <ul className="divide-y border-t">
          <HealthRow
            label="Database"
            tone={health.database.ok ? (health.database.latencyMs! > 250 ? "warn" : "ok") : "warn"}
            value={health.database.ok ? `${health.database.latencyMs} ms` : "Unreachable"}
          />
          <HealthRow
            label="Migrations"
            tone={health.migrations.applied ? "ok" : "warn"}
            value={health.migrations.applied === null ? "Unknown" : `${health.migrations.applied} applied`}
            hint={health.migrations.lastAppliedAt ? `Last applied ${f.date(new Date(health.migrations.lastAppliedAt))}` : undefined}
          />
          <HealthRow
            label="Scheduled jobs (cron)"
            tone={!health.cron.configured ? "warn" : health.cron.stale ? "warn" : "ok"}
            value={cronAt ? f.relative(cronAt) : "Never run"}
            hint={
              !health.cron.configured
                ? "Set CRON_SECRET to enable the scheduler."
                : health.cron.lastRunUsers !== null
                  ? `${health.cron.lastRunUsers} users processed${health.cron.lastRunErrors ? ` · ${health.cron.lastRunErrors} errors` : ""}`
                  : "Reminders still run when people open the app."
            }
          />
          <HealthRow label="AI assistant" tone={health.ai ? "ok" : "off"} value={health.ai ? "Configured" : "Not configured"} />
          <HealthRow label="Push notifications" tone={health.push ? "ok" : "off"} value={health.push ? "VAPID keys set" : "Not configured"} />
          <HealthRow
            label="Email delivery"
            tone={health.email ? "ok" : "off"}
            value={health.email ? "Configured" : "Not configured"}
            hint={health.email ? undefined : "Password-reset emails are logged, not sent. Use reset links from Users instead."}
          />
          <HealthRow label="Public app URL" tone={health.appUrl ? "ok" : "warn"} value={health.appUrl ? "Set" : "Using default"} hint={health.appUrl ? undefined : "Set APP_URL so invite and reset links point to this site."} />
        </ul>
      </Card>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>New users per week</CardTitle>
            <span className="num text-[12.5px] text-muted-foreground">{m.users.new7d} in the last 7 days</span>
          </CardHeader>
          <CardContent>
            <div className="flex h-28 items-end gap-0.5" aria-hidden>
              {m.newUsersPerWeek.map((w) => (
                <Tooltip key={w.week} content={`Week of ${f.date(new Date(`${w.week}T12:00:00Z`))}: ${w.count}`}>
                  <div className="group flex h-full flex-1 cursor-default items-end px-[3px]">
                    <div
                      className="w-full rounded-t-[4px] bg-[var(--series-1)] transition-opacity group-hover:opacity-80"
                      style={{ height: w.count ? `${Math.max(4, (w.count / maxWeek) * 100)}%` : "2px", opacity: w.count ? 1 : 0.35 }}
                    />
                  </div>
                </Tooltip>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between border-t pt-1.5 text-[11.5px] text-muted-foreground" aria-hidden>
              <span>{f.date(new Date(`${m.newUsersPerWeek[0]?.week}T12:00:00Z`))}</span>
              <span>This week</span>
            </div>
            <table className="sr-only">
              <caption>New users per week</caption>
              <thead>
                <tr>
                  <th scope="col">Week starting</th>
                  <th scope="col">New users</th>
                </tr>
              </thead>
              <tbody>
                {m.newUsersPerWeek.map((w) => (
                  <tr key={w.week}>
                    <td>{w.week}</td>
                    <td>{w.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invites</CardTitle>
            <Link href="/admin/invites" className="text-[13px] font-medium text-muted-foreground hover:text-foreground">
              Manage
            </Link>
          </CardHeader>
          <dl className="grid grid-cols-4 divide-x border-t">
            {(
              [
                ["Active", m.invites.active],
                ["Used", m.invites.used],
                ["Expired", m.invites.expired],
                ["Revoked", m.invites.revoked],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="px-4 py-3">
                <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
                <dd className="num mt-0.5 text-lg font-semibold">{n}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
