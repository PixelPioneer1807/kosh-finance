# Feature Checklist

Items marked **(research)** came from the competitive research in [RESEARCH.md](./RESEARCH.md).
Check items off as they ship. Within each section, the order is a rough priority.

**Legend:** `[x]` implemented · `[~]` partially implemented (note says what's missing) · `[ ]` not implemented.
Statuses were verified against the code on 2026-10-03. Kosh is single-user per account (no households), so household items are marked against per-user behaviour.

**Overall:** 153 done · 99 partial · 94 not yet (346 items)

| Section | Done | Partial | Not yet |
|---|---:|---:|---:|
| Auth & invites | 4 | 4 | 9 |
| Admin | 4 | 4 | 3 |
| Security & isolation | 10 | 5 | 2 |
| Accounts | 5 | 3 | 2 |
| Transactions (splits, refunds, transfers) | 10 | 8 | 7 |
| Categories | 7 | 1 | 4 |
| Income/salary | 3 | 2 | 3 |
| Budgets & alerts | 9 | 1 | 8 |
| Recurring/bills/subscriptions | 7 | 4 | 3 |
| Goals | 5 | 2 | 3 |
| Net worth | 5 | 3 | 0 |
| Credit cards | 5 | 0 | 4 |
| Calendar | 4 | 2 | 2 |
| Analytics | 8 | 3 | 2 |
| Daily view | 2 | 3 | 1 |
| Merchants | 2 | 3 | 2 |
| Receipts/OCR | 3 | 2 | 3 |
| Forecasting | 2 | 4 | 1 |
| AI assistant/actions/insights | 6 | 6 | 3 |
| Notifications | 8 | 3 | 3 |
| PWA | 5 | 2 | 4 |
| Reports | 4 | 1 | 3 |
| Import/Export | 4 | 2 | 4 |
| Dashboard personalization | 3 | 3 | 1 |
| Command palette & quick actions | 5 | 2 | 0 |
| Monthly review | 0 | 6 | 2 |
| Global search | 2 | 2 | 3 |
| Settings | 7 | 3 | 2 |
| Accessibility | 5 | 6 | 1 |
| Performance | 2 | 5 | 5 |
| Testing | 7 | 4 | 4 |
| **Total** | **152** | **99** | **95** |

---

## Auth & invites
- [x] Email + password sign-up/sign-in with secure hashing (argon2/bcrypt) — argon2id, `src/server/auth/password.ts`
- [ ] Email verification before first login — not yet
- [x] Password reset via single-use, expiring token — `src/server/services/auth.ts`
- [ ] Magic-link sign-in (optional) — not yet
- [ ] OAuth sign-in (Google/Apple) (optional) — not yet
- [~] Invite-only registration mode (admin toggle) — always invite-only; no toggle
- [ ] Household/workspace invites by email with expiring, single-use tokens — not yet (no households; app-level invite codes only)
- [ ] Invite roles: owner, editor, viewer — not yet (invites grant user/admin only)
- [~] Resend / revoke pending invites — revoke only; no resend or invite email
- [~] Accept invite flow for both new and existing users — new-user registration only
- [ ] Leave household; owner transfer before leaving — not yet
- [x] Session management: list active sessions/devices, revoke individually or all — `src/app/(app)/settings/security/`
- [ ] Remember-me / session duration settings — not yet (fixed 30-day sliding session)
- [ ] Two-factor auth (TOTP) with recovery codes — not yet
- [ ] Passkeys / WebAuthn (research) — not yet
- [x] Rate-limited login with lockout/backoff — `src/server/services/auth.ts`, `src/server/auth/rate-limit.ts`
- [~] Account deletion with grace period and full data purge — immediate cascade purge; no grace period

## Admin
- [x] Admin role, separate from household owner — `src/server/services/admin.ts` (`assertAdmin`)
- [x] User list with search, status, created/last-active dates — `src/app/(app)/admin/users/`
- [~] Disable / re-enable / delete users — disable/re-enable only; no delete
- [~] Manage invite-only mode and invite quotas — per-invite max uses; no mode toggle
- [ ] View households and member counts (no access to financial contents by default) — not yet (no households)
- [~] System health: job queue status, failed jobs, email delivery failures — DB/cron/config status; no email failures
- [ ] Feature flags per user/household — not yet
- [x] Audit log viewer (admin actions, auth events) — `src/app/(app)/admin/audit/`
- [~] AI usage / cost metering per household — system-wide request count only; no cost
- [ ] Broadcast announcements (in-app banner) — not yet
- [x] Impersonation only with explicit user consent and full audit trail (or not at all) — no impersonation exists

## Security & isolation
- [x] Every query scoped by household/user ID (enforced in a data-access layer, not ad hoc) — user-scoped services + `src/server/services/ownership.ts`
- [x] Row-level security or equivalent tenant guard, with tests proving cross-tenant access fails — `assertOwned` + `tests/isolation.test.ts` (no DB RLS)
- [x] Authorization checks on every server action / route handler (role-based) — `userAction`/`userRoute` in `src/server/safe.ts`, admin `assertAdmin`
- [x] CSRF protection for mutations — server-action Origin check, `assertSameOrigin`, SameSite=Lax
- [x] Input validation on every endpoint (schema validation, e.g. zod)
- [~] Output encoding / no dangerous HTML; strict CSP headers — CSP still allows `'unsafe-inline'` scripts
- [x] Secure cookies (HttpOnly, Secure, SameSite) — `src/server/auth/current.ts`
- [x] Secrets only in env/secret store; none in client bundles — `server-only` modules
- [x] Rate limiting on auth, AI, import, and export endpoints — `src/server/auth/rate-limit.ts`
- [ ] Encryption at rest for sensitive fields (account numbers, notes) — not yet
- [~] Receipt/file storage with private buckets and signed, short-lived URLs — Postgres-stored, auth-gated route; no signed URLs
- [~] Upload validation (type sniffing, size limits, image re-encoding) — sniffing + size limit; no server re-encode
- [~] Audit log for sensitive actions (exports, deletes, role changes) — roles/auth/backup logged; not CSV exports/deletes
- [x] AI prompt-injection defenses: user data treated as data; tool calls scoped to the current tenant — `src/server/ai/tools.ts`, `tests/ai.test.ts`
- [ ] Dependency scanning and security headers checks in CI — not yet (no CI)
- [~] Clear "how we protect your data" page (trust cue) (research) — AI data section in settings only
- [x] Backups and a tested restore procedure — `docs/BACKUP_RECOVERY.md`, `tests/backup.test.ts`

## Accounts
- [x] Account types: cash, checking, savings, credit card, loan, investment, wallet/e-wallet, other asset/liability — `src/server/services/accounts.ts`
- [x] Opening balance and date
- [x] Per-account currency
- [x] Current balance computed from transactions, plus manual reconcile/adjust — `accountBalances`, reconcile dialog
- [~] Reconciliation flow: enter statement balance, then mark cleared transactions (research) — adjustment only; no mark-cleared step
- [x] Archive/close account (hidden but kept in history)
- [~] Include/exclude from net worth and from budgets — net worth only, not budgets
- [~] Account ordering, icons, colours — reordering only; no icon/colour picker
- [ ] Shared vs personal accounts within a household — not yet (no households)
- [ ] Balance history chart per account (research) — not yet

## Transactions (splits, refunds, transfers)
- [x] Create/edit/delete expense and income — `src/server/services/transactions.ts`
- [x] Fields: amount, date, account, category, merchant/payee, note, tags, attachments — `src/components/app/transaction-form.tsx`
- [~] Keypad-first amount entry with inline calculator (research) — inline +/− maths; no on-screen keypad
- [~] Recent/frequent category grid in entry form (research) — grid ordered by sort order, not usage
- [ ] Transaction templates / favourites for one-tap entry (research) — not yet
- [x] Duplicate transaction / "repeat last" — `duplicateTransaction`
- [~] Natural-language quick add ("coffee 4.5 yesterday #work") (research) — amount/merchant/date parsed; no #tags
- [~] Split transaction across multiple categories (amount or %) — amount splits only; no percentages
- [ ] Split one charge evenly across N months (amortize annual costs) (research) — not yet
- [ ] Transaction groups (bundle related items, e.g. a trip) (research) — not yet
- [x] Refunds: link to original purchase; net against original category — `refundTransaction`
- [x] Transfers between accounts (single linked pair; excluded from spend/income)
- [x] Credit card payment modelled as a transfer
- [x] Pending vs cleared status — `is_pending`
- [x] Multi-currency transactions with FX rate stored at entry time (research) — `fx_rate` / `base_amount`
- [~] Bulk select: re-categorize, tag, delete, move account — re-categorize and delete only
- [~] Undo for delete and bulk edits (toast with undo) — delete undo only; not bulk re-categorize
- [ ] Review inbox for auto-created/imported/OCR/AI items (research) — not yet
- [~] Duplicate detection on create/import — import only; not on manual create
- [ ] Swipe actions on mobile rows (edit, delete, split) — not yet
- [~] Infinite scroll / virtualized list with sticky date headers — "Load more" button; headers not sticky
- [x] Filters: date range, account, category, tag, merchant, amount range, type — `transactionFilters`
- [x] Running total of filtered results (research) — `summarizeTransactions`
- [ ] Location capture (optional, opt-in) — not yet
- [ ] Created-by attribution in shared households (research) — not yet (no households)

## Categories
- [x] Default category set on onboarding (editable) — `src/server/services/defaults.ts`
- [x] Category groups (parent/child, two levels) — `src/server/services/taxonomy.ts`
- [x] Custom icon and colour
- [x] Income vs expense categories
- [x] Reorder, rename, archive (preserve history) — `moveCategory`, `setCategoryArchived`
- [x] Merge categories (reassign transactions) — via delete-with-reassign (`deleteCategory`)
- [ ] Mark category as fixed / flexible / non-monthly (Flex model) (research) — not yet
- [x] Exclude category from budgets/reports (e.g. reimbursable) — `exclude_from_reports`
- [ ] Rules engine: conditions on merchant/note/amount/account, then set category/tags/merchant/split (research) — not yet
- [ ] Rule priority/ordering and a preview of matching transactions (research) — not yet
- [ ] "Create rule from this edit" prompt after re-categorizing (research) — not yet
- [~] AI category suggestions that learn from corrections (research) — learned merchant default category; not AI

## Income/salary
- [x] Income sources (salary, freelance, interest, other) — default income categories + income recurring items
- [~] Recurring salary schedule (monthly, biweekly, semi-monthly, custom) — no semi-monthly frequency
- [ ] Payday detection/suggestion from history (research) — not yet (detection covers expenses only)
- [~] Expected vs actual income per period — expected shown; no comparison view
- [x] Gross vs net with optional deductions breakdown (tax, retirement, insurance) — `gross_amount` / `deductions` on recurring income
- [ ] Paycheck planning: assign upcoming bills to the paycheck that covers them (research) — not yet
- [ ] Irregular income mode (budget from last month's income) (research) — not yet
- [x] Payday notification (opt-in) (research) — income reminders in `src/server/services/reminders.ts`

## Budgets & alerts
- [x] Monthly budget per category — `src/server/services/budgets.ts`
- [x] Weekly / yearly / custom-period budgets
- [x] Overall monthly spending budget
- [~] Per-category rollover (positive and/or negative) with optional starting balance (research) — previous-period carry only; no starting balance
- [ ] Copy last month's budget / budget from average of last N months (research) — not yet
- [ ] Suggested budgets from spending history (research) — not yet
- [x] Safe-to-spend figure: income minus bills, goals, and allotments (research) — `safeToSpend` in `src/server/services/forecast.ts`
- [ ] Flex budgeting mode: fixed / non-monthly / flexible buckets (research) — not yet
- [ ] Optional zero-based mode: "left to assign" must reach zero (research) — not yet
- [ ] Move money between categories to cover overspending (research) — not yet
- [ ] Hold surplus for next month (research) — not yet
- [x] Progress bars with pace indicator (spent vs expected by today) — `budgets-view.tsx`
- [x] Colour states: on track / warning / over (not colour-only; see Accessibility) — icon + label badges
- [x] Threshold alerts at configurable % (default 80% / 100%), at most once per threshold per period — `generateBudgetAlerts` (defaults 50/75/90/100)
- [x] Pace alert: "on track to exceed by $X" (research) — `alert_on_projected`
- [ ] Snooze an alert/target for the current period (research) — not yet
- [ ] Shared household budgets (research) — not yet
- [x] Budget history and month-over-month comparison — `budgetHistory`, `budget-history-chart.tsx`

## Recurring/bills/subscriptions
- [~] Manual recurring transactions with flexible schedules (daily/weekly/biweekly/monthly/yearly/custom, nth weekday, end date/count) — no nth-weekday or occurrence count
- [x] Auto-post vs require approval (planned payments) (research) — `auto_post`
- [ ] Convert an existing transaction into a recurring item (research) — not yet
- [x] Recurring detection from history (same merchant, similar amount, regular interval) presented as suggestions (research) — `detectRecurringCandidates`
- [ ] Auto-match logged transactions to expected recurring items (research) — not yet
- [x] Bills list: upcoming, due, overdue, paid states (research) — `upcomingOccurrences`, `recurring-view.tsx`
- [x] Subscriptions view with monthly and annualized total cost (research) — `recurringCostSummary`
- [~] Price-increase detection and alert (research) — detected and shown; no notification
- [~] Missed/unexpected-charge detection (expected charge didn't happen) (research) — overdue badge only; no detection
- [x] Free-trial ending reminders (research) — `src/server/services/reminders.ts`
- [~] Mark subscription as cancelled; track savings from cancellations (research) — cancel supported; no savings tracking
- [x] Bill reminders N days before due (per bill override) — `remind_days_before`
- [ ] Variable bill amounts (estimate from last N) — not yet
- [x] Recurring transfers (e.g. savings contributions)

## Goals
- [x] Savings goals with target amount and optional target date — `src/server/services/goals.ts`
- [x] Required monthly contribution computed from target date (research) — `computeProgress`
- [x] Link goal to account or track via contributions
- [ ] Sinking funds (e.g. car insurance every 6 months) (research) — not yet
- [ ] Debt payoff goals (snowball / avalanche comparison) (research) — not yet
- [x] Progress bar, projected completion date, on-track status
- [x] Goal contributions reduce safe-to-spend (research) — `goalCommitmentsThisMonth`
- [~] Milestone celebrations (25/50/75/100%), subtle and not spammy — 100% "goal reached" only
- [~] Pause / archive / complete goals — complete/archive only; no pause
- [ ] Shared household goals — not yet

## Net worth
- [x] Assets minus liabilities from account balances — `src/server/services/networth.ts`
- [~] Manual assets (property, vehicle, valuables) with value history — "asset" accounts; no per-asset history
- [~] Manual liabilities (loans, mortgages) with balance history — loan accounts; no per-loan history
- [x] Net worth trend chart (monthly snapshots) — `net-worth-chart.tsx`
- [x] Breakdown by asset class / account type
- [~] Month-over-month change with drivers (research) — change shown; no drivers
- [x] Multi-currency conversion to home currency (research)
- [x] Monthly snapshot job (so history persists even without daily data) — daily snapshot in `src/server/services/cron.ts`

## Credit cards
- [x] Credit limit, statement closing day, payment due day, APR — account fields
- [x] Current balance and statement balance — `src/server/services/credit.ts`
- [x] Utilization % per card and overall, with threshold warning (e.g. above 30%)
- [x] Payment due reminders (statement balance and minimum) — `generateCreditCardReminders`
- [ ] Track spending on card vs funds set aside to pay it (YNAB-style payment reserve) (research) — not yet
- [x] Mark payments as transfers from a checking account
- [ ] Interest estimate if carrying a balance — not yet (APR displayed only)
- [ ] Rewards/cashback tracking (optional) — not yet
- [ ] Statement cycle view (transactions in current cycle) — not yet

## Calendar
- [x] Month grid with daily expense/income totals (research) — `src/server/services/calendar.ts`
- [~] Spending heatmap intensity per day (research) — heatmap on Daily analytics, not calendar
- [x] Upcoming bills, paydays, and goal deadlines on calendar (research)
- [x] Tap a day to see its transactions and add one for that date (research)
- [ ] Week and agenda views — not yet
- [x] Projected balance per day (links to forecasting) (research)
- [~] Credit card due/statement dates shown — due dates only; no statement dates
- [ ] Export calendar feed (ICS) for bills (optional) — not yet

## Analytics
- [x] Spending by category (donut/bar) for a selected period — `src/server/services/analytics.ts`
- [x] Income vs expense over time (cash flow)
- [x] Category trend over months — `categoryTrends`
- [x] Top merchants — `src/app/(app)/analytics/merchants/`
- [x] Month-over-month and year-over-year comparisons — deltas vs previous equal-length period
- [~] Average daily spend; projected month-end spend — average only; no month-end projection
- [x] Savings rate %
- [x] Fixed vs flexible spend breakdown (research) — recurring vs discretionary
- [~] Tag-based reports (e.g. trip, project) — tag filter totals only; no report
- [~] Drill-down from any chart to underlying transactions — category/account/largest links only
- [ ] Custom query/report builder (group by, filter, granularity) (research) — not yet
- [ ] Per-member breakdown in households — not yet (no households)
- [x] Charts accessible: table alternative, keyboard navigable, not colour-only — `DataTable` toggle in `chart-kit.tsx`

## Daily view
- [~] Today's spend vs daily allowance (safe-to-spend / days remaining) (research) — allowance shown; not compared to today
- [x] Today's transactions list with quick add — `src/app/(app)/analytics/daily/`
- [~] Bills due today/tomorrow — dashboard Upcoming widget, not daily view
- [~] Day-by-day navigation (prev/next, swipe) — heatmap jump; no prev/next/swipe
- [ ] Daily totals summary by category — not yet
- [x] "No spend day" marker (opt-in, low-key) — `noSpendDays`

## Merchants
- [~] Merchant entity with normalized name (e.g. "AMZN MKTP US*2K3" becomes "Amazon") — case/whitespace normalization only
- [~] Merchant aliases and merge — merge via rename; no aliases
- [x] Default category per merchant — learned `default_category_id`
- [ ] Merchant logo/icon (optional; favicon or initials) — not yet
- [x] Merchant detail page: total spend, frequency, average ticket, trend — `merchantDetail`
- [~] Merchant autocomplete in entry form (recent first) — ranked by frequency, not recency
- [ ] Recurring-merchant indicator (research) — not yet

## Receipts/OCR
- [x] Attach photos/PDFs to transactions — `src/server/services/receipts.ts`
- [x] Camera capture on mobile (PWA) — `receipt-scanner.tsx`
- [x] OCR extracts amount, date, merchant, tax, and line items (research) — `src/lib/receipt-parse.ts`, `src/server/ai/receipt.ts`
- [~] Prefilled transaction lands in review inbox for confirmation (research) — prefills form to confirm; no inbox
- [ ] Line items can become a split transaction — not yet (items go to notes)
- [ ] Receipt thumbnail gallery and search by receipt text — not yet
- [~] Image compression before upload — scanner path only; direct attach uncompressed
- [ ] Email-in receipts (forward to address) (optional) — not yet

## Forecasting
- [x] Cash-flow projection from recurring income/bills (30/60/90 days) (research) — `cashFlowForecast`
- [~] Projected balance per account with low-balance warning (research) — aggregate liquid balance only, not per account
- [~] Month-end spending projection from current pace — per-budget projection only
- [~] "Can I afford it?" what-if simulation (one-off purchase) (research) — AI what-if covers category cuts only
- [x] Goal completion projections
- [ ] Days-of-buffer metric (how long savings cover expenses) (research) — not yet
- [~] Shortfall alerts before payday (research) — flagged in forecast; no alert

## AI assistant/actions/insights
- [x] Chat assistant answering questions grounded in the user's data ("how much on dining in March?") (research) — `src/server/ai/assistant.ts`
- [x] Tool-based querying (structured queries, not raw data dumps) scoped to the current household — `src/server/ai/tools.ts` (user-scoped)
- [~] Cites the transactions/figures used in answers — lists tools used; no per-figure citations
- [~] Actions: create transaction, re-categorize, create budget/goal/rule, all **proposed as a preview diff then confirmed** (research) — no rule creation
- [~] Undo for every AI-applied action — undo for deletions only
- [x] Natural-language transaction entry parsing (research) — `src/server/ai/parse.ts`, `src/lib/nl-parse.ts`
- [~] Auto-categorization suggestions with confidence; learns from corrections (research) — merchant memory; confidence only in NL parse
- [~] Insights: anomalies, category spikes vs 3-month average, new recurring charges, price increases (research) — anomalies, MoM spikes; no recurring/price
- [ ] Weekly recap: spend drivers, recurring changes, net-worth delta (in-app + optional email) (research) — not yet
- [ ] Monthly review summary draft (see Monthly review) — not yet
- [ ] User-provided context (household size, goals) to personalize advice, opt-in (research) — not yet
- [~] Clear disclosure: not financial advice; data handling explained — data handling explained; no not-advice notice
- [x] AI opt-out entirely; per-feature toggles — `src/app/(app)/settings/ai/`
- [x] Usage limits and graceful fallback when AI unavailable — `assertAiQuota`, local parser fallback
- [x] Conversation history with delete — `deleteConversation`

## Notifications
- [x] In-app notification center (read/unread, mark all read) — `notification-bell.tsx`, `src/server/services/notifications.ts`
- [x] Web push (PWA), only requested after a user gesture once the value is clear (research) — `push-toggle.tsx`
- [ ] Email notifications and digests — not yet
- [~] Per-type toggles and per-channel preferences — per-type toggles; push on/off only
- [~] Types: bill due, budget threshold, unusual charge, price increase, goal milestone, payday, weekly recap, invite events — no unusual/price/recap/invite types
- [x] Batching/coalescing of similar events (research) — push coalescing + payments digest
- [x] Frequency cap per user per day (research) — `max_per_day`
- [~] Digest mode (daily/weekly) for informational items (research) — fixed daily payments digest only
- [x] Quiet hours and timezone-aware delivery (research) — `inQuietHours`
- [ ] Snooze individual notifications/alerts (research) — not yet
- [x] Deduplicate: same alert at most once per period — `dedupe_key`
- [x] Deep links from notification to relevant screen
- [x] Gentle optional daily logging reminder (off by default, no streak guilt) — `daily_reminder_enabled`
- [ ] Unsubscribe link in every email — not yet (no notification emails)

## PWA
- [x] Web app manifest (name, icons, maskable icons, theme colour, `display: standalone`) — `public/manifest.webmanifest`
- [~] Service worker with app-shell caching — static assets + offline page only
- [ ] Offline viewing of recent data — not yet (authenticated pages never cached)
- [ ] Offline transaction entry queue with background sync on reconnect (research) — not yet
- [ ] Conflict handling for offline edits — not yet
- [x] Install prompt (custom, non-intrusive) and iOS "Add to Home Screen" instructions (research) — `install-prompt.tsx`
- [x] iOS web push support (installed PWA, iOS 16.4+) (research) — `push-toggle.tsx`
- [x] Safe-area insets, bottom tab bar, large floating add button — `mobile-nav.tsx`
- [~] App shortcuts (manifest `shortcuts`: Add expense, Scan receipt) — Add expense only; no Scan receipt
- [ ] Share target (share receipt image into app) (optional) — not yet
- [x] Update available prompt when a new service worker is waiting — `sw-register.tsx`

## Reports
- [x] Monthly report (income, expense, savings rate, top categories, budget performance) — `src/server/services/reports.ts`
- [x] Yearly summary / year in review
- [~] Category report and tag report — category only; no tag report
- [ ] Tax-relevant report (tagged deductible expenses) — not yet
- [x] Net worth report
- [x] Printable / PDF export of reports — print stylesheet in `report-view.tsx`, CSV export
- [ ] Scheduled email report (opt-in) — not yet
- [ ] Saved custom reports (research) — not yet

## Import/Export
- [~] CSV import with column mapping and saved mapping presets — mapping yes; no saved presets
- [x] Date/amount format detection (locale, negative conventions, debit/credit columns) — `src/lib/csv-import.ts`
- [~] Preview, duplicate detection, and rule application before commit — no rule application (no rules engine)
- [ ] OFX/QIF import (research) — not yet
- [ ] Import from YNAB / other app exports (research) — not yet
- [x] Import history with undo (roll back an import batch) — `undoImportBatch`
- [x] CSV export of transactions (filtered) — `src/app/api/export/transactions/`
- [x] Full data export (JSON) for portability — `src/app/api/export/backup/`
- [ ] Export receipts archive (zip) — not yet (backup has receipt metadata only)
- [ ] Read-only API/personal access tokens (optional, later) (research) — not yet

## Dashboard personalization
- [x] Hero metric: safe to spend / left in budget (research) — `safe-to-spend-widget.tsx`
- [~] Widget cards: budgets, upcoming bills, recent transactions, net worth, goals, cash-flow forecast, AI insights, weekly recap — no cash-flow or weekly-recap widget
- [~] Show/hide, reorder (drag and drop + keyboard), and resize widgets — show/hide + up/down only; no drag/resize
- [x] Per-user layout saved server-side — `dashboard_widgets`
- [~] Period selector (this month, last month, custom) — default range in Settings; none on dashboard
- [x] Sensible default layout for new users; reset to default — `appearance-form.tsx`
- [ ] Privacy mode (blur amounts) toggle (research) — not yet

## Command palette & quick actions
- [x] Global command palette (Cmd/Ctrl+K) — `src/components/shell/command-palette.tsx`
- [x] Actions: add expense/income/transfer, go to page, search transactions, create budget/goal
- [x] Natural-language add directly from palette (research) — "Quick entry" group
- [~] Keyboard shortcuts (N for new, / for search, G then D for dashboard, ? for help overlay) — only ⌘K and N
- [~] Recent items and fuzzy matching — fuzzy filtering; no recent items
- [x] Floating quick-add button on mobile — `mobile-nav.tsx`
- [x] Long-press / app-shortcut quick actions (PWA shortcuts) — manifest `shortcuts`

## Monthly review
- [~] Guided month-close flow: review uncategorized/inbox items, reconcile accounts, review budgets (research) — read-only summary; no guided steps
- [~] Budget vs actual per category with notes — budget vs actual; no notes
- [~] Highlights: biggest changes, new subscriptions, price increases (research) — category changes only
- [~] Goal progress and net-worth change — goal contributions only; no net worth
- [ ] AI-drafted summary that the user can edit (research) — not yet
- [ ] Set next month's budgets (copy/adjust/suggested) (research) — not yet
- [~] Handle rollovers at month close — automatic budget rollover; not in review
- [~] Mark month as reviewed; review history — month picker; no reviewed state

## Global search
- [x] Search across transactions, merchants, categories, notes, tags, accounts, goals — `src/server/services/search.ts`
- [~] Amount search (exact, ranges, ">50") — exact only; ranges via filters, no ">50"
- [ ] Date-aware queries ("last month", "march") — not yet
- [ ] Receipt text search (OCR content) — not yet
- [ ] Saved searches / filters — not yet
- [x] Result totals (sum, count) (research) — `summarizeTransactions` on `/transactions?q=`
- [~] Fast, server-side indexed (full-text) with highlighting — trigram indexes + LIKE; no highlighting

## Settings
- [~] Profile (name, avatar, email change with verification) — name only; no avatar/email change
- [x] Home currency, locale, number/date formats — `src/app/(app)/settings/profile-form.tsx`
- [x] First day of week; budget month start day (e.g. payday-aligned) (research)
- [x] Timezone
- [x] Theme: light/dark/system
- [x] Notification preferences (see Notifications) — `src/app/(app)/settings/notifications/`
- [ ] Household management (members, roles, invites) — not yet
- [~] Security (password, 2FA, sessions, passkeys) — password and sessions only
- [x] AI preferences and data controls — `src/app/(app)/settings/ai/`
- [x] Data: import, export, delete account — `settings/data`, `/import`, `settings/security`
- [~] Default account and category for quick add — account/payment method; no default category
- [ ] Privacy mode default — not yet

## Accessibility
- [~] WCAG 2.2 AA conformance target — good practices in code; no stated target/audit
- [x] Full keyboard navigation and visible focus states — global `:focus-visible`, Radix primitives
- [x] Semantic HTML and correct ARIA for custom widgets (dialogs, comboboxes, tabs) — Radix + cmdk
- [~] Screen-reader-friendly amounts (currency read correctly, sign announced) — visible signs only; no SR labels
- [x] Status never conveyed by colour alone (icons/labels for over/under budget)
- [~] Sufficient contrast in light and dark themes — not verified or audited
- [x] Respect `prefers-reduced-motion` — `src/app/globals.css`
- [~] Touch targets at least 44x44px — default buttons are 36px
- [x] Chart alternatives (data tables, summaries) — `DataTable` in `chart-kit.tsx`
- [~] Form errors announced and linked to fields — announced; `aria-describedby` linking inconsistent
- [~] Zoom/reflow to 320px without horizontal scrolling — mobile layouts; 320px not verified
- [ ] Automated a11y checks (axe) in CI plus manual screen-reader passes — not yet

## Performance
- [ ] Core Web Vitals budget (LCP < 2.5s, INP < 200ms, CLS < 0.1) on mid-range mobile — not yet
- [x] Server components / streaming for data-heavy pages — server pages + `loading.tsx`
- [ ] Optimistic UI for transaction create/edit — not yet
- [ ] Virtualized long lists — not yet
- [x] Database indexes on (household_id, date), (household_id, category_id), merchant, full-text — user-scoped indexes + trigram in `schema.ts`
- [ ] Pre-aggregated monthly totals / materialized summaries for dashboards — not yet
- [~] Pagination/cursor-based APIs — offset pagination, not cursor
- [~] Code splitting; lazy-load charts and OCR — OCR lazy-loaded; charts not
- [~] Image optimization for receipts and icons — client compression in scanner only
- [~] Caching with correct invalidation on mutations — no data cache; `refresh()` after mutations
- [~] Background jobs for recurring generation, detection, digests, snapshots — daily cron; detection computed on demand
- [ ] Performance monitoring and error tracking in production — not yet

## Testing
- [x] Unit tests for money math (integer minor units, rounding, FX, splits, rollovers) — `tests/money.test.ts`, `tests/budgets.test.ts`
- [~] Unit tests for recurrence schedule generation (month-end, leap years, DST, timezones) — month-end and leap years; no DST/timezone
- [x] Unit tests for recurring/subscription detection heuristics — `tests/recurring.test.ts`
- [ ] Unit tests for rules engine ordering and matching — not yet (no rules engine)
- [x] Integration tests for server actions/APIs with auth and role checks — `tests/admin.test.ts`, `tests/security.test.ts`
- [x] Tenant-isolation tests (cross-household access must fail for every resource) — `tests/isolation.test.ts` + per-feature
- [~] Import parser tests with real-world CSV/OFX fixtures — inline CSV samples; no OFX
- [~] E2E tests (Playwright) for critical flows: sign-up/invite, add expense, budget alert, import, month review — invite + expense only
- [ ] PWA offline queue tests — not yet
- [x] AI action tests: proposals are never applied without confirmation; tool scoping — `tests/ai.test.ts`
- [ ] Accessibility tests (axe) in E2E — not yet
- [ ] Visual regression for key screens (light/dark, mobile/desktop) — not yet
- [x] Notification dedup/frequency-cap tests — `tests/reminders.test.ts`
- [x] CI pipeline: typecheck, lint, test, build on every change — `.github/workflows/ci.yml`
- [~] Seed data / fixtures for local dev and demos — test fixtures only; no demo seed
