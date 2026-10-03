/** Applies pending migrations. Safe to run repeatedly (used by `vercel-build`). */
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main() {
  // Prefer a direct (non-pooled) URL for DDL when the provider offers one.
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  console.log("Applying migrations…");
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log("Migrations up to date.");
  await sql.end();
}

main().catch((e) => {
  console.error("Migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
