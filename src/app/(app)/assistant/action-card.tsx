"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, CircleSlash, Clock, Pencil, PiggyBank, Plus, Target, Trash2, TriangleAlert, Undo2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/controls";
import { cn } from "@/lib/utils";
import { restoreTransactionsAction } from "@/app/(app)/transactions/actions";
import type { ActionCard } from "@/server/ai/ai-actions";
import { cancelAiActionAction, confirmAiActionAction } from "./actions";

const TYPE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  add_transaction: { label: "Add transaction", icon: Plus },
  create_budget: { label: "Create budget", icon: Wallet },
  create_goal: { label: "Create goal", icon: Target },
  add_goal_contribution: { label: "Goal contribution", icon: PiggyBank },
  update_transaction: { label: "Edit transaction", icon: Pencil },
  delete_transactions: { label: "Delete transactions", icon: Trash2 },
};

function resultLink(card: ActionCard): { href: string; label: string } | null {
  const r = card.result ?? {};
  if (typeof r.transactionId === "string") return { href: `/transactions?open=${r.transactionId}`, label: "View transaction" };
  if (typeof r.budgetId === "string") return { href: "/budgets", label: "View budgets" };
  if (typeof r.goalId === "string") return { href: `/goals?open=${r.goalId}`, label: "View goal" };
  if (typeof r.contributionId === "string") return { href: "/goals", label: "View goals" };
  return null;
}

/** Re-render every 20s so a card flips to "expired" without a reload. */
function useNow(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ActionCardView({ card, onChange }: { card: ActionCard; onChange: (c: ActionCard) => void }) {
  const meta = TYPE_META[card.actionType] ?? { label: "Suggested change", icon: Pencil };
  const Icon = meta.icon;
  const now = useNow(card.status === "pending");
  const expired = card.status === "expired" || (card.status === "pending" && new Date(card.expiresAt).getTime() <= now);
  const status = expired ? "expired" : card.status;
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [busy, setBusy] = React.useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const ackId = React.useId();

  async function run(kind: "confirm" | "cancel") {
    setBusy(kind);
    setError(null);
    const r = kind === "confirm" ? await confirmAiActionAction(card.id) : await cancelAiActionAction(card.id);
    setBusy(null);
    if (r.ok) {
      onChange(r.data);
      if (kind === "confirm") {
        const undoIds = Array.isArray(r.data.result?.ids) ? (r.data.result!.ids as string[]) : null;
        toast.success(card.destructive ? "Deleted" : "Done", {
          action: undoIds
            ? {
                label: "Undo",
                onClick: async () => {
                  const u = await restoreTransactionsAction(undoIds);
                  if (u.ok) toast.success("Restored");
                  else toast.error(u.error);
                },
              }
            : undefined,
        });
      }
    } else {
      setError(r.error);
      if (r.code === "VALIDATION" && /expired/i.test(r.error)) onChange({ ...card, status: "expired" });
      if (r.code === "CONFLICT" || r.code === "NOT_FOUND") onChange({ ...card, status: "failed", result: { error: r.error } });
    }
  }

  const link = status === "confirmed" ? resultLink(card) : null;
  const undoIds = status === "confirmed" && Array.isArray(card.result?.ids) ? (card.result!.ids as string[]) : null;

  return (
    <section
      aria-label={`Suggested change: ${meta.label}`}
      className={cn(
        "grid gap-3 rounded-xl border bg-card p-3.5 shadow-xs",
        card.destructive && status === "pending" && "border-negative/40 bg-negative-soft/40",
        status !== "pending" && "opacity-90",
      )}
    >
      <header className="flex items-start gap-2.5">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", card.destructive ? "bg-negative-soft text-negative" : "bg-accent-soft text-accent")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[13px] font-medium text-muted-foreground">{meta.label}</p>
            {status === "pending" && <Badge variant={card.destructive ? "negative" : "outline"}>{card.destructive ? "Needs confirmation · destructive" : "Needs confirmation"}</Badge>}
            {status === "confirmed" && (
              <Badge variant="positive">
                <Check /> Done
              </Badge>
            )}
            {status === "cancelled" && (
              <Badge>
                <CircleSlash /> Cancelled
              </Badge>
            )}
            {status === "expired" && (
              <Badge variant="warning">
                <Clock /> Expired
              </Badge>
            )}
            {status === "failed" && (
              <Badge variant="negative">
                <TriangleAlert /> Not done
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[14px] font-medium">{card.summary}</p>
        </div>
      </header>

      {card.details.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-subtle px-3 py-2 text-[13px]">
          {card.details.map((d, i) => (
            <React.Fragment key={i}>
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd className="num min-w-0 break-words">{d.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}

      {status === "pending" && (
        <div className="grid gap-2.5">
          {card.destructive && (
            <label htmlFor={ackId} className="flex items-start gap-2 text-[13px]">
              <Checkbox id={ackId} checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} className="mt-0.5" />
              <span>I understand this will delete these transactions. (You can undo right after.)</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={card.destructive ? "destructive" : "default"}
              loading={busy === "confirm"}
              disabled={Boolean(busy) || (card.destructive && !acknowledged)}
              onClick={() => void run("confirm")}
            >
              {card.destructive ? <Trash2 /> : <Check />}
              {card.destructive ? "Delete" : "Confirm"}
            </Button>
            <Button size="sm" variant="ghost" loading={busy === "cancel"} disabled={Boolean(busy)} onClick={() => void run("cancel")}>
              Cancel
            </Button>
            <span className="ml-auto text-[12px] text-muted-foreground">
              Expires at {new Date(card.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        </div>
      )}

      {(link || undoIds) && (
        <div className="flex flex-wrap items-center gap-2">
          {link && (
            <Button asChild size="sm" variant="outline">
              <Link href={link.href}>{link.label}</Link>
            </Button>
          )}
          {undoIds && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const u = await restoreTransactionsAction(undoIds);
                if (u.ok) toast.success(`Restored ${u.data.count}`);
                else toast.error(u.error);
              }}
            >
              <Undo2 /> Undo delete
            </Button>
          )}
        </div>
      )}
      {status === "expired" && <p className="text-[13px] text-muted-foreground">This suggestion expired. Ask the assistant again if you still want it.</p>}
      {(error || (status === "failed" && typeof card.result?.error === "string")) && (
        <p role="alert" className="text-[13px] text-negative">
          {error ?? String(card.result?.error)}
        </p>
      )}
    </section>
  );
}
