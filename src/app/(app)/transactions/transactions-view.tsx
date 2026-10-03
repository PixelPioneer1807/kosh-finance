"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeftRight, CheckSquare, Copy, Download, Filter, Loader2, MoreHorizontal, Paperclip, Plus, Receipt, Repeat, RotateCcw, Search,
  Split, Tag, Trash2, Undo2, X, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Segmented, Switch } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui/misc";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { TransactionForm, type TransactionFormValues } from "@/components/app/transaction-form";
import { useAppData, useMoney } from "@/components/app/user-context";
import { useShell } from "@/components/shell/shell-context";
import { RANGE_PRESETS, formatDate, relativeDayLabel } from "@/lib/dates";
import { add, sub, toInputValue, cmp } from "@/lib/money";
import { cn, pluralize } from "@/lib/utils";
import type { TransactionFilters, TransactionRow } from "@/server/services/transactions";
import {
  bulkCategorizeAction,
  deleteTransactionsAction,
  duplicateTransactionAction,
  getTransactionAction,
  loadTransactionsAction,
  refundTransactionAction,
  restoreTransactionsAction,
} from "./actions";

type Summary = { count: number; income: string; expenses: string; refunds: string; spending: string; net: string };

/* ───────────── URL-driven filters ───────────── */

function useFilterNav() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return React.useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      next.delete("open");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
    },
    [params, pathname, router],
  );
}

function SearchBox() {
  const params = useSearchParams();
  const nav = useFilterNav();
  const [q, setQ] = React.useState(params.get("q") ?? "");
  React.useEffect(() => {
    const current = params.get("q") ?? "";
    if (q === current) return;
    const t = setTimeout(() => nav({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
  }, [q, params, nav]);
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search merchant, category, notes, tags, amount…"
        aria-label="Search transactions"
        className="pl-9"
      />
    </div>
  );
}

function FiltersPopover({ tags, merchants }: { tags: { id: string; name: string }[]; merchants: { id: string; name: string }[] }) {
  const params = useSearchParams();
  const nav = useFilterNav();
  const { accounts, categories, paymentMethods } = useAppData();
  const [from, setFrom] = React.useState(params.get("from") ?? "");
  const [to, setTo] = React.useState(params.get("to") ?? "");
  const [min, setMin] = React.useState(params.get("min") ?? "");
  const [max, setMax] = React.useState(params.get("max") ?? "");
  const activeCount = ["account", "category", "method", "tag", "merchant", "min", "max", "recurring", "refunded", "receipt", "pending", "uncategorized"].filter((k) => params.get(k)).length;
  const toggle = (k: string) => (
    <Switch checked={params.get(k) === "1"} onCheckedChange={(c) => nav({ [k]: c ? "1" : null })} aria-label={k} />
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="shrink-0">
          <Filter /> Filters
          {activeCount > 0 && <span className="grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground">{activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] p-4">
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="From" htmlFor="f-from">
              <Input id="f-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} onBlur={() => from && nav({ range: "custom", from, to: to || from })} />
            </Field>
            <Field label="To" htmlFor="f-to">
              <Input id="f-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} onBlur={() => to && nav({ range: "custom", from: from || to, to })} />
            </Field>
          </div>
          <Field label="Account" htmlFor="f-acc">
            <NativeSelect id="f-acc" value={params.get("account") ?? ""} onChange={(e) => nav({ account: e.target.value })}>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Category" htmlFor="f-cat">
            <NativeSelect id="f-cat" value={params.get("category") ?? ""} onChange={(e) => nav({ category: e.target.value })}>
              <option value="">All categories</option>
              {(["expense", "income"] as const).map((kind) => (
                <optgroup key={kind} label={kind === "expense" ? "Expenses" : "Income"}>
                  {categories
                    .filter((c) => c.kind === kind && !c.parentId)
                    .flatMap((p) => [p, ...categories.filter((c) => c.parentId === p.id)])
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.parentId ? `   ${c.name}` : c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Payment method" htmlFor="f-pm">
              <NativeSelect id="f-pm" value={params.get("method") ?? ""} onChange={(e) => nav({ method: e.target.value })}>
                <option value="">Any</option>
                {paymentMethods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Tag" htmlFor="f-tag">
              <NativeSelect id="f-tag" value={params.get("tag") ?? ""} onChange={(e) => nav({ tag: e.target.value })}>
                <option value="">Any</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {merchants.length > 0 && (
            <Field label="Merchant" htmlFor="f-mer">
              <NativeSelect id="f-mer" value={params.get("merchant") ?? ""} onChange={(e) => nav({ merchant: e.target.value })}>
                <option value="">Any merchant</option>
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Min amount" htmlFor="f-min">
              <Input id="f-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} onBlur={() => nav({ min })} />
            </Field>
            <Field label="Max amount" htmlFor="f-max">
              <Input id="f-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} onBlur={() => nav({ max })} />
            </Field>
          </div>
          <div className="grid gap-2 text-sm">
            {[
              ["recurring", "Recurring only"],
              ["refunded", "Refunds & refunded"],
              ["receipt", "Has receipt"],
              ["pending", "Pending"],
              ["uncategorized", "Uncategorised"],
            ].map(([k, l]) => (
              <label key={k} className="flex items-center justify-between">
                {l} {toggle(k)}
              </label>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => nav({ account: null, category: null, method: null, tag: null, merchant: null, min: null, max: null, recurring: null, refunded: null, receipt: null, pending: null, uncategorized: null })}
          >
            Clear filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ───────────── Rows ───────────── */

function rowTitle(t: TransactionRow) {
  if (t.type === "transfer") return `${t.accountName} → ${t.toAccountName ?? "account"}`;
  if (t.type === "adjustment") return "Balance adjustment";
  return t.merchantName || t.notes || t.categoryName || (t.type === "income" ? "Income" : "Expense");
}

function TransactionItem({
  t,
  selecting,
  selected,
  onToggle,
  onOpen,
}: {
  t: TransactionRow;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { prefs } = useAppData();
  const direction = t.type === "income" || t.type === "refund" ? "in" : t.type === "expense" ? "out" : "neutral";
  const subtitle = [
    t.hasSplits ? `Split · ${t.splits.length} categories` : t.categoryName ? (t.parentCategoryName ? `${t.parentCategoryName} › ${t.categoryName}` : t.categoryName) : t.type === "transfer" ? "Transfer" : t.type === "adjustment" ? "Adjustment" : "Uncategorised",
    t.type !== "transfer" ? t.accountName : null,
    t.paymentMethodName,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className={cn("group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-subtle sm:px-5", selected && "bg-accent-soft/60")}>
      {selecting && <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${rowTitle(t)}`} />}
      <button type="button" onClick={selecting ? onToggle : onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left after:absolute after:inset-0" aria-label={`${rowTitle(t)}, ${subtitle}`}>
        {t.type === "transfer" ? (
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <ArrowLeftRight className="size-4" />
          </span>
        ) : t.hasSplits ? (
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <Split className="size-4" />
          </span>
        ) : (
          <CategoryBadge icon={t.categoryIcon ?? (t.type === "adjustment" ? "wrench" : "circle-dashed")} color={t.categoryColor} />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-medium">{rowTitle(t)}</span>
            {t.type === "refund" && <Badge variant="positive">Refund</Badge>}
            {t.isPending && <Badge variant="warning"><Clock /> Pending</Badge>}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <span className="truncate">{subtitle}</span>
            {t.recurringId && <Repeat className="size-3 shrink-0" aria-label="Recurring" />}
            {t.receiptCount > 0 && <Paperclip className="size-3 shrink-0" aria-label="Has receipt" />}
            {cmp(t.refundedAmount, "0") > 0 && <RotateCcw className="size-3 shrink-0" aria-label="Partly refunded" />}
          </span>
          {t.tags.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {t.tags.map((tag) => (
                <span key={tag.id} className="rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
                  #{tag.name}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="text-right">
          <Money
            amount={t.type === "adjustment" ? t.amount : t.amount}
            currency={t.currency}
            direction={t.type === "adjustment" ? undefined : direction === "neutral" ? undefined : direction}
            signed={t.type === "adjustment"}
            tone="flow"
            className="text-[14.5px] font-medium"
          />
          {t.currency !== prefs.currency && (
            <span className="block text-[11.5px] text-muted-foreground">
              <Money amount={t.baseAmount} />
            </span>
          )}
          {t.originalCurrency && (
            <span className="block text-[11.5px] text-muted-foreground">
              <Money amount={t.originalAmount} currency={t.originalCurrency} />
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/* ───────────── Edit / refund dialogs ───────────── */

type Detail = Awaited<ReturnType<typeof getTransactionAction>> extends infer R ? (R extends { ok: true; data: infer D } ? D : never) : never;

function toFormValues(d: Detail): Partial<TransactionFormValues> {
  return {
    id: d.id,
    type: d.type,
    amount: toInputValue(d.amount),
    accountId: d.accountId,
    toAccountId: d.toAccountId ?? "",
    toAmount: d.toAmount ? toInputValue(d.toAmount) : "",
    categoryId: d.categoryId,
    date: d.date,
    merchant: d.merchantName ?? "",
    paymentMethodId: d.paymentMethodId ?? "",
    notes: d.notes ?? "",
    tags: d.tags.map((t) => t.name),
    isPending: d.isPending,
    splits: d.splits.map((s) => ({ categoryId: s.categoryId ?? "", amount: toInputValue(s.amount) })),
    originalCurrency: d.originalCurrency ?? "",
    originalAmount: d.originalAmount ? toInputValue(d.originalAmount) : "",
    refundOfId: d.refundOfId,
    receipt: d.receipts[0] ? { id: d.receipts[0].id, filename: d.receipts[0].filename } : null,
  };
}

function EditDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [busy, start] = React.useTransition();
  const fmt = useMoney();

  // The dialog is keyed by id, so state starts empty for each transaction.
  React.useEffect(() => {
    if (!id) return;
    let alive = true;
    getTransactionAction(id).then((r) => {
      if (!alive) return;
      if (r.ok) setDetail(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const refundable = detail && detail.type === "expense" ? sub(detail.amount, detail.refundedAmount) : "0";

  return (
    <>
      <Dialog open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          title={detail ? (detail.type === "transfer" ? "Transfer" : detail.type === "refund" ? "Refund" : detail.type === "income" ? "Income" : detail.type === "adjustment" ? "Adjustment" : "Expense") : "Transaction"}
          description={detail ? `${formatDate(detail.date, "EEEE, d MMMM yyyy")}${detail.source !== "manual" ? ` · added via ${detail.source}` : ""}` : undefined}
        >
          {error ? (
            <p role="alert" className="text-sm text-negative">{error}</p>
          ) : !detail ? (
            <div className="grid gap-3" aria-busy>
              <Skeleton className="h-9" />
              <Skeleton className="h-14" />
              <Skeleton className="h-40" />
            </div>
          ) : (
            <div className="grid gap-5">
              {(detail.refunds.length > 0 || detail.refundOfId || detail.recurringId) && (
                <div className="grid gap-1.5 rounded-lg bg-subtle px-3 py-2.5 text-[13px] text-muted-foreground">
                  {detail.refunds.length > 0 && (
                    <p>
                      Refunded {fmt(detail.refundedAmount, detail.currency)} of {fmt(detail.amount, detail.currency)} in {pluralize(detail.refunds.length, "refund")}.
                    </p>
                  )}
                  {detail.refundOfId && <p>This refund is linked to an earlier expense.</p>}
                  {detail.recurringId && <p>Created from a recurring schedule.</p>}
                </div>
              )}
              <TransactionForm initial={toFormValues(detail)} allowTypes={[detail.type]} onDone={onClose} />
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy}
                  onClick={() =>
                    start(async () => {
                      const r = await duplicateTransactionAction({ id: detail.id });
                      if (r.ok) {
                        toast.success("Duplicated to today");
                        onClose();
                      } else toast.error(r.error);
                    })
                  }
                >
                  <Copy /> Duplicate
                </Button>
                {detail.type === "expense" && cmp(refundable, "0") > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setRefundOpen(true)}>
                    <RotateCcw /> Record refund
                  </Button>
                )}
                {detail.receipts.map((r) => (
                  <Button key={r.id} variant="outline" size="sm" asChild>
                    <a href={`/api/receipts/${r.id}`} target="_blank" rel="noreferrer">
                      <Receipt /> View receipt
                    </a>
                  </Button>
                ))}
                <Button variant="ghost" size="sm" className="ml-auto text-negative hover:bg-negative-soft" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {detail && (
        <>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title="Delete this transaction?"
            description="It will be removed from your balances and reports. You can undo right after."
            loading={busy}
            onConfirm={() =>
              start(async () => {
                const r = await deleteTransactionsAction([detail.id]);
                setConfirmDelete(false);
                if (!r.ok) return void toast.error(r.error);
                onClose();
                toast("Transaction deleted", { action: { label: "Undo", onClick: () => void restoreTransactionsAction([detail.id]) } });
              })
            }
          />
          <RefundDialog open={refundOpen} onOpenChange={setRefundOpen} txn={detail} max={refundable} onDone={onClose} />
        </>
      )}
    </>
  );
}

function RefundDialog({ open, onOpenChange, txn, max, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; txn: Detail; max: string; onDone: () => void }) {
  const { prefs } = useAppData();
  const fmt = useMoney();
  const [amount, setAmount] = React.useState(toInputValue(max));
  const [date, setDate] = React.useState(prefs.today);
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Record a refund" description={`Up to ${fmt(max, txn.currency)} can be refunded. Refunds reduce spending in the original category — they aren't counted as income.`} size="sm">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const r = await refundTransactionAction({ id: txn.id, amount, date, notes: notes || null });
              if (!r.ok) return setError(r.error);
              toast.success("Refund recorded");
              onOpenChange(false);
              onDone();
            });
          }}
        >
          <Field label="Amount" htmlFor="r-amt">
            <Input id="r-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Date" htmlFor="r-date">
            <Input id="r-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Note" htmlFor="r-note" optional>
            <Input id="r-note" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} />
          </Field>
          {error && <p role="alert" className="text-sm text-negative">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save refund
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────── Main view ───────────── */

export function TransactionsView({
  filters,
  rangePreset,
  range,
  initial,
  summary,
  tags,
  merchants,
  openId,
}: {
  filters: TransactionFilters;
  rangePreset: string;
  range: { from: string; to: string };
  initial: { rows: TransactionRow[]; hasMore: boolean; nextOffset: number };
  summary: Summary;
  tags: { id: string; name: string }[];
  merchants: { id: string; name: string }[];
  openId: string | null;
}) {
  const { prefs, categories } = useAppData();
  const { openQuickAdd } = useShell();
  const fmt = useMoney();
  const params = useSearchParams();
  const router = useRouter();
  const nav = useFilterNav();
  const [rows, setRows] = React.useState(initial.rows);
  const [hasMore, setHasMore] = React.useState(initial.hasMore);
  const [offset, setOffset] = React.useState(initial.nextOffset);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [openTxn, setOpenTxn] = React.useState<string | null>(openId);
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const [busy, start] = React.useTransition();

  // Server re-renders (after a save or filter change) deliver a fresh first page: reset the list.
  const [prevInitial, setPrevInitial] = React.useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setRows(initial.rows);
    setHasMore(initial.hasMore);
    setOffset(initial.nextOffset);
  }

  const loadMore = async () => {
    setLoadingMore(true);
    const r = await loadTransactionsAction({ filters, offset, limit: 50 });
    setLoadingMore(false);
    if (!r.ok) return void toast.error(r.error);
    setRows((prev) => [...prev, ...r.data.rows.filter((n) => !prev.some((p) => p.id === n.id))]);
    setHasMore(r.data.hasMore);
    setOffset(r.data.nextOffset);
  };

  const groups = React.useMemo(() => {
    const map = new Map<string, TransactionRow[]>();
    for (const r of rows) map.set(r.date, [...(map.get(r.date) ?? []), r]);
    return [...map.entries()].map(([date, items]) => {
      let out = "0";
      let inn = "0";
      for (const t of items) {
        if (t.type === "expense") out = add(out, t.baseAmount);
        if (t.type === "refund") out = sub(out, t.baseAmount);
        if (t.type === "income") inn = add(inn, t.baseAmount);
      }
      return { date, items, out, inn };
    });
  }, [rows]);

  const sortedByDate = !filters.sort || filters.sort.startsWith("date");
  const typeValue = filters.types?.length === 1 ? filters.types[0] : filters.types?.length ? "custom" : "all";
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const exportHref = `/api/export/transactions?${params.toString()}`;
  const hasFilters = Boolean(filters.q || filters.from || filters.types || filters.accountIds || filters.categoryIds || filters.tagIds || filters.minAmount || filters.maxAmount || filters.merchantIds || filters.paymentMethodIds);

  return (
    <div>
      <PageHeader
        title="Transactions"
        description={
          summary.count > 0 ? (
            <span className="num">
              {pluralize(summary.count, "transaction")} · spent {fmt(summary.spending)} · income {fmt(summary.income)}
            </span>
          ) : undefined
        }
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setSelecting((s) => !s)}>
                  <CheckSquare /> {selecting ? "Done selecting" : "Select multiple"}
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={exportHref}>
                    <Download /> Export CSV
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="/import">
                    <Download className="rotate-180" /> Import CSV
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => openQuickAdd()}>
              <Plus /> Add
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-[minmax(0,1fr)] gap-2.5">
        <div className="flex gap-2">
          <SearchBox />
          <FiltersPopover tags={tags} merchants={merchants} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label="Date range"
            value={rangePreset}
            onChange={(e) => nav({ range: e.target.value === "all" ? null : e.target.value, from: null, to: null })}
            className="h-8 w-auto py-0 text-[13px]"
          >
            {RANGE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {rangePreset === "custom" && <option value="custom">{`${formatDate(range.from, "d MMM")} – ${formatDate(range.to, "d MMM yyyy")}`}</option>}
          </NativeSelect>
          <div className="scrollbar-none -mx-1 overflow-x-auto px-1">
            <Segmented
              size="sm"
              ariaLabel="Transaction type"
              value={typeValue as "all"}
              onChange={(v) => nav({ type: v === "all" ? null : v })}
              options={[
                { value: "all", label: "All" },
                { value: "expense" as "all", label: "Expenses" },
                { value: "income" as "all", label: "Income" },
                { value: "transfer" as "all", label: "Transfers" },
                { value: "refund" as "all", label: "Refunds" },
              ]}
            />
          </div>
          <NativeSelect aria-label="Sort" value={filters.sort ?? "date_desc"} onChange={(e) => nav({ sort: e.target.value === "date_desc" ? null : e.target.value })} className="h-8 w-auto py-0 text-[13px]">
            <option value="date_desc">Newest first</option>
            <option value="date_asc">Oldest first</option>
            <option value="amount_desc">Largest first</option>
            <option value="amount_asc">Smallest first</option>
          </NativeSelect>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={() => router.push("/transactions")}>
              <X /> Reset
            </Button>
          )}
        </div>
        {filters.categoryIds?.length === 1 && (
          <p className="text-[13px] text-muted-foreground">
            Category: <strong className="text-foreground">{categories.find((c) => c.id === filters.categoryIds![0])?.name ?? "—"}</strong> (including subcategories and splits)
          </p>
        )}
      </div>

      {selecting && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm lg:top-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>
            Select loaded
          </Button>
          <div className="flex-1" />
          <NativeSelect
            aria-label="Set category for selected"
            className="h-8 w-44 py-0 text-[13px]"
            value=""
            disabled={!selected.size || busy}
            onChange={(e) => {
              const categoryId = e.target.value === "none" ? null : e.target.value;
              start(async () => {
                const r = await bulkCategorizeAction({ ids: [...selected], categoryId });
                if (r.ok) {
                  toast.success(`Updated ${pluralize(r.data.count, "transaction")}`);
                  setSelected(new Set());
                } else toast.error(r.error);
              });
            }}
          >
            <option value="">Set category…</option>
            <option value="none">Uncategorised</option>
            {categories
              .filter((c) => !c.isArchived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.kind === "income" ? "↑ " : ""}
                  {c.name}
                </option>
              ))}
          </NativeSelect>
          <Button variant="destructive" size="sm" disabled={!selected.size} onClick={() => setConfirmBulk(true)}>
            <Trash2 /> Delete
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Stop selecting" onClick={() => (setSelecting(false), setSelected(new Set()))}>
            <X />
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={hasFilters ? <Search /> : <Tag />}
            title={hasFilters ? "No transactions match" : "No transactions yet"}
            description={hasFilters ? "Try a different search or clear some filters." : "Add your first expense — it takes a few seconds. Or import a CSV from your bank."}
            action={
              hasFilters ? (
                <Button variant="outline" onClick={() => router.push("/transactions")}>
                  Clear search
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Button onClick={() => openQuickAdd()}>
                    <Plus /> Add transaction
                  </Button>
                  <Button variant="outline" asChild>
                    <a href="/import">Import CSV</a>
                  </Button>
                </div>
              )
            }
          />
        </Card>
      ) : sortedByDate ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {groups.map((g) => (
            <section key={g.date} aria-labelledby={`d-${g.date}`}>
              <div className="mb-1.5 flex items-baseline justify-between px-1">
                <h2 id={`d-${g.date}`} className="text-[13px] font-medium text-muted-foreground">
                  {relativeDayLabel(g.date, prefs.today)}
                </h2>
                <p className="num text-[12.5px] text-muted-foreground">
                  {cmp(g.inn, "0") > 0 && <span className="mr-2 text-positive">+{fmt(g.inn)}</span>}
                  {cmp(g.out, "0") !== 0 && <span>−{fmt(g.out)}</span>}
                </p>
              </div>
              <Card className="overflow-hidden">
                <ul className="divide-y">
                  {g.items.map((t) => (
                    <TransactionItem key={t.id} t={t} selecting={selecting} selected={selected.has(t.id)} onToggle={() => toggle(t.id)} onOpen={() => setOpenTxn(t.id)} />
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {rows.map((t) => (
              <TransactionItem key={t.id} t={t} selecting={selecting} selected={selected.has(t.id)} onToggle={() => toggle(t.id)} onOpen={() => setOpenTxn(t.id)} />
            ))}
          </ul>
        </Card>
      )}

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="animate-spin" />} Load more
          </Button>
        </div>
      )}

      <EditDialog key={openTxn ?? "closed"} id={openTxn} onClose={() => setOpenTxn(null)} />
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`Delete ${pluralize(selected.size, "transaction")}?`}
        description="They'll be removed from balances and reports. You can undo right after."
        loading={busy}
        onConfirm={() =>
          start(async () => {
            const list = [...selected];
            const r = await deleteTransactionsAction(list);
            setConfirmBulk(false);
            if (!r.ok) return void toast.error(r.error);
            setSelected(new Set());
            toast(`Deleted ${pluralize(r.data.count, "transaction")}`, {
              action: { label: <span className="inline-flex items-center gap-1"><Undo2 className="size-3" /> Undo</span>, onClick: () => void restoreTransactionsAction(list) },
            });
          })
        }
      />
    </div>
  );
}
