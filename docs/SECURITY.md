# Security model

## Authentication
- **Invite-only registration.** Codes are 12 characters from a 32-symbol alphabet (~60 bits), stored only
  as HMAC-SHA256 (keyed with `AUTH_SECRET`); the plaintext is shown once to the admin. Redemption is an
  atomic conditional `UPDATE … WHERE status='active' AND expires_at > now() AND use_count < max_uses
  [AND email matches] RETURNING`, inside the same DB transaction that creates the user — concurrent sign-ups
  can't over-redeem a code, and a failed sign-up never consumes it.
- **Passwords**: argon2id (19 MiB, t=2, p=1 — OWASP baseline) via `@node-rs/argon2`; policy: ≥10 chars,
  ≤128, not a common password, not containing the email's local part, mixed character classes below 16
  chars. Unknown-email logins still run a dummy verify to equalise timing.
- **Sessions**: 256-bit random token in an `HttpOnly; Secure; SameSite=Lax` cookie (`__Host-` prefixed in
  production). The database stores only SHA-256(token), so a DB leak doesn't yield usable sessions.
  30-day sliding expiry; revocable per device (Settings → Security) and revoked everywhere on password
  reset/change and when an admin disables the account.
- **Brute force**: Postgres-backed fixed-window rate limits (work across serverless instances) on login
  (per IP and per email), registration, invite checks, password reset, AI calls and uploads; account lockout
  for 15 minutes after 8 consecutive failed logins.
- **Password reset**: single-use 256-bit tokens (hashed at rest), 1-hour expiry, previous tokens invalidated;
  the request endpoint responds identically whether or not the email exists.

## Authorization & data isolation
- Every service function takes the **authenticated** `userId` (from the session, never from client input)
  and filters every query by `user_id`. Child tables (splits, tags, contributions, AI messages…) carry
  `user_id` too, so no query relies on a join for scoping.
- **Reference IDOR**: before writing, `assertOwned()` verifies every referenced id (account, category,
  merchant, payment method, goal, original transaction…) belongs to the same user — you can't attach your
  record to someone else's account by guessing ids. Unknown and foreign ids return the same "not found".
- `src/proxy.ts` only does optimistic redirects; real checks happen in every page (`requireUserPage`),
  server action (`userAction`) and route handler (`userRoute`).
- Admins manage invites/users and see aggregate counts only — no admin screen or API exposes another
  user's financial records.
- Tests: `tests/isolation.test.ts` and per-feature isolation tests exercise read/update/delete/reference
  attempts across users; `e2e/smoke.spec.ts` checks the same through the browser.

## Request security
- **CSRF**: server actions verify `Origin` against `Host` (Next.js); custom mutating route handlers do the
  same (`assertSameOrigin`); cookies are `SameSite=Lax`; all mutations are POST/DELETE.
- **XSS**: React escapes all output; AI/markdown output is rendered to React elements, never raw HTML.
  CSP restricts scripts to self (+ jsDelivr for the OCR worker), `frame-ancestors 'none'`, `object-src 'none'`.
- **SQL injection**: all SQL goes through Drizzle's parameterised builder / tagged `sql` templates; `LIKE`
  wildcards in search terms are escaped.
- **File uploads**: type detected from magic bytes (JPEG/PNG/WebP/PDF only; the client's MIME type is
  ignored), 4 MB cap, filenames sanitised, served only to the owner with `X-Content-Type-Options: nosniff`
  and a `sandbox` CSP so even a crafted PDF can't script the origin.
- **CSV exports** neutralise spreadsheet formula injection (`=`, `+`, `-`, `@` prefixes).
- **Errors**: unexpected errors are logged server-side and replaced with a generic message — no stack
  traces, SQL or infrastructure details reach the client. `/api/health` reports only up/down.
- Security headers: HSTS, X-Frame-Options DENY, nosniff, strict Referrer-Policy, restrictive
  Permissions-Policy, COOP.

## Secrets
- `GROQ_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `VAPID_PRIVATE_KEY`, `RESEND_API_KEY` are
  read only in server modules (`server-only` guards the DB/AI modules from client bundles). Only
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `NEXT_PUBLIC_APP_NAME` reach the browser, by design.
- `.env*` files are git-ignored (except `.env.example`, which contains no values).

## AI
- All Groq calls go through `src/server/ai/groq.ts` (server-only), with per-user per-minute limits and a
  daily quota recorded in `ai_usage`.
- The model receives only what the request needs (e.g. category/account *names* for parsing; tool results
  for specific questions) — never credentials, other users' data or bulk exports.
- Tools are read-only and user-scoped; any change the model proposes is stored as a pending `ai_action`
  and executes only after the user confirms (destructive ones require an explicit second confirmation),
  through the same validated services as the UI. Confirmations are claimed atomically (no double execution)
  and expire after 30 minutes.
- Merchant names/notes are user-controlled text: tool results are delimited JSON and the system prompt
  instructs the model to treat them as data (prompt-injection hygiene).

## Known limitations
- No 2FA/WebAuthn yet; no email verification (registration is invite-gated instead).
- Rate limiting is per-IP + per-account; a distributed attacker with many IPs is slowed mainly by the
  per-account lockout.
- Database-level Row-Level Security is not enabled (isolation is enforced in the service layer and
  covered by tests) — a recommended defence-in-depth improvement.
