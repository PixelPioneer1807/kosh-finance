import type { Metadata } from "next";
import { requireAdminPage } from "@/server/auth/current";
import { listUsers } from "@/server/services/admin";
import { getPreferences } from "@/server/services/preferences";
import { adminFormatters } from "../format";
import { UsersView } from "./users-view";

export const metadata: Metadata = { title: "Users · Admin" };

const PAGE_SIZE = 50;

export default async function AdminUsersPage({ searchParams }: PageProps<"/admin/users">) {
  const { user } = await requireAdminPage();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const q = str("q")?.slice(0, 100) ?? "";
  const filter = (["active", "disabled", "admins"] as const).find((f) => f === str("filter")) ?? "all";
  const page = Math.max(1, Math.min(1000, Number.parseInt(str("page") ?? "1", 10) || 1));
  const [{ rows, total }, prefs] = await Promise.all([
    listUsers(user.id, {
      q,
      status: filter === "active" || filter === "disabled" ? filter : undefined,
      role: filter === "admins" ? "admin" : undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getPreferences(user.id),
  ]);
  const f = adminFormatters(prefs.locale, prefs.timezone);
  return (
    <UsersView
      currentUserId={user.id}
      q={q}
      filter={filter}
      page={page}
      pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))}
      total={total}
      users={rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        locked: u.locked,
        activeSessions: u.activeSessions,
        joined: f.date(u.createdAt),
        lastActive: f.relative(u.lastActiveAt),
        lastActiveExact: f.dateTime(u.lastActiveAt),
      }))}
    />
  );
}
