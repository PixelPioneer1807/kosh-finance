import type { Metadata } from "next";
import { requireAdminPage } from "@/server/auth/current";
import { INVITE_STATUSES, listInvites, type InviteStatus } from "@/server/services/admin";
import { getPreferences } from "@/server/services/preferences";
import { adminFormatters } from "../format";
import { InvitesView } from "./invites-view";

export const metadata: Metadata = { title: "Invites · Admin" };

export default async function AdminInvitesPage({ searchParams }: PageProps<"/admin/invites">) {
  const { user } = await requireAdminPage();
  const sp = await searchParams;
  const status = INVITE_STATUSES.find((s) => s === sp.status) as InviteStatus | undefined;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const [invites, prefs] = await Promise.all([listInvites(user.id, { status: status ?? "all", q }), getPreferences(user.id)]);
  const f = adminFormatters(prefs.locale, prefs.timezone);
  return (
    <InvitesView
      status={status ?? "all"}
      q={q}
      invites={invites.map((i) => ({
        id: i.id,
        codePrefix: i.codePrefix,
        label: i.label,
        email: i.email,
        role: i.role,
        maxUses: i.maxUses,
        useCount: i.useCount,
        status: i.status,
        createdByEmail: i.createdByEmail,
        expires: f.dateTime(i.expiresAt),
        expiresRelative: f.relative(i.expiresAt),
        created: f.date(i.createdAt),
      }))}
    />
  );
}
