"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Search, ShieldCheck, Ticket } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/misc";
import { CopyButton } from "@/components/app/copy-button";
import { createInviteAction, revokeInviteAction } from "../actions";

type Status = "active" | "used" | "expired" | "revoked";
export type InviteRow = {
  id: string;
  codePrefix: string;
  label: string | null;
  email: string | null;
  role: "user" | "admin";
  maxUses: number;
  useCount: number;
  status: Status;
  createdByEmail: string | null;
  expires: string;
  expiresRelative: string;
  created: string;
};

const STATUS_BADGE: Record<Status, { label: string; variant: "positive" | "default" | "outline" | "negative" }> = {
  active: { label: "Active", variant: "positive" },
  used: { label: "Used", variant: "default" },
  expired: { label: "Expired", variant: "outline" },
  revoked: { label: "Revoked", variant: "negative" },
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "used", label: "Used" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
] as const;

export function InvitesView({ invites, status, q }: { invites: InviteRow[]; status: Status | "all"; q: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [creating, setCreating] = React.useState(false);
  const [revoking, setRevoking] = React.useState<InviteRow | null>(null);
  const [revokePending, startRevoke] = React.useTransition();
  const [search, setSearch] = React.useState(q);

  const setParam = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
    },
    [params, pathname, router],
  );

  React.useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => setParam("q", search.trim() || null), 300);
    return () => clearTimeout(t);
  }, [search, q, setParam]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="Filter by status"
          value={status}
          onChange={(v) => setParam("status", v === "all" ? null : v)}
          options={FILTERS.map((f) => ({ value: f.value, label: f.label }))}
          className="scrollbar-none max-w-full overflow-x-auto"
        />
        <div className="relative min-w-48 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search label, email, code" aria-label="Search invites" className="pl-9" />
        </div>
        <div className="flex-1" />
        <Button onClick={() => setCreating(true)}>
          <Plus /> Create invite
        </Button>
      </div>

      <Card className="overflow-hidden">
        {invites.length === 0 ? (
          <EmptyState
            icon={<Ticket />}
            title={status === "all" && !q ? "No invites yet" : "No invites match"}
            description={status === "all" && !q ? "Kosh is invite-only. Create an invite code to let someone sign up." : "Try a different filter or search."}
            action={
              status === "all" && !q ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus /> Create invite
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full text-sm md:table">
              <thead className="border-b bg-subtle text-left text-[12.5px] text-muted-foreground">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Invite</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Uses</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Expires</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Created</th>
                  <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invites.map((i) => (
                  <tr key={i.id} className="align-top">
                    <td className="px-5 py-3">
                      <InviteIdentity i={i} />
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={STATUS_BADGE[i.status].variant}>{STATUS_BADGE[i.status].label}</Badge>
                    </td>
                    <td className="num px-3 py-3 text-right">
                      {i.useCount}/{i.maxUses}
                    </td>
                    <td className="px-3 py-3">
                      <span title={i.expires}>{i.expiresRelative}</span>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <p>{i.created}</p>
                      {i.createdByEmail && <p className="max-w-48 truncate text-[12.5px]">{i.createdByEmail}</p>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {i.status !== "revoked" && (
                        <Button variant="ghost" size="sm" className="text-negative hover:bg-negative-soft" onClick={() => setRevoking(i)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile list */}
            <ul className="divide-y md:hidden">
              {invites.map((i) => (
                <li key={i.id} className="space-y-2 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <InviteIdentity i={i} />
                    <Badge variant={STATUS_BADGE[i.status].variant}>{STATUS_BADGE[i.status].label}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
                    <span className="num">
                      {i.useCount}/{i.maxUses} uses
                    </span>
                    <span>Expires {i.expiresRelative}</span>
                    <span>Created {i.created}</span>
                  </div>
                  {i.status !== "revoked" && (
                    <Button variant="outline" size="sm" className="h-10 w-full text-negative" onClick={() => setRevoking(i)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <CreateInviteDialog open={creating} onOpenChange={setCreating} />

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this invite?"
        description={
          revoking
            ? `${revoking.label ?? `Code ${revoking.codePrefix}-…`} will stop working immediately. People who already signed up with it keep their accounts.`
            : undefined
        }
        confirmLabel="Revoke invite"
        loading={revokePending}
        onConfirm={() =>
          startRevoke(async () => {
            if (!revoking) return;
            const r = await revokeInviteAction({ id: revoking.id });
            if (!r.ok) toast.error(r.error);
            else toast.success("Invite revoked");
            setRevoking(null);
          })
        }
      />
    </div>
  );
}

function InviteIdentity({ i }: { i: InviteRow }) {
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-1.5 font-medium">
        <span className="truncate">{i.label ?? "Untitled invite"}</span>
        {i.role === "admin" && (
          <Badge variant="accent">
            <ShieldCheck aria-hidden /> Admin
          </Badge>
        )}
      </p>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">
        <span className="font-mono">{i.codePrefix}-····-····</span>
        {i.email && <span> · only {i.email}</span>}
      </p>
    </div>
  );
}

type Created = { code: string; link: string; expiresAt: string; role: "user" | "admin"; maxUses: number };

function CreateInviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pending, start] = React.useTransition();
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [created, setCreated] = React.useState<Created | null>(null);
  const [role, setRole] = React.useState<"user" | "admin">("user");

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      // Reset after the closing animation; the code is gone for good once the dialog closes.
      setTimeout(() => {
        setCreated(null);
        setErrors({});
        setRole("user");
      }, 200);
    }
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const r = await createInviteAction({
        label: String(fd.get("label") ?? ""),
        email: String(fd.get("email") ?? ""),
        expiresInDays: Number(fd.get("expiresInDays")),
        maxUses: Number(fd.get("maxUses")),
        role,
      });
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      setErrors({});
      setCreated(r.data);
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={created ? "Invite created" : "Create invite"}
        description={created ? "Copy the code now — for security it won't be shown again." : "Invite codes are single-use by default and expire automatically."}
      >
        {created ? (
          <div className="space-y-4">
            <div className="rounded-lg border bg-subtle p-4 text-center">
              <p className="text-[12.5px] text-muted-foreground">Invite code</p>
              <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.12em] select-all" aria-live="polite">
                {created.code}
              </p>
              <CopyButton value={created.code} label="Copy code" className="mt-3" />
            </div>
            <Field label="Sign-up link" htmlFor="invite-link" hint="Anyone with this link can register (until it's used up or expires).">
              <div className="flex gap-2">
                <Input id="invite-link" readOnly value={created.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" />
                <CopyButton value={created.link} label="Copy" />
              </div>
            </Field>
            <p className="text-[13px] text-muted-foreground">
              {created.maxUses === 1 ? "Single use" : `${created.maxUses} uses`} · {created.role === "admin" ? "grants admin access" : "regular user"} · expires{" "}
              {new Date(created.expiresAt).toLocaleString()}
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Label" htmlFor="inv-label" optional hint="Only admins see this, e.g. who it's for." error={errors.label}>
              <Input id="inv-label" name="label" maxLength={60} placeholder="e.g. Priya" aria-invalid={Boolean(errors.label) || undefined} />
            </Field>
            <Field label="Restrict to email" htmlFor="inv-email" optional hint="Only this address can use the code." error={errors.email}>
              <Input id="inv-email" name="email" type="email" autoComplete="off" placeholder="name@example.com" aria-invalid={Boolean(errors.email) || undefined} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Expires after" htmlFor="inv-exp" error={errors.expiresInDays}>
                <NativeSelect id="inv-exp" name="expiresInDays" defaultValue="7">
                  {[1, 3, 7, 14, 30, 90].map((d) => (
                    <option key={d} value={d}>
                      {d === 1 ? "1 day" : `${d} days`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Max uses" htmlFor="inv-uses" error={errors.maxUses}>
                <Input id="inv-uses" name="maxUses" type="number" inputMode="numeric" min={1} max={500} defaultValue={1} aria-invalid={Boolean(errors.maxUses) || undefined} />
              </Field>
            </div>
            <div className="grid gap-1.5">
              <span className="text-[13px] font-medium" id="inv-role-label">
                Role
              </span>
              <Segmented
                ariaLabel="Role"
                value={role}
                onChange={setRole}
                options={[
                  { value: "user", label: "User" },
                  { value: "admin", label: "Admin" },
                ]}
                className="w-full"
              />
              {role === "admin" && <p className="text-[13px] text-warning">Admins can manage invites and user accounts (but never see anyone&apos;s finances).</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                Create invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
