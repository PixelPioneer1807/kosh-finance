"use client";

import * as React from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Banknote, CreditCard, Landmark, MoreHorizontal, Pencil, Plus, Smartphone, Trash2, Wallet, CircleDashed, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { archivePaymentMethodAction, createPaymentMethodAction, deletePaymentMethodAction, updatePaymentMethodAction } from "../taxonomy-actions";
import { SettingsSection } from "../section";

type PMType = "cash" | "bank_transfer" | "debit_card" | "credit_card" | "upi" | "wallet" | "other";
type Method = { id: string; name: string; type: PMType; defaultAccountId: string | null; isArchived: boolean };

const TYPES: { value: PMType; label: string; icon: LucideIcon }[] = [
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "debit_card", label: "Debit card", icon: CreditCard },
  { value: "credit_card", label: "Credit card", icon: CreditCard },
  { value: "bank_transfer", label: "Bank transfer", icon: Landmark },
  { value: "upi", label: "UPI", icon: Smartphone },
  { value: "wallet", label: "Wallet", icon: Wallet },
  { value: "other", label: "Other", icon: CircleDashed },
];
const typeMeta = (t: string) => TYPES.find((x) => x.value === t) ?? TYPES[TYPES.length - 1];

export function PaymentMethodsManager({ methods, accounts }: { methods: Method[]; accounts: { id: string; name: string }[] }) {
  const [editing, setEditing] = React.useState<Partial<Method> | null>(null);
  const [deleting, setDeleting] = React.useState<Method | null>(null);
  const [pendingDelete, startDelete] = React.useTransition();
  const [busy, setBusy] = React.useState<string | null>(null);
  const active = methods.filter((m) => !m.isArchived);
  const archived = methods.filter((m) => m.isArchived);
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name;

  async function archive(m: Method) {
    setBusy(m.id);
    const r = await archivePaymentMethodAction({ id: m.id, archived: !m.isArchived });
    setBusy(null);
    if (r.ok) toast.success(m.isArchived ? `${m.name} restored` : `${m.name} archived`);
    else toast.error(r.error);
  }

  const list = (items: Method[]) => (
    <ul className="divide-y">
      {items.map((m) => {
        const T = typeMeta(m.type);
        const acc = accountName(m.defaultAccountId);
        return (
          <li key={m.id} className={cn("flex items-center gap-3 px-4 py-3 sm:px-5", m.isArchived && "opacity-60")}>
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
              <T.icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{m.name}</p>
              <p className="truncate text-[12.5px] text-muted-foreground">
                {T.label}
                {acc ? ` · pays from ${acc}` : ""}
              </p>
            </div>
            {m.isArchived && <Badge>Archived</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="size-10 sm:size-8" aria-label={`Actions for ${m.name}`} disabled={busy === m.id}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setEditing(m)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void archive(m)}>
                  {m.isArchived ? <ArchiveRestore /> : <Archive />} {m.isArchived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDeleting(m)}>
                  <Trash2 /> Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div>
      <SettingsSection
        id="methods"
        title="Payment methods"
        description="How you pay — cards, UPI, cash. A default account pre-fills the account when you pick this method."
        actions={
          <Button onClick={() => setEditing({ type: "debit_card" })}>
            <Plus /> New method
          </Button>
        }
      >
        <Card>
          {active.length === 0 ? (
            <EmptyState
              icon={<CreditCard />}
              title="No payment methods"
              description="Add the cards and apps you pay with to see spending by method."
              action={
                <Button variant="outline" onClick={() => setEditing({ type: "debit_card" })}>
                  <Plus /> New method
                </Button>
              }
            />
          ) : (
            list(active)
          )}
        </Card>
      </SettingsSection>
      {archived.length > 0 && (
        <SettingsSection id="archived" title="Archived" description="Hidden from pickers; past transactions keep them.">
          <Card>{list(archived)}</Card>
        </SettingsSection>
      )}
      {editing && <MethodDialog initial={editing} accounts={accounts} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete “${deleting.name}”?`}
          description="Transactions paid with it keep everything else but lose the payment method. Archive instead to keep the history."
          confirmLabel="Delete method"
          loading={pendingDelete}
          onConfirm={() =>
            startDelete(async () => {
              const r = await deletePaymentMethodAction({ id: deleting.id });
              if (r.ok) {
                toast.success(`${deleting.name} deleted`);
                setDeleting(null);
              } else toast.error(r.error);
            })
          }
        />
      )}
    </div>
  );
}

function MethodDialog({ initial, accounts, onClose }: { initial: Partial<Method>; accounts: { id: string; name: string }[]; onClose: () => void }) {
  const editing = Boolean(initial.id);
  const [name, setName] = React.useState(initial.name ?? "");
  const [type, setType] = React.useState<PMType>(initial.type ?? "debit_card");
  const [accountId, setAccountId] = React.useState(initial.defaultAccountId ?? "");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    const data = { name, type, defaultAccountId: accountId || null };
    start(async () => {
      const r = editing ? await updatePaymentMethodAction({ id: initial.id!, data }) : await createPaymentMethodAction(data);
      if (r.ok) {
        toast.success(editing ? "Payment method updated" : `${name.trim()} added`);
        onClose();
      } else {
        setErrors(r.fieldErrors ?? {});
        setFormError(r.code === "CONFLICT" ? "You already have a payment method with that name." : r.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={editing ? "Edit payment method" : "New payment method"} size="sm">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field label="Name" htmlFor="pm-name" error={errors.name}>
            <Input id="pm-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. HDFC Visa" autoFocus aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? "pm-name-error" : undefined} />
          </Field>
          <Field label="Type" htmlFor="pm-type">
            <NativeSelect id="pm-type" value={type} onChange={(e) => setType(e.target.value as PMType)}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Default account" htmlFor="pm-account" optional error={errors.defaultAccountId} hint="Selected automatically when you choose this method.">
            <NativeSelect id="pm-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">None</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {formError && (
            <p role="alert" className="rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
              {formError}
            </p>
          )}
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {editing ? "Save changes" : "Add method"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
