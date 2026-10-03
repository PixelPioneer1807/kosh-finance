"use client";

import * as React from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, EyeOff, MoreHorizontal, Pencil, Plus, Shapes, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch, Tabs, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState } from "@/components/ui/misc";
import { CATEGORY_COLORS, CategoryBadge, ICON_NAMES, Icon } from "@/components/app/icons";
import { cn } from "@/lib/utils";
import {
  archiveCategoryAction,
  createCategoryAction,
  deleteCategoryAction,
  moveCategoryAction,
  setCategoryExcludedAction,
  updateCategoryAction,
} from "../taxonomy-actions";
import { SettingsSection } from "../section";

type Kind = "expense" | "income";
export type Cat = {
  id: string;
  name: string;
  kind: Kind;
  parentId: string | null;
  icon: string;
  color: string;
  isArchived: boolean;
  excludeFromReports: boolean;
  sortOrder: number;
};

type Draft = { id?: string; name: string; kind: Kind; parentId: string; icon: string; color: string; excludeFromReports: boolean };

export function CategoriesManager({ categories, usage }: { categories: Cat[]; usage: Record<string, number> }) {
  const [kind, setKind] = React.useState<Kind>("expense");
  const [showArchived, setShowArchived] = React.useState(false);
  const [editing, setEditing] = React.useState<Draft | null>(null);
  const [deleting, setDeleting] = React.useState<Cat | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const ofKind = categories.filter((c) => c.kind === kind && (showArchived || !c.isArchived));
  const parents = ofKind.filter((c) => !c.parentId);
  const childrenOf = (id: string) => ofKind.filter((c) => c.parentId === id);
  const archivedCount = categories.filter((c) => c.kind === kind && c.isArchived).length;

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    setBusyId(id);
    const r = await fn();
    setBusyId(null);
    if (!r.ok) toast.error(r.error ?? "Something went wrong");
    else if (success) toast.success(success);
  }

  const newDraft = (parentId = ""): Draft => ({ name: "", kind, parentId, icon: "circle", color: CATEGORY_COLORS[(categories.length * 7) % CATEGORY_COLORS.length], excludeFromReports: false });

  function renderRow(c: Cat, siblings: Cat[], index: number, child = false) {
    const n = usage[c.id] ?? 0;
    const busy = busyId === c.id;
    return (
      <li key={c.id} className={cn("flex items-center gap-3 py-2.5 pr-3 sm:pr-4", child ? "pl-12 sm:pl-14" : "pl-4 sm:pl-5", c.isArchived && "opacity-60")}>
        <CategoryBadge icon={c.icon} color={c.color} size={child ? "sm" : "md"} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate", child ? "text-[13.5px]" : "text-sm font-medium")}>{c.name}</p>
          <p className="text-[12px] text-muted-foreground">
            {n === 0 ? "No transactions" : `${n.toLocaleString()} transaction${n === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="hidden items-center gap-1.5 sm:flex">
          {c.excludeFromReports && (
            <Badge variant="outline">
              <EyeOff /> Excluded
            </Badge>
          )}
          {c.isArchived && <Badge>Archived</Badge>}
        </div>
        <div className="flex shrink-0 items-center">
          <Button type="button" variant="ghost" size="icon-sm" className="size-10 sm:size-8" disabled={index === 0 || busy} onClick={() => run(c.id, () => moveCategoryAction({ id: c.id, direction: "up" }))} aria-label={`Move ${c.name} up`}>
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-10 sm:size-8"
            disabled={index === siblings.length - 1 || busy}
            onClick={() => run(c.id, () => moveCategoryAction({ id: c.id, direction: "down" }))}
            aria-label={`Move ${c.name} down`}
          >
            <ArrowDown />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" className="size-10 sm:size-8" aria-label={`More actions for ${c.name}`} disabled={busy}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setEditing({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId ?? "", icon: c.icon, color: c.color, excludeFromReports: c.excludeFromReports })}>
                <Pencil /> Edit
              </DropdownMenuItem>
              {!child && !c.isArchived && (
                <DropdownMenuItem onSelect={() => setEditing(newDraft(c.id))}>
                  <Plus /> Add subcategory
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() =>
                  run(c.id, () => setCategoryExcludedAction({ id: c.id, excluded: !c.excludeFromReports }), c.excludeFromReports ? `${c.name} included in reports` : `${c.name} excluded from reports`)
                }
              >
                <EyeOff /> {c.excludeFromReports ? "Include in reports" : "Exclude from reports"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(c.id, () => archiveCategoryAction({ id: c.id, archived: !c.isArchived }), c.isArchived ? `${c.name} restored` : `${c.name} archived`)}>
                {c.isArchived ? <ArchiveRestore /> : <Archive />} {c.isArchived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDeleting(c)}>
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  }

  return (
    <SettingsSection
      id="categories"
      title="Categories"
      description="Group spending and income your way. Archive a category to hide it from pickers while keeping its history."
      actions={
        <Button type="button" onClick={() => setEditing(newDraft())}>
          <Plus /> New category
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={kind} onValueChange={(k) => setKind(k as Kind)}>
          <TabsList aria-label="Category type">
            <TabsTrigger value="expense">Expense</TabsTrigger>
            <TabsTrigger value="income">Income</TabsTrigger>
          </TabsList>
        </Tabs>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Show archived categories" />
          Show archived{archivedCount ? ` (${archivedCount})` : ""}
        </label>
      </div>
      <Card>
        {parents.length === 0 ? (
          <EmptyState
            icon={<Shapes />}
            title={`No ${kind} categories yet`}
            description="Create categories to see where your money goes."
            action={
              <Button type="button" variant="outline" onClick={() => setEditing(newDraft())}>
                <Plus /> New category
              </Button>
            }
          />
        ) : (
          <ul className="divide-y">
            {parents.map((p, i) => {
              const kids = childrenOf(p.id);
              return (
                <li key={p.id}>
                  <ul>
                    {renderRow(p, parents, i)}
                    {kids.map((k, j) => renderRow(k, kids, j, true))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {editing && <CategoryDialog draft={editing} categories={categories} onClose={() => setEditing(null)} />}
      {deleting && <DeleteCategoryDialog cat={deleting} categories={categories} usage={usage} onClose={() => setDeleting(null)} />}
    </SettingsSection>
  );
}

/* ───────────── Create / edit ───────────── */

function CategoryDialog({ draft, categories, onClose }: { draft: Draft; categories: Cat[]; onClose: () => void }) {
  const [v, setV] = React.useState<Draft>(draft);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const editing = Boolean(draft.id);
  const hasChildren = editing && categories.some((c) => c.parentId === draft.id);
  const parentOptions = categories.filter((c) => c.kind === v.kind && !c.parentId && c.id !== draft.id && !c.isArchived);
  const set = <K extends keyof Draft>(k: K, val: Draft[K]) => setV((s) => ({ ...s, [k]: val }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    const data = { name: v.name, parentId: v.parentId || null, icon: v.icon, color: v.color, excludeFromReports: v.excludeFromReports };
    start(async () => {
      const r = editing ? await updateCategoryAction({ id: draft.id!, data }) : await createCategoryAction({ ...data, kind: v.kind });
      if (r.ok) {
        toast.success(editing ? "Category updated" : `${v.name.trim()} created`);
        onClose();
      } else {
        setErrors(r.fieldErrors ?? {});
        setFormError(r.code === "CONFLICT" ? "A category with that name already exists here." : r.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={editing ? "Edit category" : v.parentId ? "New subcategory" : `New ${v.kind} category`} size="md">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <div className="flex items-end gap-3">
            <CategoryBadge icon={v.icon} color={v.color} size="lg" />
            <Field label="Name" htmlFor="cat-name" error={errors.name} className="flex-1">
              <Input id="cat-name" value={v.name} onChange={(e) => set("name", e.target.value)} maxLength={50} autoFocus required aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? "cat-name-error" : undefined} />
            </Field>
          </div>
          <Field label="Parent" htmlFor="cat-parent" hint={hasChildren ? "This category has subcategories, so it stays top-level." : "Subcategories are one level deep."}>
            <NativeSelect id="cat-parent" value={v.parentId} onChange={(e) => set("parentId", e.target.value)} disabled={hasChildren}>
              <option value="">None (top-level)</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Colour</legend>
            <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
              {CATEGORY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={v.color === c}
                  aria-label={c}
                  onClick={() => set("color", c)}
                  className={cn("size-8 rounded-full ring-offset-2 ring-offset-popover transition focus-visible:outline-2 focus-visible:outline-ring", v.color === c && "ring-2 ring-foreground")}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Icon</legend>
            <div role="radiogroup" aria-label="Icon" className="grid max-h-48 grid-cols-8 gap-1 overflow-y-auto rounded-lg border bg-subtle p-1.5 sm:grid-cols-10">
              {ICON_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={v.icon === name}
                  aria-label={name.replace(/-/g, " ")}
                  title={name.replace(/-/g, " ")}
                  onClick={() => set("icon", name)}
                  className={cn("grid aspect-square place-items-center rounded-md text-muted-foreground transition hover:bg-card hover:text-foreground [&_svg]:size-4", v.icon === name && "bg-card text-foreground shadow-xs ring-1 ring-border-strong")}
                  style={v.icon === name ? { color: v.color } : undefined}
                >
                  <Icon name={name} />
                </button>
              ))}
            </div>
          </fieldset>
          <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
            <div>
              <Label htmlFor="cat-exclude">Exclude from reports</Label>
              <p className="mt-1 text-[12.5px] text-muted-foreground">For money that isn&apos;t really spending — reimbursable costs, internal moves.</p>
            </div>
            <Switch id="cat-exclude" checked={v.excludeFromReports} onCheckedChange={(on) => set("excludeFromReports", on)} />
          </div>
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
              {editing ? "Save changes" : "Create category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────── Delete with reassignment ───────────── */

function DeleteCategoryDialog({ cat, categories, usage, onClose }: { cat: Cat; categories: Cat[]; usage: Record<string, number>; onClose: () => void }) {
  const children = categories.filter((c) => c.parentId === cat.id);
  const affected = [cat, ...children].reduce((n, c) => n + (usage[c.id] ?? 0), 0);
  const excluded = new Set([cat.id, ...children.map((c) => c.id)]);
  const targets = categories.filter((c) => c.kind === cat.kind && !excluded.has(c.id) && !c.isArchived);
  const parentsT = targets.filter((c) => !c.parentId);
  const [to, setTo] = React.useState("");
  const [pending, start] = React.useTransition();
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete “${cat.name}”?`}
      description={
        <>
          {children.length > 0 && <>Its {children.length} subcategor{children.length === 1 ? "y" : "ies"} will be deleted too. </>}
          {affected > 0 ? `${affected.toLocaleString()} transaction${affected === 1 ? "" : "s"} use${affected === 1 ? "s" : ""} it.` : "No transactions use it."} Budgets for it move with its transactions, or are removed if left uncategorised. This can&apos;t be undone — archive instead to keep its history.
        </>
      }
      confirmLabel="Delete category"
      loading={pending}
      onConfirm={() =>
        start(async () => {
          const r = await deleteCategoryAction({ id: cat.id, reassignTo: to || null });
          if (r.ok) {
            toast.success(`${cat.name} deleted`);
            onClose();
          } else toast.error(r.error);
        })
      }
    >
      {affected > 0 && (
        <div className="mt-4">
          <Field label="Move its transactions to" htmlFor="reassign">
            <NativeSelect id="reassign" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Leave uncategorised</option>
              {parentsT.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  <option value={p.id}>{p.name}</option>
                  {targets
                    .filter((c) => c.parentId === p.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {p.name} › {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </NativeSelect>
          </Field>
        </div>
      )}
    </ConfirmDialog>
  );
}
