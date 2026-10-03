/**
 * Kosh database schema (PostgreSQL, Drizzle ORM).
 *
 * Conventions
 * - Every user-owned table carries `user_id` (even child tables such as splits) so that every
 *   query can be scoped by the authenticated user without joins. Services MUST filter on it.
 * - Money is `numeric(19,4)` and travels through the app as decimal strings (see src/lib/money.ts).
 *   Never floats.
 * - `base_amount` is the amount converted to the user's base currency at entry time (fx_rate),
 *   so analytics can aggregate across currencies exactly.
 * - Calendar dates (transaction date, due dates) are `date` columns interpreted in the user's
 *   timezone; instants are `timestamptz`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const money = (name: string) => numeric(name, { precision: 19, scale: 4 });
const rate = (name: string) => numeric(name, { precision: 20, scale: 10 });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const userRef = () =>
  uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

/* ───────────────────────────── Enums ───────────────────────────── */

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const invitationStatus = pgEnum("invitation_status", ["active", "revoked"]);
export const accountType = pgEnum("account_type", [
  "checking",
  "savings",
  "cash",
  "wallet",
  "credit_card",
  "investment",
  "loan",
  "asset",
  "other",
]);
export const transactionType = pgEnum("transaction_type", [
  "expense",
  "income",
  "transfer",
  "refund",
  "adjustment",
]);
export const transactionSource = pgEnum("transaction_source", [
  "manual",
  "import",
  "recurring",
  "ai",
  "receipt",
  "restore",
]);
export const paymentMethodType = pgEnum("payment_method_type", [
  "cash",
  "bank_transfer",
  "debit_card",
  "credit_card",
  "upi",
  "wallet",
  "other",
]);
export const categoryKind = pgEnum("category_kind", ["expense", "income"]);
export const recurrenceFrequency = pgEnum("recurrence_frequency", [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
  "custom",
]);
export const recurrenceUnit = pgEnum("recurrence_unit", ["day", "week", "month", "year"]);
export const recurringKind = pgEnum("recurring_kind", [
  "expense",
  "bill",
  "subscription",
  "income",
  "transfer",
]);
export const recurringStatus = pgEnum("recurring_status", ["active", "paused", "cancelled", "ended"]);
export const budgetPeriod = pgEnum("budget_period", ["weekly", "monthly", "yearly", "custom"]);
export const goalStatus = pgEnum("goal_status", ["active", "completed", "archived"]);
export const aiActionStatus = pgEnum("ai_action_status", [
  "pending",
  "confirmed",
  "cancelled",
  "failed",
  "expired",
]);

/* ─────────────────────────── Authentication ─────────────────────────── */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("user"),
    status: userStatus("status").notNull().default("active"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token. The raw token only ever lives in the user's cookie. */
    id: text("id").primaryKey(),
    userId: userRef(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 of the normalized invite code. The plaintext code is shown once, at creation. */
    codeHash: text("code_hash").notNull(),
    codePrefix: text("code_prefix").notNull(),
    label: text("label"),
    email: text("email"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: invitationStatus("status").notNull().default("active"),
    role: userRole("role").notNull().default("user"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_code_hash_uq").on(t.codeHash),
    check("invitations_max_uses_ck", sql`${t.maxUses} >= 1`),
    check("invitations_use_count_ck", sql`${t.useCount} >= 0 AND ${t.useCount} <= ${t.maxUses}`),
  ],
);

export const invitationRedemptions = pgTable(
  "invitation_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    userId: userRef(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invitation_redemptions_invitation_idx").on(t.invitationId)],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("password_reset_token_hash_uq").on(t.tokenHash), index("password_reset_user_idx").on(t.userId)],
);

/** Fixed-window rate limiter shared across serverless instances. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_created_idx").on(t.createdAt), index("audit_logs_actor_idx").on(t.actorId)],
);

/* ─────────────────────────── Preferences ─────────────────────────── */

export type DashboardWidget = { id: string; visible: boolean };

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("UTC"),
  locale: text("locale").notNull().default("en-US"),
  theme: text("theme").notNull().default("system"),
  /** 0 = Sunday, 1 = Monday */
  weekStartsOn: smallint("week_starts_on").notNull().default(1),
  /** Day of month budgets/"this month" start on (e.g. payday). 1-28. */
  monthStartDay: smallint("month_start_day").notNull().default(1),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  aiInsightsEnabled: boolean("ai_insights_enabled").notNull().default(true),
  dashboardWidgets: jsonb("dashboard_widgets").$type<DashboardWidget[]>(),
  defaultDateRange: text("default_date_range").notNull().default("this_month"),
  defaultAccountId: uuid("default_account_id"),
  defaultPaymentMethodId: uuid("default_payment_method_id"),
  /** User-declared expected monthly income (used when no income schedule exists). */
  expectedMonthlyIncome: money("expected_monthly_income"),
  updatedAt: updatedAt(),
});

/** Manual exchange rates: 1 unit of `currency` = `rate` units of the user's base currency. */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    userId: userRef(),
    currency: text("currency").notNull(),
    rate: rate("rate").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.currency] }), check("exchange_rates_positive_ck", sql`${t.rate} > 0`)],
);

/* ─────────────────────────── Financial core ─────────────────────────── */

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    currency: text("currency").notNull(),
    openingBalance: money("opening_balance").notNull().default("0"),
    openingDate: date("opening_date"),
    institution: text("institution"),
    notes: text("notes"),
    color: text("color"),
    icon: text("icon"),
    includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
    isArchived: boolean("is_archived").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    // Credit card / loan details (nullable for other account types)
    creditLimit: money("credit_limit"),
    statementDay: smallint("statement_day"),
    dueDay: smallint("due_day"),
    minimumPayment: money("minimum_payment"),
    annualFee: money("annual_fee"),
    interestRate: numeric("interest_rate", { precision: 7, scale: 4 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("accounts_user_idx").on(t.userId),
    check("accounts_statement_day_ck", sql`${t.statementDay} IS NULL OR (${t.statementDay} BETWEEN 1 AND 31)`),
    check("accounts_due_day_ck", sql`${t.dueDay} IS NULL OR (${t.dueDay} BETWEEN 1 AND 31)`),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: categoryKind("kind").notNull().default("expense"),
    icon: text("icon").notNull().default("circle"),
    color: text("color").notNull().default("#64748b"),
    sortOrder: integer("sort_order").notNull().default(0),
    isArchived: boolean("is_archived").notNull().default(false),
    /** Marks categories whose spending is excluded from "spending" totals (e.g. internal moves). */
    excludeFromReports: boolean("exclude_from_reports").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("categories_user_idx").on(t.userId),
    uniqueIndex("categories_user_parent_name_uq")
      .on(t.userId, t.kind, sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`),
  ],
);

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    /** Learned from the user's last categorisation of this merchant. */
    defaultCategoryId: uuid("default_category_id").references(() => categories.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("merchants_user_normalized_uq").on(t.userId, t.normalizedName),
    index("merchants_name_trgm_idx").using("gin", sql`${t.normalizedName} gin_trgm_ops`),
  ],
);

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    name: text("name").notNull(),
    type: paymentMethodType("type").notNull().default("other"),
    defaultAccountId: uuid("default_account_id").references(() => accounts.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("payment_methods_user_name_uq").on(t.userId, sql`lower(${t.name})`)],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tags_user_name_uq").on(t.userId, sql`lower(${t.name})`)],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    filename: text("filename"),
    rowCount: integer("row_count").notNull().default(0),
    importedCount: integer("imported_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("import_batches_user_idx").on(t.userId)],
);

export const recurringTransactions = pgTable(
  "recurring_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    kind: recurringKind("kind").notNull().default("expense"),
    name: text("name").notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    toAccountId: uuid("to_account_id").references(() => accounts.id, { onDelete: "set null" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    merchantId: uuid("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, { onDelete: "set null" }),
    notes: text("notes"),
    frequency: recurrenceFrequency("frequency").notNull().default("monthly"),
    /** For `custom`: every `interval` `intervalUnit`s. Ignored otherwise. */
    interval: integer("interval").notNull().default(1),
    intervalUnit: recurrenceUnit("interval_unit").notNull().default("month"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextDate: date("next_date"),
    /** Create the transaction automatically on its due date (otherwise it waits for "Mark paid"). */
    autoPost: boolean("auto_post").notNull().default(false),
    remindDaysBefore: smallint("remind_days_before").notNull().default(2),
    status: recurringStatus("status").notNull().default("active"),
    // Subscription-specific
    serviceUrl: text("service_url"),
    trialEndsAt: date("trial_ends_at"),
    cancelledAt: date("cancelled_at"),
    // Income-specific (salary breakdown). `amount` is the net amount received.
    employer: text("employer"),
    grossAmount: money("gross_amount"),
    deductions: jsonb("deductions").$type<{ label: string; amount: string; kind: "tax" | "deduction" | "bonus" }[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("recurring_user_next_idx").on(t.userId, t.nextDate),
    check("recurring_amount_positive_ck", sql`${t.amount} > 0`),
    check("recurring_interval_ck", sql`${t.interval} >= 1`),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    type: transactionType("type").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Positive magnitude in the account's currency. Direction is implied by `type`.
     *  Exception: `adjustment` may be negative. */
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    /** 1 unit of `currency` = fx_rate units of the user's base currency. */
    fxRate: rate("fx_rate").notNull().default("1"),
    baseAmount: money("base_amount").notNull(),
    /** When paid in a foreign currency (e.g. €20 charged to an INR card): what was actually paid. */
    originalAmount: money("original_amount"),
    originalCurrency: text("original_currency"),
    date: date("date").notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    merchantId: uuid("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, { onDelete: "set null" }),
    notes: text("notes"),
    // Transfers: money leaves `account_id` and arrives in `to_account_id` as `to_amount`.
    toAccountId: uuid("to_account_id").references(() => accounts.id, { onDelete: "cascade" }),
    toAmount: money("to_amount"),
    // Refunds link to the original expense.
    refundOfId: uuid("refund_of_id").references((): AnyPgColumn => transactions.id, { onDelete: "set null" }),
    recurringId: uuid("recurring_id").references(() => recurringTransactions.id, { onDelete: "set null" }),
    /** The scheduled occurrence this transaction fulfils (idempotency key with recurring_id). */
    recurringDate: date("recurring_date"),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id, { onDelete: "set null" }),
    /** Fingerprint for duplicate detection on import. */
    importHash: text("import_hash"),
    hasSplits: boolean("has_splits").notNull().default(false),
    isPending: boolean("is_pending").notNull().default(false),
    source: transactionSource("source").notNull().default("manual"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("transactions_user_date_idx").on(t.userId, t.date.desc(), t.createdAt.desc()),
    index("transactions_user_account_idx").on(t.userId, t.accountId, t.date),
    index("transactions_to_account_idx").on(t.toAccountId),
    index("transactions_user_category_idx").on(t.userId, t.categoryId, t.date),
    index("transactions_user_merchant_idx").on(t.userId, t.merchantId, t.date),
    index("transactions_refund_of_idx").on(t.refundOfId),
    index("transactions_user_import_hash_idx").on(t.userId, t.importHash),
    index("transactions_notes_trgm_idx").using("gin", sql`${t.notes} gin_trgm_ops`),
    uniqueIndex("transactions_recurring_occurrence_uq").on(t.recurringId, t.recurringDate),
    check(
      "transactions_amount_ck",
      sql`(${t.type} = 'adjustment' AND ${t.amount} <> 0) OR (${t.type} <> 'adjustment' AND ${t.amount} > 0)`,
    ),
    check(
      "transactions_transfer_ck",
      sql`(${t.type} = 'transfer') = (${t.toAccountId} IS NOT NULL) AND (${t.toAccountId} IS NULL OR ${t.toAccountId} <> ${t.accountId})`,
    ),
  ],
);

export const transactionSplits = pgTable(
  "transaction_splits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    amount: money("amount").notNull(),
    baseAmount: money("base_amount").notNull(),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("transaction_splits_txn_idx").on(t.transactionId),
    index("transaction_splits_user_category_idx").on(t.userId, t.categoryId),
    check("transaction_splits_amount_ck", sql`${t.amount} > 0`),
  ],
);

export const transactionTags = pgTable(
  "transaction_tags",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    userId: userRef(),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] }), index("transaction_tags_tag_idx").on(t.tagId)],
);

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** File bytes are stored in Postgres so receipts share the database's backups. */
    data: bytea("data").notNull(),
    ocrText: text("ocr_text"),
    extracted: jsonb("extracted").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("receipts_user_idx").on(t.userId), index("receipts_txn_idx").on(t.transactionId)],
);

/* ─────────────────────────── Planning ─────────────────────────── */

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    name: text("name").notNull(),
    period: budgetPeriod("period").notNull().default("monthly"),
    /** null = overall spending budget */
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    includeSubcategories: boolean("include_subcategories").notNull().default(true),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    /** Custom-period window; for weekly/monthly/yearly only `startDate` (anchor) is used. */
    startDate: date("start_date"),
    endDate: date("end_date"),
    rollover: boolean("rollover").notNull().default(false),
    alertsEnabled: boolean("alerts_enabled").notNull().default(true),
    alertThresholds: integer("alert_thresholds").array().notNull().default(sql`ARRAY[50,75,90,100]`),
    alertOnProjected: boolean("alert_on_projected").notNull().default(true),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("budgets_user_idx").on(t.userId), check("budgets_amount_ck", sql`${t.amount} > 0`)],
);

/** One row per (budget, period, threshold) so each alert fires at most once per period. */
export const budgetAlertEvents = pgTable(
  "budget_alert_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    /** Percentage threshold, or -1 for "projected to exceed". */
    threshold: integer("threshold").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("budget_alert_events_uq").on(t.budgetId, t.periodStart, t.threshold)],
);

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("custom"),
    icon: text("icon"),
    color: text("color"),
    targetAmount: money("target_amount").notNull(),
    startingAmount: money("starting_amount").notNull().default("0"),
    currency: text("currency").notNull(),
    deadline: date("deadline"),
    contributionFrequency: recurrenceFrequency("contribution_frequency"),
    targetContribution: money("target_contribution"),
    linkedAccountId: uuid("linked_account_id").references(() => accounts.id, { onDelete: "set null" }),
    status: goalStatus("status").notNull().default("active"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("goals_user_idx").on(t.userId), check("goals_target_ck", sql`${t.targetAmount} > 0`)],
);

export const goalContributions = pgTable(
  "goal_contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    /** Negative for withdrawals. */
    amount: money("amount").notNull(),
    date: date("date").notNull(),
    note: text("note"),
    transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("goal_contributions_goal_idx").on(t.goalId, t.date), check("goal_contrib_nonzero_ck", sql`${t.amount} <> 0`)],
);

/* ─────────────────────────── Analytics ─────────────────────────── */

export const financialSnapshots = pgTable(
  "financial_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    date: date("date").notNull(),
    currency: text("currency").notNull(),
    assets: money("assets").notNull(),
    liabilities: money("liabilities").notNull(),
    netWorth: money("net_worth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("financial_snapshots_user_date_uq").on(t.userId, t.date)],
);

/* ─────────────────────────── AI ─────────────────────────── */

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    title: text("title").notNull().default("New conversation"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** Tool names + arguments used to produce an assistant message (for transparency). */
    toolTrace: jsonb("tool_trace").$type<{ name: string; args: unknown }[]>(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

/** Actions proposed by the AI. Nothing is executed until the user confirms. */
export const aiActions = pgTable(
  "ai_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    conversationId: uuid("conversation_id").references(() => aiConversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => aiMessages.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    summary: text("summary").notNull(),
    destructive: boolean("destructive").notNull().default(false),
    status: aiActionStatus("status").notNull().default("pending"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("ai_actions_user_idx").on(t.userId, t.status)],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    userId: userRef(),
    day: date("day").notNull(),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/* ─────────────────────────── Notifications ─────────────────────────── */

export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  pushEnabled: boolean("push_enabled").notNull().default(false),
  dailyReminderEnabled: boolean("daily_reminder_enabled").notNull().default(false),
  /** Local time "HH:MM" in the user's timezone */
  dailyReminderTime: text("daily_reminder_time").notNull().default("20:30"),
  /** Remind when nothing has been logged for N days (0 = off). */
  missingEntriesDays: smallint("missing_entries_days").notNull().default(3),
  budgetAlerts: boolean("budget_alerts").notNull().default(true),
  billReminders: boolean("bill_reminders").notNull().default(true),
  subscriptionReminders: boolean("subscription_reminders").notNull().default(true),
  creditCardReminders: boolean("credit_card_reminders").notNull().default(true),
  incomeReminders: boolean("income_reminders").notNull().default(true),
  goalReminders: boolean("goal_reminders").notNull().default(true),
  /** Hard cap on push notifications per day across all types (anti-spam). */
  maxPerDay: smallint("max_per_day").notNull().default(4),
  quietHoursStart: text("quiet_hours_start").default("22:00"),
  quietHoursEnd: text("quiet_hours_end").default("08:00"),
  updatedAt: updatedAt(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    /** Idempotency key — the same reminder is never created twice. */
    dedupeKey: text("dedupe_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notifications_user_dedupe_uq").on(t.userId, t.dedupeKey),
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userRef(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)],
);

export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Merchant = typeof merchants.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type RecurringTransaction = typeof recurringTransactions.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type GoalContribution = typeof goalContributions.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type NotificationPreferences = typeof notificationPreferences.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;
