# Backups, recovery and migrations

Kosh stores financial data, so durability is designed in at three layers.

## 1. What is stored where

| Data | Location | Notes |
|---|---|---|
| All financial records, settings, receipts (file bytes) | PostgreSQL | Receipts are `bytea` in Postgres on purpose so they share the database's backups |
| Sessions, rate limits, audit logs | PostgreSQL | |
| Nothing financial | Vercel filesystem / browser storage | Deployment storage is ephemeral and is never used for data. The browser only caches static assets (service worker) and a theme preference |

## 2. Write safety

- Every multi-step write (transaction + splits + tags, invite redemption + user creation, restore, imports,
  recurring posting) runs in a single database transaction — all or nothing.
- The UI only confirms "saved" after the server action returns success (which happens after commit).
- Constraints enforce invariants at the database level: positive amounts, transfer shape, unique
  recurring occurrences (no double-posting), invite use counts ≤ max uses, foreign keys with explicit
  cascade rules, unique per-user names.
- Transactions are soft-deleted (with Undo) and purged after 30 days by the cron job.

## 3. Backups

### Provider backups (primary)
**Neon** keeps a continuous WAL history and supports **point-in-time restore (PITR)** to any second within
the configured history-retention window (Neon → Project → Settings → *History retention*; set ≥ 7 days on
free, 30 days on paid plans). This is the primary disaster-recovery mechanism.

Recommended additionally: a nightly logical dump to storage you control, e.g. a GitHub Action:

```bash
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL_UNPOOLED" > kosh-$(date +%F).dump
# upload to S3/R2/B2 with lifecycle rules (e.g. keep 30 daily, 12 monthly), encrypted at rest
```

### User-level backups
Every user can download a complete JSON backup of their own data (Settings → Data → Export backup) and
restore it (merge or replace). Restores remap every id, so a backup file can never write into another
user's records.

## 4. Restoring

**Whole-database incident (bad migration, accidental mass deletion):**
1. In Neon, create a branch from a point in time just before the incident (Branches → Create → *Past
   data*). This does not touch production.
2. Verify the branch (connect with `psql`, check row counts / the affected user's data).
3. Either *Restore* the main branch to that point (Neon → Restore), or point `DATABASE_URL` at the new
   branch and redeploy. Expect writes made after the restore point to be lost — announce a maintenance window.

**Single user's data:** restore a Neon branch to the point in time, export that user's data with the
app's backup function (or targeted `pg_dump --data-only` queries), and import it into production with
Settings → Data → Restore (merge).

**From a logical dump:** `pg_restore --clean --no-owner -d "$DATABASE_URL_UNPOOLED" kosh-YYYY-MM-DD.dump`.

## 5. Migrations

- Schema lives in `src/server/db/schema.ts`; SQL migrations are generated with `npm run db:generate`
  into `drizzle/` and committed. Never edit an applied migration — add a new one.
- `npm run db:migrate` (and the `vercel-build` step) applies pending migrations inside a transaction and
  records them in `drizzle.__drizzle_migrations`.
- The test-suite builds a fresh database from the migrations on every run, so a broken migration fails CI.

### Rollback considerations
Drizzle migrations are forward-only. To roll back:
1. Prefer **roll-forward**: write a new migration that reverses the change.
2. Make destructive changes in two deploys (expand → migrate data → contract), so the previous app
   version still works against the new schema and can be redeployed instantly (Vercel → Deployments →
   *Promote* an older deployment).
3. Before risky migrations, create a Neon branch (instant copy) and rehearse the migration on it.
4. If a migration corrupts data, use PITR (section 4) to a point just before it ran.

## 6. Recovery objectives (with the recommended setup)

| | Target |
|---|---|
| RPO (max data loss) | seconds (Neon PITR) |
| RTO (time to restore) | minutes for a branch restore; < 1 h including verification |
