"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, Hash, Pencil, Search, Store, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { deleteMerchantAction, deleteTagAction, renameMerchantAction } from "../taxonomy-actions";
import { SettingsSection } from "../section";

type Item = { id: string; name: string; uses: number };

const PAGE = 100;

export function MerchantsManager({ merchants, tags }: { merchants: Item[]; tags: Item[] }) {
  const [q, setQ] = React.useState("");
  const [limit, setLimit] = React.useState(PAGE);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [confirmMerge, setConfirmMerge] = React.useState<{ id: string; from: string; into: string } | null>(null);
  const [deleting, setDeleting] = React.useState<{ kind: "merchant" | "tag"; item: Item } | null>(null);
  const [pending, start] = React.useTransition();

  const term = q.trim().toLowerCase();
  const filtered = term ? merchants.filter((m) => m.name.toLowerCase().includes(term)) : merchants;
  const shown = filtered.slice(0, limit);

  function rename(id: string, force = false) {
    const name = draft.trim();
    const current = merchants.find((m) => m.id === id);
    if (!name || !current) return;
    if (name === current.name) {
      setEditing(null);
      return;
    }
    const clash = merchants.find((m) => m.id !== id && m.name.trim().replace(/\s+/g, " ").toLowerCase() === name.replace(/\s+/g, " ").toLowerCase());
    if (clash && !force) {
      setConfirmMerge({ id, from: current.name, into: clash.name });
      return;
    }
    setError(null);
    start(async () => {
      const r = await renameMerchantAction({ id, name });
      setConfirmMerge(null);
      if (r.ok) {
        toast.success(r.data.merged ? `Merged into ${clash?.name ?? name}` : "Merchant renamed");
        setEditing(null);
      } else setError(r.fieldErrors?.name?.[0] ?? r.error);
    });
  }

  return (
    <div>
      <SettingsSection id="merchants" title="Merchants" description="Rename a merchant to tidy it up. Renaming to an existing merchant's name merges them, moving all transactions.">
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search merchants" aria-label="Search merchants" className="pl-9 sm:max-w-sm" />
        </div>
        <Card>
          {merchants.length === 0 ? (
            <EmptyState icon={<Store />} title="No merchants yet" description="Merchants are created automatically as you record where you spend." />
          ) : filtered.length === 0 ? (
            <EmptyState icon={<Search />} title="No matches" description={`No merchants match “${q}”.`} />
          ) : (
            <ul className="divide-y">
              {shown.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                  {editing === m.id ? (
                    <form
                      className="flex min-w-0 flex-1 flex-col gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        rename(m.id);
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <Input
                          autoFocus
                          value={draft}
                          maxLength={80}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                          aria-label={`New name for ${m.name}`}
                          aria-invalid={error ? true : undefined}
                          className="h-9"
                        />
                        <Button type="submit" size="icon-sm" variant="ghost" aria-label="Save name" loading={pending}>
                          {!pending && <Check />}
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setEditing(null)}>
                          <X />
                        </Button>
                      </div>
                      {error && (
                        <p role="alert" className="text-[12.5px] text-negative">
                          {error}
                        </p>
                      )}
                    </form>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{m.name}</p>
                        <p className="text-[12px] text-muted-foreground">
                          {m.uses === 0 ? (
                            "Unused"
                          ) : (
                            <Link href={`/transactions?merchant=${m.id}`} className="hover:text-foreground hover:underline">
                              {m.uses.toLocaleString()} transaction{m.uses === 1 ? "" : "s"}
                            </Link>
                          )}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-10 sm:size-8"
                        aria-label={`Rename ${m.name}`}
                        onClick={() => {
                          setEditing(m.id);
                          setDraft(m.name);
                          setError(null);
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="size-10 sm:size-8" aria-label={`Delete ${m.name}`} onClick={() => setDeleting({ kind: "merchant", item: m })}>
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {filtered.length > shown.length && (
            <div className="border-t p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({(filtered.length - shown.length).toLocaleString()} left)
              </Button>
            </div>
          )}
        </Card>
      </SettingsSection>

      <SettingsSection id="tags" title="Tags" description="Tags are created when you add them to a transaction. Deleting a tag removes it from every transaction.">
        <Card>
          {tags.length === 0 ? (
            <EmptyState icon={<Hash />} title="No tags yet" description="Add tags like #work or #trip to transactions to group them across categories." />
          ) : (
            <ul className="flex flex-wrap gap-2 p-4">
              {tags.map((t) => (
                <li key={t.id} className="inline-flex items-center gap-1 rounded-full border bg-card py-1 pr-1 pl-3 text-[13px]">
                  <Link href={`/transactions?tag=${t.id}`} className="hover:underline">
                    #{t.name}
                  </Link>
                  <span className="num text-[12px] text-muted-foreground">{t.uses}</span>
                  <button
                    type="button"
                    onClick={() => setDeleting({ kind: "tag", item: t })}
                    aria-label={`Delete tag ${t.name}`}
                    className="ml-0.5 grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </SettingsSection>

      {confirmMerge && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirmMerge(null)}
          title={`Merge “${confirmMerge.from}” into “${confirmMerge.into}”?`}
          description={`A merchant called “${confirmMerge.into}” already exists. All of “${confirmMerge.from}”'s transactions and recurring items will move to it, and “${confirmMerge.from}” will be removed.`}
          confirmLabel="Merge merchants"
          destructive={false}
          loading={pending}
          onConfirm={() => rename(confirmMerge.id, true)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={deleting.kind === "tag" ? `Delete tag #${deleting.item.name}?` : `Delete “${deleting.item.name}”?`}
          description={
            deleting.kind === "tag"
              ? `It will be removed from ${deleting.item.uses.toLocaleString()} transaction${deleting.item.uses === 1 ? "" : "s"}. The transactions themselves stay.`
              : `${deleting.item.uses.toLocaleString()} transaction${deleting.item.uses === 1 ? "" : "s"} will keep their amounts and categories but no longer show a merchant.`
          }
          confirmLabel="Delete"
          loading={pending}
          onConfirm={() =>
            start(async () => {
              const r = deleting.kind === "tag" ? await deleteTagAction({ id: deleting.item.id }) : await deleteMerchantAction({ id: deleting.item.id });
              if (r.ok) {
                toast.success(deleting.kind === "tag" ? `#${deleting.item.name} deleted` : `${deleting.item.name} deleted`);
                setDeleting(null);
              } else toast.error(r.error);
            })
          }
        />
      )}
    </div>
  );
}
