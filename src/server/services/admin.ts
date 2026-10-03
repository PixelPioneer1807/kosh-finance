/**
 * Administration: system health, aggregate metrics, invitations, user accounts and the audit log.
 *
 * Security model
 * - Every function takes the acting user's id first and re-checks in the database that the actor is
 *   an *active admin* (`assertAdmin`) — the session's role is never trusted on its own.
 * - Admins never see users' financial data: metrics are system-wide COUNTs only, and user listings
 *   expose account metadata (email, role, status, dates), nothing from financial tables.
 * - Role/status changes lock the set of active admins, so concurrent changes can't remove the last one.
 * - Every mutation writes an audit_logs row.
 */
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type DbOrTx, type Tx } from "@/server/db";
import { auditLogs, invitations, sessions, users } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { generateInviteCode, hashInviteCode } from "@/server/auth/tokens";
import { appUrl } from "@/server/mailer";
import { optionalText } from "@/lib/validation";
import { createPasswordResetLink } from "./auth";
import { pushConfigured } from "./push";
import { lastCronRun } from "./cron";

type Meta = { ip?: string | null };

/* ───────────── Guard ───────────── */

/** Throws FORBIDDEN unless `actorId` is an active admin right now (checked in the DB). */
export async function assertAdmin(actorId: string, dbx: DbOrTx = db) {
  const [u] = await dbx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, actorId)).limit(1);
  if (!u || u.role !== "admin" || u.status !== "active") throw new AppError("FORBIDDEN", "Admins only.");
}

async function audit(dbx: DbOrTx, actorId: string, action: string, targetUserId: string | null, meta: Record<string, unknown> | null, m: Meta) {
  await dbx.insert(auditLogs).values({ actorId, targetUserId, action, meta, ipAddress: m.ip ?? null });
}

/** Lock every active admin row (consistent order) so admin-count checks are race-free. */
async function lockActiveAdmins(tx: Tx) {
  const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE`);
  return new Set([...rows].map((r) => r.id));
}

/* ───────────── Health & metrics ───────────── */

export type SystemHealth = {
  database: { ok: boolean; latencyMs: number | null };
  migrations: { applied: number | null; lastAppliedAt: string | null };
  ai: boolean;
  push: boolean;
  email: boolean;
  appUrl: boolean;
  /** `stale`: no run in the last 36 hours (daily cron missed). */
  cron: { configured: boolean; lastRunAt: string | null; stale: boolean; lastRunUsers: number | null; lastRunErrors: number | null };
};

export async function getSystemHealth(actorId: string): Promise<SystemHealth> {
  await assertAdmin(actorId);
  let latencyMs: number | null = null;
  let ok = false;
  try {
    const t0 = performance.now();
    await db.execute(sql`SELECT 1`);
    latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    ok = true;
  } catch {
    ok = false;
  }
  let applied: number | null = null;
  let lastAppliedAt: string | null = null;
  try {
    const rows = await db.execute<{ n: number; last: string | null }>(
      sql`SELECT count(*)::int AS n, max(created_at)::text AS last FROM drizzle.__drizzle_migrations`,
    );
    applied = Number(rows[0]?.n ?? 0);
    lastAppliedAt = rows[0]?.last ? new Date(Number(rows[0].last)).toISOString() : null;
  } catch {
    applied = null;
  }
  const cron = await lastCronRun().catch(() => null);
  const cronMeta = (cron?.meta ?? {}) as { users?: number; errors?: number };
  return {
    database: { ok, latencyMs },
    migrations: { applied, lastAppliedAt },
    ai: Boolean(process.env.GROQ_API_KEY),
    push: pushConfigured(),
    email: Boolean(process.env.RESEND_API_KEY),
    appUrl: Boolean(process.env.APP_URL),
    cron: {
      configured: Boolean(process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 16),
      lastRunAt: cron?.at.toISOString() ?? null,
      stale: !cron || Date.now() - cron.at.getTime() > 36 * 3600_000,
      lastRunUsers: typeof cronMeta.users === "number" ? cronMeta.users : null,
      lastRunErrors: typeof cronMeta.errors === "number" ? cronMeta.errors : null,
    },
  };
}

/** Aggregate COUNTs only — no amounts, no per-user financial details. */
export type SystemMetrics = {
  users: { total: number; active: number; disabled: number; admins: number; active7d: number; active30d: number; new7d: number };
  newUsersPerWeek: { week: string; count: number }[];
  sessions: { active: number };
  invites: { active: number; used: number; expired: number; revoked: number };
  transactions: { total: number };
  ai: { requestsToday: number };
  push: { devices: number };
  notifications: { last24h: number };
};

export async function getMetrics(actorId: string): Promise<SystemMetrics> {
  await assertAdmin(actorId);
  const [m] = await db.execute<Record<string, number>>(sql`
    SELECT
      (SELECT count(*) FROM users)::int AS total_users,
      (SELECT count(*) FROM users WHERE status = 'active')::int AS active_users,
      (SELECT count(*) FROM users WHERE status = 'disabled')::int AS disabled_users,
      (SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active')::int AS admins,
      (SELECT count(*) FROM users WHERE last_active_at > now() - interval '7 days')::int AS active_7d,
      (SELECT count(*) FROM users WHERE last_active_at > now() - interval '30 days')::int AS active_30d,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_7d,
      (SELECT count(*) FROM sessions WHERE expires_at > now())::int AS active_sessions,
      (SELECT count(*) FROM transactions WHERE deleted_at IS NULL)::int AS total_transactions,
      (SELECT coalesce(sum(requests), 0) FROM ai_usage WHERE day = current_date)::int AS ai_today,
      (SELECT count(*) FROM push_subscriptions)::int AS push_devices,
      (SELECT count(*) FROM notifications WHERE created_at > now() - interval '24 hours')::int AS notifications_24h,
      (SELECT count(*) FROM invitations WHERE status = 'revoked')::int AS inv_revoked,
      (SELECT count(*) FROM invitations WHERE status = 'active' AND use_count >= max_uses)::int AS inv_used,
      (SELECT count(*) FROM invitations WHERE status = 'active' AND use_count < max_uses AND expires_at <= now())::int AS inv_expired,
      (SELECT count(*) FROM invitations WHERE status = 'active' AND use_count < max_uses AND expires_at > now())::int AS inv_active`);
  const weeks = await db.execute<{ week: string; n: number }>(sql`
    SELECT to_char(w, 'YYYY-MM-DD') AS week, count(u.id)::int AS n
    FROM generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS w
    LEFT JOIN users u ON date_trunc('week', u.created_at) = w
    GROUP BY w ORDER BY w`);
  const n = (k: string) => Number(m?.[k] ?? 0);
  return {
    users: {
      total: n("total_users"),
      active: n("active_users"),
      disabled: n("disabled_users"),
      admins: n("admins"),
      active7d: n("active_7d"),
      active30d: n("active_30d"),
      new7d: n("new_7d"),
    },
    newUsersPerWeek: [...weeks].map((w) => ({ week: w.week, count: Number(w.n) })),
    sessions: { active: n("active_sessions") },
    invites: { active: n("inv_active"), used: n("inv_used"), expired: n("inv_expired"), revoked: n("inv_revoked") },
    transactions: { total: n("total_transactions") },
    ai: { requestsToday: n("ai_today") },
    push: { devices: n("push_devices") },
    notifications: { last24h: n("notifications_24h") },
  };
}

/* ───────────── Invitations ───────────── */

export type InviteStatus = "active" | "expired" | "used" | "revoked";
export const INVITE_STATUSES: InviteStatus[] = ["active", "used", "expired", "revoked"];

/** Effective status: revoked beats used beats expired. */
export function inviteStatus(inv: { status: "active" | "revoked"; useCount: number; maxUses: number; expiresAt: Date }, now = new Date()): InviteStatus {
  if (inv.status === "revoked") return "revoked";
  if (inv.useCount >= inv.maxUses) return "used";
  if (inv.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export const inviteInput = z.object({
  expiresInDays: z.coerce.number().int().min(1, "At least 1 day").max(365, "At most 365 days").default(7),
  maxUses: z.coerce.number().int().min(1, "At least 1 use").max(500, "At most 500 uses").default(1),
  email: z
    .union([z.literal(""), z.null(), z.string().trim().toLowerCase().pipe(z.email({ message: "Enter a valid email address" }))])
    .optional()
    .transform((v) => v || null),
  label: optionalText(60),
  role: z.enum(["user", "admin"]).default("user"),
});
export type InviteInput = z.input<typeof inviteInput>;

export async function createInvite(actorId: string, raw: InviteInput, meta: Meta = {}) {
  await assertAdmin(actorId);
  const input = inviteInput.parse(raw);
  if (input.email) {
    const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email}`).limit(1);
    if (exists) throw new AppError("VALIDATION", "Someone with that email already has an account.", { email: ["Already registered"] });
  }
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  const row = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(invitations)
      .values({
        codeHash: hashInviteCode(code),
        codePrefix: code.slice(0, 4),
        label: input.label,
        email: input.email,
        maxUses: input.maxUses,
        expiresAt,
        role: input.role,
        createdById: actorId,
      })
      .returning();
    await audit(tx, actorId, "admin.invite_created", null, { invitationId: inv.id, role: inv.role, maxUses: inv.maxUses, expiresInDays: input.expiresInDays, emailRestricted: Boolean(inv.email) }, meta);
    return inv;
  });
  // The plaintext code is returned exactly once; only its hash is stored.
  return { id: row.id, code, link: `${appUrl()}/register?code=${encodeURIComponent(code)}`, expiresAt: row.expiresAt, role: row.role, maxUses: row.maxUses };
}

export async function revokeInvite(actorId: string, invitationId: string, meta: Meta = {}) {
  await assertAdmin(actorId);
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.id, invitationId)).for("update").limit(1);
    if (!inv) throw notFound("Invite");
    if (inv.status === "revoked") return { alreadyRevoked: true };
    await tx.update(invitations).set({ status: "revoked", revokedAt: new Date() }).where(eq(invitations.id, invitationId));
    await audit(tx, actorId, "admin.invite_revoked", null, { invitationId, uses: inv.useCount }, meta);
    return { alreadyRevoked: false };
  });
}

export type AdminInvite = {
  id: string;
  codePrefix: string;
  label: string | null;
  email: string | null;
  role: "user" | "admin";
  maxUses: number;
  useCount: number;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  createdByEmail: string | null;
  status: InviteStatus;
};

export async function listInvites(actorId: string, opts: { status?: InviteStatus | "all"; q?: string } = {}): Promise<AdminInvite[]> {
  await assertAdmin(actorId);
  const creator = alias(users, "creator");
  const q = opts.q?.trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db
    .select({
      id: invitations.id,
      codePrefix: invitations.codePrefix,
      label: invitations.label,
      email: invitations.email,
      role: invitations.role,
      maxUses: invitations.maxUses,
      useCount: invitations.useCount,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      revokedAt: invitations.revokedAt,
      status: invitations.status,
      createdByEmail: creator.email,
    })
    .from(invitations)
    .leftJoin(creator, eq(creator.id, invitations.createdById))
    .where(like ? or(ilike(invitations.label, like), ilike(invitations.email, like), ilike(invitations.codePrefix, like)) : undefined)
    .orderBy(desc(invitations.createdAt))
    .limit(500);
  const now = new Date();
  return rows
    .map((r) => ({ ...r, status: inviteStatus(r, now) }))
    .filter((r) => !opts.status || opts.status === "all" || r.status === opts.status);
}

/* ───────────── Users ───────────── */

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: Date;
  lastActiveAt: Date | null;
  lastLoginAt: Date | null;
  locked: boolean;
  activeSessions: number;
};

export async function listUsers(
  actorId: string,
  opts: { q?: string; status?: "active" | "disabled"; role?: "user" | "admin"; limit?: number; offset?: number } = {},
): Promise<{ rows: AdminUserRow[]; total: number }> {
  await assertAdmin(actorId);
  const q = opts.q?.trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where: SQL | undefined = and(
    like ? or(ilike(users.email, like), ilike(users.name, like)) : undefined,
    opts.status ? eq(users.status, opts.status) : undefined,
    opts.role ? eq(users.role, opts.role) : undefined,
  );
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        createdAt: users.createdAt,
        lastActiveAt: users.lastActiveAt,
        lastLoginAt: users.lastLoginAt,
        locked: sql<boolean>`coalesce(${users.lockedUntil} > now(), false)`,
        activeSessions: sql<number>`(SELECT count(*) FROM sessions s WHERE s.user_id = "users"."id" AND s.expires_at > now())::int`,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(Math.max(opts.offset ?? 0, 0)),
    db.select({ total: sql<number>`count(*)::int` }).from(users).where(where),
  ]);
  return { rows, total };
}

export async function setUserStatus(actorId: string, targetId: string, status: "active" | "disabled", meta: Meta = {}) {
  if (actorId === targetId && status === "disabled") throw new AppError("VALIDATION", "You can't disable your own account.");
  return db.transaction(async (tx) => {
    const admins = await lockActiveAdmins(tx);
    if (!admins.has(actorId)) throw new AppError("FORBIDDEN", "Admins only.");
    const [target] = await tx.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, targetId)).for("update").limit(1);
    if (!target) throw notFound("User");
    if (target.status === status) return { changed: false };
    if (status === "disabled" && admins.has(targetId) && admins.size <= 1)
      throw new AppError("VALIDATION", "You can't disable the last active admin.");
    await tx
      .update(users)
      .set(status === "active" ? { status, failedLoginCount: 0, lockedUntil: null } : { status })
      .where(eq(users.id, targetId));
    let sessionsRevoked = 0;
    if (status === "disabled") {
      const del = await tx.delete(sessions).where(eq(sessions.userId, targetId)).returning({ id: sessions.id });
      sessionsRevoked = del.length;
    }
    await audit(tx, actorId, status === "disabled" ? "admin.user_disabled" : "admin.user_reactivated", targetId, status === "disabled" ? { sessionsRevoked } : null, meta);
    return { changed: true };
  });
}

export async function setUserRole(actorId: string, targetId: string, role: "user" | "admin", meta: Meta = {}) {
  if (actorId === targetId && role !== "admin") throw new AppError("VALIDATION", "You can't remove your own admin role. Ask another admin to do it.");
  return db.transaction(async (tx) => {
    const admins = await lockActiveAdmins(tx);
    if (!admins.has(actorId)) throw new AppError("FORBIDDEN", "Admins only.");
    const [target] = await tx.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, targetId)).for("update").limit(1);
    if (!target) throw notFound("User");
    if (target.role === role) return { changed: false };
    if (role === "user" && admins.has(targetId) && admins.size <= 1) throw new AppError("VALIDATION", "There must always be at least one active admin.");
    await tx.update(users).set({ role }).where(eq(users.id, targetId));
    await audit(tx, actorId, "admin.role_changed", targetId, { from: target.role, to: role }, meta);
    return { changed: true };
  });
}

/** One-time password reset link for a user who can't use email. Shown once to the admin. */
export async function adminCreateResetLink(actorId: string, targetId: string, meta: Meta = {}) {
  await assertAdmin(actorId);
  const [target] = await db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, targetId)).limit(1);
  if (!target) throw notFound("User");
  if (target.status !== "active") throw new AppError("VALIDATION", "Reactivate this account before creating a reset link.");
  const link = await createPasswordResetLink(targetId);
  await audit(db, actorId, "admin.reset_link_created", targetId, null, meta);
  return { link, expiresInMinutes: 60 };
}

/* ───────────── Audit log ───────────── */

export const AUDIT_CATEGORIES = ["security", "admin", "auth", "system"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export type AuditRow = {
  id: string;
  action: string;
  createdAt: Date;
  ipAddress: string | null;
  actorEmail: string | null;
  targetEmail: string | null;
  meta: Record<string, unknown> | null;
};

export async function listAuditLogs(
  actorId: string,
  opts: { page?: number; pageSize?: number; category?: AuditCategory } = {},
): Promise<{ rows: AuditRow[]; page: number; hasMore: boolean }> {
  await assertAdmin(actorId);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const actor = alias(users, "actor");
  const target = alias(users, "target");
  const filter: Record<AuditCategory, SQL> = {
    security: sql`${auditLogs.action} NOT LIKE 'cron.%'`,
    admin: sql`${auditLogs.action} LIKE 'admin.%'`,
    auth: sql`${auditLogs.action} LIKE 'user.%'`,
    system: sql`${auditLogs.action} LIKE 'cron.%'`,
  };
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      ipAddress: auditLogs.ipAddress,
      actorEmail: actor.email,
      targetEmail: target.email,
      meta: auditLogs.meta,
    })
    .from(auditLogs)
    .leftJoin(actor, eq(actor.id, auditLogs.actorId))
    .leftJoin(target, eq(target.id, auditLogs.targetUserId))
    .where(filter[opts.category ?? "security"])
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);
  return { rows: rows.slice(0, pageSize), page, hasMore: rows.length > pageSize };
}

