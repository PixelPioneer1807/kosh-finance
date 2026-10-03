"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeftRight,
  Briefcase,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Receipt,
  Repeat,
  SkipForward,
  Sparkles,
  Trash2,
  TrendingUp,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { CategoryBadge } from "@/components/app/icons";
import { Money } from "@/components/app/money";
import { useAppData, useMoney } from "@/components/app/user-context";
import { add, cmp, isPositive, toInputValue } from "@/lib/money";
import { daysBetween, formatDate, relativeDayLabel } from "@/lib/dates";
import { describeRule } from "@/lib/recurrence";
import { cn, pluralize } from "@/lib/utils";
import {
  acceptPriceChangeAction,
  acceptSuggestionAction,
  deleteRecurringAction,
  markPaidAction,
  setRecurringStatusAction,
  skipOccurrenceAction,
} from "./actions";
import { emptyRecurring, itemToValues, RecurringDialog, type RecurringFormValues } from "./recurring-form";
import { KIND_LABEL, type CostSummary, type OccurrenceRow, type PriceChangeRow, type RecurringItem, type RecurringKindId, type Suggestion } from "./types";

const KIND_ICON: Record<RecurringKindId, React.ComponentType<{ className?: string }>> = {
  bill: Receipt,
  subscription: Repeat,
  income: Briefcase,
  expense: CalendarClock,
  transfer: ArrowLeftRight,
};

const TABS = ["upcoming", "bills", "subscriptions", "income", "other"] as const;
type TabId = (typeof TABS)[number];

const isOut = (k: RecurringKindId) => k === "bill" || k === "subscription" || k === "expense";
const paidVerb = (k: RecurringKindId) => (k === "income" ? "Mark received" : k === "transfer" ? "Mark done" : "Mark paid");

function KindIcon({
  item,
  categories,
}: {
  item: { kind: RecurringKindId; categoryId: string | null };
  categories: { id: string; icon: string; color: string }[];
}) {
  const cat = categories.find((c) => c.id === item.categoryId);
  if (cat) return <CategoryBadge icon={cat.icon} color={cat.color} size="md" />;
  const I = KIND_ICON[item.kind];
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
      <I className="size-4" />
    </span>
  );
}

function TrialBadge({ trialEndsAt, today }: { trialEndsAt: string | null; today: string }) {
  if (!trialEndsAt || trialEndsAt < today) return null;
  const days = daysBetween(today, trialEndsAt);
  return days <= 14 ? (
    <Badge variant="warning">
      <AlertTriangle aria-hidden /> Trial ends {days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}
    </Badge>
  ) : (
    <Badge variant="outline">Trial until {formatDate(trialEndsAt, "d MMM")}</Badge>
  );
}

/* ───────────── Mark paid ───────────── */

type PayTarget = { item: RecurringItem; occurrence: string };

function MarkPaidDialog({ target, onOpenChange }: { target: PayTarget | null; onOpenChange: (o: boolean) => void }) {
  const { prefs } = useAppData();
  if (!target) return null;
  const verb = paidVerb(target.item.kind);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={`${verb}: ${target.item.name}`}
        description={`Records the ${target.occurrence === prefs.today ? "occurrence due today" : `occurrence due ${formatDate(target.occurrence, "d MMM")}`} as a transaction and moves the schedule on.`}
      >
        <MarkPaidForm key={`${target.item.id}:${target.occurrence}`} target={target} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MarkPaidForm({ target, onDone }: { target: PayTarget; onDone: () => void }) {
  const { prefs, accounts } = useAppData();
  const fmt = useMoney();
  const item = target.item;
  const [date, setDate] = React.useState(prefs.today);
  const [amount, setAmount] = React.useState(() => toInputValue(item.amount));
  const [accountId, setAccountId] = React.useState(() => item.accountId ?? accounts.find((a) => !a.isArchived)?.id ?? "");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const account = accounts.find((a) => a.id === accountId);
  const verb = paidVerb(item.kind);
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors({});
        setFormError(null);
        start(async () => {
          const r = await markPaidAction({ id: item.id, occurrence: target.occurrence, date, amount, accountId: accountId || null });
          if (!r.ok) {
            setFormError(r.error);
            setErrors(r.fieldErrors ?? {});
            return;
          }
          toast.success(r.data.alreadyPosted ? "This one was already recorded" : `${item.name}: ${fmt(amount, account?.currency ?? item.currency)} recorded`);
          onDone();
        });
      }}
    >
      <Field label={`Amount (${account?.currency ?? item.currency})`} htmlFor="mp-amount" error={errors.amount}>
        <Input
          id="mp-amount"
          inputMode="decimal"
          className="num"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
          required
          autoFocus
        />
      </Field>
      <Field label={item.kind === "income" ? "Received on" : "Paid on"} htmlFor="mp-date" error={errors.date}>
        <div className="grid gap-1.5">
          <Input id="mp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <div className="flex gap-1">
            {[
              { d: prefs.today, l: "Today" },
              { d: target.occurrence, l: "Due date" },
            ]
              .filter((o, i, arr) => arr.findIndex((x) => x.d === o.d) === i)
              .map((o) => (
                <button
                  key={o.l}
                  type="button"
                  onClick={() => setDate(o.d)}
                  aria-pressed={date === o.d}
                  className={cn("h-8 rounded-full border px-2.5 text-[12.5px] text-muted-foreground", date === o.d && "border-foreground/40 text-foreground")}
                >
                  {o.l}
                </button>
              ))}
          </div>
        </div>
      </Field>
      <Field label={item.kind === "income" ? "Into account" : "From account"} htmlFor="mp-account" error={errors.accountId}>
        <NativeSelect id="mp-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
          <option value="">Choose…</option>
          {accounts
            .filter((a) => !a.isArchived || a.id === accountId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </NativeSelect>
      </Field>
      {formError && (
        <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
          {formError}
        </p>
      )}
      <DialogFooter className="mt-1">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          <Check /> {verb}
        </Button>
      </DialogFooter>
    </form>
  );
}

/* ───────────── Rows ───────────── */

type RowActions = {
  onEdit: (i: RecurringItem) => void;
  onPay: (i: RecurringItem, occurrence: string) => void;
  onSkip: (i: RecurringItem) => void;
  onStatus: (i: RecurringItem, s: "active" | "paused" | "cancelled") => void;
  onDelete: (i: RecurringItem) => void;
};

function ItemMenu({ item, a }: { item: RecurringItem; a: RowActions }) {
  const active = item.status === "active";
  const inactive = item.status === "cancelled" || item.status === "ended";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${item.name}`} className="text-muted-foreground">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => a.onEdit(item)}>
          <Pencil /> Edit
        </DropdownMenuItem>
        {item.nextDate && !inactive && (
          <>
            <DropdownMenuItem onSelect={() => a.onPay(item, item.nextDate!)}>
              <Check /> {paidVerb(item.kind)}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => a.onSkip(item)}>
              <SkipForward /> Skip next ({formatDate(item.nextDate, "d MMM")})
            </DropdownMenuItem>
          </>
        )}
        {item.serviceUrl && (
          <DropdownMenuItem asChild>
            <a href={item.serviceUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> Open manage page
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {active && (
          <DropdownMenuItem onSelect={() => a.onStatus(item, "paused")}>
            <Pause /> Pause
          </DropdownMenuItem>
        )}
        {!active && (
          <DropdownMenuItem onSelect={() => a.onStatus(item, "active")}>
            <Play /> {item.status === "paused" ? "Resume" : "Reactivate"}
          </DropdownMenuItem>
        )}
        {!inactive && (
          <DropdownMenuItem onSelect={() => a.onStatus(item, "cancelled")}>
            <XCircle /> {item.kind === "subscription" ? "Mark cancelled" : "Stop tracking"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem destructive onSelect={() => a.onDelete(item)}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({ item, a, children }: { item: RecurringItem; a: RowActions; children?: React.ReactNode }) {
  const { prefs, accounts, categories } = useAppData();
  const acc = accounts.find((x) => x.id === item.accountId);
  const to = accounts.find((x) => x.id === item.toAccountId);
  const inactive = item.status === "cancelled" || item.status === "ended";
  const overdue = item.status === "active" && item.nextDate && item.nextDate < prefs.today && !item.autoPost;
  return (
    <li className={cn("flex gap-3 px-4 py-3.5 sm:px-5", inactive && "opacity-70")}>
      <KindIcon item={item} categories={categories} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => a.onEdit(item)}
              className="truncate text-left text-[15px] font-medium hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {item.name}
            </button>
            <p className="text-[13px] text-muted-foreground">
              {describeRule(item)}
              {item.status === "active" && item.nextDate && <> · next {relativeDayLabel(item.nextDate, prefs.today)}</>}
              {item.kind === "transfer" ? (acc && to ? ` · ${acc.name} → ${to.name}` : "") : acc ? ` · ${acc.name}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-start gap-1">
            <div className="text-right">
              <Money
                amount={item.amount}
                currency={item.currency}
                direction={item.kind === "income" ? "in" : undefined}
                tone={item.kind === "income" ? "flow" : "none"}
                className="text-[15px] font-medium"
              />
              {item.kind === "subscription" && item.frequency !== "monthly" && (
                <p className="text-[12px] text-muted-foreground">
                  <Money amount={item.monthly} currency={item.currency} />
                  /mo
                </p>
              )}
            </div>
            <div className="-mt-1 -mr-2">
              <ItemMenu item={item} a={a} />
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {overdue && (
            <Badge variant="negative">
              <CircleAlert aria-hidden /> Overdue since {formatDate(item.nextDate!, "d MMM")}
            </Badge>
          )}
          {item.status === "paused" && <Badge variant="default">Paused</Badge>}
          {item.status === "cancelled" && <Badge variant="outline">Cancelled{item.cancelledAt ? ` ${formatDate(item.cancelledAt, "d MMM yyyy")}` : ""}</Badge>}
          {item.status === "ended" && <Badge variant="outline">Ended</Badge>}
          {item.autoPost && item.status === "active" && (
            <Badge variant="info">
              <Zap aria-hidden /> Auto-records
            </Badge>
          )}
          {item.kind === "subscription" && <TrialBadge trialEndsAt={item.trialEndsAt} today={prefs.today} />}
          {item.lastPaid && (
            <span className="text-[12.5px] text-muted-foreground">
              Last {item.kind === "income" ? "received" : "paid"} {formatDate(item.lastPaid.date, "d MMM")} ·{" "}
              <Money amount={item.lastPaid.amount} currency={item.currency} />
            </span>
          )}
        </div>
        {children}
      </div>
    </li>
  );
}

function ItemList({
  items,
  a,
  empty,
  inactiveLabel = "Cancelled & ended",
}: {
  items: RecurringItem[];
  a: RowActions;
  empty: React.ReactNode;
  inactiveLabel?: string;
}) {
  const [showInactive, setShowInactive] = React.useState(false);
  const live = items.filter((i) => i.status === "active" || i.status === "paused");
  const gone = items.filter((i) => i.status === "cancelled" || i.status === "ended");
  return (
    <div className="grid gap-3">
      {live.length ? (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {live.map((i) => (
              <ItemRow key={i.id} item={i} a={a} />
            ))}
          </ul>
        </Card>
      ) : (
        <Card>{empty}</Card>
      )}
      {gone.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowInactive((s) => !s)}
            aria-expanded={showInactive}
            className="flex h-10 items-center gap-1 px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-4 transition-transform", showInactive && "rotate-180")} aria-hidden />
            {inactiveLabel} ({gone.length})
          </button>
          {showInactive && (
            <Card className="mt-1 overflow-hidden">
              <ul className="divide-y">
                {gone.map((i) => (
                  <ItemRow key={i.id} item={i} a={a} />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────── Upcoming ───────────── */

function UpcomingTab({ occurrences, items, a, onNew }: { occurrences: OccurrenceRow[]; items: RecurringItem[]; a: RowActions; onNew: () => void }) {
  const { prefs, accounts, categories } = useAppData();
  const byId = new Map(items.map((i) => [i.id, i]));
  // Only the earliest pending occurrence of each item is actionable; later ones are previews.
  const firstOf = new Map<string, string>();
  for (const o of occurrences) if (!firstOf.has(o.recurringId)) firstOf.set(o.recurringId, o.date);

  const overdue = occurrences.filter((o) => o.status === "overdue");
  const rest = occurrences.filter((o) => o.status !== "overdue");
  const groups: { date: string; rows: OccurrenceRow[] }[] = [];
  for (const o of rest) {
    const g = groups[groups.length - 1];
    if (g && g.date === o.date) g.rows.push(o);
    else groups.push({ date: o.date, rows: [o] });
  }

  if (!occurrences.length)
    return (
      <Card>
        <EmptyState
          icon={<CalendarClock />}
          title="Nothing due in the next 30 days"
          description={items.length ? "Your active items are scheduled further out." : "Add your bills, subscriptions and paydays to see what's coming up."}
          action={
            <Button onClick={onNew}>
              <Plus /> Add recurring item
            </Button>
          }
        />
      </Card>
    );

  const renderRow = (o: OccurrenceRow) => {
    const item = byId.get(o.recurringId);
    if (!item) return null;
    const acc = accounts.find((x) => x.id === o.accountId);
    const actionable = firstOf.get(o.recurringId) === o.date;
    return (
      <li key={`${o.recurringId}:${o.date}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5">
        <KindIcon item={o} categories={categories} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => a.onEdit(item)}
            className="truncate text-left text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {o.name}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Badge variant="outline">{KIND_LABEL[o.kind]}</Badge>
            {acc && <span>{acc.name}</span>}
            {o.status === "overdue" && <span className="text-negative">Due {formatDate(o.date, "d MMM")}</span>}
            {o.autoPost && (
              <span className="inline-flex items-center gap-0.5">
                <Zap className="size-3" aria-hidden /> Auto
              </span>
            )}
          </div>
        </div>
        <Money
          amount={o.amount}
          currency={o.currency}
          direction={o.kind === "income" ? "in" : o.kind === "transfer" ? undefined : "out"}
          tone={o.kind === "income" ? "flow" : "none"}
          className="text-sm font-medium"
        />
        {actionable ? (
          <div className="flex w-full justify-end gap-1.5 sm:w-auto">
            <Button size="sm" variant="ghost" onClick={() => a.onSkip(item)} aria-label={`Skip ${o.name} on ${formatDate(o.date, "d MMM")}`}>
              <SkipForward /> Skip
            </Button>
            <Button size="sm" variant="outline" onClick={() => a.onPay(item, o.date)}>
              <Check /> {paidVerb(o.kind)}
            </Button>
          </div>
        ) : (
          <span className="w-full text-right text-[12.5px] text-muted-foreground sm:w-24">Scheduled</span>
        )}
      </li>
    );
  };

  return (
    <div className="grid gap-4">
      {overdue.length > 0 && (
        <section aria-labelledby="up-overdue">
          <h2 id="up-overdue" className="mb-2 flex items-center gap-1.5 px-1 text-[13px] font-medium text-negative">
            <CircleAlert className="size-3.5" aria-hidden /> Overdue · {overdue.length}
          </h2>
          <Card className="overflow-hidden border-negative/30">
            <ul className="divide-y">{overdue.map(renderRow)}</ul>
          </Card>
        </section>
      )}
      {groups.map((g) => {
        const out = add(...g.rows.filter((r) => isOut(r.kind) && r.baseAmount).map((r) => r.baseAmount!));
        return (
          <section key={g.date} aria-labelledby={`up-${g.date}`}>
            <div className="mb-2 flex items-baseline justify-between px-1">
              <h2 id={`up-${g.date}`} className="text-[13px] font-medium">
                {relativeDayLabel(g.date, prefs.today)}
                {/* Relative labels like "Monday" get the date alongside; dated labels already include it. */}
                {!/\d/.test(relativeDayLabel(g.date, prefs.today)) && <span className="ml-1.5 font-normal text-muted-foreground">{formatDate(g.date, "d MMM")}</span>}
              </h2>
              {isPositive(out) && (
                <span className="text-[12.5px] text-muted-foreground">
                  <Money amount={out} /> out
                </span>
              )}
            </div>
            <Card className="overflow-hidden">
              <ul className="divide-y">{g.rows.map(renderRow)}</ul>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

/* ───────────── Suggestions ───────────── */

const HIDDEN_KEY = "kosh:recurring:hidden-suggestions";
const HIDDEN_EVENT = "kosh:hidden-suggestions";
function subscribeHidden(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(HIDDEN_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(HIDDEN_EVENT, cb);
  };
}
function readHidden() {
  try {
    return window.localStorage.getItem(HIDDEN_KEY);
  } catch {
    return null;
  }
}
const FREQ_WORD: Record<Suggestion["frequency"], string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Every 3 months",
  yearly: "Yearly",
};

function Suggestions({ suggestions, onCustomize }: { suggestions: Suggestion[]; onCustomize: (s: Suggestion) => void }) {
  const { prefs } = useAppData();
  const raw = React.useSyncExternalStore(subscribeHidden, readHidden, () => null);
  const [sessionHidden, setSessionHidden] = React.useState<string[]>([]);
  const hidden = React.useMemo(() => {
    let saved: string[] = [];
    try {
      saved = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      saved = [];
    }
    return [...saved, ...sessionHidden];
  }, [raw, sessionHidden]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const hide = (id: string) => {
    setSessionHidden((h) => [...h, id]);
    try {
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...new Set([...hidden, id])].slice(-200)));
      window.dispatchEvent(new Event(HIDDEN_EVENT));
    } catch {
      /* storage unavailable — hidden for this visit only */
    }
  };
  const visible = suggestions.filter((s) => !hidden.includes(s.merchantId));
  if (!visible.length) return null;
  return (
    <section aria-labelledby="sugg-title" className="mb-5">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 id="sugg-title" className="flex items-center gap-1.5 text-[13px] font-medium">
          <Sparkles className="size-3.5 text-accent" aria-hidden /> Looks recurring
        </h2>
        <span className="text-[12.5px] text-muted-foreground">Found in your history — nothing is added until you confirm</span>
      </div>
      <Card className="overflow-hidden">
        <ul className="divide-y">
          {visible.map((s) => {
            const kind = s.fixedAmount ? "subscription" : "bill";
            return (
              <li key={`${s.merchantId}:${s.currency}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                  <Repeat className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.merchantName}</p>
                  <p className="text-[12.5px] text-muted-foreground">
                    {FREQ_WORD[s.frequency]} · {s.fixedAmount ? "" : "about "}
                    <Money amount={s.typicalAmount} currency={s.currency} /> · seen {s.count}× · next expected {relativeDayLabel(s.nextExpected, prefs.today)}
                  </p>
                </div>
                <div className="flex w-full justify-end gap-1.5 sm:w-auto">
                  <Button size="sm" variant="ghost" aria-label={`Hide suggestion for ${s.merchantName}`} onClick={() => hide(s.merchantId)}>
                    <X /> <span className="sm:sr-only">Not recurring</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onCustomize(s)}>
                    Customize
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy === s.merchantId}
                    onClick={async () => {
                      setBusy(s.merchantId);
                      const r = await acceptSuggestionAction({
                        merchantName: s.merchantName,
                        kind,
                        amount: s.typicalAmount,
                        accountId: s.accountId,
                        categoryId: s.categoryId,
                        frequency: s.frequency,
                        lastDate: s.lastDate,
                      });
                      setBusy(null);
                      if (!r.ok) return void toast.error(r.error);
                      toast.success(`Tracking ${s.merchantName} as a ${kind}`);
                    }}
                  >
                    <Plus /> Track it
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}

/* ───────────── Income breakdown ───────────── */

function IncomeBreakdownView({ item }: { item: RecurringItem }) {
  if (!item.grossAmount && !item.deductions.length) return null;
  return (
    <dl className="mt-2.5 grid max-w-sm gap-1 rounded-lg bg-subtle px-3 py-2 text-[13px]">
      {item.grossAmount && (
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Gross</dt>
          <dd>
            <Money amount={item.grossAmount} currency={item.currency} />
          </dd>
        </div>
      )}
      {item.deductions.map((d, i) => (
        <div key={i} className="flex justify-between gap-3">
          <dt className="text-muted-foreground">
            {d.label} <span className="text-[11.5px]">({d.kind === "tax" ? "tax" : d.kind === "bonus" ? "bonus" : "deduction"})</span>
          </dt>
          <dd>
            <Money amount={d.amount} currency={item.currency} direction={d.kind === "bonus" ? "in" : "out"} />
          </dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t pt-1 font-medium">
        <dt>Net</dt>
        <dd>
          <Money amount={item.amount} currency={item.currency} />
        </dd>
      </div>
    </dl>
  );
}

/* ───────────── Page ───────────── */

export function RecurringView({
  items,
  upcoming,
  costs,
  priceChanges,
  suggestions,
  newKind,
  openId,
  initialTab,
}: {
  items: RecurringItem[];
  upcoming: OccurrenceRow[];
  costs: { subscriptions: CostSummary; bills: CostSummary; income: CostSummary };
  priceChanges: PriceChangeRow[];
  suggestions: Suggestion[];
  newKind: RecurringKindId | null;
  openId: string | null;
  initialTab: string | null;
}) {
  const { prefs, accounts } = useAppData();
  const fmt = useMoney();
  const router = useRouter();
  const [tab, setTab] = React.useState<TabId>(() => (TABS.find((t) => t === initialTab) ?? "upcoming") as TabId);
  const [formOpen, setFormOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState<RecurringFormValues>(() => emptyRecurring("bill", prefs, accounts));
  const [pay, setPay] = React.useState<PayTarget | null>(null);
  const [confirm, setConfirm] = React.useState<RecurringItem | null>(null);

  const openNew = React.useCallback(
    (kind: RecurringKindId, patch: Partial<RecurringFormValues> = {}) => {
      setFormValues({ ...emptyRecurring(kind, prefs, accounts), ...patch });
      setFormOpen(true);
    },
    [prefs, accounts],
  );
  const openEdit = React.useCallback((i: RecurringItem) => {
    setFormValues(itemToValues(i));
    setFormOpen(true);
  }, []);

  // React to ?new=<kind> / ?open=<id> (also when navigated to while already on this page).
  const urlKey = newKind ? `new:${newKind}` : openId ? `open:${openId}` : "";
  const [seenUrlKey, setSeenUrlKey] = React.useState("");
  const [urlDriven, setUrlDriven] = React.useState(false);
  const [missing, setMissing] = React.useState(false);
  if (urlKey !== seenUrlKey) {
    setSeenUrlKey(urlKey);
    const it = openId ? items.find((i) => i.id === openId) : undefined;
    if (newKind) {
      setFormValues(emptyRecurring(newKind, prefs, accounts));
      setFormOpen(true);
      setUrlDriven(true);
    } else if (it) {
      setFormValues(itemToValues(it));
      setFormOpen(true);
      setUrlDriven(true);
    } else if (openId) setMissing(true);
  }
  React.useEffect(() => {
    if (!missing) return;
    toast.error("That recurring item wasn't found.");
    router.replace("/recurring", { scroll: false });
  }, [missing, router]);

  const onFormOpenChange = (o: boolean) => {
    setFormOpen(o);
    if (!o && urlDriven) {
      setUrlDriven(false);
      router.replace("/recurring", { scroll: false });
    }
  };

  const run = async (p: Promise<{ ok: boolean; error?: string }>, success: string) => {
    const r = await p;
    if (!r.ok) toast.error((r as { error: string }).error);
    else toast.success(success);
  };
  const actions: RowActions = {
    onEdit: openEdit,
    onPay: (item, occurrence) => setPay({ item, occurrence }),
    onSkip: (item) => void run(skipOccurrenceAction(item.id), `Skipped ${item.name}${item.nextDate ? ` on ${formatDate(item.nextDate, "d MMM")}` : ""}`),
    onStatus: (item, status) =>
      void run(
        setRecurringStatusAction({ id: item.id, status }),
        status === "paused"
          ? `${item.name} paused`
          : status === "cancelled"
            ? item.kind === "subscription"
              ? `${item.name} marked cancelled`
              : `Stopped tracking ${item.name}`
            : `${item.name} is active again`,
      ),
    onDelete: setConfirm,
  };

  const byKind = (kinds: RecurringKindId[]) => items.filter((i) => kinds.includes(i.kind));
  const outNext30 = add(...upcoming.filter((o) => isOut(o.kind) && o.baseAmount).map((o) => o.baseAmount!));
  const inNext30 = add(...upcoming.filter((o) => o.kind === "income" && o.baseAmount).map((o) => o.baseAmount!));
  const overdueCount = upcoming.filter((o) => o.status === "overdue").length;
  const subs = byKind(["subscription"]);
  const changeById = new Map(priceChanges.map((p) => [p.recurringId, p]));
  const trialsSoon = subs.filter(
    (s) => s.status === "active" && s.trialEndsAt && s.trialEndsAt >= prefs.today && daysBetween(prefs.today, s.trialEndsAt) <= 14,
  );

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus /> Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {(["bill", "subscription", "income", "expense", "transfer"] as const).map((k) => {
          const I = KIND_ICON[k];
          return (
            <DropdownMenuItem key={k} onSelect={() => openNew(k)}>
              <I /> {KIND_LABEL[k]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const unconverted = [...new Set([...costs.subscriptions.unconvertedCurrencies, ...upcoming.filter((o) => !o.baseAmount).map((o) => o.currency)])];

  return (
    <>
      <PageHeader title="Bills & recurring" description="Bills, subscriptions and paydays — what's due, what it costs, and what's changed." actions={addMenu} />

      {items.length > 0 && (
        <Card className="mb-5 grid grid-cols-2 divide-x divide-y sm:grid-cols-4 sm:divide-y-0">
          <div className="px-4 py-3 sm:px-5">
            <p className="text-[12.5px] text-muted-foreground">Due next 30 days</p>
            <p className="mt-0.5 text-lg font-semibold">
              <Money amount={outNext30} />
            </p>
          </div>
          <div className="px-4 py-3 sm:px-5">
            <p className="text-[12.5px] text-muted-foreground">Income next 30 days</p>
            <p className="mt-0.5 text-lg font-semibold">
              <Money amount={inNext30} />
            </p>
          </div>
          <div className="px-4 py-3 sm:px-5">
            <p className="text-[12.5px] text-muted-foreground">Subscriptions</p>
            <p className="mt-0.5 text-lg font-semibold">
              <Money amount={costs.subscriptions.monthly} />
              <span className="text-[13px] font-normal text-muted-foreground">/mo</span>
            </p>
          </div>
          <div className="px-4 py-3 sm:px-5">
            <p className="text-[12.5px] text-muted-foreground">Overdue</p>
            <p className={cn("mt-0.5 flex items-center gap-1 text-lg font-semibold", overdueCount > 0 && "text-negative")}>
              {overdueCount > 0 && <CircleAlert className="size-4" aria-hidden />}
              {overdueCount}
            </p>
          </div>
        </Card>
      )}
      {unconverted.length > 0 && (
        <p className="-mt-3 mb-4 px-1 text-[12.5px] text-muted-foreground">
          Totals exclude items in {unconverted.join(", ")} — add an exchange rate in Settings to include them.
        </p>
      )}

      <Suggestions
        suggestions={suggestions}
        onCustomize={(s) =>
          openNew(s.fixedAmount ? "subscription" : "bill", {
            name: s.merchantName,
            merchant: s.merchantName,
            amount: toInputValue(s.typicalAmount),
            accountId: s.accountId,
            categoryId: s.categoryId ?? "",
            frequency: s.frequency,
            startDate: s.lastDate,
          })
        }
      />

      <Tabs value={tab} onValueChange={(t) => setTab(t as TabId)}>
        <div className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList aria-label="Recurring views">
            <TabsTrigger value="upcoming">
              Upcoming{overdueCount > 0 && <span className="num rounded-full bg-negative-soft px-1.5 text-[11px] text-negative">{overdueCount}</span>}
            </TabsTrigger>
            <TabsTrigger value="bills">Bills</TabsTrigger>
            <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
            <TabsTrigger value="income">Income</TabsTrigger>
            <TabsTrigger value="other">Other</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="upcoming">
          <UpcomingTab occurrences={upcoming} items={items} a={actions} onNew={() => openNew("bill")} />
        </TabsContent>

        <TabsContent value="bills" className="grid gap-3">
          {costs.bills.count > 0 && (
            <p className="px-1 text-sm text-muted-foreground">
              {pluralize(costs.bills.count, "active bill")} · about <Money amount={costs.bills.monthly} className="text-foreground" /> a month
            </p>
          )}
          <ItemList
            items={byKind(["bill"])}
            a={actions}
            empty={
              <EmptyState
                icon={<Receipt />}
                title="No bills yet"
                description="Rent, utilities, phone, insurance — add them once and get reminded before they're due."
                action={
                  <Button onClick={() => openNew("bill")}>
                    <Plus /> Add a bill
                  </Button>
                }
              />
            }
          />
        </TabsContent>

        <TabsContent value="subscriptions" className="grid gap-3">
          {costs.subscriptions.count > 0 && (
            <Card className="flex flex-wrap items-end justify-between gap-3 px-5 py-4">
              <div>
                <p className="text-[13px] text-muted-foreground">{pluralize(costs.subscriptions.count, "active subscription")}</p>
                <p className="mt-0.5 text-[26px] font-semibold tracking-tight">
                  <Money amount={costs.subscriptions.monthly} />
                  <span className="text-base font-normal text-muted-foreground"> / month</span>
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                <Money amount={costs.subscriptions.yearly} className="font-medium text-foreground" /> a year
              </p>
            </Card>
          )}
          {(priceChanges.length > 0 || trialsSoon.length > 0) && (
            <Card className="overflow-hidden border-warning/40">
              <ul className="divide-y">
                {priceChanges.map((p) => {
                  const up = cmp(p.difference, "0") > 0;
                  return (
                    <li key={p.recurringId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5">
                      <TrendingUp className={cn("size-4 shrink-0", up ? "text-warning" : "rotate-180 text-positive")} aria-hidden />
                      <p className="min-w-0 flex-1 text-sm">
                        <span className="font-medium">{p.name}</span> charged <Money amount={p.charged} currency={p.currency} /> on{" "}
                        {formatDate(p.date, "d MMM")} — tracked at <Money amount={p.expected} currency={p.currency} /> ({up ? "+" : "−"}
                        {Math.abs(Math.round(p.changePct * 100))}%)
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        onClick={() =>
                          void run(acceptPriceChangeAction({ id: p.recurringId, amount: p.charged }), `${p.name} updated to ${fmt(p.charged, p.currency)}`)
                        }
                      >
                        Update to <Money amount={p.charged} currency={p.currency} />
                      </Button>
                    </li>
                  );
                })}
                {trialsSoon.map((s) => (
                  <li key={`trial-${s.id}`} className="flex items-center gap-3 px-4 py-3 text-sm sm:px-5">
                    <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
                    <p className="min-w-0 flex-1">
                      <span className="font-medium">{s.name}</span> free trial ends {relativeDayLabel(s.trialEndsAt!, prefs.today).toLowerCase()} — then{" "}
                      <Money amount={s.amount} currency={s.currency} /> {describeRule(s).toLowerCase()}.
                    </p>
                    {s.serviceUrl && (
                      <Button size="sm" variant="ghost" asChild>
                        <a href={s.serviceUrl} target="_blank" rel="noopener noreferrer">
                          Manage <ExternalLink />
                        </a>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <ItemList
            items={subs}
            a={actions}
            inactiveLabel="Cancelled"
            empty={
              <EmptyState
                icon={<Repeat />}
                title="No subscriptions tracked"
                description="See what your subscriptions really cost per month and per year, and catch price increases and trial endings."
                action={
                  <Button onClick={() => openNew("subscription")}>
                    <Plus /> Add a subscription
                  </Button>
                }
              />
            }
          />
          {subs.some((s) => s.status === "active") && changeById.size === 0 && trialsSoon.length === 0 && (
            <p className="px-1 text-[12.5px] text-muted-foreground">No price changes detected on your latest charges.</p>
          )}
        </TabsContent>

        <TabsContent value="income" className="grid gap-3">
          {costs.income.count > 0 && (
            <p className="px-1 text-sm text-muted-foreground">
              Expected take-home about <Money amount={costs.income.monthly} className="text-foreground" /> a month from{" "}
              {pluralize(costs.income.count, "schedule")}
            </p>
          )}
          <IncomeList items={byKind(["income"])} a={actions} onNew={() => openNew("income")} />
        </TabsContent>

        <TabsContent value="other">
          <ItemList
            items={byKind(["expense", "transfer"])}
            a={actions}
            empty={
              <EmptyState
                icon={<CalendarClock />}
                title="No other recurring items"
                description="Regular expenses like a gym membership, or automatic transfers into savings."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" onClick={() => openNew("transfer")}>
                      <ArrowLeftRight /> Recurring transfer
                    </Button>
                    <Button onClick={() => openNew("expense")}>
                      <Plus /> Recurring expense
                    </Button>
                  </div>
                }
              />
            }
          />
        </TabsContent>
      </Tabs>

      <RecurringDialog open={formOpen} onOpenChange={onFormOpenChange} initial={formValues} />
      <MarkPaidDialog target={pay} onOpenChange={(o) => !o && setPay(null)} />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete “${confirm?.name ?? ""}”?`}
        description="The schedule is removed. Transactions already recorded from it stay in your history. To keep the record, mark it cancelled instead."
        onConfirm={async () => {
          if (!confirm) return;
          const r = await deleteRecurringAction(confirm.id);
          if (!r.ok) return void toast.error(r.error);
          toast.success(`${confirm.name} deleted`);
          setConfirm(null);
        }}
      />
    </>
  );
}

function IncomeList({ items, a, onNew }: { items: RecurringItem[]; a: RowActions; onNew: () => void }) {
  const [showInactive, setShowInactive] = React.useState(false);
  const live = items.filter((i) => i.status === "active" || i.status === "paused");
  const gone = items.filter((i) => i.status === "cancelled" || i.status === "ended");
  if (!items.length)
    return (
      <Card>
        <EmptyState
          icon={<Briefcase />}
          title="No income schedules"
          description="Add your salary or regular freelance income, optionally with gross pay, taxes and deductions, to see paydays ahead."
          action={
            <Button onClick={onNew}>
              <Plus /> Add income
            </Button>
          }
        />
      </Card>
    );
  return (
    <div className="grid gap-3">
      {live.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {live.map((i) => (
              <ItemRow key={i.id} item={i} a={a}>
                {i.employer && <p className="mt-1 text-[12.5px] text-muted-foreground">From {i.employer}</p>}
                <IncomeBreakdownView item={i} />
                {i.status === "active" && i.nextDate && (
                  <Button size="sm" variant="outline" className="mt-2.5" onClick={() => a.onPay(i, i.nextDate!)}>
                    <Check /> Mark received
                  </Button>
                )}
              </ItemRow>
            ))}
          </ul>
        </Card>
      )}
      {gone.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowInactive((s) => !s)}
            aria-expanded={showInactive}
            className="flex h-10 items-center gap-1 px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-4 transition-transform", showInactive && "rotate-180")} aria-hidden />
            Ended ({gone.length})
          </button>
          {showInactive && (
            <Card className="mt-1 overflow-hidden">
              <ul className="divide-y">
                {gone.map((i) => (
                  <ItemRow key={i.id} item={i} a={a} />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
