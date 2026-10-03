"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  MoreHorizontal,
  Pencil,
  PieChart,
  Plus,
  RotateCw,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState, ErrorState, PageHeader, Progress, Skeleton } from "@/components/ui/misc";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData, useMoney } from "@/components/app/user-context";
import { add, cmp, divInt, isNegative, isPositive, ratio, sub } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { cn, pluralize } from "@/lib/utils";
import type { BudgetProgress } from "@/server/services/budgets";
import { archiveBudgetAction, budgetHistoryAction, deleteBudgetAction } from "./actions";
import { BudgetDialog, emptyBudget, toFormValues, type BudgetFormValues } from "./budget-form";
import { BudgetHistoryChart, type HistoryPoint } from "./budget-history-chart";

export type BudgetRow = BudgetProgress & { firedThresholds: number[] };
type ArchivedRow = { id: string; name: string; period: string; categoryId: string | null; amount: string; currency: string };
type Summary = { basis: "overall" | "categories"; budgeted: string; spent: string; count: number; period: { from: string; to: string } | null };

const STATUS = {
  over: { label: "Over budget", icon: CircleAlert, badge: "negative", tone: "negative" },
  projected_over: { label: "On pace to go over", icon: TrendingUp, badge: "warning", tone: "warning" },
  warning: { label: "Almost at limit", icon: AlertTriangle, badge: "warning", tone: "warning" },
  ok: { label: "On track", icon: CheckCircle2, badge: "positive", tone: "positive" },
} as const;

const PERIOD_LABEL: Record<string, string> = { weekly: "Weekly", monthly: "Monthly", yearly: "Yearly", custom: "Custom" };
const PERIOD_ORDER = ["monthly", "weekly", "yearly", "custom"];

const rangeText = (r: { from: string; to: string }) =>
  r.from.slice(0, 4) === r.to.slice(0, 4)
    ? `${formatDate(r.from, "d MMM")} – ${formatDate(r.to, "d MMM")}`
    : `${formatDate(r.from, "d MMM yyyy")} – ${formatDate(r.to, "d MMM yyyy")}`;

function transactionsHref(b: Pick<BudgetRow, "categoryId" | "periodRange">) {
  const p = new URLSearchParams({ from: b.periodRange.from, to: b.periodRange.to, type: "expense,refund" });
  if (b.categoryId) p.set("category", b.categoryId);
  return `/transactions?${p}`;
}

/** Progress bar plus a pace tick showing where spending would be if spread evenly. */
function BudgetBar({ b }: { b: BudgetRow }) {
  const tone = STATUS[b.status].tone;
  const pace = isPositive(b.available) && b.daysLeft > 0 && b.elapsedDays > 0 ? Math.min(1, ratio(b.expectedByToday, b.available)) : null;
  return (
    <div className="relative">
      <Progress value={Math.min(b.pct, 1)} tone={tone} label={`${b.name}: ${Math.round(b.pct * 100)}% of budget used`} className="h-2" />
      {pace !== null && (
        <span
          aria-hidden
          title="Even pace for today"
          className="absolute -top-0.5 h-3 w-0.5 rounded-full bg-foreground/50"
          style={{ left: `calc(${pace * 100}% - 1px)` }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: BudgetRow["status"] }) {
  const s = STATUS[status];
  const I = s.icon;
  return (
    <Badge variant={s.badge}>
      <I aria-hidden /> {s.label}
    </Badge>
  );
}

function BudgetMenu({
  b,
  onEdit,
  onDetails,
  onArchive,
  onDelete,
}: {
  b: BudgetRow;
  onEdit: () => void;
  onDetails: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${b.name}`} className="text-muted-foreground">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onDetails}>
          <PieChart /> History & details
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={transactionsHref(b)}>
            <ArrowUpRight /> View transactions
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onArchive}>
          <Archive /> Archive
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={onDelete}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BudgetListRow({ b, onOpen, menu }: { b: BudgetRow; onOpen: () => void; menu: React.ReactNode }) {
  const { categories } = useAppData();
  const fmt = useMoney();
  const cat = categories.find((c) => c.id === b.categoryId);
  const over = isNegative(b.remaining);
  return (
    <li className="group relative flex gap-3 px-4 py-4 sm:px-5">
      <div className="pt-0.5">
        {cat ? (
          <CategoryBadge icon={cat.icon} color={cat.color} size="lg" />
        ) : (
          <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <PieChart className="size-5" aria-hidden />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onOpen}
              className="text-left text-[15px] font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/30"
            >
              {b.name}
            </button>
            <p className="text-[13px] text-muted-foreground">
              {PERIOD_LABEL[b.period]} · {rangeText(b.periodRange)}
              {b.daysLeft > 0 && b.period !== "custom" ? ` · ${pluralize(b.daysLeft, "day")} left` : ""}
            </p>
          </div>
          <div className="relative z-10 -mt-1 -mr-2 flex items-center gap-1">{menu}</div>
        </div>
        <div className="mt-2.5 flex items-baseline justify-between gap-2">
          <p className="text-sm">
            <Money amount={b.spent} className="font-semibold" /> <span className="text-muted-foreground">of</span>{" "}
            <Money amount={b.available} className="text-muted-foreground" />
          </p>
          <span className={cn("num text-[13px] font-medium", over ? "text-negative" : b.status === "ok" ? "text-muted-foreground" : "text-warning")}>
            {Math.round(b.pct * 100)}%
          </span>
        </div>
        <div className="mt-1.5">
          <BudgetBar b={b} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
          {b.status !== "ok" && <StatusBadge status={b.status} />}
          {over ? (
            <span className="text-negative">
              <Money amount={sub(b.spent, b.available)} /> over
            </span>
          ) : (
            <span className="text-muted-foreground">
              <Money amount={b.remaining} className="text-foreground" /> left
              {b.daysLeft > 0 && isPositive(b.dailyAllowance) && <> · ≈{fmt(b.dailyAllowance)}/day</>}
            </span>
          )}
          {b.projectionReliable && (
            <span className={cn("inline-flex items-center gap-1", cmp(b.projected, b.available) > 0 ? "text-warning" : "text-muted-foreground")}>
              <TrendingUp className="size-3.5" aria-hidden />
              Forecast ≈{fmt(b.projected)}
            </span>
          )}
          {b.rollover && cmp(b.rolloverAmount, "0") !== 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <RotateCw className="size-3.5" aria-hidden />
              <Money amount={b.rolloverAmount} signed /> rolled over
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/** Mounted only while the details dialog is open; fetches the last 6 periods. */
function BudgetHistorySection({ id, period }: { id: string; period: string }) {
  const fmt = useMoney();
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<{ key: string; error: string | null; points: HistoryPoint[] } | null>(null);
  const key = `${id}:${attempt}`;
  React.useEffect(() => {
    let live = true;
    void budgetHistoryAction({ id, periods: 6 }).then((r) => {
      if (live) setState(r.ok ? { key, error: null, points: r.data } : { key, error: r.error, points: [] });
    });
    return () => {
      live = false;
    };
  }, [id, key]);
  const loading = !state || state.key !== key;
  const points = state?.points ?? [];
  const avg = points.filter((p) => !p.current);
  return (
    <section aria-labelledby="hist-title" className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <h3 id="hist-title" className="text-sm font-medium">
          Spending per period
        </h3>
        {avg.length > 0 && !loading && (
          <span className="text-[13px] text-muted-foreground">
            Avg of last {pluralize(avg.length, "period")}: {fmt(divInt(add(...avg.map((p) => p.spent)), avg.length))}
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-44 w-full" />
      ) : state?.error ? (
        <ErrorState
          message={state?.error ?? undefined}
          retry={
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      ) : (
        <BudgetHistoryChart points={points} period={period} />
      )}
    </section>
  );
}

function BudgetDetails({ b, open, onOpenChange, onEdit }: { b: BudgetRow | null; open: boolean; onOpenChange: (o: boolean) => void; onEdit: () => void }) {
  const fmt = useMoney();
  if (!b) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={b.name} description={`${PERIOD_LABEL[b.period]} budget · ${rangeText(b.periodRange)}`} size="lg">
        <div className="grid gap-5">
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-2xl font-semibold tracking-tight">
                <Money amount={b.spent} /> <span className="text-base font-normal text-muted-foreground">of {fmt(b.available)}</span>
              </p>
              <StatusBadge status={b.status} />
            </div>
            <BudgetBar b={b} />
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-[13px] text-muted-foreground">{isNegative(b.remaining) ? "Over by" : "Left"}</dt>
              <dd className={cn("num font-medium", isNegative(b.remaining) && "text-negative")}>
                {fmt(isNegative(b.remaining) ? sub(b.spent, b.available) : b.remaining)}
              </dd>
            </div>
            <div>
              <dt className="text-[13px] text-muted-foreground">Per day left</dt>
              <dd className="num font-medium">{b.daysLeft > 0 ? `≈${fmt(b.dailyAllowance)}` : "—"}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-muted-foreground">Forecast (pace)</dt>
              <dd className="num font-medium">{b.projectionReliable ? `≈${fmt(b.projected)}` : <span className="text-muted-foreground">Too early</span>}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-muted-foreground">Even pace today</dt>
              <dd className="num font-medium">{fmt(b.expectedByToday)}</dd>
            </div>
            {b.rollover && (
              <div className="col-span-2">
                <dt className="text-[13px] text-muted-foreground">Rolled over from last period</dt>
                <dd className="num font-medium">
                  {fmt(b.rolloverAmount, undefined, { signed: true })} <span className="font-normal text-muted-foreground">(budget {fmt(b.amount)})</span>
                </dd>
              </div>
            )}
          </dl>
          <p className="-mt-2 text-[12.5px] text-muted-foreground">Forecasts assume you keep spending at the same daily pace for the rest of the period.</p>

          <BudgetHistorySection id={b.id} period={b.period} />

          {b.alertsEnabled ? (
            <section className="grid gap-2" aria-label="Alert thresholds">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <Bell className="size-3.5" aria-hidden /> Alerts this period
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {b.alertThresholds.map((t) => {
                  const fired = b.firedThresholds.includes(t);
                  return (
                    <span
                      key={t}
                      className={cn(
                        "num inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12.5px]",
                        fired ? "border-foreground/30 text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {fired && <Check className="size-3" aria-hidden />}
                      {t}%<span className="sr-only">{fired ? " (sent)" : " (not reached)"}</span>
                    </span>
                  );
                })}
                {b.alertOnProjected && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12.5px]",
                      b.firedThresholds.includes(-1) ? "border-foreground/30" : "text-muted-foreground",
                    )}
                  >
                    {b.firedThresholds.includes(-1) && <Check className="size-3" aria-hidden />}
                    On pace to go over
                  </span>
                )}
              </div>
            </section>
          ) : (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <BellOff className="size-3.5" aria-hidden /> Alerts are off for this budget.
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" asChild>
              <Link href={transactionsHref(b)}>
                View transactions <ArrowUpRight />
              </Link>
            </Button>
            <Button onClick={onEdit}>
              <Pencil /> Edit budget
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BudgetsView({
  budgets,
  archived,
  summary,
  openNew,
  newCategoryId,
}: {
  budgets: BudgetRow[];
  archived: ArchivedRow[];
  summary: Summary;
  openNew: boolean;
  newCategoryId: string | null;
}) {
  const { prefs, categories } = useAppData();
  const router = useRouter();
  const [formOpen, setFormOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState<BudgetFormValues>(() => emptyBudget(prefs.today, newCategoryId));
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ id: string; name: string } | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [busy, start] = React.useTransition();

  // React to ?new=1 (also when navigated to while already on this page).
  const urlKey = openNew ? `new:${newCategoryId ?? ""}` : "";
  const [seenUrlKey, setSeenUrlKey] = React.useState("");
  if (urlKey !== seenUrlKey) {
    setSeenUrlKey(urlKey);
    if (openNew) {
      setFormValues(emptyBudget(prefs.today, newCategoryId));
      setFormOpen(true);
    }
  }

  const openCreate = () => {
    setFormValues(emptyBudget(prefs.today));
    setFormOpen(true);
  };
  const openEdit = (b: BudgetRow) => {
    setDetailId(null);
    setFormValues(toFormValues(b, prefs.today));
    setFormOpen(true);
  };
  const onFormOpenChange = (o: boolean) => {
    setFormOpen(o);
    if (!o && openNew) router.replace("/budgets", { scroll: false });
  };
  const archive = (id: string, archivedFlag: boolean) =>
    start(async () => {
      const r = await archiveBudgetAction({ id, archived: archivedFlag });
      if (!r.ok) return void toast.error(r.error);
      toast.success(
        archivedFlag ? "Budget archived" : "Budget restored",
        archivedFlag ? { action: { label: "Undo", onClick: () => void archiveBudgetAction({ id, archived: false }) } } : undefined,
      );
    });
  const remove = async () => {
    if (!confirm) return;
    const r = await deleteBudgetAction(confirm.id);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Budget deleted");
    setConfirm(null);
  };

  const detail = budgets.find((b) => b.id === detailId) ?? null;
  const groups = PERIOD_ORDER.map((p) => ({ period: p, items: budgets.filter((b) => b.period === p) })).filter((g) => g.items.length);
  const attention = budgets.filter((b) => b.status === "over" || b.status === "projected_over").length;
  const summaryPct = isPositive(summary.budgeted) ? ratio(summary.spent, summary.budgeted) : 0;
  const summaryLeft = sub(summary.budgeted, summary.spent);

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Set limits, see your pace, and get a heads-up before you overspend."
        actions={
          budgets.length > 0 && (
            <Button onClick={openCreate}>
              <Plus /> New budget
            </Button>
          )
        }
      />

      {budgets.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PieChart />}
            title="No budgets yet"
            description="Start with one overall monthly limit, or budget the categories you want to keep an eye on. Spending you've already logged counts right away."
            action={
              <Button onClick={openCreate}>
                <Plus /> Create a budget
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-5">
          {summary.count > 0 && summary.period && (
            <Card className="px-5 py-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[13px] text-muted-foreground">
                    This month · {rangeText(summary.period)} ·{" "}
                    {summary.basis === "overall" ? "overall budget" : `${pluralize(summary.count, "category budget")}`}
                  </p>
                  <p className="mt-1 text-[26px] font-semibold tracking-tight">
                    <Money amount={summary.spent} />{" "}
                    <span className="text-base font-normal text-muted-foreground">
                      spent of <Money amount={summary.budgeted} />
                    </span>
                  </p>
                </div>
                <div className="text-right text-sm">
                  {isNegative(summaryLeft) ? (
                    <p className="font-medium text-negative">
                      <Money amount={sub(summary.spent, summary.budgeted)} /> over
                    </p>
                  ) : (
                    <p className="font-medium">
                      <Money amount={summaryLeft} /> left
                    </p>
                  )}
                  {attention > 0 && (
                    <p className="mt-0.5 inline-flex items-center gap-1 text-[13px] text-warning">
                      <AlertTriangle className="size-3.5" aria-hidden /> {pluralize(attention, "budget")} need attention
                    </p>
                  )}
                </div>
              </div>
              <Progress
                className="mt-3 h-2"
                value={Math.min(summaryPct, 1)}
                tone={summaryPct > 1 ? "negative" : summaryPct >= 0.8 ? "warning" : "default"}
                label={`${Math.round(summaryPct * 100)}% of this month's budget used`}
              />
            </Card>
          )}

          {groups.map((g) => (
            <section key={g.period} aria-labelledby={`grp-${g.period}`}>
              <h2 id={`grp-${g.period}`} className="mb-2 px-1 text-[13px] font-medium text-muted-foreground">
                {PERIOD_LABEL[g.period]}
              </h2>
              <Card className="overflow-hidden">
                <ul className="divide-y">
                  {g.items.map((b) => (
                    <BudgetListRow
                      key={b.id}
                      b={b}
                      onOpen={() => setDetailId(b.id)}
                      menu={
                        <BudgetMenu
                          b={b}
                          onDetails={() => setDetailId(b.id)}
                          onEdit={() => openEdit(b)}
                          onArchive={() => archive(b.id, true)}
                          onDelete={() => setConfirm({ id: b.id, name: b.name })}
                        />
                      }
                    />
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          <p className="px-1 text-[12.5px] text-muted-foreground">
            The small tick on each bar marks an even pace for today. Forecasts project your current daily pace to the end of the period.
          </p>
        </div>
      )}

      {archived.length > 0 && (
        <section className="mt-6">
          <button
            type="button"
            onClick={() => setShowArchived((s) => !s)}
            aria-expanded={showArchived}
            className="flex h-10 items-center gap-1 px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-4 transition-transform", showArchived && "rotate-180")} aria-hidden />
            Archived ({archived.length})
          </button>
          {showArchived && (
            <Card className="mt-1 overflow-hidden">
              <ul className="divide-y">
                {archived.map((a) => {
                  const cat = categories.find((c) => c.id === a.categoryId);
                  return (
                    <li key={a.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                      {cat ? <CategoryBadge icon={cat.icon} color={cat.color} size="sm" /> : <PieChart className="size-4 text-muted-foreground" aria-hidden />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{a.name}</p>
                        <p className="text-[12.5px] text-muted-foreground">
                          {PERIOD_LABEL[a.period]} · <Money amount={a.amount} currency={a.currency} />
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => archive(a.id, false)}>
                        <ArchiveRestore /> Restore
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${a.name}`} onClick={() => setConfirm({ id: a.id, name: a.name })}>
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>
      )}

      <BudgetDialog open={formOpen} onOpenChange={onFormOpenChange} initial={formValues} />
      <BudgetDetails b={detail} open={Boolean(detail)} onOpenChange={(o) => !o && setDetailId(null)} onEdit={() => detail && openEdit(detail)} />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete “${confirm?.name ?? ""}”?`}
        description="The budget and its alert history are removed. Your transactions aren't affected. Archive instead if you might want it back."
        onConfirm={remove}
      />
    </>
  );
}
