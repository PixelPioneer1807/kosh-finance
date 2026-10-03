"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, KeyRound, MoreHorizontal, Search, ShieldCheck, ShieldOff, UserCheck, UserX, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState } from "@/components/ui/misc";
import { CopyButton } from "@/components/app/copy-button";
import { initials, pluralize } from "@/lib/utils";
import { createResetLinkAction, setUserRoleAction, setUserStatusAction } from "../actions";

export type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  locked: boolean;
  activeSessions: number;
  joined: string;
  lastActive: string;
  lastActiveExact: string;
};

type Filter = "all" | "active" | "disabled" | "admins";
type Pending =
  | { kind: "disable" | "reactivate" | "promote" | "demote"; user: AdminUser }
  | null;

export function UsersView({
  users,
  currentUserId,
  q,
  filter,
  page,
  pageCount,
  total,
}: {
  users: AdminUser[];
  currentUserId: string;
  q: string;
  filter: Filter;
  page: number;
  pageCount: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = React.useState(q);
  const [confirm, setConfirm] = React.useState<Pending>(null);
  const [resetLink, setResetLink] = React.useState<{ email: string; link: string } | null>(null);
  const [busy, start] = React.useTransition();

  const hrefWith = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      return `${pathname}${next.size ? `?${next}` : ""}`;
    },
    [params, pathname],
  );

  React.useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => router.replace(hrefWith({ q: search.trim() || null, page: null }), { scroll: false }), 300);
    return () => clearTimeout(t);
  }, [search, q, hrefWith, router]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong");
      else toast.success(success);
      setConfirm(null);
    });

  const onConfirm = () => {
    if (!confirm) return;
    const { kind, user } = confirm;
    const who = user.name || user.email;
    if (kind === "disable") run(() => setUserStatusAction({ id: user.id, status: "disabled" }), `${who} was disabled and signed out`);
    if (kind === "reactivate") run(() => setUserStatusAction({ id: user.id, status: "active" }), `${who} can sign in again`);
    if (kind === "promote") run(() => setUserRoleAction({ id: user.id, role: "admin" }), `${who} is now an admin`);
    if (kind === "demote") run(() => setUserRoleAction({ id: user.id, role: "user" }), `${who} is no longer an admin`);
  };

  const makeResetLink = (u: AdminUser) =>
    start(async () => {
      const r = await createResetLinkAction({ id: u.id });
      if (!r.ok) return void toast.error(r.error);
      setResetLink({ email: u.email, link: r.data.link });
    });

  const actions = (u: AdminUser) => {
    const self = u.id === currentUserId;
    return (
      // Non-modal so the confirm/reset dialogs opened from it get focus and pointer events cleanly.
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${u.email}`} disabled={busy}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuItem disabled={u.status !== "active"} onSelect={() => makeResetLink(u)}>
            <KeyRound /> Create password-reset link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {u.role === "admin" ? (
            <DropdownMenuItem disabled={self} onSelect={() => setConfirm({ kind: "demote", user: u })}>
              <ShieldOff /> Remove admin role
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={u.status !== "active"} onSelect={() => setConfirm({ kind: "promote", user: u })}>
              <ShieldCheck /> Make admin
            </DropdownMenuItem>
          )}
          {u.status === "active" ? (
            <DropdownMenuItem destructive disabled={self} onSelect={() => setConfirm({ kind: "disable", user: u })}>
              <UserX /> Disable account
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setConfirm({ kind: "reactivate", user: u })}>
              <UserCheck /> Reactivate account
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const badges = (u: AdminUser) => (
    <>
      {u.id === currentUserId && <Badge variant="outline">You</Badge>}
      {u.role === "admin" && (
        <Badge variant="accent">
          <ShieldCheck aria-hidden /> Admin
        </Badge>
      )}
      {u.status === "disabled" && <Badge variant="negative">Disabled</Badge>}
      {u.locked && <Badge variant="warning">Locked</Badge>}
    </>
  );

  const confirmCopy: Record<NonNullable<Pending>["kind"], { title: string; label: string; destructive: boolean; body: (u: AdminUser) => string }> = {
    disable: {
      title: "Disable this account?",
      label: "Disable account",
      destructive: true,
      body: (u) =>
        `${u.email} will be signed out of ${pluralize(u.activeSessions, "device")} and won't be able to sign in. Their data is kept and you can reactivate them later.`,
    },
    reactivate: { title: "Reactivate this account?", label: "Reactivate", destructive: false, body: (u) => `${u.email} will be able to sign in again.` },
    promote: {
      title: "Make this person an admin?",
      label: "Make admin",
      destructive: false,
      body: (u) => `${u.email} will be able to create invites and manage accounts. Admins still can't see anyone's financial data.`,
    },
    demote: { title: "Remove admin role?", label: "Remove admin", destructive: true, body: (u) => `${u.email} will lose access to the admin area.` },
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1 sm:max-w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" aria-label="Search users" className="pl-9" />
        </div>
        <Segmented
          ariaLabel="Filter users"
          value={filter}
          onChange={(v) => router.replace(hrefWith({ filter: v === "all" ? null : v, page: null }), { scroll: false })}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "disabled", label: "Disabled" },
            { value: "admins", label: "Admins" },
          ]}
        />
        <p className="num ml-auto text-[13px] text-muted-foreground">{pluralize(total, "user")}</p>
      </div>

      <Card className="overflow-hidden">
        {users.length === 0 ? (
          <EmptyState icon={<Users />} title="No users found" description={q ? `Nobody matches “${q}”.` : "Try a different filter."} />
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead className="border-b bg-subtle text-left text-[12.5px] text-muted-foreground">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">User</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Joined</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Last active</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Sessions</th>
                  <th scope="col" className="w-14 px-5 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar u={u} />
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-1.5 font-medium">
                            <span className="truncate">{u.name || u.email}</span>
                            {badges(u)}
                          </p>
                          {u.name && <p className="truncate text-[12.5px] text-muted-foreground">{u.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{u.joined}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <span title={u.lastActiveExact}>{u.lastActive}</span>
                    </td>
                    <td className="num px-3 py-3 text-right text-muted-foreground">{u.activeSessions}</td>
                    <td className="px-5 py-2 text-right">{actions(u)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="divide-y md:hidden">
              {users.map((u) => (
                <li key={u.id} className="flex items-start gap-3 px-4 py-3.5">
                  <Avatar u={u} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{u.name || u.email}</p>
                    {u.name && <p className="truncate text-[12.5px] text-muted-foreground">{u.email}</p>}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">{badges(u)}</div>
                    <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                      Joined {u.joined} · Active {u.lastActive.toLowerCase()}
                    </p>
                  </div>
                  {actions(u)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {pageCount > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={hrefWith({ page: String(page - 1) })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ChevronLeft /> Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="num text-[13px] text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link href={hrefWith({ page: String(page + 1) })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Next <ChevronRight />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}

      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={confirmCopy[confirm.kind].title}
          description={confirmCopy[confirm.kind].body(confirm.user)}
          confirmLabel={confirmCopy[confirm.kind].label}
          destructive={confirmCopy[confirm.kind].destructive}
          loading={busy}
          onConfirm={onConfirm}
        />
      )}

      <Dialog open={Boolean(resetLink)} onOpenChange={(o) => !o && setResetLink(null)}>
        <DialogContent
          title="Password-reset link"
          description={resetLink ? `Send this to ${resetLink.email} through a channel you trust. It works once and expires in 1 hour.` : undefined}
        >
          {resetLink && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input readOnly aria-label="Reset link" value={resetLink.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" />
                <CopyButton value={resetLink.link} />
              </div>
              <p className="text-[13px] text-muted-foreground">This link won&apos;t be shown again. Creating a new one invalidates this one.</p>
              <DialogFooter>
                <Button onClick={() => setResetLink(null)}>Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Avatar({ u }: { u: AdminUser }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-[12px] font-semibold text-muted-foreground" aria-hidden>
      {initials(u.name, u.email)}
    </span>
  );
}
