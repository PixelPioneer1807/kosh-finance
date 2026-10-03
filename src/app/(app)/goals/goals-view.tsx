"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArchiveRestore, CircleCheck, Ellipsis, Minus, Pencil, Plus, Target, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Icon } from "@/components/app/icons";
import { useMoney } from "@/components/app/user-context";
import { ProgressRing } from "@/components/widgets/progress-ring";
import { GoalTrackBadge, goalPlanLine, goalProjectionLine } from "@/components/widgets/goal-bits";
import { formatDate } from "@/lib/dates";
import { add, isPositive } from "@/lib/money";
import { GOAL_KINDS, goalKindMeta, type GoalKind } from "@/lib/goals";
import type { GoalProgress, GoalStatusAction } from "@/server/services/goals";
import { deleteGoalAction, setGoalStatusAction } from "./actions";
import { GoalFormDialog } from "./goal-form";
import { ContributeDialog, type ContributeTarget } from "./contribute-dialog";
import { GoalDetailDialog } from "./goal-detail";

type Tab = "active" | "completed" | "archived";
type FormState = { goalId: string | null; kind?: GoalKind } | null;

const uuidRe = /^[0-9a-f-]{36}$/i;

export function GoalsView({ goals, baseCurrency }: { goals: GoalProgress[]; baseCurrency: string }) {
  const fmt = useMoney();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [tab, setTab] = React.useState<Tab>("active");
  const [form, setForm] = React.useState<FormState>(null);
  const [contribute, setContribute] = React.useState<ContributeTarget | null>(null);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<GoalProgress | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Deep links: ?new=1, ?contribute=1, ?open=<id>. Applied once per change (state adjusted during
  // render, not in an effect), then the URL is cleaned so a refresh doesn't reopen the dialog.
  const intent = sp.get("new") === "1" ? "new" : sp.get("contribute") === "1" ? "contribute" : uuidRe.test(sp.get("open") ?? "") ? `open:${sp.get("open")}` : "";
  const [handled, setHandled] = React.useState("");
  if (intent !== handled) {
    setHandled(intent);
    if (intent === "new") setForm({ goalId: null });
    else if (intent === "contribute") setContribute({ goalId: null, direction: "contribute" });
    else if (intent.startsWith("open:")) {
      const g = goals.find((x) => x.id === intent.slice(5));
      if (g) {
        setDetailId(g.id);
        setTab(g.status);
      }
    }
  }
  React.useEffect(() => {
    if (intent) router.replace(pathname, { scroll: false });
  }, [intent, pathname, router]);

  const counts = { active: 0, completed: 0, archived: 0 };
  for (const g of goals) counts[g.status]++;
  const visible = goals.filter((g) => g.status === tab);
  const detail = goals.find((g) => g.id === detailId) ?? null;
  const formGoal = form?.goalId ? (goals.find((g) => g.id === form.goalId) ?? null) : null;

  // Overall line only when every active goal is in the base currency (no silent mixing).
  const active = goals.filter((g) => g.status === "active");
  const sameCurrency = active.length > 0 && active.every((g) => g.currency === baseCurrency);
  const description = sameCurrency
    ? `${fmt(add(...active.map((g) => g.current)), baseCurrency, { trimZeros: true })} saved of ${fmt(add(...active.map((g) => g.targetAmount)), baseCurrency, { trimZeros: true })} across ${active.length} active goal${active.length === 1 ? "" : "s"}`
    : "Save towards the things that matter, at a pace you can keep.";

  async function changeStatus(g: GoalProgress, action: GoalStatusAction) {
    const r = await setGoalStatusAction({ id: g.id, action });
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    const msg = action === "complete" ? `Marked "${g.name}" as reached` : action === "archive" ? `Archived "${g.name}"` : `"${g.name}" is active again`;
    toast.success(msg, {
      action:
        action === "reactivate"
          ? undefined
          : { label: "Undo", onClick: () => void setGoalStatusAction({ id: g.id, action: "reactivate" }) },
    });
  }

  async function remove() {
    if (!confirmDelete) return;
    setBusy(true);
    const r = await deleteGoalAction({ id: confirmDelete.id });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(`Deleted "${confirmDelete.name}"`);
    if (detailId === confirmDelete.id) setDetailId(null);
    setConfirmDelete(null);
  }

  const menu = (g: GoalProgress, inDetail = false) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`More actions for ${g.name}`} className="text-muted-foreground">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => setForm({ goalId: g.id })}>
          <Pencil /> Edit
        </DropdownMenuItem>
        {!inDetail && g.status !== "archived" && isPositive(g.current) && (
          <DropdownMenuItem onSelect={() => setContribute({ goalId: g.id, direction: "withdraw" })}>
            <Minus /> Withdraw
          </DropdownMenuItem>
        )}
        {!inDetail && (
          <DropdownMenuItem onSelect={() => setDetailId(g.id)}>
            <Target /> Details & history
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {g.status === "active" && (
          <DropdownMenuItem onSelect={() => void changeStatus(g, "complete")}>
            <CircleCheck /> Mark as reached
          </DropdownMenuItem>
        )}
        {g.status !== "active" && (
          <DropdownMenuItem onSelect={() => void changeStatus(g, "reactivate")}>
            <ArchiveRestore /> Reactivate
          </DropdownMenuItem>
        )}
        {g.status !== "archived" && (
          <DropdownMenuItem onSelect={() => void changeStatus(g, "archive")}>
            <Archive /> Archive
          </DropdownMenuItem>
        )}
        <DropdownMenuItem destructive onSelect={() => setConfirmDelete(g)}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <PageHeader
        title="Goals"
        description={description}
        actions={
          <>
            {counts.active > 0 && (
              <Button variant="outline" onClick={() => setContribute({ goalId: null, direction: "contribute" })}>
                Add money
              </Button>
            )}
            <Button onClick={() => setForm({ goalId: null })}>
              <Plus /> New goal
            </Button>
          </>
        }
      />

      {goals.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Target />}
            title="Set your first goal"
            description="Pick what you're saving for. Add a date and we'll work out how much to put aside each month."
            action={
              <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                {GOAL_KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setForm({ goalId: null, kind: k.id })}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-card px-3 text-[13px] text-muted-foreground transition hover:text-foreground [&_svg]:size-3.5"
                  >
                    <span style={{ color: k.color }}>
                      <Icon name={k.icon} />
                    </span>
                    {k.label}
                  </button>
                ))}
              </div>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          <Segmented
            ariaLabel="Show goals"
            value={tab}
            onChange={setTab}
            className="self-start"
            options={[
              { value: "active", label: `Active · ${counts.active}` },
              { value: "completed", label: `Reached · ${counts.completed}` },
              { value: "archived", label: `Archived · ${counts.archived}` },
            ]}
          />
          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={tab === "archived" ? <Archive /> : tab === "completed" ? <CircleCheck /> : <Target />}
                title={tab === "active" ? "No active goals" : tab === "completed" ? "Nothing reached yet" : "No archived goals"}
                description={tab === "active" ? "Start a new one whenever you're ready." : tab === "completed" ? "Goals you reach will show up here." : "Archived goals are kept out of the way but not deleted."}
                action={
                  tab === "active" ? (
                    <Button onClick={() => setForm({ goalId: null })}>
                      <Plus /> New goal
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <Card>
              <ul className="divide-y" aria-label={`${tab} goals`}>
                {visible.map((g) => (
                  <GoalRow
                    key={g.id}
                    goal={g}
                    menu={menu(g)}
                    onOpen={() => setDetailId(g.id)}
                    onContribute={() => setContribute({ goalId: g.id, direction: "contribute" })}
                  />
                ))}
              </ul>
            </Card>
          )}
          <p className="text-[12.5px] text-muted-foreground">
            Projections assume you keep saving at your net pace from the last 90 days (at least 30). They&apos;re estimates, not guarantees.
          </p>
        </div>
      )}

      <GoalFormDialog
        open={Boolean(form)}
        onOpenChange={(o) => !o && setForm(null)}
        goal={formGoal}
        initialKind={form?.kind}
        onSaved={() => {
          if (!form?.goalId) setTab("active");
        }}
      />
      <ContributeDialog target={contribute} goals={goals} onOpenChange={(o) => !o && setContribute(null)} />
      <GoalDetailDialog
        goal={contribute || form || confirmDelete ? null : detail}
        onOpenChange={(o) => !o && setDetailId(null)}
        onContribute={(direction) => detail && setContribute({ goalId: detail.id, direction })}
        actions={detail ? menu(detail, true) : null}
      />
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete "${confirmDelete?.name ?? "goal"}"?`}
        description="The goal and its contribution history are removed. Transfers you made between accounts stay in your transactions. To keep the history, archive it instead."
        confirmLabel="Delete goal"
        onConfirm={remove}
        loading={busy}
      />
    </>
  );
}

function GoalRow({ goal: g, menu, onOpen, onContribute }: { goal: GoalProgress; menu: React.ReactNode; onOpen: () => void; onContribute: () => void }) {
  const fmt = useMoney();
  const pct = Math.round(g.progress * 100);
  const plan = goalPlanLine(g, fmt);
  const projection = goalProjectionLine(g);
  return (
    <li className="flex gap-3 px-4 py-4 sm:gap-4 sm:px-5">
      <ProgressRing value={g.progress} color={g.color} size={52} stroke={4.5} label={`${g.name}: ${pct}% saved`} className="mt-0.5">
        <span className="[&_svg]:size-5" style={{ color: g.color }}>
          <Icon name={g.icon} />
        </span>
      </ProgressRing>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex items-start gap-2">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-ring">
            <span className="block truncate text-[15px] font-medium hover:underline hover:underline-offset-4">{g.name}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
              <span>{goalKindMeta(g.kind).label}</span>
              {g.deadline && <span>· by {formatDate(g.deadline)}</span>}
              {g.linkedAccountName && <span>· in {g.linkedAccountName}</span>}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {g.status === "active" && (
              <Button size="sm" variant="outline" onClick={onContribute} className="hidden sm:inline-flex" aria-label={`Add money to ${g.name}`}>
                <Plus /> Add
              </Button>
            )}
            {menu}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-sm">
            <span className="num font-semibold">{fmt(g.current, g.currency)}</span>
            <span className="text-muted-foreground">
              {" "}
              of <span className="num">{fmt(g.targetAmount, g.currency)}</span>
            </span>
            <span className="num ml-1.5 text-[12.5px] text-muted-foreground">{pct}%</span>
          </p>
          <GoalTrackBadge track={g.track} />
        </div>
        {(plan || projection || (g.status === "active" && isPositive(g.remaining))) && (
          <div className="grid gap-0.5 text-[13px] text-muted-foreground">
            {plan ? <p>{plan}</p> : g.status === "active" && isPositive(g.remaining) ? <p>{fmt(g.remaining, g.currency)} to go</p> : null}
            {projection && (
              <p>
                <span className="mr-1 rounded bg-muted px-1 py-px text-[11px] font-medium tracking-wide uppercase">Projection</span>
                {projection}
              </p>
            )}
          </div>
        )}
        {g.status === "active" && (
          <Button size="sm" variant="outline" onClick={onContribute} className="mt-1 justify-self-start sm:hidden">
            <Plus /> Add money
          </Button>
        )}
      </div>
    </li>
  );
}
