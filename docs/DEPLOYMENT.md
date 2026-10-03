# Deploying Kosh to Vercel

Kosh is a standard Next.js 16 app plus a PostgreSQL database. Vercel hosts the app; **Neon**
(Vercel Marketplace → Neon Postgres) is the recommended database: serverless Postgres, a pooled
connection endpoint built for serverless functions, automatic backups with point-in-time restore,
and branching for safe migration rehearsals.

## 1. Create the database

1. Vercel dashboard → your project → **Storage** → **Create** → **Neon Postgres** (or create a project
   at neon.tech directly). Pick the region closest to your Vercel functions region.
2. Neon gives you two connection strings:
   - **Pooled** (host contains `-pooler`) → use for `DATABASE_URL` (runtime).
   - **Direct** → use for `DATABASE_URL_UNPOOLED` (migrations only).
   The Vercel integration sets both automatically.
3. In Neon → Settings → **Backup & restore**, set the history-retention window (point-in-time restore)
   to at least 7 days (30 on paid plans). See `docs/BACKUP_RECOVERY.md`.

## 2. Environment variables

Set these in Vercel → Project → Settings → **Environment Variables** (Production and Preview).
Full reference with comments: `.env.example`.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon **pooled** URL, `?sslmode=require` |
| `DATABASE_URL_UNPOOLED` | recommended | Neon direct URL — used by the migration step |
| `AUTH_SECRET` | ✅ | `openssl rand -base64 32` — keys invite-code hashes. **Never rotate casually**: rotating invalidates unused invite codes (sessions are unaffected). |
| `APP_URL` | ✅ | e.g. `https://kosh.yourdomain.com` (password-reset links) |
| `CRON_SECRET` | ✅ | random string; Vercel Cron sends it as a Bearer token |
| `GROQ_API_KEY` | for AI | server-side only; AI features are hidden when unset |
| `GROQ_MODEL`, `GROQ_FALLBACK_MODEL` | optional | defaults `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` |
| `AI_DAILY_REQUEST_LIMIT` | optional | per-user daily AI cap (default 300) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | for push | `npx web-push generate-vapid-keys` |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional | password-reset emails; otherwise admins generate reset links |

Secrets are only read in server code. The only browser-exposed variables are the `NEXT_PUBLIC_*` ones
(VAPID public key and app name), which are public by design.

## 3. Build & migrate

`package.json` has a `vercel-build` script that Vercel runs instead of `build`:

```
tsx scripts/migrate.ts && next build
```

So every deployment applies pending migrations (idempotent, tracked in `drizzle.__drizzle_migrations`)
before building. If a migration fails the deployment fails and the previous version keeps serving.

> Prefer manual control? Remove `vercel-build` and run `DATABASE_URL=<direct url> npm run db:migrate`
> from your machine or CI before promoting a deployment.

## 4. First deploy

```bash
npm i -g vercel
vercel link
vercel env pull .env.production.local   # optional, to run scripts against prod
vercel --prod
```

## 5. Create the first administrator

Run once against the production database (from your machine):

```bash
DATABASE_URL="<neon direct url>" AUTH_SECRET="<same as Vercel>" \
  npm run admin:create -- --email you@example.com --password '<strong password>' --name "Your Name"
```

Then sign in and create invite codes in **Admin → Invites**. (CLI alternative:
`npm run invite:create -- --days 30 --uses 1 --email friend@example.com`.)

## 6. Scheduled jobs (reminders, auto-posting, snapshots, housekeeping)

`vercel.json` registers a cron job calling `/api/cron/tick`. On the Hobby plan Vercel crons run at most
once per day; reminders still work without cron because they are also evaluated (throttled) whenever a
user opens the app. For timely daily reminders/push on Hobby, point an external scheduler (GitHub
Actions, cron-job.org) at `https://<your-app>/api/cron/tick` every 15–60 minutes with header
`Authorization: Bearer <CRON_SECRET>`. On Pro, change the schedule in `vercel.json` to hourly.

## 7. Seed data

There is intentionally **no demo/seed financial data** — every user starts with their own editable
default categories and payment methods (created at registration). The only bootstrap step is creating
the first admin (step 5).

## 8. Post-deploy checklist

- [ ] `https://<app>/api/health` returns `{"ok":true}`
- [ ] Sign in as admin, create an invite, register a second user in a private window
- [ ] Add a transaction as each user; confirm neither can see the other's data
- [ ] Admin → Overview shows DB, AI, push, email status
- [ ] Install the PWA on a phone; enable notifications in Settings → Notifications and send a test
- [ ] Neon point-in-time restore window configured

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DATABASE_URL is not set` at build | Add the env var for the **Production** (and Preview) environment, redeploy |
| `prepared statement … does not exist` | You're using a pooled URL with prepared statements elsewhere; Kosh disables them (`prepare: false`). Make sure you're on the latest code |
| Migrations time out on Neon | Set `DATABASE_URL_UNPOOLED` to the direct (non-pooler) host |
| `too many connections` | Lower `DATABASE_POOL_MAX` (e.g. 3) and make sure `DATABASE_URL` is the pooled host |
| Invite codes created before a secret change no longer work | `AUTH_SECRET` changed — revoke and re-issue invites |
| AI says "isn't configured" | Set `GROQ_API_KEY` and redeploy; check Admin → Overview |
| Push notifications never arrive | VAPID keys set? Permission granted? On iOS the PWA must be installed to the Home Screen (iOS 16.4+) |
| Cron returns 401 | `CRON_SECRET` mismatch between Vercel env and scheduler header |
| Server actions fail behind a custom proxy/domain | Ensure the proxy forwards `x-forwarded-host`; or add the host to `experimental.serverActions.allowedOrigins` |
| Receipt upload fails over ~4 MB | Vercel's request body limit is 4.5 MB; the app compresses images client-side and caps files at 4 MB |
