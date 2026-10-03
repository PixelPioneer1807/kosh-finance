import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/server/db";
import {
  auditLogs,
  invitationRedemptions,
  invitations,
  notificationPreferences,
  passwordResetTokens,
  userPreferences,
  users,
} from "@/server/db/schema";
import { AppError, invalid } from "@/server/errors";
import { dummyVerify, hashPassword, passwordProblems, verifyPassword } from "@/server/auth/password";
import { enforceRateLimit, resetRateLimit } from "@/server/auth/rate-limit";
import { createSession, invalidateUserSessions } from "@/server/auth/sessions";
import { hashInviteCode, randomToken, sha256 } from "@/server/auth/tokens";
import { seedUserDefaults } from "./defaults";
import { appUrl, sendEmail } from "@/server/mailer";

type Meta = { ip?: string | null; userAgent?: string | null };

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

export type InviteState = "valid" | "invalid" | "revoked" | "expired" | "used" | "email_mismatch";

/** Inspect an invite without consuming it (used for the registration form's live check). */
export async function checkInvite(code: string, email?: string): Promise<InviteState> {
  const [inv] = await db.select().from(invitations).where(eq(invitations.codeHash, hashInviteCode(code))).limit(1);
  if (!inv) return "invalid";
  if (inv.status === "revoked") return "revoked";
  if (inv.expiresAt <= new Date()) return "expired";
  if (inv.useCount >= inv.maxUses) return "used";
  if (email && inv.email && inv.email.toLowerCase() !== email.toLowerCase()) return "email_mismatch";
  return "valid";
}

const INVITE_MESSAGES: Record<Exclude<InviteState, "valid">, string> = {
  invalid: "That invite code isn't valid. Check for typos.",
  revoked: "That invite code has been revoked.",
  expired: "That invite code has expired. Ask your administrator for a new one.",
  used: "That invite code has already been used.",
  email_mismatch: "That invite code is reserved for a different email address.",
};

export async function registerWithInvite(
  input: { inviteCode: string; email: string; password: string; name?: string | null },
  meta: Meta = {},
) {
  await enforceRateLimit(`register:ip:${meta.ip ?? "unknown"}`, 10, 3600, "Too many sign-up attempts from this network. Try again later.");
  const email = input.email.trim().toLowerCase();
  const problems = passwordProblems(input.password, email);
  if (problems.length) throw invalid(problems[0], { password: problems });

  const passwordHash = await hashPassword(input.password);
  const codeHash = hashInviteCode(input.inviteCode);

  return db.transaction(async (tx) => {
    // Atomically claim one use of the invite. Concurrent registrations can't over-redeem it.
    const [claimed] = await tx
      .update(invitations)
      .set({ useCount: sql`${invitations.useCount} + 1` })
      .where(
        and(
          eq(invitations.codeHash, codeHash),
          eq(invitations.status, "active"),
          gt(invitations.expiresAt, new Date()),
          lt(invitations.useCount, invitations.maxUses),
          or(isNull(invitations.email), sql`lower(${invitations.email}) = ${email}`),
        ),
      )
      .returning({ id: invitations.id, role: invitations.role });
    if (!claimed) {
      const state = await checkInvite(input.inviteCode, email);
      throw new AppError("VALIDATION", INVITE_MESSAGES[state === "valid" ? "invalid" : state], { inviteCode: ["Invalid invite"] });
    }

    const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (existing.length) throw new AppError("CONFLICT", "An account with this email already exists. Try signing in.", { email: ["Already registered"] });

    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, name: input.name?.trim() || null, role: claimed.role, passwordChangedAt: new Date() })
      .returning();
    await tx.insert(userPreferences).values({ userId: user.id });
    await tx.insert(notificationPreferences).values({ userId: user.id });
    await seedUserDefaults(tx, user.id);
    await tx.insert(invitationRedemptions).values({ invitationId: claimed.id, userId: user.id });
    await tx.insert(auditLogs).values({ actorId: user.id, targetUserId: user.id, action: "user.registered", meta: { invitationId: claimed.id }, ipAddress: meta.ip ?? null });
    return user;
  });
}

export async function login(input: { email: string; password: string }, meta: Meta = {}) {
  const email = input.email.trim().toLowerCase();
  await enforceRateLimit(`login:ip:${meta.ip ?? "unknown"}`, 30, 900);
  await enforceRateLimit(`login:email:${email}`, 10, 900);

  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  const generic = new AppError("UNAUTHORIZED", "Incorrect email or password.");
  if (!user) {
    await dummyVerify(input.password);
    throw generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError("RATE_LIMITED", "This account is temporarily locked after too many failed attempts. Try again in a few minutes.");
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const failures = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failures >= MAX_FAILED_LOGINS ? 0 : failures,
        lockedUntil: failures >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
      })
      .where(eq(users.id, user.id));
    if (failures >= MAX_FAILED_LOGINS)
      await db.insert(auditLogs).values({ targetUserId: user.id, action: "user.locked", ipAddress: meta.ip ?? null });
    throw generic;
  }
  if (user.status !== "active") throw new AppError("FORBIDDEN", "This account has been disabled. Contact your administrator.");

  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastActiveAt: new Date() }).where(eq(users.id, user.id));
  await resetRateLimit(`login:email:${email}`);
  const session = await createSession(user.id, meta);
  return { user, ...session };
}

const RESET_TTL_MS = 60 * 60 * 1000;

/** Always resolves the same way whether or not the email exists (no account enumeration). */
export async function requestPasswordReset(emailRaw: string, meta: Meta = {}) {
  const email = emailRaw.trim().toLowerCase();
  await enforceRateLimit(`reset:ip:${meta.ip ?? "unknown"}`, 10, 3600);
  await enforceRateLimit(`reset:email:${email}`, 3, 3600);
  const [user] = await db.select({ id: users.id, status: users.status }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (!user || user.status !== "active") return;
  const link = await createPasswordResetLink(user.id);
  await sendEmail({
    to: email,
    subject: "Reset your Kosh password",
    text: `Someone (hopefully you) asked to reset your password.\n\nReset it here (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
  });
}

/** Creates a single-use reset link. Also used by admins to help a locked-out user. */
export async function createPasswordResetLink(userId: string) {
  const token = randomToken(32);
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  await db.insert(passwordResetTokens).values({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  return `${appUrl()}/reset-password?token=${token}`;
}

export async function resetPassword(token: string, newPassword: string, meta: Meta = {}) {
  await enforceRateLimit(`reset-confirm:ip:${meta.ip ?? "unknown"}`, 20, 3600);
  const [row] = await db
    .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId, email: users.email })
    .from(passwordResetTokens)
    .innerJoin(users, eq(users.id, passwordResetTokens.userId))
    .where(and(eq(passwordResetTokens.tokenHash, sha256(token)), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())))
    .limit(1);
  if (!row) throw new AppError("VALIDATION", "This reset link is invalid or has expired. Request a new one.");
  const problems = passwordProblems(newPassword, row.email);
  if (problems.length) throw invalid(problems[0], { password: problems });
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    const used = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });
    if (!used.length) throw new AppError("VALIDATION", "This reset link has already been used.");
    await tx.update(users).set({ passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, row.userId));
    await tx.insert(auditLogs).values({ actorId: row.userId, targetUserId: row.userId, action: "user.password_reset", ipAddress: meta.ip ?? null });
  });
  await invalidateUserSessions(row.userId);
}

export async function changePassword(userId: string, current: string, next: string, keepSessionId?: string) {
  await enforceRateLimit(`change-password:${userId}`, 10, 3600);
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !(await verifyPassword(user.passwordHash, current)))
    throw new AppError("VALIDATION", "Your current password is incorrect.", { currentPassword: ["Incorrect password"] });
  const problems = passwordProblems(next, user.email);
  if (problems.length) throw invalid(problems[0], { newPassword: problems });
  await db.update(users).set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date() }).where(eq(users.id, userId));
  await invalidateUserSessions(userId, keepSessionId);
  await db.insert(auditLogs).values({ actorId: userId, targetUserId: userId, action: "user.password_changed" });
}

/** Permanently deletes the user and (via ON DELETE CASCADE) every row they own. */
export async function deleteOwnAccount(userId: string, password: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !(await verifyPassword(user.passwordHash, password)))
    throw new AppError("VALIDATION", "Password is incorrect.", { password: ["Incorrect password"] });
  if (user.role === "admin") {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active")));
    if (count <= 1) throw new AppError("VALIDATION", "You're the only admin. Promote another admin before deleting your account.");
  }
  await db.insert(auditLogs).values({ action: "user.deleted_self", meta: { userId } });
  await db.delete(users).where(eq(users.id, userId));
}
