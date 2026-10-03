import "server-only";
/**
 * Confirmation flow for AI-proposed actions.
 *
 * The model can only *propose* (tools.ts stores a pending `ai_actions` row). Execution happens
 * here, when the owner presses Confirm:
 * - only the owner can act on a row (every query filters on user_id; foreign ids look missing);
 * - only pending, unexpired rows execute;
 * - the row is *claimed* with a conditional `UPDATE … WHERE status = 'pending' … RETURNING`, so a
 *   double click / two tabs / a replayed request can never execute it twice;
 * - execution goes through the regular services, which re-validate everything (ownership, kinds,
 *   amounts) — the stored payload is never trusted blindly.
 */
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { aiActions } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { createTransaction, deleteTransactions, getTransaction, transactionInput, updateTransaction } from "@/server/services/transactions";
import { budgetInput, createBudget } from "@/server/services/budgets";
import { addContribution, contributionInput, createGoal, goalInput } from "@/server/services/goals";
import type { ActionDetail } from "./tools";

export type ActionStatus = "pending" | "confirmed" | "cancelled" | "failed" | "expired";

export type ActionCard = {
  id: string;
  actionType: string;
  summary: string;
  details: ActionDetail[];
  destructive: boolean;
  status: ActionStatus;
  expiresAt: string;
  messageId: string | null;
  /** Execution outcome: e.g. { transactionId } / { count } / { error }. */
  result: Record<string, unknown> | null;
};

type Row = typeof aiActions.$inferSelect;

export function toCard(row: Row): ActionCard {
  const payload = (row.payload ?? {}) as { display?: ActionDetail[] };
  const expired = row.status === "pending" && row.expiresAt.getTime() <= Date.now();
  return {
    id: row.id,
    actionType: row.actionType,
    summary: row.summary,
    details: Array.isArray(payload.display) ? payload.display.slice(0, 12) : [],
    destructive: row.destructive,
    status: expired ? "expired" : row.status,
    expiresAt: row.expiresAt.toISOString(),
    messageId: row.messageId,
    result: row.result ?? null,
  };
}

const updatePayload = z.object({
  transactionId: z.uuid(),
  patch: z.object({
    categoryId: z.uuid().nullish(),
    amount: z.string().optional(),
    date: z.string().optional(),
    notes: z.string().nullish(),
  }),
});

async function execute(userId: string, row: Row): Promise<Record<string, unknown>> {
  const p = row.payload as Record<string, unknown>;
  switch (row.actionType) {
    case "add_transaction": {
      const input = transactionInput.parse(p.input);
      const t = await createTransaction(userId, input, { source: "ai" });
      return { transactionId: t.id };
    }
    case "create_budget": {
      const b = await createBudget(userId, budgetInput.parse(p.input));
      return { budgetId: b.id };
    }
    case "create_goal": {
      const g = await createGoal(userId, goalInput.parse(p.input));
      return { goalId: (g as { id: string }).id };
    }
    case "add_goal_contribution": {
      const r = await addContribution(userId, contributionInput.parse(p.input));
      return { contributionId: r.contribution.id, goalCompleted: Boolean(r.completed) };
    }
    case "update_transaction": {
      const { transactionId, patch } = updatePayload.parse(p);
      // Re-read the current state so the edit applies to what the transaction is *now*.
      const t = await getTransaction(userId, transactionId);
      await updateTransaction(userId, t.id, {
        type: t.type,
        accountId: t.accountId,
        amount: patch.amount ?? t.amount,
        date: patch.date ?? t.date,
        categoryId: patch.categoryId !== undefined ? patch.categoryId : t.categoryId,
        merchant: t.merchantName,
        paymentMethodId: t.paymentMethodId,
        notes: patch.notes !== undefined ? patch.notes : t.notes,
        tags: t.tags.map((x) => x.name),
        toAccountId: t.toAccountId,
        toAmount: t.toAmount,
        refundOfId: t.refundOfId,
        splits: t.splits.filter((s) => s.categoryId).map((s) => ({ categoryId: s.categoryId!, amount: s.amount, notes: s.notes })),
        isPending: t.isPending,
        originalAmount: t.originalAmount,
        originalCurrency: t.originalCurrency,
        fxRate: t.fxRate, // keep the historical rate
      });
      return { transactionId: t.id };
    }
    case "delete_transactions": {
      const ids = z.array(z.uuid()).min(1).max(50).parse(p.ids);
      const count = await deleteTransactions(userId, ids);
      return { count, ids };
    }
    default:
      throw new AppError("VALIDATION", "This kind of suggestion is no longer supported.");
  }
}

function userMessage(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof z.ZodError) return e.issues[0]?.message ?? "Invalid data";
  console.error("[ai] action execution failed", e);
  return "Something went wrong. Nothing was changed.";
}

async function load(userId: string, actionId: string) {
  const [row] = await db
    .select()
    .from(aiActions)
    .where(and(eq(aiActions.id, actionId), eq(aiActions.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Suggestion");
  return row;
}

/**
 * Confirm and execute a pending action. Idempotent: confirming an already-confirmed action
 * returns its card without executing again.
 */
export async function confirmAction(userId: string, actionId: string): Promise<ActionCard> {
  const id = z.uuid().parse(actionId);
  const [claimed] = await db
    .update(aiActions)
    .set({ status: "confirmed", resolvedAt: new Date() })
    .where(and(eq(aiActions.id, id), eq(aiActions.userId, userId), eq(aiActions.status, "pending"), gt(aiActions.expiresAt, new Date())))
    .returning();
  if (!claimed) {
    const row = await load(userId, id);
    if (row.status === "confirmed") return toCard(row);
    if (row.status === "pending") {
      await db
        .update(aiActions)
        .set({ status: "expired", resolvedAt: new Date() })
        .where(and(eq(aiActions.id, id), eq(aiActions.userId, userId), eq(aiActions.status, "pending")));
      throw new AppError("VALIDATION", "This suggestion expired. Ask the assistant again.");
    }
    throw new AppError("CONFLICT", `This suggestion was already ${row.status}.`);
  }
  try {
    const result = await execute(userId, claimed);
    const [done] = await db.update(aiActions).set({ result }).where(and(eq(aiActions.id, id), eq(aiActions.userId, userId))).returning();
    return toCard(done);
  } catch (e) {
    const error = userMessage(e);
    await db.update(aiActions).set({ status: "failed", result: { error } }).where(and(eq(aiActions.id, id), eq(aiActions.userId, userId)));
    throw new AppError(e instanceof AppError ? e.code : "VALIDATION", error);
  }
}

/** Cancel a pending action. Cancelling twice is a no-op; a confirmed action can't be cancelled. */
export async function cancelAction(userId: string, actionId: string): Promise<ActionCard> {
  const id = z.uuid().parse(actionId);
  const [row] = await db
    .update(aiActions)
    .set({ status: "cancelled", resolvedAt: new Date() })
    .where(and(eq(aiActions.id, id), eq(aiActions.userId, userId), eq(aiActions.status, "pending")))
    .returning();
  if (row) return toCard(row);
  const current = await load(userId, id);
  if (current.status === "cancelled" || current.status === "expired") return toCard(current);
  throw new AppError("CONFLICT", `This suggestion was already ${current.status}.`);
}

export async function listActions(userId: string, opts: { conversationId?: string; ids?: string[]; limit?: number } = {}) {
  const rows = await db
    .select()
    .from(aiActions)
    .where(
      and(
        eq(aiActions.userId, userId),
        opts.conversationId ? eq(aiActions.conversationId, opts.conversationId) : undefined,
        opts.ids ? (opts.ids.length ? inArray(aiActions.id, opts.ids) : sql`false`) : undefined,
      ),
    )
    .orderBy(desc(aiActions.createdAt))
    .limit(Math.min(opts.limit ?? 200, 500));
  return rows.reverse().map(toCard);
}

/** Housekeeping: mark stale pending rows as expired (safe to call from cron). */
export async function expireStaleActions(userId?: string) {
  const rows = await db
    .update(aiActions)
    .set({ status: "expired", resolvedAt: new Date() })
    .where(and(eq(aiActions.status, "pending"), lte(aiActions.expiresAt, new Date()), userId ? eq(aiActions.userId, userId) : undefined))
    .returning({ id: aiActions.id });
  return rows.length;
}
