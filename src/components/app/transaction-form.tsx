"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, ChevronDown, Loader2, Paperclip, Plus, ScanLine, Sparkles, Split, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { Segmented, Switch } from "@/components/ui/controls";
import { cn } from "@/lib/utils";
import { addDaysISO } from "@/lib/dates";
import { add, cmp, currencySymbol, normalize, sub, toInputValue, isZero } from "@/lib/money";
import { evalAmount } from "@/lib/amount-expr";
import { CURRENCIES } from "@/lib/money";
import { CategoryBadge } from "./icons";
import { ReceiptScanner, type ScannedReceipt } from "./receipt-scanner";
import { useAppData, useMoney, type ClientCategory } from "./user-context";
import {
  createTransactionAction,
  deleteTransactionsAction,
  merchantCategoryAction,
  parseTextAction,
  restoreTransactionsAction,
  suggestMerchantsAction,
  updateTransactionAction,
} from "@/app/(app)/transactions/actions";
import { createAccountAction } from "@/app/(app)/accounts/actions";

export type TxType = "expense" | "income" | "transfer" | "refund" | "adjustment";

export type TransactionFormValues = {
  id?: string;
  type: TxType;
  amount: string;
  accountId: string;
  toAccountId: string;
  toAmount: string;
  categoryId: string | null;
  date: string;
  merchant: string;
  paymentMethodId: string;
  notes: string;
  tags: string[];
  isPending: boolean;
  splits: { categoryId: string; amount: string }[];
  originalCurrency: string;
  originalAmount: string;
  refundOfId: string | null;
  receipt: { id: string; filename: string } | null;
};

export function emptyValues(prefs: { today: string; defaultAccountId: string | null; defaultPaymentMethodId: string | null }, accounts: { id: string }[]): TransactionFormValues {
  return {
    type: "expense",
    amount: "",
    accountId: prefs.defaultAccountId && accounts.some((a) => a.id === prefs.defaultAccountId) ? prefs.defaultAccountId : (accounts[0]?.id ?? ""),
    toAccountId: "",
    toAmount: "",
    categoryId: null,
    date: prefs.today,
    merchant: "",
    paymentMethodId: prefs.defaultPaymentMethodId ?? "",
    notes: "",
    tags: [],
    isPending: false,
    splits: [],
    originalCurrency: "",
    originalAmount: "",
    refundOfId: null,
    receipt: null,
  };
}

/* ───────────── Category picker ───────────── */

function CategoryPicker({
  categories,
  kind,
  value,
  onChange,
  invalid,
}: {
  categories: ClientCategory[];
  kind: "expense" | "income";
  value: string | null;
  onChange: (id: string | null) => void;
  invalid?: boolean;
}) {
  const parents = categories.filter((c) => c.kind === kind && !c.parentId && !c.isArchived);
  const selected = categories.find((c) => c.id === value);
  const activeParentId = selected ? (selected.parentId ?? selected.id) : null;
  const children = activeParentId ? categories.filter((c) => c.parentId === activeParentId && !c.isArchived) : [];
  return (
    <div className={cn("grid gap-2", invalid && "rounded-lg ring-1 ring-negative/40")} role="group" aria-label="Category">
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
        {parents.map((c) => {
          const active = activeParentId === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(active && value === c.id ? null : c.id)}
              aria-pressed={active}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border border-transparent px-1 py-2 text-center text-[11.5px] leading-tight text-muted-foreground transition hover:bg-muted",
                active && "border-border-strong bg-muted text-foreground",
              )}
            >
              <CategoryBadge icon={c.icon} color={c.color} size="md" />
              <span className="line-clamp-2">{c.name}</span>
            </button>
          );
        })}
      </div>
      {children.length > 0 && (
        <div className="flex flex-wrap gap-1.5 rounded-lg bg-subtle p-2">
          <span className="sr-only">Subcategory</span>
          {children.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(value === c.id ? activeParentId : c.id)}
              aria-pressed={value === c.id}
              className={cn(
                "rounded-full border bg-card px-2.5 py-1 text-[12.5px] text-muted-foreground transition hover:text-foreground",
                value === c.id && "border-foreground/40 text-foreground",
              )}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CategorySelect({ categories, kind, value, onChange, id }: { categories: ClientCategory[]; kind: "expense" | "income"; value: string; onChange: (v: string) => void; id?: string }) {
  const parents = categories.filter((c) => c.kind === kind && !c.parentId && !c.isArchived);
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Category">
      <option value="">Choose category…</option>
      {parents.map((p) => (
        <optgroup key={p.id} label={p.name}>
          <option value={p.id}>{p.name}</option>
          {categories
            .filter((c) => c.parentId === p.id && !c.isArchived)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {p.name} › {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

/* ───────────── Merchant input with suggestions ───────────── */

function MerchantInput({ value, onChange, onPick }: { value: string; onChange: (v: string) => void; onPick: (name: string, categoryId: string | null) => void }) {
  const [items, setItems] = React.useState<{ id: string; name: string; defaultCategoryId: string | null }[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const listId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      const r = await suggestMerchantsAction(value);
      if (r.ok) setItems(r.data.filter((m) => m.name.toLowerCase() !== value.trim().toLowerCase() || value.length === 0));
    }, 120);
    return () => clearTimeout(t);
  }, [value, open]);
  return (
    <div className="relative">
      <Input
        id="merchant"
        value={value}
        placeholder="Where? e.g. Starbucks"
        autoComplete="off"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (!open || !items.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            onPick(items[active].name, items[active].defaultCategoryId);
            setOpen(false);
          } else if (e.key === "Escape") setOpen(false);
        }}
        maxLength={80}
      />
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" className="absolute top-full z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border bg-popover p-1 shadow-md">
          {items.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(m.name, m.defaultCategoryId);
                setOpen(false);
              }}
              className={cn("cursor-pointer rounded-md px-2 py-1.5 text-sm", i === active ? "bg-muted" : "hover:bg-muted")}
            >
              {m.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ───────────── First-account bootstrap ───────────── */

function FirstAccount({ onCreated }: { onCreated: (id: string) => void }) {
  const { prefs } = useAppData();
  const [name, setName] = React.useState("Cash");
  const [type, setType] = React.useState("cash");
  const [balance, setBalance] = React.useState("");
  const [pending, start] = React.useTransition();
  return (
    <div className="grid gap-3 rounded-lg border bg-subtle p-4">
      <div>
        <p className="text-sm font-medium">First, where does money come from?</p>
        <p className="text-[13px] text-muted-foreground">Create an account to record transactions against. You can add more later.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Account name" />
        <NativeSelect value={type} onChange={(e) => setType(e.target.value)} aria-label="Account type">
          <option value="cash">Cash</option>
          <option value="checking">Bank account</option>
          <option value="savings">Savings</option>
          <option value="wallet">Wallet</option>
          <option value="credit_card">Credit card</option>
        </NativeSelect>
      </div>
      <Input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" placeholder={`Current balance (${prefs.currency})`} aria-label="Current balance" />
      <Button
        type="button"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await createAccountAction({ name, type: type as "cash", currency: prefs.currency, openingBalance: balance || "0" });
            if (r.ok) onCreated(r.data.id);
            else toast.error(r.error);
          })
        }
      >
        Create account
      </Button>
    </div>
  );
}

/* ───────────── The form ───────────── */

export function TransactionForm({
  initial,
  initialText,
  onDone,
  allowTypes = ["expense", "income", "transfer"],
  compact,
}: {
  initial?: Partial<TransactionFormValues>;
  /** Natural-language text to parse on open (e.g. from the command palette). */
  initialText?: string;
  onDone?: (id?: string) => void;
  allowTypes?: TxType[];
  compact?: boolean;
}) {
  const { prefs, accounts: allAccounts, categories, paymentMethods } = useAppData();
  const accounts = allAccounts.filter((a) => !a.isArchived || a.id === initial?.accountId || a.id === initial?.toAccountId);
  const fmt = useMoney();
  const editing = Boolean(initial?.id);
  const [v, setV] = React.useState<TransactionFormValues>(() => ({ ...emptyValues(prefs, accounts), ...initial }));
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [showMore, setShowMore] = React.useState(
    Boolean(initial?.notes || initial?.tags?.length || initial?.splits?.length || initial?.originalCurrency || initial?.receipt || initial?.isPending),
  );
  const [nl, setNl] = React.useState(initialText ?? "");
  const [parsing, setParsing] = React.useState(false);
  const [parsedNote, setParsedNote] = React.useState<{ parser: string; uncertain: string[] } | null>(null);
  const [tagDraft, setTagDraft] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [pending, start] = React.useTransition();
  const amountRef = React.useRef<HTMLInputElement>(null);

  const set = <K extends keyof TransactionFormValues>(k: K, val: TransactionFormValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const account = accounts.find((a) => a.id === v.accountId);
  const toAccount = accounts.find((a) => a.id === v.toAccountId);
  const currency = account?.currency ?? prefs.currency;
  const kind: "expense" | "income" = v.type === "income" ? "income" : "expense";
  const amountValue = evalAmount(v.amount);
  const isTransfer = v.type === "transfer";
  const splitting = v.splits.length > 0;
  const splitTotal = add(...v.splits.map((s) => evalAmount(s.amount) ?? "0"));
  const splitRemaining = amountValue ? sub(amountValue, splitTotal) : "0";

  const runParse = React.useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setParsing(true);
      const r = await parseTextAction(text);
      setParsing(false);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const d = r.data;
      setV((s) => ({
        ...s,
        type: d.type,
        amount: d.amount ? toInputValue(d.amount) : s.amount,
        date: d.date,
        merchant: d.merchant ?? "",
        notes: d.notes ?? s.notes,
        categoryId: d.categoryId,
        accountId: d.accountId ?? s.accountId,
        paymentMethodId: d.paymentMethodId ?? s.paymentMethodId,
      }));
      setParsedNote({ parser: d.parser, uncertain: d.uncertain });
      if (d.notes) setShowMore(true);
      setTimeout(() => amountRef.current?.focus(), 0);
    },
    [],
  );

  React.useEffect(() => {
    // Kick off parsing of text handed over by the command palette (async request; sets a loading flag).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialText) void runParse(initialText);
  }, [initialText, runParse]);

  async function uploadReceipt(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (v.id) fd.append("transactionId", v.id);
      const r = await fetch("/api/receipts", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Upload failed");
      set("receipt", { id: j.id, filename: j.filename });
      toast.success("Receipt attached");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function applyReceipt(r: ScannedReceipt) {
    const notes = r.notes;
    setV((s) => ({
      ...s,
      type: s.type === "income" || s.type === "transfer" ? "expense" : s.type,
      amount: r.amount ?? s.amount,
      merchant: r.merchant ?? s.merchant,
      date: r.date ?? s.date,
      notes: s.notes || notes || "",
      paymentMethodId: r.paymentMethodId ?? s.paymentMethodId,
      receipt: r.receipt,
    }));
    setParsedNote({ parser: "receipt", uncertain: [!r.amount && "amount", !r.merchant && "merchant", !r.date && "date"].filter(Boolean) as string[] });
    setShowMore(true);
    if (r.merchant) {
      const c = await merchantCategoryAction(r.merchant);
      if (c.ok && c.data) setV((s) => (s.categoryId ? s : { ...s, categoryId: categories.some((k) => k.id === c.data && k.kind === "expense") ? c.data : null }));
    }
    setTimeout(() => amountRef.current?.focus(), 0);
  }

  function addTag(raw: string) {
    const t = raw.trim().replace(/^#/, "");
    if (t && !v.tags.some((x) => x.toLowerCase() === t.toLowerCase())) set("tags", [...v.tags, t].slice(0, 20));
    setTagDraft("");
  }

  function submit(another: boolean) {
    setErrors({});
    setFormError(null);
    if (!amountValue || cmp(amountValue, "0") <= 0) {
      setErrors({ amount: ["Enter an amount"] });
      amountRef.current?.focus();
      return;
    }
    if (splitting && !isZero(splitRemaining)) {
      setErrors({ splits: [`Splits must add up to ${fmt(amountValue, currency)} — ${fmt(splitRemaining, currency)} left`] });
      return;
    }
    const payload = {
      type: v.type,
      accountId: v.accountId,
      amount: amountValue,
      date: v.date,
      categoryId: isTransfer || splitting ? null : v.categoryId,
      merchant: isTransfer ? null : v.merchant || null,
      paymentMethodId: isTransfer ? null : v.paymentMethodId || null,
      notes: v.notes || null,
      tags: v.tags,
      toAccountId: isTransfer ? v.toAccountId || null : null,
      toAmount: isTransfer && toAccount && account && toAccount.currency !== account.currency ? evalAmount(v.toAmount) : null,
      refundOfId: v.refundOfId,
      splits: splitting ? v.splits.map((s) => ({ categoryId: s.categoryId, amount: evalAmount(s.amount) ?? "0" })) : [],
      isPending: v.isPending,
      originalCurrency: v.originalCurrency || null,
      originalAmount: v.originalCurrency ? evalAmount(v.originalAmount) : null,
      receiptId: v.receipt && !editing ? v.receipt.id : null,
    };
    start(async () => {
      const r = editing ? await updateTransactionAction({ id: v.id!, data: payload }) : await createTransactionAction(payload);
      if (!r.ok) {
        setFormError(r.error);
        setErrors(r.fieldErrors ?? {});
        return;
      }
      const id = r.data.id;
      const label = isTransfer ? "Transfer" : v.type === "income" ? "Income" : v.type === "refund" ? "Refund" : "Expense";
      toast.success(editing ? `${label} updated` : `${label} of ${fmt(amountValue, currency)} saved`, {
        action: editing
          ? undefined
          : {
              label: "Undo",
              onClick: async () => {
                const u = await deleteTransactionsAction([id]);
                if (u.ok)
                  toast("Removed", {
                    action: { label: "Redo", onClick: () => void restoreTransactionsAction([id]) },
                  });
              },
            },
      });
      if (another) {
        setV((s) => ({ ...s, amount: "", merchant: "", notes: "", tags: [], splits: [], categoryId: null, receipt: null, originalAmount: "" }));
        setNl("");
        setParsedNote(null);
        amountRef.current?.focus();
      } else onDone?.(id);
    });
  }

  if (!accounts.length) return <FirstAccount onCreated={(id) => set("accountId", id)} />;

  const typeOptions = (
    [
      { value: "expense", label: "Expense" },
      { value: "income", label: "Income" },
      { value: "transfer", label: "Transfer" },
      { value: "refund", label: "Refund" },
      { value: "adjustment", label: "Adjustment" },
    ] as { value: TxType; label: string }[]
  ).filter((o) => allowTypes.includes(o.value) || o.value === v.type);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          submit(false);
        }
      }}
    >
      {!editing && (
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Sparkles className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-accent" aria-hidden />
            <Input
              value={nl}
              onChange={(e) => setNl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runParse(nl);
                }
              }}
              placeholder='Type it naturally — "Spent 450 at Starbucks today"'
              aria-label="Describe the transaction in your own words"
              className="h-10 bg-subtle pr-20 pl-9"
              maxLength={300}
            />
            <Button type="button" size="sm" variant="ghost" className="absolute top-1 right-1 h-8" onClick={() => void runParse(nl)} disabled={!nl.trim() || parsing}>
              {parsing ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              <span className="sr-only">Fill from text</span>
            </Button>
          </div>
          <Button type="button" variant="outline" size="icon" className="size-10" aria-label="Scan receipt" title="Scan receipt" onClick={() => setScanning(true)}>
            <ScanLine />
          </Button>
          {/* Portalled; its own form stops event propagation so it never submits this one. */}
          <ReceiptScanner open={scanning} onOpenChange={setScanning} onComplete={(r) => void applyReceipt(r)} />
        </div>
      )}
      {parsedNote && (
        <div role="status" className="flex items-start gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" />
          <p>
            {parsedNote.parser === "receipt" ? "Filled in from your receipt" : `Filled in from your note${parsedNote.parser === "ai" ? " with AI" : ""}`} — please check before saving.
            {parsedNote.uncertain.length > 0 && <> Not sure about: <strong>{parsedNote.uncertain.join(", ")}</strong>.</>}
          </p>
        </div>
      )}

      {typeOptions.length > 1 && (
        <Segmented
          ariaLabel="Transaction type"
          value={v.type}
          onChange={(t) => setV((s) => ({ ...s, type: t, categoryId: null, splits: [] }))}
          options={typeOptions}
          className="w-full"
        />
      )}

      <div>
        <label htmlFor="amount" className="sr-only">
          Amount
        </label>
        <div className={cn("flex items-baseline gap-2 border-b-2 border-border pb-1 transition-colors focus-within:border-foreground", errors.amount && "border-negative")}>
          <span className="text-2xl font-medium text-muted-foreground">{currencySymbol(currency, prefs.locale)}</span>
          <input
            ref={amountRef}
            id="amount"
            value={v.amount}
            onChange={(e) => set("amount", e.target.value.replace(/[^\d.,+\-\s]/g, ""))}
            inputMode="decimal"
            autoComplete="off"
            autoFocus={!initialText}
            placeholder="0"
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={errors.amount ? "amount-error" : undefined}
            className="num w-full min-w-0 bg-transparent text-[40px] leading-tight font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
          />
        </div>
        {v.amount && amountValue && /[+-]/.test(v.amount.replace(/^[+-]/, "")) && (
          <p className="mt-1 text-[13px] text-muted-foreground">= {fmt(amountValue, currency)}</p>
        )}
        {errors.amount && (
          <p id="amount-error" role="alert" className="mt-1 text-[13px] text-negative">
            {errors.amount[0]}
          </p>
        )}
      </div>

      {isTransfer ? (
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label="From" htmlFor="from">
            <NativeSelect id="from" value={v.accountId} onChange={(e) => set("accountId", e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <ArrowRight className="mb-3 size-4 text-muted-foreground" aria-hidden />
          <Field label="To" htmlFor="to" error={errors.toAccountId}>
            <NativeSelect id="to" value={v.toAccountId} onChange={(e) => set("toAccountId", e.target.value)} aria-invalid={errors.toAccountId ? true : undefined}>
              <option value="">Choose…</option>
              {accounts
                .filter((a) => a.id !== v.accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          {toAccount && account && toAccount.currency !== account.currency && (
            <Field label={`Amount received (${toAccount.currency})`} htmlFor="toAmount" className="col-span-3" error={errors.toAmount}>
              <Input id="toAmount" inputMode="decimal" value={v.toAmount} onChange={(e) => set("toAmount", e.target.value)} />
            </Field>
          )}
        </div>
      ) : (
        <>
          {!splitting && v.type !== "adjustment" && (
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <CategoryPicker categories={categories} kind={kind} value={v.categoryId} onChange={(id) => set("categoryId", id)} invalid={Boolean(errors.categoryId)} />
              {errors.categoryId && <p className="text-[13px] text-negative">{errors.categoryId[0]}</p>}
            </div>
          )}
          {v.type !== "adjustment" && (
            <Field label={v.type === "income" ? "From (payer)" : "Merchant"} htmlFor="merchant" optional>
              <MerchantInput
                value={v.merchant}
                onChange={(m) => set("merchant", m)}
                onPick={(name, categoryId) => {
                  setV((s) => ({ ...s, merchant: name, categoryId: s.categoryId ?? (categories.find((c) => c.id === categoryId && c.kind === kind) ? categoryId : null) }));
                }}
              />
            </Field>
          )}
        </>
      )}

      <div className={cn("grid gap-3", isTransfer ? "grid-cols-1" : "grid-cols-2")}>
        <Field label="Date" htmlFor="date" error={errors.date}>
          <div className="grid gap-1.5">
            <Input id="date" type="date" value={v.date} max={addDaysISO(prefs.today, 366)} onChange={(e) => set("date", e.target.value)} required />
            <div className="flex gap-1">
              {[
                { d: prefs.today, l: "Today" },
                { d: addDaysISO(prefs.today, -1), l: "Yesterday" },
              ].map((o) => (
                <button
                  key={o.l}
                  type="button"
                  onClick={() => set("date", o.d)}
                  aria-pressed={v.date === o.d}
                  className={cn("rounded-full border px-2 py-0.5 text-[12px] text-muted-foreground", v.date === o.d && "border-foreground/40 text-foreground")}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>
        </Field>
        {!isTransfer && (
          <Field label="Account" htmlFor="account" error={errors.accountId}>
            <NativeSelect id="account" value={v.accountId} onChange={(e) => set("accountId", e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.currency !== prefs.currency ? ` (${a.currency})` : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
      </div>

      {!isTransfer && v.type !== "adjustment" && (
        <Field label="Paid with" htmlFor="pm" optional>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Payment method" id="pm">
            {paymentMethods.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={v.paymentMethodId === p.id}
                onClick={() => {
                  const selecting = v.paymentMethodId !== p.id;
                  setV((s) => ({
                    ...s,
                    paymentMethodId: selecting ? p.id : "",
                    accountId: selecting && p.defaultAccountId && accounts.some((a) => a.id === p.defaultAccountId) ? p.defaultAccountId : s.accountId,
                  }));
                }}
                className={cn(
                  "rounded-full border bg-card px-3 py-1 text-[13px] text-muted-foreground transition hover:text-foreground",
                  v.paymentMethodId === p.id && "border-foreground bg-foreground text-background hover:text-background",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        </Field>
      )}

      <button
        type="button"
        onClick={() => setShowMore((s) => !s)}
        aria-expanded={showMore}
        className="flex items-center gap-1 justify-self-start text-[13px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("size-4 transition-transform", showMore && "rotate-180")} />
        {showMore ? "Fewer details" : "Notes, tags, split, receipt…"}
      </button>

      {showMore && (
        <div className="grid gap-4 rounded-lg border bg-subtle/60 p-3.5">
          <Field label="Notes" htmlFor="notes" optional>
            <Textarea id="notes" rows={2} value={v.notes} onChange={(e) => set("notes", e.target.value)} maxLength={1000} placeholder="What was it for?" />
          </Field>
          <Field label="Tags" htmlFor="tags" optional>
            <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5">
              {v.tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[12.5px]">
                  #{t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => set("tags", v.tags.filter((x) => x !== t))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                id="tags"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === " ") {
                    if (tagDraft.trim()) {
                      e.preventDefault();
                      addTag(tagDraft);
                    }
                  } else if (e.key === "Backspace" && !tagDraft && v.tags.length) set("tags", v.tags.slice(0, -1));
                }}
                onBlur={() => tagDraft && addTag(tagDraft)}
                placeholder={v.tags.length ? "" : "vacation, work…"}
                className="min-w-24 flex-1 bg-transparent text-sm outline-none"
                maxLength={30}
              />
            </div>
          </Field>

          {(v.type === "expense" || v.type === "income") && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Split className="size-3.5" /> Split across categories
                </Label>
                <Switch
                  checked={splitting}
                  aria-label="Split across categories"
                  onCheckedChange={(on) => {
                    if (on) {
                      const half = amountValue ? normalize(amountValue) : "";
                      set("splits", [
                        { categoryId: v.categoryId ?? "", amount: half ? toInputValue(half) : "" },
                        { categoryId: "", amount: "" },
                      ]);
                    } else set("splits", []);
                  }}
                />
              </div>
              {splitting && (
                <div className="grid gap-2">
                  {v.splits.map((s, i) => (
                    <div key={i} className="grid grid-cols-[1fr_7rem_auto] gap-2">
                      <CategorySelect
                        categories={categories}
                        kind={kind}
                        value={s.categoryId}
                        onChange={(val) => set("splits", v.splits.map((x, j) => (j === i ? { ...x, categoryId: val } : x)))}
                      />
                      <Input
                        inputMode="decimal"
                        aria-label={`Split ${i + 1} amount`}
                        value={s.amount}
                        onChange={(e) => set("splits", v.splits.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                        placeholder="0"
                        className="num text-right"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove split"
                        disabled={v.splits.length <= 2}
                        onClick={() => set("splits", v.splits.filter((_, j) => j !== i))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-[13px]">
                    <Button type="button" variant="ghost" size="sm" onClick={() => set("splits", [...v.splits, { categoryId: "", amount: isZero(splitRemaining) ? "" : toInputValue(splitRemaining) }])}>
                      <Plus /> Add part
                    </Button>
                    <span className={cn("num", isZero(splitRemaining) ? "text-positive" : "text-warning")} aria-live="polite">
                      {isZero(splitRemaining) ? "Adds up ✓" : `${fmt(splitRemaining, currency)} ${cmp(splitRemaining, "0") > 0 ? "left to assign" : "over"}`}
                    </span>
                  </div>
                  {errors.splits && <p className="text-[13px] text-negative">{errors.splits[0]}</p>}
                </div>
              )}
            </div>
          )}

          {!isTransfer && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Paid in another currency" htmlFor="ocur" optional>
                <NativeSelect id="ocur" value={v.originalCurrency} onChange={(e) => set("originalCurrency", e.target.value)}>
                  <option value="">Same as account ({currency})</option>
                  {CURRENCIES.filter((c) => c.code !== currency).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {v.originalCurrency && (
                <Field label={`Amount in ${v.originalCurrency}`} htmlFor="oamt" hint={`The amount above is what was charged in ${currency}.`}>
                  <Input id="oamt" inputMode="decimal" value={v.originalAmount} onChange={(e) => set("originalAmount", e.target.value)} />
                </Field>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={v.isPending} onCheckedChange={(c) => set("isPending", c)} aria-label="Pending" /> Pending (not cleared yet)
            </label>
            <div className="flex items-center gap-2">
              {v.receipt ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12.5px]">
                  <Paperclip className="size-3.5" />
                  <a href={`/api/receipts/${v.receipt.id}`} target="_blank" rel="noreferrer" className="max-w-36 truncate underline-offset-2 hover:underline">
                    {v.receipt.filename}
                  </a>
                  {!editing && (
                    <button type="button" aria-label="Remove receipt" onClick={() => set("receipt", null)}>
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ) : (
                <label className={cn("inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[13px] text-muted-foreground hover:text-foreground", uploading && "opacity-60")}>
                  {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
                  Attach receipt
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="sr-only"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadReceipt(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
          </div>
        </div>
      )}

      {formError && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {formError}
        </p>
      )}

      <div className={cn("flex gap-2", compact ? "" : "pt-1")}>
        {!editing && (
          <Button type="button" variant="outline" size="lg" className="flex-1 sm:flex-none" disabled={pending} onClick={() => submit(true)}>
            Save & add another
          </Button>
        )}
        <Button type="submit" size="lg" loading={pending} className="flex-1">
          {editing ? "Save changes" : "Save"}
        </Button>
      </div>
    </form>
  );
}
