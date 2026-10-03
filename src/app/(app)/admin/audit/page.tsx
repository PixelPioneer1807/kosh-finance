import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { requireAdminPage } from "@/server/auth/current";
import { AUDIT_CATEGORIES, listAuditLogs, type AuditCategory } from "@/server/services/admin";
import { getPreferences } from "@/server/services/preferences";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { adminFormatters } from "../format";

export const metadata: Metadata = { title: "Audit log · Admin" };

const LABELS: Record<string, { label: string; tone: "default" | "warning" | "negative" | "positive" | "info" }> = {
  "user.registered": { label: "Registered", tone: "positive" },
  "user.locked": { label: "Locked after failed sign-ins", tone: "warning" },
  "user.password_reset": { label: "Reset password", tone: "info" },
  "user.password_changed": { label: "Changed password", tone: "info" },
  "user.deleted_self": { label: "Deleted own account", tone: "negative" },
  "admin.invite_created": { label: "Created invite", tone: "default" },
  "admin.invite_revoked": { label: "Revoked invite", tone: "warning" },
  "admin.user_disabled": { label: "Disabled user", tone: "negative" },
  "admin.user_reactivated": { label: "Reactivated user", tone: "positive" },
  "admin.role_changed": { label: "Changed role", tone: "warning" },
  "admin.reset_link_created": { label: "Created reset link", tone: "warning" },
  "cron.tick": { label: "Scheduled run", tone: "default" },
};

const CATEGORY_LABEL: Record<AuditCategory, string> = { security: "All events", admin: "Admin actions", auth: "Account events", system: "System" };

/** Compact, non-sensitive rendering of an event's metadata. */
function describeMeta(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined || typeof v === "object") continue;
    if (/id$/i.test(k)) continue; // internal ids aren't useful to read
    parts.push(`${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${String(v)}`);
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join(" · ") : null;
}

export default async function AdminAuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const { user } = await requireAdminPage();
  const sp = await searchParams;
  const category = AUDIT_CATEGORIES.find((c) => c === sp.category) ?? "security";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(typeof sp.page === "string" ? sp.page : "1", 10) || 1));
  const [{ rows, hasMore }, prefs] = await Promise.all([listAuditLogs(user.id, { category, page, pageSize: 50 }), getPreferences(user.id)]);
  const f = adminFormatters(prefs.locale, prefs.timezone);
  const href = (patch: { category?: AuditCategory; page?: number }) => {
    const p = new URLSearchParams();
    const c = patch.category ?? category;
    if (c !== "security") p.set("category", c);
    const pg = patch.page ?? 1;
    if (pg > 1) p.set("page", String(pg));
    return `/admin/audit${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <nav aria-label="Event type" className="scrollbar-none -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {AUDIT_CATEGORIES.map((c) => (
            <li key={c}>
              <Link
                href={href({ category: c })}
                aria-current={c === category ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground hover:text-foreground",
                  c === category && "bg-card text-foreground shadow-xs",
                )}
              >
                {CATEGORY_LABEL[c]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<ScrollText />} title="No events" description={page > 1 ? "You've reached the end of the log." : "Security-relevant events will be recorded here."} />
        ) : (
          <ol className="divide-y">
            {rows.map((r) => {
              const l = LABELS[r.action] ?? { label: r.action, tone: "default" as const };
              const details = describeMeta(r.meta);
              return (
                <li key={r.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <time dateTime={r.createdAt.toISOString()} className="num shrink-0 text-[13px] text-muted-foreground sm:w-44">
                    {f.dateTime(r.createdAt)}
                  </time>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <Badge variant={l.tone}>{l.label}</Badge>
                      {r.actorEmail ? <span className="font-medium">{r.actorEmail}</span> : <span className="text-muted-foreground">System</span>}
                      {r.targetEmail && r.targetEmail !== r.actorEmail && (
                        <>
                          <span className="text-muted-foreground" aria-label="on">→</span>
                          <span>{r.targetEmail}</span>
                        </>
                      )}
                    </p>
                    {(details || r.ipAddress) && (
                      <p className="mt-1 text-[12.5px] break-words text-muted-foreground">
                        {details}
                        {details && r.ipAddress ? " · " : ""}
                        {r.ipAddress && `IP ${r.ipAddress}`}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {(page > 1 || hasMore) && (
        <nav aria-label="Pagination" className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={href({ page: page - 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ChevronLeft /> Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="num text-[13px] text-muted-foreground">Page {page}</span>
          {hasMore ? (
            <Link href={href({ page: page + 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Older <ChevronRight />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
