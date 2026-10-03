import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { invitations } from "@/server/db/schema";
import { generateInviteCode, hashInviteCode } from "@/server/auth/tokens";
import { registerWithInvite } from "@/server/services/auth";
import { updatePreferences } from "@/server/services/preferences";
import { createAccount } from "@/server/services/accounts";
import { listCategories } from "@/server/services/taxonomy";

export const PASSWORD = "Correct-Horse-42";

export async function makeInvite(opts: Partial<typeof invitations.$inferInsert> = {}) {
  const code = generateInviteCode();
  await db.insert(invitations).values({
    codeHash: hashInviteCode(code),
    codePrefix: code.slice(0, 4),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...opts,
  });
  return code;
}

/** Registers a fresh user through the real invite flow. */
export async function makeUser(opts: { currency?: string; role?: "user" | "admin" } = {}) {
  const code = await makeInvite({ role: opts.role ?? "user" });
  const email = `u-${randomUUID().slice(0, 8)}@example.com`;
  const user = await registerWithInvite({ inviteCode: code, email, password: PASSWORD, name: "Test" }, { ip: randomUUID() });
  await updatePreferences(user.id, { currency: opts.currency ?? "USD", timezone: "UTC" });
  return { ...user, email };
}

export async function makeAccount(userId: string, opts: { name?: string; type?: string; currency?: string; openingBalance?: string } = {}) {
  return createAccount(userId, {
    name: opts.name ?? "Checking",
    type: (opts.type ?? "checking") as "checking",
    currency: opts.currency ?? "USD",
    openingBalance: opts.openingBalance ?? "1000",
  });
}

export async function category(userId: string, name: string) {
  const cats = await listCategories(userId);
  const c = cats.find((x) => x.name === name);
  if (!c) throw new Error(`No category ${name}`);
  return c;
}
