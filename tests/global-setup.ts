import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Each test run gets its own throwaway database, built from the migrations (which also proves
 * migrations apply cleanly) and dropped afterwards. Concurrent runs never interfere.
 */
export default async function setup() {
  config({ path: ".env.local", quiet: true });
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL must be set");
  const name = `kosh_test_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const runUrl = url.toString();
  const sql = postgres(runUrl, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end();
  process.env.KOSH_TEST_RUN_DB_URL = runUrl;
  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  };
}
