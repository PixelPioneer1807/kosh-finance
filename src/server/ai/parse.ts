import "server-only";
import { matchCategory, parseTransactionLocally } from "@/lib/nl-parse";
import { isISODate } from "@/lib/dates";
import { normalize, toUnits } from "@/lib/money";
import { getPreferences } from "@/server/services/preferences";
import { listCategories, listPaymentMethods } from "@/server/services/taxonomy";
import { listAccounts } from "@/server/services/accounts";
import { suggestCategoryForMerchant } from "@/server/services/transactions";
import { aiConfigured, chat, extractJson } from "./groq";

export type TransactionDraft = {
  type: "expense" | "income";
  amount: string | null;
  date: string;
  merchant: string | null;
  notes: string | null;
  categoryId: string | null;
  accountId: string | null;
  paymentMethodId: string | null;
  confidence: number;
  uncertain: string[];
  parser: "ai" | "local";
};

/**
 * Turns "Spent 450 at Starbucks today" into a *draft* transaction. Nothing is saved here:
 * the UI always shows the draft for the user to confirm or correct.
 * Only the user's category/account/payment-method names are sent to the model — no balances
 * or transaction history.
 */
export async function parseTransactionText(userId: string, text: string): Promise<TransactionDraft> {
  const [prefs, cats, accounts, methods] = await Promise.all([
    getPreferences(userId),
    listCategories(userId),
    listAccounts(userId),
    listPaymentMethods(userId),
  ]);
  const local = parseTransactionLocally(text, prefs.today);
  let draft: TransactionDraft = {
    type: local.type,
    amount: local.amount,
    date: local.date,
    merchant: local.merchant,
    notes: local.notes,
    categoryId: matchCategory(local.categoryHint, cats, local.type)?.id ?? null,
    accountId: null,
    paymentMethodId: null,
    confidence: local.confidence,
    uncertain: local.uncertain,
    parser: "local",
  };

  if (prefs.aiEnabled && aiConfigured()) {
    try {
      const catList = cats.filter((c) => !c.isArchived).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
      const { message } = await chat(
        userId,
        [
          {
            role: "system",
            content: `You convert a short note about money into JSON for a personal finance app. Today is ${prefs.today}. Default currency ${prefs.currency}.
Return ONLY a JSON object: {"type":"expense"|"income","amount":string|null,"date":"YYYY-MM-DD","merchant":string|null,"notes":string|null,"categoryId":string|null,"accountId":string|null,"paymentMethodId":string|null,"uncertain":string[]}
Rules: amount is a plain decimal string without currency symbols or thousands separators (expand "5k" to "5000"). Never invent an amount — use null if absent.
merchant is the business/person paid or paying (not the item). notes is a short description of what it was for.
Pick categoryId/accountId/paymentMethodId ONLY from the provided lists (copy the id exactly) or null. A category must match the type (expense vs income).
List any field you are unsure about in "uncertain".`,
          },
          {
            role: "user",
            content: JSON.stringify({
              text,
              categories: catList,
              accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })),
              paymentMethods: methods.map((m) => ({ id: m.id, name: m.name, type: m.type })),
            }),
          },
        ],
        { json: true, temperature: 0, maxTokens: 400, timeoutMs: 12_000 },
      );
      const ai = extractJson<Partial<TransactionDraft>>(message.content);
      if (ai) {
        const type = ai.type === "income" ? "income" : "expense";
        const validCat = cats.find((c) => c.id === ai.categoryId && c.kind === type);
        let amount = draft.amount;
        try {
          if (ai.amount && toUnits(ai.amount) > BigInt(0)) amount = normalize(ai.amount);
        } catch {
          /* keep local amount */
        }
        // Guard against hallucinated amounts: if the digits don't appear in the text, keep the local parse.
        if (amount && draft.amount && amount !== draft.amount && !text.replace(/,/g, "").includes(amount.replace(/\.?0+$/, ""))) {
          if (!/\d+\s*(k|lakh|lac|cr|m)\b/i.test(text)) amount = draft.amount;
        }
        draft = {
          type,
          amount,
          date: ai.date && isISODate(ai.date) ? ai.date : draft.date,
          merchant: ai.merchant?.toString().slice(0, 80) || draft.merchant,
          notes: ai.notes?.toString().slice(0, 200) || draft.notes,
          categoryId: validCat?.id ?? draft.categoryId,
          accountId: accounts.some((a) => a.id === ai.accountId) ? ai.accountId! : null,
          paymentMethodId: methods.some((m) => m.id === ai.paymentMethodId) ? ai.paymentMethodId! : null,
          confidence: Array.isArray(ai.uncertain) ? Math.max(0.3, 1 - ai.uncertain.length * 0.2) : 0.8,
          uncertain: Array.isArray(ai.uncertain) ? ai.uncertain.map(String).slice(0, 8) : [],
          parser: "ai",
        };
      }
    } catch (e) {
      console.warn("[ai] parse fell back to local parser:", e instanceof Error ? e.message : e);
    }
  }

  // The user's own history beats both parsers for category choice.
  if (draft.merchant) {
    const learned = await suggestCategoryForMerchant(userId, draft.merchant);
    if (learned && cats.some((c) => c.id === learned && c.kind === draft.type)) draft.categoryId = learned;
  }
  if (!draft.amount && !draft.uncertain.includes("amount")) draft.uncertain.push("amount");
  // Present uncertainty in plain words; account / payment method fall back to defaults, so they aren't flagged.
  const LABELS: Record<string, string> = { amount: "amount", categoryId: "category", category: "category", merchant: "merchant", date: "date", notes: "description", type: "income vs expense" };
  draft.uncertain = [...new Set(draft.uncertain.map((u) => LABELS[u]).filter((u): u is string => Boolean(u)))];
  if (draft.categoryId) draft.uncertain = draft.uncertain.filter((u) => u !== "category");
  return draft;
}
