import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db";
import { auditLogs, invitations, sessions, users } from "@/server/db/schema";
import {
  adminCreateResetLink,
  assertAdmin,
  createInvite,
  getMetrics,
  getSystemHealth,
  inviteStatus,
  listAuditLogs,
  listInvites,
  listUsers,
  revokeInvite,
  setUserRole,
  setUserStatus,
} from "@/server/services/admin";
import { checkInvite, login, registerWithInvite, resetPassword } from "@/server/services/auth";
import { validateSessionToken } from "@/server/auth/sessions";
import { createTransaction } from "@/server/services/transactions";
import { makeAccount, makeUser, PASSWORD } from "./helpers";
import { randomUUID } from "node:crypto";

let admin: Awaited<ReturnType<typeof makeUser>>;
let regular: Awaited<ReturnType<typeof makeUser>>;
const ip = () => randomUUID();
const email = () => `adm-${randomUUID().slice(0, 8)}@example.com`;

beforeAll(async () => {
  admin = await makeUser({ role: "admin" });
  regular = await makeUser();
});

const auditFor = (actorId: string, action: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.actorId, actorId), eq(auditLogs.action, action)));

describe("admin guard", () => {
  it("rejects non-admins on every admin operation", async () => {
    const id = regular.id;
    const calls: (() => Promise<unknown>)[] = [
      () => assertAdmin(id),
      () => getSystemHealth(id),
      () => getMetrics(id),
      () => listInvites(id),
      () => createInvite(id, { expiresInDays: 7, maxUses: 1 }),
      () => revokeInvite(id, randomUUID()),
      () => listUsers(id),
      () => setUserStatus(id, admin.id, "disabled"),
      () => setUserRole(id, id, "admin"),
      () => adminCreateResetLink(id, admin.id),
      () => listAuditLogs(id),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The non-admin couldn't promote themselves.
    const [me] = await db.select({ role: users.role }).from(users).where(eq(users.id, id));
    expect(me.role).toBe("user");
  });

  it("rejects a disabled admin and unknown ids", async () => {
    const a = await makeUser({ role: "admin" });
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, a.id));
    await expect(getMetrics(a.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createInvite(a.id, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertAdmin(randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("invites", () => {
  it("derives status: revoked > used > expired > active", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const future = new Date("2026-10-10T00:00:00Z");
    const past = new Date("2026-10-01T00:00:00Z");
    expect(inviteStatus({ status: "active", useCount: 0, maxUses: 1, expiresAt: future }, now)).toBe("active");
    expect(inviteStatus({ status: "active", useCount: 0, maxUses: 1, expiresAt: past }, now)).toBe("expired");
    expect(inviteStatus({ status: "active", useCount: 1, maxUses: 1, expiresAt: past }, now)).toBe("used");
    expect(inviteStatus({ status: "revoked", useCount: 1, maxUses: 1, expiresAt: future }, now)).toBe("revoked");
    expect(inviteStatus({ status: "active", useCount: 2, maxUses: 5, expiresAt: future }, now)).toBe("active");
  });

  it("creates an invite whose code works, stores only a hash, and audits it", async () => {
    const r = await createInvite(admin.id, { expiresInDays: 3, maxUses: 2, label: "Friend" }, { ip: "10.0.0.1" });
    expect(r.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.link).toContain(`/register?code=${encodeURIComponent(r.code)}`);
    expect(await checkInvite(r.code)).toBe("valid");
    const [row] = await db.select().from(invitations).where(eq(invitations.id, r.id));
    expect(JSON.stringify(row)).not.toContain(r.code.replace(/-/g, ""));
    expect(row.createdById).toBe(admin.id);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
    const listed = await listInvites(admin.id, { status: "active" });
    const mine = listed.find((i) => i.id === r.id)!;
    expect(mine).toMatchObject({ status: "active", maxUses: 2, useCount: 0, label: "Friend", createdByEmail: admin.email });
    const logs = await auditFor(admin.id, "admin.invite_created");
    expect(logs.some((l) => l.meta?.invitationId === r.id && l.ipAddress === "10.0.0.1")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(r.code);
  });

  it("revoking stops the code working and shows as revoked", async () => {
    const r = await createInvite(admin.id, { expiresInDays: 7 });
    expect((await revokeInvite(admin.id, r.id)).alreadyRevoked).toBe(false);
    expect((await revokeInvite(admin.id, r.id)).alreadyRevoked).toBe(true);
    expect(await checkInvite(r.code)).toBe("revoked");
    await expect(registerWithInvite({ inviteCode: r.code, email: email(), password: PASSWORD }, { ip: ip() })).rejects.toThrow(/revoked/);
    expect((await listInvites(admin.id, { status: "revoked" })).map((i) => i.id)).toContain(r.id);
    expect((await listInvites(admin.id, { status: "active" })).map((i) => i.id)).not.toContain(r.id);
    expect((await auditFor(admin.id, "admin.invite_revoked")).some((l) => l.meta?.invitationId === r.id)).toBe(true);
  });

  it("supports email restriction and admin role invites", async () => {
    const target = email();
    const r = await createInvite(admin.id, { email: target.toUpperCase(), role: "admin", maxUses: 1 });
    await expect(registerWithInvite({ inviteCode: r.code, email: email(), password: PASSWORD }, { ip: ip() })).rejects.toThrow(/different email/);
    const u = await registerWithInvite({ inviteCode: r.code, email: target, password: PASSWORD }, { ip: ip() });
    expect(u.role).toBe("admin");
    expect((await listInvites(admin.id, { status: "used" })).map((i) => i.id)).toContain(r.id);
  });

  it("validates input and refuses invites for existing accounts", async () => {
    await expect(createInvite(admin.id, { expiresInDays: 0 })).rejects.toThrow();
    await expect(createInvite(admin.id, { maxUses: 10_000 })).rejects.toThrow();
    await expect(createInvite(admin.id, { email: "not-an-email" })).rejects.toThrow();
    await expect(createInvite(admin.id, { email: regular.email })).rejects.toThrow(/already has an account/);
  });
});

describe("user management", () => {
  it("disabling kills sessions and blocks login; reactivating restores access", async () => {
    const u = await makeUser();
    const { token } = await login({ email: u.email, password: PASSWORD }, { ip: ip() });
    expect(await validateSessionToken(token)).not.toBeNull();
    expect((await setUserStatus(admin.id, u.id, "disabled", { ip: "10.0.0.2" })).changed).toBe(true);
    expect(await validateSessionToken(token)).toBeNull();
    const left = await db.select().from(sessions).where(eq(sessions.userId, u.id));
    expect(left).toHaveLength(0);
    await expect(login({ email: u.email, password: PASSWORD }, { ip: ip() })).rejects.toThrow(/disabled/);
    const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.targetUserId, u.id), eq(auditLogs.action, "admin.user_disabled")));
    expect(log).toMatchObject({ actorId: admin.id, ipAddress: "10.0.0.2" });
    expect(log.meta).toMatchObject({ sessionsRevoked: 1 });

    expect((await setUserStatus(admin.id, u.id, "active")).changed).toBe(true);
    await expect(login({ email: u.email, password: PASSWORD }, { ip: ip() })).resolves.toBeTruthy();
    expect(await auditFor(admin.id, "admin.user_reactivated")).not.toHaveLength(0);
  });

  it("prevents self-disable and self-demotion (lockout)", async () => {
    await expect(setUserStatus(admin.id, admin.id, "disabled")).rejects.toThrow(/your own account/);
    await expect(setUserRole(admin.id, admin.id, "user")).rejects.toThrow(/your own admin role/);
    await assertAdmin(admin.id);
  });

  it("promotes and demotes other users with an audit trail", async () => {
    const u = await makeUser();
    await setUserRole(admin.id, u.id, "admin");
    await assertAdmin(u.id);
    await setUserRole(admin.id, u.id, "user");
    await expect(assertAdmin(u.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.targetUserId, u.id), eq(auditLogs.action, "admin.role_changed")));
    expect(logs.map((l) => l.meta?.to).sort()).toEqual(["admin", "user"]);
  });

  it("two admins demoting each other at once can never leave zero admins", async () => {
    const a = await makeUser({ role: "admin" });
    const b = await makeUser({ role: "admin" });
    const results = await Promise.allSettled([setUserRole(a.id, b.id, "user"), setUserRole(b.id, a.id, "user")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.select({ role: users.role }).from(users).where(inArray(users.id, [a.id, b.id]));
    expect(rows.filter((r) => r.role === "admin")).toHaveLength(1);
  });

  it("creates a single-use reset link for an active user", async () => {
    const u = await makeUser();
    const { link } = await adminCreateResetLink(admin.id, u.id);
    const token = new URL(link).searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(20);
    await resetPassword(token, "Another-Strong-77", { ip: ip() });
    await expect(login({ email: u.email, password: "Another-Strong-77" }, { ip: ip() })).resolves.toBeTruthy();
    await expect(resetPassword(token, "Third-Strong-88", { ip: ip() })).rejects.toThrow(/invalid or has expired/);
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.targetUserId, u.id), eq(auditLogs.action, "admin.reset_link_created")));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(token);

    await setUserStatus(admin.id, u.id, "disabled");
    await expect(adminCreateResetLink(admin.id, u.id)).rejects.toThrow(/Reactivate/);
  });

  it("lists and searches users without exposing financial data", async () => {
    const { rows, total } = await listUsers(admin.id, { q: regular.email });
    expect(total).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["activeSessions", "createdAt", "email", "id", "lastActiveAt", "lastLoginAt", "locked", "name", "role", "status"]);
    // LIKE wildcards in the search are treated literally.
    expect((await listUsers(admin.id, { q: "%" })).total).toBe(0);
    const admins = await listUsers(admin.id, { role: "admin", limit: 200 });
    expect(admins.rows.every((r) => r.role === "admin")).toBe(true);
  });
});

describe("metrics and health", () => {
  it("are aggregate counts only — never amounts or anyone's details", async () => {
    const acc = await makeAccount(regular.id);
    await createTransaction(regular.id, { type: "expense", accountId: acc.id, amount: "987654.3210", date: "2026-10-01", merchant: "ZebraSecretShop", notes: "very private" });
    const m = await getMetrics(admin.id);
    const h = await getSystemHealth(admin.id);
    const text = JSON.stringify({ m, h });
    for (const needle of ["987654", "ZebraSecretShop", "very private", regular.email, "USD"]) expect(text).not.toContain(needle);
    for (const secret of [process.env.CRON_SECRET, process.env.VAPID_PRIVATE_KEY, process.env.GROQ_API_KEY, process.env.DATABASE_URL]) {
      if (secret) expect(text).not.toContain(secret);
    }
    // Every metric leaf is a count (weeks are labelled by date only).
    const leaves: unknown[] = [];
    const walk = (v: unknown, key = "") => {
      if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
      else if (key !== "week") leaves.push(v);
    };
    walk(m);
    expect(leaves.every((v) => Number.isInteger(v) && (v as number) >= 0)).toBe(true);
    expect(m.transactions.total).toBeGreaterThanOrEqual(1);
    expect(m.newUsersPerWeek).toHaveLength(8);
    expect(m.users.admins).toBeGreaterThanOrEqual(1);
    expect(h.database.ok).toBe(true);
    expect(h.migrations.applied).toBeGreaterThanOrEqual(1);
  });
});

describe("audit log", () => {
  it("paginates and filters by category", async () => {
    const first = await listAuditLogs(admin.id, { pageSize: 2, page: 1 });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await listAuditLogs(admin.id, { pageSize: 2, page: 2 });
    expect(second.rows.map((r) => r.id)).not.toContain(first.rows[0].id);
    const adminOnly = await listAuditLogs(admin.id, { category: "admin", pageSize: 200 });
    expect(adminOnly.rows.every((r) => r.action.startsWith("admin."))).toBe(true);
    await db.insert(auditLogs).values({ action: "cron.tick", meta: { users: 1 } });
    const security = await listAuditLogs(admin.id, { pageSize: 200 });
    expect(security.rows.some((r) => r.action === "cron.tick")).toBe(false);
    const system = await listAuditLogs(admin.id, { category: "system" });
    expect(system.rows.some((r) => r.action === "cron.tick")).toBe(true);
  });
});

