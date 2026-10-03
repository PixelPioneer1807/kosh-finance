# Kosh — personal finance, privately

Kosh is a multi-user, invite-only personal finance and expense tracking web app. Every user gets a
completely independent, private financial workspace: accounts, transactions, budgets, bills,
subscriptions, goals, net worth, analytics, an AI assistant and reminders — all backed by PostgreSQL.

No financial values are hard-coded. New users start with editable default categories and payment
methods; everything else is theirs to enter.

---

## Features

| Area | Highlights |
|---|---|
| **Fast entry** | Global quick-add (`N` key, `+` on mobile) · natural-language entry ("Spent 450 at Starbucks today") with confirmation · amount maths (`120+45`) · merchant autocomplete that learns categories · splits, tags, receipts, foreign-currency amounts, pending flag · undo |
| **Transactions** | Expenses, income, transfers (never counted as spending), refunds linked to the original (reduce spending, not income), balance adjustments · search across merchant/category/notes/tags/amount/account/method · filters (range presets, custom dates, amounts, type, recurring, refunded, receipt, pending, uncategorised) · bulk categorise/delete · CSV export |
| **Accounts** | Bank, savings, cash, wallet, credit card, investment, loan, other assets · balances computed from the ledger · multi-currency with your own exchange rates · reconcile ("update balance") · archive |
| **Credit cards** | Limit, utilisation, available credit, statement & due dates, minimum payment, annual fee, warnings and due-date reminders |
| **Budgets** | Weekly/monthly/yearly/custom, overall or per category (incl. subcategories & splits), rollover, payday-based months, projected spend, configurable alert thresholds (50/75/90/100% + projected overspend) |
| **Bills & recurring** | Bills, subscriptions, income/salary (gross, tax, deductions, net), recurring expenses & transfers · daily…yearly + custom intervals · mark paid / skip / auto-post · subscription monthly & yearly cost · price-change detection · "looks recurring" suggestions from history |
| **Goals** | Unlimited goals, contributions & withdrawals (optionally moving real money between accounts), required contribution per period, projected completion, on-track status |
| **Net worth** | Assets − liabilities with history from the ledger, breakdown by account type, monthly snapshots |
| **Insights** | Dashboard (personalisable widgets), analytics (categories, trends, merchants, accounts, payment methods, recurring vs discretionary, savings rate), daily view, financial calendar, cash-flow forecast & safe-to-spend, monthly review, printable reports (PDF via print, CSV) |
| **AI (Groq)** | Assistant that answers from your real data through user-scoped tools · proposes changes (add/edit/delete transactions, budgets, goals) that only run after you confirm · deterministic insights with optional AI interpretation · receipt OCR (in-browser Tesseract + AI structuring) |
| **Notifications** | In-app notification centre + Web Push · daily check-in, missing entries, bills/subscriptions, trials, income, budgets, goals, credit cards · quiet hours, daily cap, per-type toggles |
| **PWA** | Installable, home-screen icon & shortcuts, offline page, service worker |
| **Data** | CSV import (column mapping, preview, validation, duplicate detection, undo), full JSON backup & restore, CSV exports, account deletion |
| **Admin** | Invite codes (expiry, max uses, email restriction, revoke), users (disable/reactivate, roles, reset links), system health, aggregate metrics, audit log — **no access to anyone's financial data** |
| **Everywhere** | Command palette (`⌘K`/`Ctrl K`) with global search · light/dark/system theme · keyboard & screen-reader friendly · responsive mobile-first UI |

---

## Quick start (local)

Requirements: Node 20+ (tested on 26), Docker (for Postgres), npm.

```bash
npm install
cp .env.example .env.local        # then fill in values (see below)
npm run db:up                      # starts Postgres 17 on 127.0.0.1:55432 (docker compose)
npm run db:migrate                 # applies migrations
npm run admin:create -- --email you@example.com --password 'A-strong-pass-123' --name "You"
npm run dev                        # http://localhost:3210
```

Sign in as the admin, open **Admin → Invites**, create a code, and register other users at
`/register` (or `npm run invite:create -- --days 30 --uses 1`).

Minimum `.env.local` for local development:

```dotenv
DATABASE_URL=postgres://kosh:kosh@127.0.0.1:55432/kosh
TEST_DATABASE_URL=postgres://kosh:kosh@127.0.0.1:55432/kosh_test
AUTH_SECRET=<openssl rand -base64 32>
APP_URL=http://localhost:3210
GROQ_API_KEY=<optional, enables AI>
CRON_SECRET=<random string>
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<npx web-push generate-vapid-keys>
VAPID_PRIVATE_KEY=<…>
VAPID_SUBJECT=mailto:you@example.com
```

Every variable is documented in [`.env.example`](.env.example).

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on port 3210 |
| `npm run build` / `npm start` | Production build / server |
| `npm run db:up` | Start local Postgres (Docker) |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Drizzle Studio (DB browser) |
| `npm run admin:create -- --email … --password …` | Create or promote an admin |
| `npm run invite:create -- [--days 30] [--uses 1] [--email …]` | Create an invite code |
| `npm run cron:local` | Hit the cron endpoint every minute (reminders, auto-posting) |
| `npm test` | Unit/integration tests (Vitest, real Postgres) |
| `npm run test:e2e` | Browser tests (Playwright; needs `npm run dev` running) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |

---

## Tech stack

- **Next.js 16** (App Router, Server Components, Server Actions, `proxy.ts`), **React 19**, **TypeScript**
- **Tailwind CSS v4** + Radix primitives (custom component library in `src/components/ui`)
- **PostgreSQL 17** + **Drizzle ORM** (`postgres` driver) — Neon recommended in production
- **Zod 4** validation shared by client and server
- **Recharts** (validated colour palette, accessible tables for every chart)
- **Groq** API (OpenAI-compatible; `openai/gpt-oss-120b`, fallback `qwen/qwen3.8-27b`)
- **argon2id** password hashing, DB-backed sessions & rate limits
- **web-push** (VAPID), service worker PWA, **tesseract.js** OCR in the browser
- **Vitest** (274 tests against real Postgres) and **Playwright** (E2E)

## Project structure

```
src/
  app/
    (auth)/            login, register (invite), forgot/reset password + actions
    (app)/             authenticated app: dashboard, transactions, accounts, budgets, recurring,
                       goals, net-worth, calendar, analytics, review, reports, assistant, import,
                       notifications, settings/*, admin/*  (each with actions.ts)
    onboarding/        optional setup wizard
    api/               route handlers: receipts, search, exports, backup/restore, notifications,
                       push, cron/tick, health
  server/
    db/                schema.ts (single source of truth) + client
    auth/              sessions, password, rate limiting, request guards
    services/          business logic — every function takes the authenticated userId
    ai/                Groq client, assistant loop, tools, confirmable actions, parsing, receipts
    safe.ts            userAction / userRoute wrappers (auth + validation + safe errors + CSRF)
  lib/                 money (exact decimals), dates, recurrence, validation, CSV, NL parser
  components/          ui/ primitives, app/ components, shell/ (nav, palette, quick add), widgets/, charts/
drizzle/               SQL migrations
tests/                 Vitest suites (auth, isolation, transactions, budgets, recurring, goals,
                       net worth, analytics, forecast, AI, import, backup, admin, reminders, security…)
e2e/                   Playwright smoke tests (desktop + mobile)
docs/                  research, feature checklist, deployment, backups, security, conventions
```

## How the money works

- Amounts are PostgreSQL `numeric(19,4)` and decimal strings in TypeScript; arithmetic uses BigInt
  (`src/lib/money.ts`). Floats are never used for money.
- Each transaction stores its amount in the account's currency plus `base_amount` in your base
  currency (via your exchange rates), so totals across currencies are exact.
- Balances are always computed from the ledger (opening balance + transactions) — never stored, so
  they can't drift.
- Spending = expenses − refunds. Transfers move money between accounts and are never income or
  spending. Splits allocate one transaction across categories and must add up exactly (checked in the
  browser, the server and by DB constraints).

## Data isolation & security

Every query is scoped to the authenticated user in the service layer, referenced ids are ownership-
checked before writes, and admins can't see financial data. See **[docs/SECURITY.md](docs/SECURITY.md)**
for the full model (sessions, CSRF, CSP, uploads, rate limits, AI safeguards) and
`tests/isolation.test.ts` + `e2e/smoke.spec.ts` for the tests that prove it.

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Vercel + Neon deployment, env vars, cron, troubleshooting
- [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) — backups, point-in-time restore, migrations & rollback
- [docs/SECURITY.md](docs/SECURITY.md) — security model
- [docs/RESEARCH.md](docs/RESEARCH.md) — product research (YNAB, Monarch, Copilot, Rocket Money, …)
- [docs/FEATURE_CHECKLIST.md](docs/FEATURE_CHECKLIST.md) — feature checklist with implementation status
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — engineering conventions for contributors

---

## Known limitations

- **No bank sync** — transactions are entered manually, by natural language, receipt scan or CSV import.
- **Exchange rates are user-maintained** (with an optional "fetch latest" helper); historical
  conversions use the rate at entry time, net-worth history uses current rates.
- **Reminders on Vercel Hobby** run via a once-daily cron plus lazy evaluation when you open the app;
  timely hourly reminders need Vercel Pro or an external scheduler (see DEPLOYMENT.md).
- **iOS push** requires installing the PWA to the Home Screen (iOS 16.4+).
- **Groq free tier** has per-minute token limits; several rapid assistant questions in a row can be
  throttled (the app shows a clear message and retries with the fallback model).
- **Receipt OCR** runs in the browser; scanned PDFs without a text layer can't be OCR'd (the file is
  still attached). Receipts are stored in Postgres (4 MB max each).
- **Offline**: the app shows an offline page/banner; entering transactions offline isn't supported.
- **No 2FA / passkeys** yet, and no email verification (registration is invite-gated).
- Push notification text (e.g. budget alerts with amounts) can appear on the lock screen.
- Restoring a backup in *merge* mode appends budgets/goals/recurring items (doesn't de-duplicate them).

## Future improvements

- Passkeys/TOTP 2FA, email verification, per-device session names
- Postgres Row-Level Security as defence-in-depth for user isolation
- Bank/aggregator connections (Plaid, GoCardless, Account Aggregator in India) and statement PDF parsing
- Automatic FX rates by date; rules engine for auto-categorisation; transaction "review inbox"
- Shared/household budgets with explicit sharing (still private by default)
- Offline entry queue with background sync
- Streaming AI responses; local/edge models for categorisation; weekly AI recap email
- Drag-and-drop dashboard layout; saved CSV import mappings; scheduled report emails
- Object storage (Vercel Blob/S3) for larger receipt files
