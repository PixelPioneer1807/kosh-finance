import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { listTransactions, summarizeTransactions, type TransactionFilters } from "@/server/services/transactions";
import { listTags, listMerchants } from "@/server/services/taxonomy";
import { resolveRange } from "@/lib/dates";
import { TransactionsView } from "./transactions-view";

export const metadata: Metadata = { title: "Transactions" };

const asArray = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(",").filter(Boolean));
const uuidRe = /^[0-9a-f-]{36}$/i;
const ids = (v: string | string[] | undefined) => asArray(v)?.filter((x) => uuidRe.test(x));
const bool = (v: string | string[] | undefined) => (v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : undefined);

export default async function TransactionsPage({ searchParams }: PageProps<"/transactions">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  // Default view is "all time" so search covers everything; ranges narrow it.
  const preset = str("range") ?? (str("from") || str("to") ? "custom" : "all");
  const range = resolveRange(preset, prefs.today, { weekStartsOn: prefs.weekStartsOn, monthStartDay: prefs.monthStartDay, from: str("from"), to: str("to") });
  const types = asArray(sp.type)?.filter((t): t is NonNullable<TransactionFilters["types"]>[number] => ["expense", "income", "transfer", "refund", "adjustment"].includes(t));

  const filters: TransactionFilters = {
    q: str("q")?.slice(0, 100),
    from: range.preset === "all" ? undefined : range.from,
    to: range.preset === "all" ? undefined : range.to,
    types: types?.length ? types : undefined,
    accountIds: ids(sp.account),
    categoryIds: ids(sp.category),
    merchantIds: ids(sp.merchant),
    paymentMethodIds: ids(sp.method),
    tagIds: ids(sp.tag),
    minAmount: str("min"),
    maxAmount: str("max"),
    recurring: bool(sp.recurring),
    refunded: bool(sp.refunded),
    hasReceipt: bool(sp.receipt),
    pending: bool(sp.pending),
    uncategorized: bool(sp.uncategorized),
    sort: (["date_desc", "date_asc", "amount_desc", "amount_asc"] as const).find((s) => s === str("sort")),
  };

  const [page, summary, tags, merchants] = await Promise.all([
    listTransactions(user.id, filters, { limit: 50 }),
    summarizeTransactions(user.id, filters),
    listTags(user.id),
    listMerchants(user.id),
  ]);

  return (
    <TransactionsView
      filters={filters}
      rangePreset={range.preset}
      range={{ from: range.from, to: range.to }}
      initial={page}
      summary={summary}
      tags={tags.map((t) => ({ id: t.id, name: t.name }))}
      merchants={merchants.map((m) => ({ id: m.id, name: m.name }))}
      openId={str("open") && uuidRe.test(str("open")!) ? str("open")! : null}
    />
  );
}
