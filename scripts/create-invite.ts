/**
 * Create an invite code from the command line.
 *   npm run invite:create -- [--days 30] [--uses 1] [--email someone@example.com] [--label "Friend"]
 */
import "./_env";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({ options: { days: { type: "string" }, uses: { type: "string" }, email: { type: "string" }, label: { type: "string" } } });
  const { db, sqlClient } = await import("../src/server/db");
  const { invitations } = await import("../src/server/db/schema");
  const { generateInviteCode, hashInviteCode } = await import("../src/server/auth/tokens");
  const days = Number(values.days ?? 30);
  const uses = Number(values.uses ?? 1);
  const code = generateInviteCode();
  await db.insert(invitations).values({
    codeHash: hashInviteCode(code),
    codePrefix: code.slice(0, 4),
    label: values.label ?? "CLI invite",
    email: values.email?.toLowerCase() ?? null,
    maxUses: uses,
    expiresAt: new Date(Date.now() + days * 86_400_000),
  });
  console.log(`Invite code: ${code}  (expires in ${days} days, ${uses} use${uses === 1 ? "" : "s"}${values.email ? `, only for ${values.email}` : ""})`);
  await sqlClient.end();
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
