import { and, eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@/server/db";
import { db as defaultDb } from "@/server/db";
import { accounts, categories, goals, merchants, paymentMethods, recurringTransactions, tags, transactions } from "@/server/db/schema";
import { AppError } from "@/server/errors";

type OwnedTable = PgTable & { id: PgColumn; userId: PgColumn };

const TABLES = {
  account: accounts,
  toAccount: accounts,
  category: categories,
  merchant: merchants,
  paymentMethod: paymentMethods,
  tag: tags,
  goal: goals,
  recurring: recurringTransactions,
  transaction: transactions,
} satisfies Record<string, OwnedTable>;

const LABELS: Record<keyof typeof TABLES, string> = {
  account: "Account",
  toAccount: "Destination account",
  category: "Category",
  merchant: "Merchant",
  paymentMethod: "Payment method",
  tag: "Tag",
  goal: "Goal",
  recurring: "Recurring item",
  transaction: "Transaction",
};

/**
 * Verifies that every referenced id belongs to `userId`. This blocks the subtle IDOR where a
 * user attaches *their* record to *someone else's* account/category by guessing an id.
 * A missing or foreign id yields the same NOT_FOUND error (no existence oracle).
 */
export async function assertOwned(
  userId: string,
  refs: Partial<Record<keyof typeof TABLES, string | string[] | null | undefined>>,
  dbx: DbOrTx = defaultDb,
) {
  for (const [key, value] of Object.entries(refs) as [keyof typeof TABLES, string | string[] | null | undefined][]) {
    if (value === null || value === undefined) continue;
    const ids = [...new Set(Array.isArray(value) ? value : [value])];
    if (!ids.length) continue;
    const table = TABLES[key] as OwnedTable;
    const rows = await dbx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.userId, userId), inArray(table.id, ids)));
    if (rows.length !== ids.length) throw new AppError("NOT_FOUND", `${LABELS[key]} not found`);
  }
}
