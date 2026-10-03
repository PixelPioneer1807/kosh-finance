"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, MoreHorizontal, Pencil, Plus, Scale, Trash2, Wallet, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState, PageHeader, Progress } from "@/components/ui/misc";
import { Icon } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData, useMoney } from "@/components/app/user-context";
import { CURRENCIES, neg, sub, toInputValue, isNegative } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ACCOUNT_TYPES_CLIENT } from "./account-types";
import { archiveAccountAction, createAccountAction, deleteAccountAction, reconcileAccountAction, reorderAccountsAction, updateAccountAction } from "./actions";

export type AccountRow = {
  id: string; name: string; type: string; currency: string; balance: string; baseBalance: string | null; openingBalance: string;
  openingDate: string | null; institution: string | null; notes: string | null; color: string | null; includeInNetWorth: boolean;
  isArchived: boolean; liability: boolean; creditLimit: string | null; statementDay: number | null; dueDay: number | null;
  minimumPayment: string | null; annualFee: string | null; interestRate: string | null; availableCredit: string | null; utilization: number | null;
};

const typeMeta = (t: string) => ACCOUNT_TYPES_CLIENT.find((x) => x.id === t) ?? ACCOUNT_TYPES_CLIENT[ACCOUNT_TYPES_CLIENT.length - 1];

function AccountDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account?: AccountRow | null }) {
  const { prefs } = useAppData();
  const editing = Boolean(account);
  const [type, setType] = React.useState(account?.type ?? "checking");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const liability = type === "credit_card" || type === "loan";
  const opening = account ? (account.liability ? toInputValue(neg(account.openingBalance)) : toInputValue(account.openingBalance)) : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={editing ? "Edit account" : "Add account"} description={editing ? undefined : "Bank accounts, cash, wallets, cards, loans, investments — anything that holds or owes money."}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const g = (k: string) => String(fd.get(k) ?? "");
            const data = {
              name: g("name"),
              type: type as "checking",
              currency: g("currency"),
              openingBalance: g("openingBalance") || "0",
              openingDate: g("openingDate") || null,
              institution: g("institution") || null,
              notes: g("notes") || null,
              includeInNetWorth: fd.get("includeInNetWorth") === "on",
              creditLimit: g("creditLimit") || null,
              statementDay: g("statementDay") || null,
              dueDay: g("dueDay") || null,
              minimumPayment: g("minimumPayment") || null,
              annualFee: g("annualFee") || null,
              interestRate: g("interestRate") || null,
            };
            setErrors({});
            setError(null);
            start(async () => {
              const r = editing ? await updateAccountAction({ id: account!.id, data }) : await createAccountAction(data);
              if (!r.ok) {
                setError(r.error);
                setErrors(r.fieldErrors ?? {});
                return;
              }
              toast.success(editing ? "Account updated" : "Account added");
              onOpenChange(false);
            });
          }}
        >
          <Field label="Type" htmlFor="a-type">
            <div id="a-type" role="radiogroup" aria-label="Account type" className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
              {ACCOUNT_TYPES_CLIENT.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={type === t.id}
                  onClick={() => setType(t.id)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11.5px] text-muted-foreground transition hover:bg-muted",
                    type === t.id && "border-foreground/40 bg-muted text-foreground",
                  )}
                >
                  <Icon name={t.icon} className="size-4" />
                  {t.label}
                </button>
              ))}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field label="Name" htmlFor="a-name" error={errors.name}>
              <Input id="a-name" name="name" defaultValue={account?.name} required maxLength={60} placeholder={typeMeta(type).placeholder} />
            </Field>
            <Field label="Currency" htmlFor="a-cur" error={errors.currency}>
              <NativeSelect id="a-cur" name="currency" defaultValue={account?.currency ?? prefs.currency}>
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={liability ? "Amount owed" : "Opening balance"}
              htmlFor="a-open"
              error={errors.openingBalance}
              hint={liability ? "What you owe as of the start date." : "Balance before the transactions you'll record."}
            >
              <Input id="a-open" name="openingBalance" inputMode="decimal" defaultValue={opening} placeholder="0" />
            </Field>
            <Field label="As of" htmlFor="a-odate" optional>
              <Input id="a-odate" name="openingDate" type="date" defaultValue={account?.openingDate ?? prefs.today} />
            </Field>
          </div>
          {type === "credit_card" && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border bg-subtle p-3 sm:grid-cols-3">
              <Field label="Credit limit" htmlFor="a-limit" error={errors.creditLimit}>
                <Input id="a-limit" name="creditLimit" inputMode="decimal" defaultValue={account?.creditLimit ? toInputValue(account.creditLimit) : ""} />
              </Field>
              <Field label="Statement day" htmlFor="a-sday" error={errors.statementDay}>
                <Input id="a-sday" name="statementDay" type="number" min={1} max={31} defaultValue={account?.statementDay ?? ""} />
              </Field>
              <Field label="Payment due day" htmlFor="a-dday" error={errors.dueDay}>
                <Input id="a-dday" name="dueDay" type="number" min={1} max={31} defaultValue={account?.dueDay ?? ""} />
              </Field>
              <Field label="Minimum payment" htmlFor="a-min">
                <Input id="a-min" name="minimumPayment" inputMode="decimal" defaultValue={account?.minimumPayment ? toInputValue(account.minimumPayment) : ""} />
              </Field>
              <Field label="Annual fee" htmlFor="a-fee">
                <Input id="a-fee" name="annualFee" inputMode="decimal" defaultValue={account?.annualFee ? toInputValue(account.annualFee) : ""} />
              </Field>
              <Field label="Interest rate %" htmlFor="a-apr">
                <Input id="a-apr" name="interestRate" inputMode="decimal" defaultValue={account?.interestRate ? toInputValue(account.interestRate) : ""} />
              </Field>
            </div>
          )}
          {type === "loan" && (
            <div className="grid grid-cols-3 gap-3 rounded-lg border bg-subtle p-3">
              <Field label="Due day" htmlFor="a-ldday">
                <Input id="a-ldday" name="dueDay" type="number" min={1} max={31} defaultValue={account?.dueDay ?? ""} />
              </Field>
              <Field label="EMI / payment" htmlFor="a-lmin">
                <Input id="a-lmin" name="minimumPayment" inputMode="decimal" defaultValue={account?.minimumPayment ? toInputValue(account.minimumPayment) : ""} />
              </Field>
              <Field label="Interest %" htmlFor="a-lapr">
                <Input id="a-lapr" name="interestRate" inputMode="decimal" defaultValue={account?.interestRate ? toInputValue(account.interestRate) : ""} />
              </Field>
            </div>
          )}
          <Field label="Institution" htmlFor="a-inst" optional>
            <Input id="a-inst" name="institution" defaultValue={account?.institution ?? ""} maxLength={80} placeholder="Bank or provider" />
          </Field>
          <Field label="Notes" htmlFor="a-notes" optional>
            <Textarea id="a-notes" name="notes" rows={2} defaultValue={account?.notes ?? ""} maxLength={500} />
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              Include in net worth
              <span className="block text-[13px] text-muted-foreground">Turn off for accounts you track but don&apos;t own.</span>
            </span>
            <Switch name="includeInNetWorth" defaultChecked={account?.includeInNetWorth ?? true} aria-label="Include in net worth" />
          </label>
          {error && <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {editing ? "Save" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReconcileDialog({ account, onClose }: { account: AccountRow | null; onClose: () => void }) {
  const fmt = useMoney();
  const [value, setValue] = React.useState(() => (account ? toInputValue(account.liability ? neg(account.balance) : account.balance) : ""));
  const [pending, start] = React.useTransition();
  if (!account) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title="Update balance"
        description={`Kosh shows ${fmt(account.liability ? neg(account.balance) : account.balance, account.currency)}${account.liability ? " owed" : ""}. Enter the real figure and we'll record an adjustment for the difference.`}
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await reconcileAccountAction({ id: account.id, actualBalance: value });
              if (!r.ok) return void toast.error(r.error);
              toast.success(r.data.adjusted ? "Balance updated" : "Already matches — no change needed");
              onClose();
            });
          }}
        >
          <Field label={account.liability ? "Actual amount owed" : "Actual balance"} htmlFor="rc">
            <Input id="rc" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ account, onClose }: { account: AccountRow | null; onClose: () => void }) {
  const [confirm, setConfirm] = React.useState("");
  const [pending, start] = React.useTransition();
  if (!account) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete “${account.name}” permanently?`}
      description="This deletes the account and every transaction recorded in it. This can't be undone — consider archiving instead."
      confirmLabel="Delete forever"
      loading={pending}
      onConfirm={() => {
        if (confirm.trim() !== account.name) return void toast.error("Type the account name exactly to confirm.");
        start(async () => {
          const r = await deleteAccountAction({ id: account.id, confirmName: confirm });
          if (!r.ok) return void toast.error(r.error);
          toast.success("Account deleted");
          onClose();
        });
      }}
    >
      <Field label={<>Type <strong>{account.name}</strong> to confirm</>} htmlFor="del-confirm" className="mt-4">
        <Input id="del-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </Field>
    </ConfirmDialog>
  );
}

export function AccountsView({ accounts, totals, openNew }: { accounts: AccountRow[]; totals: { assets: string; liabilities: string; unconverted: string[] }; openNew: boolean }) {
  const fmt = useMoney();
  const [dialog, setDialog] = React.useState<{ open: boolean; account: AccountRow | null; nonce: number }>({ open: openNew, account: null, nonce: 0 });
  const [reconcile, setReconcile] = React.useState<AccountRow | null>(null);
  const [del, setDel] = React.useState<AccountRow | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [, start] = React.useTransition();
  const active = accounts.filter((a) => !a.isArchived);
  const archived = accounts.filter((a) => a.isArchived);
  const groups = [
    { label: "Cash & bank", items: active.filter((a) => ["checking", "savings", "cash", "wallet"].includes(a.type)) },
    { label: "Credit cards", items: active.filter((a) => a.type === "credit_card") },
    { label: "Loans & debts", items: active.filter((a) => a.type === "loan") },
    { label: "Investments & assets", items: active.filter((a) => ["investment", "asset", "other"].includes(a.type)) },
  ].filter((g) => g.items.length);

  const move = (id: string, dir: -1 | 1) => {
    const ids = active.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    start(async () => {
      const r = await reorderAccountsAction([...ids, ...archived.map((a) => a.id)]);
      if (!r.ok) toast.error(r.error);
    });
  };

  const row = (a: AccountRow) => {
    const meta = typeMeta(a.type);
    const util = a.utilization ?? 0;
    return (
      <li key={a.id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon name={meta.icon} className="size-4" />
        </span>
        <Link href={`/transactions?account=${a.id}`} className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-medium">{a.name}</span>
            {!a.includeInNetWorth && <Badge variant="outline">Not in net worth</Badge>}
            {a.isArchived && <Badge variant="outline">Archived</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
            {[meta.label, a.institution, a.currency].filter(Boolean).join(" · ")}
          </span>
          {a.type === "credit_card" && a.utilization !== null && (
            <span className="mt-2 flex items-center gap-2">
              <Progress value={util} tone={util >= 0.7 ? "negative" : util >= 0.3 ? "warning" : "positive"} className="max-w-48" label="Credit utilisation" />
              <span className="num text-[12px] text-muted-foreground">
                {Math.round(util * 100)}% used · {fmt(a.availableCredit, a.currency)} available
              </span>
              {util >= 0.3 && <AlertTriangle className={cn("size-3.5", util >= 0.7 ? "text-negative" : "text-warning")} aria-label="High utilisation" />}
            </span>
          )}
        </Link>
        <div className="text-right">
          <Money amount={a.liability ? (isNegative(a.balance) ? neg(a.balance) : a.balance) : a.balance} currency={a.currency} tone={a.liability ? "none" : "balance"} className="text-[15px] font-semibold" />
          {a.liability && <span className="block text-[11.5px] text-muted-foreground">{isNegative(a.balance) ? "owed" : "in credit"}</span>}
          {a.baseBalance && a.currency !== (a.baseBalance ? undefined : a.currency) && a.baseBalance !== a.balance && (
            <span className="block text-[11.5px] text-muted-foreground">≈ {fmt(a.liability ? neg(a.baseBalance) : a.baseBalance)}</span>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setDialog((d) => ({ open: true, account: a, nonce: d.nonce + 1 }))}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setReconcile(a)}>
              <Scale /> Update balance
            </DropdownMenuItem>
            {!a.isArchived && (
              <>
                <DropdownMenuItem onSelect={() => move(a.id, -1)}>
                  <ArrowUp /> Move up
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => move(a.id, 1)}>
                  <ArrowDown /> Move down
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem
              onSelect={() =>
                start(async () => {
                  const r = await archiveAccountAction({ id: a.id, archived: !a.isArchived });
                  if (r.ok) toast.success(a.isArchived ? "Account restored" : "Account archived");
                  else toast.error(r.error);
                })
              }
            >
              {a.isArchived ? <ArchiveRestore /> : <Archive />} {a.isArchived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => setDel(a)}>
              <Trash2 /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
    );
  };

  return (
    <div>
      <PageHeader
        title="Accounts"
        description="Every place your money lives — and everything you owe."
        actions={
          <Button onClick={() => setDialog((d) => ({ open: true, account: null, nonce: d.nonce + 1 }))}>
            <Plus /> Add account
          </Button>
        }
      />
      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Wallet />}
            title="No accounts yet"
            description="Add your bank accounts, cash, cards and loans to see balances and net worth."
            action={
              <Button onClick={() => setDialog((d) => ({ open: true, account: null, nonce: d.nonce + 1 }))}>
                <Plus /> Add your first account
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-3 gap-px overflow-hidden rounded-xl border bg-border">
            {[
              { l: "Assets", v: totals.assets },
              { l: "Liabilities", v: totals.liabilities },
              { l: "Net worth", v: sub(totals.assets, totals.liabilities) },
            ].map((k) => (
              <div key={k.l} className="bg-card px-4 py-3.5 sm:px-5">
                <p className="text-[12.5px] text-muted-foreground">{k.l}</p>
                <Money amount={k.v} className="mt-0.5 block text-lg font-semibold tracking-tight sm:text-xl" tone={k.l === "Net worth" ? "balance" : "none"} />
              </div>
            ))}
          </div>
          {totals.unconverted.length > 0 && (
            <p className="mb-4 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
              Balances in {totals.unconverted.join(", ")} aren&apos;t included in totals yet — add exchange rates in{" "}
              <Link href="/settings/currencies" className="underline">Settings → Currencies</Link>.
            </p>
          )}
          <div className="grid gap-5">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="mb-1.5 px-1 text-[13px] font-medium text-muted-foreground">{g.label}</h2>
                <Card className="overflow-hidden">
                  <ul className="divide-y">{g.items.map(row)}</ul>
                </Card>
              </section>
            ))}
            {archived.length > 0 && (
              <section>
                <button className="mb-1.5 px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground" onClick={() => setShowArchived((s) => !s)} aria-expanded={showArchived}>
                  {showArchived ? "Hide" : "Show"} archived ({archived.length})
                </button>
                {showArchived && (
                  <Card className="overflow-hidden opacity-80">
                    <ul className="divide-y">{archived.map(row)}</ul>
                  </Card>
                )}
              </section>
            )}
          </div>
        </>
      )}
      {/* Keyed so each open starts from fresh form state. */}
      <AccountDialog key={dialog.nonce} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} account={dialog.account} />
      <ReconcileDialog key={reconcile?.id ?? "none"} account={reconcile} onClose={() => setReconcile(null)} />
      <DeleteDialog key={del?.id ?? "none-del"} account={del} onClose={() => setDel(null)} />
    </div>
  );
}
