import { and, eq, gt, lt, ne, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { sessions, users, type User } from "@/server/db/schema";
import { randomToken, sha256 } from "./tokens";

export const SESSION_TTL_DAYS = 30;
const DAY_MS = 86_400_000;
/** Extend the session when less than this much lifetime remains (sliding expiration). */
const RENEW_THRESHOLD_MS = 15 * DAY_MS;

export type SessionUser = Pick<User, "id" | "email" | "name" | "role" | "status" | "onboardingCompletedAt">;
export type ValidSession = { sessionId: string; expiresAt: Date; user: SessionUser };

export async function createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS);
  await db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

export async function validateSessionToken(token: string | undefined | null): Promise<ValidSession | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const id = sha256(token);
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        onboardingCompletedAt: users.onboardingCompletedAt,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  if (row.user.status !== "active") {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  const now = Date.now();
  let expiresAt = row.expiresAt;
  const needsRenew = expiresAt.getTime() - now < RENEW_THRESHOLD_MS;
  const needsTouch = now - row.lastSeenAt.getTime() > 60 * 60 * 1000;
  if (needsRenew || needsTouch) {
    if (needsRenew) expiresAt = new Date(now + SESSION_TTL_DAYS * DAY_MS);
    await db.update(sessions).set({ expiresAt, lastSeenAt: new Date() }).where(eq(sessions.id, id));
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, row.user.id));
  }
  return { sessionId: row.sessionId, expiresAt, user: row.user };
}

export async function invalidateSession(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function invalidateSessionByToken(token: string) {
  await invalidateSession(sha256(token));
}

/** Sign out everywhere (optionally keeping the current session). */
export async function invalidateUserSessions(userId: string, exceptSessionId?: string) {
  await db
    .delete(sessions)
    .where(exceptSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)) : eq(sessions.userId, userId));
}

export async function listUserSessions(userId: string) {
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(sql`${sessions.lastSeenAt} DESC`);
}

export async function deleteUserSession(userId: string, sessionId: string) {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)));
}

export async function purgeExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
