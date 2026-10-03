# Engineering conventions

Read this before changing code. It's the contract that keeps the codebase consistent.

## Stack
Next.js 16 (App Router, **`src/proxy.ts` not middleware**, async `params`/`searchParams`/`cookies()`,
global `PageProps<"/route">` / `LayoutProps<"/">` types — run `npx next typegen` after adding routes),
React 19, TypeScript strict, Tailwind v4 (tokens in `src/app/globals.css`), Radix (`radix-ui` package),
Drizzle ORM + PostgreSQL (`postgres` driver), Zod 4, Recharts 3, lucide-react, sonner, cmdk.
Next 16 docs live in `node_modules/next/dist/docs/` — check them when unsure; APIs differ from older versions.

## Layers
- `src/server/db/schema.ts` — the schema. **Frozen**: don't edit it or generate migrations without the lead's go-ahead.
- `src/server/services/*.ts` — business logic. Every function takes `userId` as its first argument and
  **every query filters by `user_id`**. No `next/*` imports here (services are unit-tested under Vitest).
  Validate referenced ids with `assertOwned(userId, {...})` from `services/ownership.ts`
  (prevents attaching your records to someone else's account/category).
  Throw `AppError` (`src/server/errors.ts`) for user-facing errors. Multi-step writes use `db.transaction`.
- `src/app/(app)/<area>/actions.ts` — `"use server"` files exporting actions built with
  `userAction(zodSchema, async (input, { userId }) => …)` from `src/server/safe.ts`. Call `refresh()`
  from `next/cache` after mutations. Never accept a userId from the client.
- Route handlers: wrap with `userRoute(...)` (auth + same-origin check for mutations + safe errors).
- Pages are Server Components that call `requireUserPage()` (from `src/server/auth/current.ts`) and read
  via services; interactive parts are client components receiving plain serialisable props.

## Money & dates
- Money is a **decimal string** everywhere (`"1234.5000"`). Use `src/lib/money.ts` (`add`, `sub`, `mul`,
  `cmp`, `ratio`, `formatMoney`…). Never `parseFloat` money for arithmetic; `toNumber` only for chart geometry.
- In SQL, aggregate `numeric` and cast `::text`. Use `base_amount` (user base currency) for cross-account totals.
- Spending = expenses − refunds. Transfers are never income or spending. Adjustments are excluded from analytics.
- Splits: a transaction with `has_splits` has its category breakdown in `transaction_splits` (use the
  `LEFT JOIN transaction_splits` + `COALESCE(s.category_id, t.category_id)` / `COALESCE(s.base_amount, t.base_amount)` pattern).
- Dates are `YYYY-MM-DD` strings in the user's timezone; use `src/lib/dates.ts`. "Today" = `prefs.today`
  from `getPreferences(userId)`. Recurrence math: `src/lib/recurrence.ts`.
- Soft-deleted transactions: always filter `deleted_at IS NULL`.

## UI
- Components: `src/components/ui/*` (Button, Input, NativeSelect, Textarea, Field, Card, Badge, Dialog/DialogContent
  (bottom sheet on mobile), ConfirmDialog, DropdownMenu, Popover, Tooltip, Tabs, Segmented, Switch, Checkbox, Progress,
  Skeleton, EmptyState, PageHeader, ErrorState, Kbd).
  App components: `Money` (`src/components/app/money.tsx`), `useMoney()`, `useAppData()` (user, prefs, accounts,
  categories, paymentMethods), `CategoryBadge`/`Icon`/`ICON_NAMES`/`CATEGORY_COLORS` (`src/components/app/icons.tsx`),
  `useShell().openQuickAdd(preset)` to open the global add-transaction sheet.
- Design: premium, calm, minimal. Neutral surfaces, ink primary buttons, colour only for meaning
  (`text-positive`, `text-negative`, `text-warning`, `bg-*-soft`). Tabular numbers: add the `num` class.
  Page layout: `<PageHeader title description actions />` then content. Prefer lists with dividers inside a
  single `Card` over grids of many small cards. Generous whitespace; 13–15px text; no gradients.
- Every async UI needs loading, empty, error and success states (toasts via `sonner`). Destructive actions use
  `ConfirmDialog`. Forms show field errors from `fieldErrors`. All inputs have labels; dialogs have titles.
- Mobile first: works at 360px; touch targets ≥ 40px; the mobile bottom nav overlaps the last 80px (main already pads).
- Charts: Recharts, colours from `src/components/charts/palette.ts` (validated categorical order; never cycle;
  fold 9+ series into "Other"; one y-axis; text in text tokens; forecasts dashed in `COLORS.forecast`;
  tooltips on hover). Category breakdowns: sorted horizontal bars with the category's icon badge as identity
  rather than a 15-colour donut. Every chart needs an accessible table/summary alternative.
- Never hardcode financial values, merchants, currencies or users anywhere. Defaults must be editable.

## Tests
Vitest against a real Postgres test DB (`npm test`; migrations applied fresh each run). Helpers in
`tests/helpers.ts` (`makeUser`, `makeAccount`, `category`). Include isolation checks (user B can't
read/modify/reference user A's records) for every new service. Run `npx vitest run tests/<file>` for your files.
Don't run `next build` or `next dev` (other people are working in the same tree); use `npx tsc --noEmit` and
`npx eslint <your files>`.
