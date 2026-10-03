import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { invitations, users } from "@/server/db/schema";
import { checkInvite, login, registerWithInvite, requestPasswordReset, resetPassword, createPasswordResetLink, changePassword } from "@/server/services/auth";
import { validateSessionToken, invalidateSessionByToken } from "@/server/auth/sessions";
import { hashInviteCode } from "@/server/auth/tokens";
import { makeInvite, PASSWORD } from "./helpers";
import { randomUUID } from "node:crypto";

const email = () => `a-${randomUUID().slice(0, 8)}@example.com`;
const ip = () => randomUUID();

describe("invite-only registration", () => {
  it("registers with a valid invite and marks it used", async () => {
    const code = await makeInvite();
    const e = email();
    const user = await registerWithInvite({ inviteCode: code, email: e, password: PASSWORD }, { ip: ip() });
    expect(user.email).toBe(e);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    const [inv] = await db.select().from(invitations).where(eq(invitations.codeHash, hashInviteCode(code)));
    expect(inv.useCount).toBe(1);
    expect(await checkInvite(code)).toBe("used");
  });
  it("accepts codes case-insensitively and without dashes", async () => {
    const code = await makeInvite();
    await expect(registerWithInvite({ inviteCode: code.toLowerCase().replace(/-/g, ""), email: email(), password: PASSWORD }, { ip: ip() })).resolves.toBeTruthy();
  });
  it("rejects invalid, expired, revoked and used invites", async () => {
    await expect(registerWithInvite({ inviteCode: "NOPE-NOPE-NOPE", email: email(), password: PASSWORD }, { ip: ip() })).rejects.toThrow(/isn't valid/);
    const expired = await makeInvite({ expiresAt: new Date(Date.now() - 1000) });
    await expect(registerWithInvite({ inviteCode: expired, email: email(), password: PASSWORD }, { ip: ip() })).rejects.toThrow(/expired/);
    const revoked = await makeInvite({ status: "revoked" });
    await expect(registerWithInvite({ inviteCode: revoked, email: email(), password: PASSWORD }, { ip: ip() })).rejects.toThrow(/revoked/);
    const once = await makeInvite();
    await registerWithInvite({ inviteCode: once, email: email(), password: PASSWORD }, { ip: ip() });
    await expect(registerWithInvite({ inviteCode: once, email: email(), password: PASSWORD }, { ip: ip() })).rejects.toThrow(/already been used/);
  });
  it("enforces email-restricted invites", async () => {
    const target = email();
    const code = await makeInvite({ email: target });
    await expect(registerWithInvite({ inviteCode: code, email: email(), password: PASSWORD }, { ip: ip() })).rejects.toThrow(/different email/);
    await expect(registerWithInvite({ inviteCode: code, email: target.toUpperCase(), password: PASSWORD }, { ip: ip() })).resolves.toBeTruthy();
  });
  it("multi-use invites stop at max uses, even under concurrency", async () => {
    const code = await makeInvite({ maxUses: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => registerWithInvite({ inviteCode: code, email: email(), password: PASSWORD }, { ip: ip() })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const [inv] = await db.select().from(invitations).where(eq(invitations.codeHash, hashInviteCode(code)));
    expect(inv.useCount).toBe(3);
  });
  it("does not consume an invite when registration fails (duplicate email / weak password)", async () => {
    const e = email();
    await registerWithInvite({ inviteCode: await makeInvite(), email: e, password: PASSWORD }, { ip: ip() });
    const code = await makeInvite();
    await expect(registerWithInvite({ inviteCode: code, email: e, password: PASSWORD }, { ip: ip() })).rejects.toThrow(/already exists/);
    await expect(registerWithInvite({ inviteCode: code, email: email(), password: "short" }, { ip: ip() })).rejects.toThrow(/10 characters/);
    expect(await checkInvite(code)).toBe("valid");
  });
  it("seeds default categories and payment methods per user", async () => {
    const u = await registerWithInvite({ inviteCode: await makeInvite(), email: email(), password: PASSWORD }, { ip: ip() });
    const { listCategories, listPaymentMethods } = await import("@/server/services/taxonomy");
    expect((await listCategories(u.id)).length).toBeGreaterThan(20);
    expect((await listPaymentMethods(u.id)).map((p) => p.type)).toContain("upi");
  });
});

describe("login / sessions", () => {
  it("logs in, validates the session, and logs out", async () => {
    const e = email();
    await registerWithInvite({ inviteCode: await makeInvite(), email: e, password: PASSWORD }, { ip: ip() });
    const { token } = await login({ email: e.toUpperCase(), password: PASSWORD }, { ip: ip() });
    const s = await validateSessionToken(token);
    expect(s?.user.email).toBe(e);
    await invalidateSessionByToken(token);
    expect(await validateSessionToken(token)).toBeNull();
  });
  it("rejects wrong passwords with a generic message and locks after repeated failures", async () => {
    const e = email();
    await registerWithInvite({ inviteCode: await makeInvite(), email: e, password: PASSWORD }, { ip: ip() });
    await expect(login({ email: e, password: "wrong-password-1" }, { ip: ip() })).rejects.toThrow("Incorrect email or password.");
    await expect(login({ email: "nobody@example.com", password: "x" }, { ip: ip() })).rejects.toThrow("Incorrect email or password.");
    for (let i = 0; i < 7; i++) await login({ email: e, password: "wrong" + i }, { ip: ip() }).catch(() => {});
    await expect(login({ email: e, password: PASSWORD }, { ip: ip() })).rejects.toThrow(/locked|Too many/);
  });
  it("rate-limits login attempts per IP", async () => {
    const theIp = ip();
    let limited = false;
    for (let i = 0; i < 35; i++) {
      try {
        await login({ email: `x${i}@example.com`, password: "nope" }, { ip: theIp });
      } catch (e) {
        if (/Too many/.test((e as Error).message)) limited = true;
      }
    }
    expect(limited).toBe(true);
  });
  it("disabled users cannot log in and their sessions stop working", async () => {
    const e = email();
    const u = await registerWithInvite({ inviteCode: await makeInvite(), email: e, password: PASSWORD }, { ip: ip() });
    const { token } = await login({ email: e, password: PASSWORD }, { ip: ip() });
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, u.id));
    expect(await validateSessionToken(token)).toBeNull();
    await expect(login({ email: e, password: PASSWORD }, { ip: ip() })).rejects.toThrow(/disabled/);
  });
  it("rejects garbage session tokens", async () => {
    expect(await validateSessionToken("")).toBeNull();
    expect(await validateSessionToken("x".repeat(43))).toBeNull();
    expect(await validateSessionToken("' OR 1=1 --".repeat(3))).toBeNull();
  });
});

describe("password reset & change", () => {
  it("resets with a single-use token and revokes sessions", async () => {
    const e = email();
    const u = await registerWithInvite({ inviteCode: await makeInvite(), email: e, password: PASSWORD }, { ip: ip() });
    const { token: sessionToken } = await login({ email: e, password: PASSWORD }, { ip: ip() });
    const link = await createPasswordResetLink(u.id);
    const token = new URL(link).searchParams.get("token")!;
    await resetPassword(token, "Brand-New-Pass-77", { ip: ip() });
    expect(await validateSessionToken(sessionToken)).toBeNull();
    await expect(resetPassword(token, "Another-Pass-88", { ip: ip() })).rejects.toThrow(/invalid or has expired/);
    await expect(login({ email: e, password: "Brand-New-Pass-77" }, { ip: ip() })).resolves.toBeTruthy();
  });
  it("request for unknown email resolves silently (no enumeration)", async () => {
    await expect(requestPasswordReset("ghost@example.com", { ip: ip() })).resolves.toBeUndefined();
  });
  it("change password requires the current password", async () => {
    const e = email();
    const u = await registerWithInvite({ inviteCode: await makeInvite(), email: e, password: PASSWORD }, { ip: ip() });
    await expect(changePassword(u.id, "wrong", "Fresh-Password-99")).rejects.toThrow(/incorrect/);
    await changePassword(u.id, PASSWORD, "Fresh-Password-99");
    await expect(login({ email: e, password: "Fresh-Password-99" }, { ip: ip() })).resolves.toBeTruthy();
  });
});
