"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight, CheckCircle2, Database, FileJson, FileSpreadsheet, FileUp, History, Undo2, Upload } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/user-context";
import { undoImportAction } from "./actions";
import { SettingsSection } from "../section";

type Batch = { id: string; filename: string | null; rowCount: number; importedCount: number; skippedCount: number; createdAt: string; undoneAt: string | null };
type Counts = { accounts: number; categories: number; transactions: number; budgets: number; goals: number; recurring: number };
type Summary = { mode: string; accounts: number; categories: number; transactions: number; skippedTransactions: number; budgets: number; goals: number; recurring: number };

const MAX_BYTES = 10 * 1024 * 1024;

export function DataManager({ counts, batches }: { counts: Counts; batches: Batch[] }) {
  return (
    <div>
      <ExportSection counts={counts} />
      <ImportSection batches={batches} />
      <RestoreSection counts={counts} />
    </div>
  );
}

function ExportSection({ counts }: { counts: Counts }) {
  return (
    <SettingsSection id="export" title="Export" description="Your data is yours. Take it anywhere.">
      <Card className="divide-y">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <FileJson className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">Full backup (JSON)</p>
              <p className="text-[13px] text-muted-foreground">
                Everything — {counts.accounts} accounts, {counts.transactions.toLocaleString()} transactions, categories, budgets, goals, recurring items and settings. Receipt images aren&apos;t included.
              </p>
            </div>
          </div>
          <a href="/api/export/backup" download className={cn(buttonVariants({ variant: "outline" }), "shrink-0")} onClick={() => toast("Preparing your backup…")}>
            Download backup
          </a>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <FileSpreadsheet className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">Transactions (CSV)</p>
              <p className="text-[13px] text-muted-foreground">For spreadsheets. To export a filtered list, use Export on the Transactions page.</p>
            </div>
          </div>
          <a href="/api/export/transactions" download className={cn(buttonVariants({ variant: "outline" }), "shrink-0")}>
            Export CSV
          </a>
        </div>
      </Card>
    </SettingsSection>
  );
}

function ImportSection({ batches }: { batches: Batch[] }) {
  const [undoing, setUndoing] = React.useState<Batch | null>(null);
  const [pending, start] = React.useTransition();
  const { prefs } = useAppData();
  const fmt = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(prefs.locale, { dateStyle: "medium", timeStyle: "short", timeZone: prefs.timezone }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16).replace("T", " ");
    }
  };
  return (
    <SettingsSection
      id="imports"
      title="Import"
      description="Bring in transactions from your bank's CSV export. Duplicates are detected and skipped."
      actions={
        <Link href="/import" className={buttonVariants({ variant: "default" })}>
          <Upload /> Import CSV
        </Link>
      }
    >
      <Card>
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <History className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-[13px] font-medium">Recent imports</h3>
        </div>
        {batches.length === 0 ? (
          <EmptyState icon={<FileUp />} title="No imports yet" description="Imports you run appear here, and can be undone in one click." />
        ) : (
          <ul className="divide-y">
            {batches.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{b.filename || "Untitled import"}</p>
                  <p className="text-[12.5px] text-muted-foreground">
                    {fmt(b.createdAt)} · {b.importedCount.toLocaleString()} imported
                    {b.skippedCount ? `, ${b.skippedCount.toLocaleString()} skipped` : ""}
                  </p>
                </div>
                {b.undoneAt ? (
                  <Badge>Undone</Badge>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setUndoing(b)}>
                    <Undo2 /> Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {undoing && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setUndoing(null)}
          title="Undo this import?"
          description={`This permanently deletes the ${undoing.importedCount.toLocaleString()} transaction${undoing.importedCount === 1 ? "" : "s"} created by “${undoing.filename || "this import"}”, including any edits you've made to them since.`}
          confirmLabel="Undo import"
          loading={pending}
          onConfirm={() =>
            start(async () => {
              const r = await undoImportAction({ batchId: undoing.id });
              if (r.ok) {
                toast.success(`Removed ${r.data.removed.toLocaleString()} imported transaction${r.data.removed === 1 ? "" : "s"}`);
                setUndoing(null);
              } else toast.error(r.error);
            })
          }
        />
      )}
    </SettingsSection>
  );
}

function RestoreSection({ counts }: { counts: Counts }) {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [mode, setMode] = React.useState<"merge" | "replace">("merge");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const canSubmit = Boolean(file) && (mode === "merge" || confirm.trim() === "REPLACE") && !busy;

  function pick(f: File | null) {
    setError(null);
    setSummary(null);
    if (f && f.size > MAX_BYTES) {
      setError("Backup files must be 10 MB or smaller.");
      setFile(null);
      return;
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", mode);
      fd.append("confirm", confirm);
      const r = await fetch("/api/backup/restore", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({ error: "The server returned an unexpected response." }));
      if (!r.ok) throw new Error(j.error ?? "Restore failed. Nothing was changed.");
      setSummary(j as Summary);
      setFile(null);
      setConfirm("");
      if (inputRef.current) inputRef.current.value = "";
      toast.success("Backup restored");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection id="restore" title="Restore from backup" description="Load a Kosh JSON backup. Everything happens in one step — if anything is wrong with the file, nothing changes.">
      <Card>
        <form onSubmit={submit} noValidate>
          <div className="grid gap-5 p-5">
            <Field label="Backup file" htmlFor="backup-file" hint="A .json file downloaded from “Download backup”, up to 10 MB.">
              <Input ref={inputRef} id="backup-file" type="file" accept="application/json,.json" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="pt-2 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium" />
            </Field>
            <div className="grid gap-2">
              <span className="text-[13px] font-medium">How to restore</span>
              <Segmented
                ariaLabel="Restore mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "merge", label: "Merge with my data" },
                  { value: "replace", label: "Replace my data" },
                ]}
                className="w-full sm:w-auto"
              />
              <p className="text-[13px] text-muted-foreground">
                {mode === "merge"
                  ? "Adds the backup to what you have. Accounts, categories, merchants and tags with the same name are reused, and identical transactions are skipped. Requires the same base currency."
                  : `Deletes your current ${counts.accounts} accounts, ${counts.transactions.toLocaleString()} transactions, budgets, goals, recurring items and receipts, then loads the backup — including its base currency and preferences.`}
              </p>
            </div>
            {mode === "replace" && (
              <div className="rounded-lg border border-negative/30 bg-negative-soft p-4">
                <Field label={<span className="text-negative">Type REPLACE to confirm</span>} htmlFor="replace-confirm">
                  <Input id="replace-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="sm:max-w-56" aria-describedby="replace-warning" />
                </Field>
                <p id="replace-warning" className="mt-2 text-[13px] text-negative">
                  This can&apos;t be undone. Download a backup of your current data first if you might need it.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
                {error}
              </p>
            )}
            {summary && (
              <div role="status" className="flex gap-2 rounded-lg bg-positive-soft px-4 py-3 text-[13px] text-positive">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  Restored {summary.transactions.toLocaleString()} transactions, {summary.accounts} accounts, {summary.categories} categories, {summary.budgets} budgets, {summary.goals} goals and {summary.recurring} recurring items
                  {summary.skippedTransactions ? ` (${summary.skippedTransactions.toLocaleString()} duplicate transactions skipped)` : ""}.
                </p>
              </div>
            )}
          </div>
          <CardFooter className="justify-between gap-3">
            <Link href="/settings/security#delete" className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
              Delete account <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
            <Button type="submit" variant={mode === "replace" ? "destructive" : "default"} loading={busy} disabled={!canSubmit}>
              <Database /> {mode === "replace" ? "Replace & restore" : "Restore backup"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </SettingsSection>
  );
}
