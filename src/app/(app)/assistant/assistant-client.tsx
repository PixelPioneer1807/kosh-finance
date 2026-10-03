"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowUp, Database, History, Loader2, MessageSquarePlus, MoreHorizontal, Pencil, RotateCcw, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { Markdown } from "@/components/app/markdown";
import { cn } from "@/lib/utils";
import type { ConversationSummary, MessageDTO, ToolTraceEntry } from "@/server/ai/assistant";
import type { ActionCard } from "@/server/ai/ai-actions";
import { deleteConversationAction, getConversationAction, renameConversationAction, sendMessageAction } from "./actions";
import { ActionCardView } from "./action-card";

export const SUGGESTED_PROMPTS = [
  "Where did my money go this month?",
  "How much did I spend on food?",
  "Compare this month with last month",
  "How much can I safely spend?",
  "What bills are coming up?",
  "When will I reach my goal?",
  "What happens if I reduce dining by 20%?",
];

const PHASES = ["Thinking…", "Looking at your transactions…", "Crunching the numbers…", "Writing the answer…"];
const MAX_LEN = 2000;

type UIMessage = MessageDTO & { failed?: { error: string; code?: string } };

type Initial = { id: string; title: string; messages: MessageDTO[]; actions: ActionCard[] } | null;

function relTime(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof a.from === "string" || typeof a.to === "string") parts.push(`${a.from ?? "…"} → ${a.to ?? "…"}`);
  for (const [k, v] of Object.entries(a)) {
    if (k === "from" || k === "to" || v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${String(v).slice(0, 40)}`);
    else if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
    else if (typeof v === "object" && "from" in (v as object)) parts.push(`${k}: ${(v as { from: string }).from} → ${(v as { to: string }).to}`);
  }
  return parts.join(" · ");
}

function DataUsed({ trace }: { trace: ToolTraceEntry[] }) {
  if (!trace.length) return null;
  const unique = trace.filter((t, i) => trace.findIndex((x) => x.name === t.name && JSON.stringify(x.args) === JSON.stringify(t.args)) === i);
  return (
    <details className="group mt-2 text-[12.5px] text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Database className="size-3.5" aria-hidden />
        Data used · {unique.length} {unique.length === 1 ? "source" : "sources"}
      </summary>
      <ul className="mt-1 grid gap-1 border-l pl-3">
        {unique.map((t, i) => (
          <li key={i} className="flex flex-wrap gap-x-2">
            <span className={cn("font-medium text-foreground", t.ok === false && "text-muted-foreground line-through")}>{t.label ?? t.name}</span>
            <span className="num">{argSummary(t.args)}</span>
            {t.ok === false && <span>(no data)</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (c: ConversationSummary) => void;
  onDelete: (c: ConversationSummary) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Button variant="outline" onClick={onNew} className="justify-start">
        <MessageSquarePlus /> New chat
      </Button>
      {conversations.length === 0 ? (
        <p className="px-2 py-4 text-[13px] text-muted-foreground">Your conversations will appear here.</p>
      ) : (
        <nav aria-label="Conversations" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <ul className="grid gap-0.5">
            {conversations.map((c) => (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={c.id === activeId ? "page" : undefined}
                  className={cn(
                    "flex min-h-10 w-full flex-col items-start rounded-md px-2.5 py-1.5 pr-9 text-left transition hover:bg-muted",
                    c.id === activeId && "bg-muted",
                  )}
                >
                  <span className="line-clamp-1 text-[13.5px] font-medium">{c.title}</span>
                  <span className="text-[11.5px] text-muted-foreground">{relTime(c.updatedAt)}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Options for ${c.title}`}
                      className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => onRename(c)}>
                      <Pencil /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive onSelect={() => onDelete(c)}>
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

export function AssistantClient({
  initialConversations,
  initial,
  prefill,
  usage,
}: {
  initialConversations: ConversationSummary[];
  initial: Initial;
  prefill: string;
  usage: { used: number; limit: number };
}) {
  const [conversations, setConversations] = React.useState(initialConversations);
  const [activeId, setActiveId] = React.useState<string | null>(initial?.id ?? null);
  const [messages, setMessages] = React.useState<UIMessage[]>(initial?.messages ?? []);
  const [actions, setActions] = React.useState<ActionCard[]>(initial?.actions ?? []);
  const [draft, setDraft] = React.useState(prefill);
  const [sending, setSending] = React.useState(false);
  const [phase, setPhase] = React.useState(0);
  const [loadingConv, setLoadingConv] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState<ConversationSummary | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleting, setDeleting] = React.useState<ConversationSummary | null>(null);
  const [requestsUsed, setRequestsUsed] = React.useState(usage.used);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const tempSeq = React.useRef(0);

  const scrollToEnd = React.useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
  }, []);

  React.useEffect(scrollToEnd, [messages.length, sending, scrollToEnd]);

  React.useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => setPhase((p) => Math.min(p + 1, PHASES.length - 1)), 2200);
    return () => clearInterval(t);
  }, [sending]);

  React.useEffect(() => {
    if (prefill) inputRef.current?.focus();
  }, [prefill]);

  function setUrl(id: string | null) {
    const url = id ? `/assistant?c=${id}` : "/assistant";
    window.history.replaceState(window.history.state, "", url);
  }

  async function openConversation(id: string) {
    setHistoryOpen(false);
    if (id === activeId || sending) return;
    setLoadingConv(true);
    const r = await getConversationAction(id);
    setLoadingConv(false);
    if (!r.ok) {
      toast.error(r.error);
      if (r.code === "NOT_FOUND") setConversations((cs) => cs.filter((c) => c.id !== id));
      return;
    }
    setActiveId(r.data.id);
    setMessages(r.data.messages);
    setActions(r.data.actions);
    setUrl(r.data.id);
  }

  function newChat() {
    setHistoryOpen(false);
    if (sending) return;
    setActiveId(null);
    setMessages([]);
    setActions([]);
    setUrl(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function send(textArg?: string, retryOf?: string) {
    const text = (textArg ?? draft).trim();
    if (!text || sending) return;
    if (text.length > MAX_LEN) {
      toast.error(`Keep messages under ${MAX_LEN} characters.`);
      return;
    }
    const tempId = `temp-${++tempSeq.current}`;
    setMessages((m) => [...m.filter((x) => x.id !== retryOf), { id: tempId, role: "user", content: text, toolTrace: null, createdAt: "" }]);
    if (!textArg) setDraft("");
    setPhase(0);
    setSending(true);
    const r = await sendMessageAction({ conversationId: activeId, message: text });
    setSending(false);
    if (!r.ok) {
      setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, failed: { error: r.error, code: r.code } } : x)));
      return;
    }
    const d = r.data;
    setRequestsUsed(d.usage.used);
    setMessages((m) => [...m.map((x) => (x.id === tempId ? d.userMessage : x)), d.message]);
    setActions((a) => [...a, ...d.actions]);
    if (!activeId) {
      setActiveId(d.conversationId);
      setUrl(d.conversationId);
    }
    setConversations((cs) => [{ id: d.conversationId, title: cs.find((c) => c.id === d.conversationId)?.title ?? d.title, updatedAt: d.message.createdAt }, ...cs.filter((c) => c.id !== d.conversationId)]);
  }

  async function doRename() {
    if (!renaming) return;
    const title = renameValue.trim();
    if (!title) return;
    const r = await renameConversationAction({ id: renaming.id, title });
    if (!r.ok) return void toast.error(r.error);
    setConversations((cs) => cs.map((c) => (c.id === renaming.id ? { ...c, title } : c)));
    setRenaming(null);
  }

  async function doDelete() {
    if (!deleting) return;
    const r = await deleteConversationAction(deleting.id);
    if (!r.ok) return void toast.error(r.error);
    setConversations((cs) => cs.filter((c) => c.id !== deleting.id));
    if (deleting.id === activeId) newChat();
    setDeleting(null);
    toast.success("Conversation deleted");
  }

  const updateAction = (card: ActionCard) => setActions((a) => a.map((x) => (x.id === card.id ? { ...x, ...card } : x)));
  const activeTitle = conversations.find((c) => c.id === activeId)?.title;
  const remaining = Math.max(0, usage.limit - requestsUsed);

  const listProps = {
    conversations,
    activeId,
    onSelect: (id: string) => void openConversation(id),
    onNew: newChat,
    onRename: (c: ConversationSummary) => {
      setHistoryOpen(false);
      setRenameValue(c.title);
      setRenaming(c);
    },
    onDelete: (c: ConversationSummary) => {
      setHistoryOpen(false);
      setDeleting(c);
    },
  };

  return (
    <div className="flex h-[calc(100dvh-13.5rem)] min-h-[440px] gap-4 lg:h-[calc(100dvh-11.5rem)]">
      <aside className="hidden w-64 shrink-0 flex-col lg:flex" aria-label="Conversation history">
        <ConversationList {...listProps} />
      </aside>

      <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 lg:px-4">
          <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Conversation history" onClick={() => setHistoryOpen(true)}>
            <History />
          </Button>
          <p className="min-w-0 flex-1 truncate text-[14px] font-medium">{activeTitle ?? "New conversation"}</p>
          {loadingConv && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading conversation" />}
          <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="New chat" onClick={newChat}>
            <MessageSquarePlus />
          </Button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5" aria-live="polite" aria-busy={sending || loadingConv}>
          {messages.length === 0 && !sending ? (
            <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-5 py-6 text-center">
              <span className="grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
                <Sparkles className="size-5" />
              </span>
              <div>
                <h2 className="text-[17px] font-semibold tracking-tight">Ask about your money</h2>
                <p className="mt-1 text-sm text-muted-foreground">Answers come only from your own transactions, budgets, bills and goals. Any change it suggests waits for your confirmation.</p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => void send(p)}
                    className="min-h-10 rounded-full border bg-card px-3.5 py-2 text-[13px] text-muted-foreground shadow-xs transition hover:border-border-strong hover:text-foreground"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="mx-auto grid max-w-3xl gap-5">
              {messages.map((m) =>
                m.role === "user" ? (
                  <li key={m.id} className="flex flex-col items-end gap-1.5">
                    <div className={cn("max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[14.5px] whitespace-pre-wrap break-words", m.failed && "opacity-70")}>{m.content}</div>
                    {m.failed && (
                      <div role="alert" className={cn("flex max-w-[85%] flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]", m.failed.code === "RATE_LIMITED" ? "bg-warning-soft text-warning" : "bg-negative-soft text-negative")}>
                        <TriangleAlert className="size-4 shrink-0" />
                        <span>{m.failed.error}</span>
                        {m.failed.code !== "FORBIDDEN" && (
                          <Button size="sm" variant="outline" className="h-7" onClick={() => void send(m.content, m.id)} disabled={sending}>
                            <RotateCcw /> Retry
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ) : (
                  <li key={m.id} className="flex gap-3">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent" aria-hidden>
                      <Sparkles className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="sr-only">Assistant:</span>
                      <Markdown content={m.content} />
                      {m.toolTrace && <DataUsed trace={m.toolTrace} />}
                      {actions.some((a) => a.messageId === m.id) && (
                        <div className="mt-3 grid gap-2.5">
                          {actions
                            .filter((a) => a.messageId === m.id)
                            .map((a) => (
                              <ActionCardView key={a.id} card={a} onChange={updateAction} />
                            ))}
                        </div>
                      )}
                    </div>
                  </li>
                ),
              )}
              {sending && (
                <li className="flex gap-3" role="status">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent" aria-hidden>
                    <Loader2 className="size-3.5 animate-spin" />
                  </span>
                  <p className="pt-1 text-[14px] text-muted-foreground">{PHASES[phase]}</p>
                </li>
              )}
            </ol>
          )}
        </div>

        <form
          className="shrink-0 border-t bg-card p-3 sm:px-5"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="mx-auto max-w-3xl">
            <div className="relative">
              <label htmlFor="assistant-input" className="sr-only">
                Message the assistant
              </label>
              <Textarea
                id="assistant-input"
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                maxLength={MAX_LEN}
                placeholder="Ask anything about your finances…"
                className="max-h-40 min-h-11 resize-none py-2.5 pr-12 [field-sizing:content]"
              />
              <Button type="submit" size="icon-sm" className="absolute right-1.5 bottom-1.5" aria-label="Send" disabled={!draft.trim() || sending}>
                {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              </Button>
            </div>
            <p className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-[11.5px] text-muted-foreground">
              <span>AI can make mistakes — numbers come from your data, but check before acting.</span>
              <span className="num">{remaining} AI requests left today</span>
            </p>
          </div>
        </form>
      </Card>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent title="Conversations" size="sm">
          <div className="flex max-h-[60dvh] flex-col">
            <ConversationList {...listProps} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renaming)} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent title="Rename conversation" size="sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void doRename();
            }}
          >
            <label htmlFor="conv-title" className="sr-only">
              Title
            </label>
            <Input id="conv-title" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={80} autoFocus />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this conversation?"
        description={`"${deleting?.title ?? ""}" and its messages will be removed. Changes you already confirmed stay.`}
        onConfirm={doDelete}
      />
    </div>
  );
}
