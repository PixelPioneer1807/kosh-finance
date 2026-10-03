import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbOrTx } from "@/server/db";
import { accounts, transactions, type Account } from "@/server/db/schema";
import { notFound, AppError } from "@/server/errors";
import { add, neg, sub, isNegative, toUnits, ratio, normalize } from "@/lib/money";
import { currencyCode, name, optionalMoney, optionalText, optionalDate, signedMoney } from "@/lib/validation";
import type { ISODate } from "@/lib/dates";

export const ACCOUNT_TYPES = [
  { id: "checking", label: "Bank account", icon: "landmark", liability: false },
  { id: "savings", label: "Savings", icon: "piggy-bank", liability: false },
  { id: "cash", label: "Cash", icon: "banknote", liability: false },
  { id: "wallet", label: "Wallet", icon: "wallet", liability: false },
  { id: "credit_card", label: "Credit card", icon: "credit-card", liability: true },
  { id: "investment", label: "Investment", icon: "trending-up", liability: false },
  { id: "loan", label: "Loan / debt", icon: "hand-coins", liability: true },
  { id: "asset", label: "Other asset", icon: "gem", liability: false },
  { id: "other", label: "Other", icon: "circle-dashed", liability: false },
] as const;
export type AccountTypeId = (typeof ACCOUNT_TYPES)[number]["id"];
export const isLiabilityType = (t: string) => t === "credit_card" || t === "loan";
/** Accounts whose balance is spendable cash (used by forecasts and safe-to-spend). */
export const isLiquidType = (t: string) => t === "checking" || t === "savings" || t === "cash" || t === "wallet";

const accountTypeEnum = z.enum(ACCOUNT_TYPES.map((t) => t.id) as [AccountTypeId, ...AccountTypeId[]]);
const day = z.union([z.literal(""), z.null(), z.coerce.number().int().min(1).max(31)]).optional().transform((v) => (v === "" || v == null ? null : v));

export const accountInput = z.object({
  name: name("Account name", 60),
  type: accountTypeEnum,
  currency: currencyCode,
  /** For liabilities the user enters what they owe as a positive number. */
  openingBalance: signedMoney.default("0"),
  openingDate: optionalDate,
  institution: optionalText(80),
  notes: optionalText(500),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  includeInNetWorth: z.boolean().default(true),
  creditLimit: optionalMoney,
  statementDay: day,
  dueDay: day,
  minimumPayment: optionalMoney,
  annualFee: optionalMoney,
  interestRate: z
    .union([z.literal(""), z.null(), z.coerce.number().min(0).max(1000)])
    .optional()
    .transform((v) => (v === "" || v == null ? null : String(v))),
});
export type AccountInput = z.input<typeof accountInput>;

function toRow(input: z.output<typeof accountInput>) {
  const liability = isLiabilityType(input.type);
  return {
    ...input,
    // Liabilities are stored as negative balances (money owed).
    openingBalance: liability ? neg(normalize(input.openingBalance).replace("-", "")) : input.openingBalance,
    creditLimit: input.type === "credit_card" ? input.creditLimit : null,
    statementDay: input.type === "credit_card" ? input.statementDay : null,
    dueDay: liability ? input.dueDay : null,
    minimumPayment: liability ? input.minimumPayment : null,
    annualFee: input.type === "credit_card" ? input.annualFee : null,
    interestRate: liability ? input.interestRate : null,
    color: input.color ?? null,
  };
}

export async function createAccount(userId: string, raw: AccountInput) {
  const input = accountInput.parse(raw);
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${accounts.sortOrder}), -1)::int` })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const [row] = await db
    .insert(accounts)
    .values({ ...toRow(input), userId, sortOrder: max + 1 })
    .returning();
  return row;
}

export async function updateAccount(userId: string, id: string, raw: AccountInput) {
  const input = accountInput.parse(raw);
  const existing = await getAccount(userId, id);
  if (existing.currency !== input.currency) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.accountId, id)));
    if (count > 0) throw new AppError("VALIDATION", "You can't change the currency of an account that already has transactions.");
  }
  const [row] = await db
    .update(accounts)
    .set(toRow(input))
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .returning();
  if (!row) throw notFound("Account");
  return row;
}

export async function setAccountArchived(userId: string, id: string, archived: boolean) {
  const [row] = await db
    .update(accounts)
    .set({ isArchived: archived })
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .returning({ id: accounts.id });
  if (!row) throw notFound("Account");
}

/** Hard delete — cascades to the account's transactions. The UI requires typed confirmation. */
export async function deleteAccount(userId: string, id: string) {
  const [row] = await db
    .delete(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .returning({ id: accounts.id });
  if (!row) throw notFound("Account");
}

export async function reorderAccounts(userId: string, orderedIds: string[]) {
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) {
      await tx.update(accounts).set({ sortOrder: i }).where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
    }
  });
}

export async function getAccount(userId: string, id: string, dbx: DbOrTx = db): Promise<Account> {
  const [row] = await dbx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Account");
  return row;
}

/**
 * Balance of every account = opening balance + signed sum of its ledger.
 * Computed from transactions (never stored) so it can't drift. Optional `asOf` gives
 * historical balances (used by net-worth history).
 */
export async function accountBalances(userId: string, asOf?: ISODate, dbx: DbOrTx = db): Promise<Map<string, string>> {
  const dateFilter = asOf ? sql`AND date <= ${asOf}` : sql``;
  const rows = await dbx.execute<{ account_id: string; balance: string }>(sql`
    WITH flows AS (
      SELECT account_id, CASE WHEN type IN ('expense','transfer') THEN -amount ELSE amount END AS delta
        FROM transactions WHERE user_id = ${userId} AND deleted_at IS NULL ${dateFilter}
      UNION ALL
      SELECT to_account_id, to_amount FROM transactions
        WHERE user_id = ${userId} AND deleted_at IS NULL AND type = 'transfer' ${dateFilter}
    )
    SELECT a.id AS account_id, (a.opening_balance + COALESCE(SUM(f.delta), 0))::text AS balance
    FROM accounts a LEFT JOIN flows f ON f.account_id = a.id
    WHERE a.user_id = ${userId}
    GROUP BY a.id`);
  return new Map(rows.map((r) => [r.account_id, normalize(r.balance)]));
}

export type AccountWithBalance = Account & {
  balance: string;
  /** Credit cards: limit − owed. */
  availableCredit: string | null;
  /** Credit cards: owed ÷ limit (0..1+). */
  utilization: number | null;
  liability: boolean;
};

export async function listAccounts(userId: string, opts: { includeArchived?: boolean } = {}): Promise<AccountWithBalance[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), opts.includeArchived ? undefined : eq(accounts.isArchived, false)))
    .orderBy(asc(accounts.sortOrder), asc(accounts.createdAt));
  const balances = await accountBalances(userId);
  return rows.map((a) => {
    const balance = balances.get(a.id) ?? normalize(a.openingBalance);
    const liability = isLiabilityType(a.type);
    const owed = isNegative(balance) ? neg(balance) : "0";
    const hasLimit = a.type === "credit_card" && a.creditLimit && toUnits(a.creditLimit) > BigInt(0);
    return {
      ...a,
      balance,
      liability,
      availableCredit: hasLimit ? sub(a.creditLimit!, owed) : null,
      utilization: hasLimit ? ratio(owed, a.creditLimit!) : null,
    };
  });
}

export function totalsByCurrency(list: { balance: string; currency: string }[]) {
  const m = new Map<string, string>();
  for (const a of list) m.set(a.currency, add(m.get(a.currency) ?? "0", a.balance));
  return m;
}
