/**
 * Bootstrap or promote an administrator.
 *   npm run admin:create -- --email you@example.com --password '…' [--name "Your Name"]
 * If the email exists, the user is promoted to admin (and the password reset if given).
 */
import "./_env";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, password: { type: "string" }, name: { type: "string" } } });
  const { db, sqlClient } = await import("../src/server/db");
  const { users, invitations } = await import("../src/server/db/schema");
  const { hashPassword, passwordProblems } = await import("../src/server/auth/password");
  const { registerWithInvite } = await import("../src/server/services/auth");
  const { generateInviteCode, hashInviteCode } = await import("../src/server/auth/tokens");
  const email = values.email?.trim().toLowerCase();
  if (!email) throw new Error("--email is required");
  const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  if (existing) {
    const patch: Partial<typeof users.$inferInsert> = { role: "admin", status: "active" };
    if (values.password) {
      const p = passwordProblems(values.password, email);
      if (p.length) throw new Error(p.join(" "));
      patch.passwordHash = await hashPassword(values.password);
    }
    await db.update(users).set(patch).where(eq(users.id, existing.id));
    console.log(`✓ ${email} is now an admin.`);
  } else {
    if (!values.password) throw new Error("--password is required for a new admin");
    // New admins go through the normal invite flow so they get default categories etc.
    const code = generateInviteCode();
    await db.insert(invitations).values({ codeHash: hashInviteCode(code), codePrefix: code.slice(0, 4), label: "Bootstrap admin", email, role: "admin", expiresAt: new Date(Date.now() + 3600_000) });
    await registerWithInvite({ inviteCode: code, email, password: values.password, name: values.name ?? null }, { ip: "cli" });
    console.log(`✓ Created admin ${email}.`);
  }
  await sqlClient.end();
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
