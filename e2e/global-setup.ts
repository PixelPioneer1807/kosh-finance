import { config } from "dotenv";
import postgres from "postgres";

/**
 * E2E runs register many users from one IP, which (correctly) trips the sign-up/login rate limits.
 * Clear the limiter counters before a run — only ever against a local database.
 */
export default async function globalSetup() {
  config({ path: ".env.local", quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url || !/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    console.warn("[e2e] DATABASE_URL is not local — not resetting rate limits");
    return;
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`DELETE FROM rate_limits WHERE key LIKE 'register:%' OR key LIKE 'login:%' OR key LIKE 'invite-check:%'`;
  await sql.end();
}
