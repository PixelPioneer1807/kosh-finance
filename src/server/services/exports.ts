/**
 * CSV exports. Transactions stream page-by-page so thousands of rows never sit in memory at once.
 */
import { csvRow, roundDecimal, CSV_BOM, type CsvValue } from "@/lib/csv";
import { resolveRange, type ISODate } from "@/lib/dates";
import { listTransactions, TRANSACTION_TYPES, type TransactionFilters, type TransactionType } from "./transactions";
import type { Report } from "./reports";

const uuidRe = /^[0-9a-f-]{36}$/i;

/**
 * Same URL vocabulary as the Transactions page (`range`, `from`, `to`, `q`, `type`, `account`,
 * `category`, `merchant`, `method`, `tag`, `min`, `max`, `recurring`, `refunded`, `receipt`,
 * `pending`, `uncategorized`, `sort`) so "Export" exports exactly what's on screen.
 */
export function transactionFiltersFromParams(
  sp: URLSearchParams,
  prefs: { today: ISODate; weekStartsOn: 0 | 1; monthStartDay: number },
): TransactionFilters {
  const str = (k: string) => sp.get(k) ?? undefined;
  const arr = (k: string) => {
    const vals = sp.getAll(k).flatMap((v) => v.split(",")).filter(Boolean);
    return vals.length ? vals : undefined;
  };
  const ids = (k: string) => arr(k)?.filter((x) => uuidRe.test(x)).slice(0, 200);
  const bool = (k: string) => {
    const v = sp.get(k);
    return v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : undefined;
  };
  const preset = str("range") ?? (str("from") || str("to") ? "custom" : "all");
  const range = resolveRange(preset, prefs.today, { weekStartsOn: prefs.weekStartsOn, monthStartDay: prefs.monthStartDay, from: str("from"), to: str("to") });
  const types = arr("type")?.filter((t): t is TransactionType => (TRANSACTION_TYPES as readonly string[]).includes(t));
  const sort = (["date_desc", "date_asc", "amount_desc", "amount_asc"] as const).find((s) => s === str("sort"));
  return {
    q: str("q")?.slice(0, 100),
    from: range.preset === "all" ? undefined : range.from,
    to: range.preset === "all" ? undefined : range.to,
    types: types?.length ? types : undefined,
    accountIds: ids("account"),
    categoryIds: ids("category"),
    merchantIds: ids("merchant"),
    paymentMethodIds: ids("method"),
    tagIds: ids("tag"),
    minAmount: str("min"),
    maxAmount: str("max"),
    recurring: bool("recurring"),
    refunded: bool("refunded"),
    hasReceipt: bool("receipt"),
    pending: bool("pending"),
    uncategorized: bool("uncategorized"),
    sort,
  };
}

export const TRANSACTION_CSV_HEADER = [
  "Date",
  "Type",
  "Amount",
  "Currency",
  "Amount (base)",
  "Base currency",
  "Account",
  "To account",
  "To amount",
  "Category",
  "Merchant",
  "Payment method",
  "Tags",
  "Notes",
  "Splits",
  "Refunded",
  "Original amount",
  "Original currency",
  "Pending",
  "Recurring",
  "Source",
  "ID",
];

/** Signed amount from the user's point of view: money out is negative. */
function signedAmount(type: string, amount: string) {
  if (type === "expense" || type === "transfer") return "-" + amount.replace(/^-/, "");
  return amount;
}

/** Yields CSV text chunks (BOM + header first, then up to `pageSize` rows per chunk). */
export async function* transactionCsvChunks(
  userId: string,
  filters: TransactionFilters,
  baseCurrency: string,
  opts: { pageSize?: number; maxRows?: number } = {},
): AsyncGenerator<string> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 500, 1), 500);
  const maxRows = opts.maxRows ?? 100_000;
  yield CSV_BOM + csvRow(TRANSACTION_CSV_HEADER);
  let offset = 0;
  let written = 0;
  while (written < maxRows) {
    const page = await listTransactions(userId, { ...filters, sort: filters.sort ?? "date_desc" }, { limit: pageSize, offset });
    let chunk = "";
    for (const t of page.rows) {
      if (written >= maxRows) break;
      const cells: CsvValue[] = [
        t.date,
        t.type,
        roundDecimal(signedAmount(t.type, t.amount)),
        t.currency,
        roundDecimal(signedAmount(t.type, t.baseAmount)),
        baseCurrency,
        t.accountName,
        t.toAccountName,
        t.toAmount ? roundDecimal(t.toAmount) : null,
        t.hasSplits ? "Split" : t.categoryName ? (t.parentCategoryName ? `${t.parentCategoryName} › ${t.categoryName}` : t.categoryName) : null,
        t.merchantName,
        t.paymentMethodName,
        t.tags.map((x) => x.name).join("; "),
        t.notes,
        t.splits.length ? t.splits.map((s) => `${s.categoryName ?? "Uncategorized"}: ${roundDecimal(s.amount)}`).join("; ") : null,
        t.refundedAmount && !/^0(\.0+)?$/.test(t.refundedAmount) ? roundDecimal(t.refundedAmount) : null,
        t.originalAmount ? roundDecimal(t.originalAmount) : null,
        t.originalCurrency,
        t.isPending ? "yes" : "no",
        t.recurringId ? "yes" : "no",
        t.source,
        t.id,
      ];
      chunk += csvRow(cells);
      written++;
    }
    if (chunk) yield chunk;
    if (!page.hasMore) return;
    offset = page.nextOffset;
  }
}

/** A report as CSV: one block per table (title row, header, rows), blank line between blocks. */
export function reportToCsv(report: Report): string {
  const lines: string[] = [CSV_BOM + csvRow([report.title]), csvRow([report.subtitle]), csvRow([`Currency: ${report.currency}`]), "\r\n"];
  if (report.kpis.length) {
    lines.push(csvRow(["Summary"]), csvRow(["Metric", "Value"]));
    for (const k of report.kpis) lines.push(csvRow([k.label, formatCell(k.value, k.kind)]));
    lines.push("\r\n");
  }
  for (const t of report.tables) {
    lines.push(csvRow([t.title]));
    lines.push(csvRow(t.columns.map((c) => c.label)));
    for (const r of t.rows) lines.push(csvRow(t.columns.map((c) => formatCell(r[c.key] ?? null, c.kind))));
    if (t.totals) lines.push(csvRow(t.columns.map((c, i) => (i === 0 ? "Total" : formatCell(t.totals![c.key] ?? null, c.kind)))));
    lines.push("\r\n");
  }
  if (report.notes.length) {
    lines.push(csvRow(["Notes"]));
    for (const n of report.notes) lines.push(csvRow([n]));
  }
  return lines.join("");
}

function formatCell(v: string | number | null, kind: string): CsvValue {
  if (v === null || v === undefined) return null;
  if (kind === "money" && typeof v === "string") return roundDecimal(v);
  if (kind === "percent" && typeof v === "number") return `${(v * 100).toFixed(1)}%`;
  return v;
}
