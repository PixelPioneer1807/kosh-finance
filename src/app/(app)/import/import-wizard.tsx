"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Copy, Download, FileSpreadsheet, Info, RotateCcw, Upload, XCircle } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Segmented, Switch } from "@/components/ui/controls";
import { Progress } from "@/components/ui/misc";
import { useAppData, useMoney, type ClientCategory } from "@/components/app/user-context";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/dates";
import {
  DATE_FORMATS,
  IMPORT_CHUNK_SIZE,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  detectDateFormat,
  detectDecimalSeparator,
  duplicateKey,
  guessMapping,
  interpretRow,
  parseCsvText,
  type DateFormat,
  type DecimalSeparator,
  type ImportMapping,
  type InterpretedRow,
} from "@/lib/csv-import";
import { checkDuplicatesAction, finishImportAction, importChunkAction, startImportAction } from "./actions";

type Step = "upload" | "map" | "preview" | "importing" | "done";
type Parsed = { filename: string; headers: string[]; rows: string[][]; delimiter: string; errors: string[]; hasHeader: boolean; text: string };
type FieldKey = keyof ImportMapping;
type Status = "ok" | "error" | "dup-file" | "dup-existing";
type PreviewRow = InterpretedRow & { line: number; index: number; status: Status; accountId: string | null; accountLabel: string; categoryLabel: string; categoryNew: boolean };
type Result = { imported: number; duplicates: number; errors: number; rows: { line: number; status: string; message?: string }[] };

const FIELDS: { key: FieldKey; label: string; hint?: string }[] = [
  { key: "date", label: "Date" },
  { key: "description", label: "Description", hint: "Becomes the merchant" },
  { key: "merchant", label: "Merchant / payee", hint: "If separate from description" },
  { key: "category", label: "Category", hint: "Matched by name, e.g. Food › Groceries" },
  { key: "account", label: "Account", hint: "Matched to your accounts by name" },
  { key: "notes", label: "Notes" },
  { key: "type", label: "Type", hint: "Expense / income / debit / credit" },
];

const EMPTY_MAPPING: ImportMapping = { date: 0, amount: null, debit: null, credit: null, description: null, merchant: null, category: null, account: null, notes: null, type: null };
const lineOf = (index: number, hasHeader: boolean) => index + (hasHeader ? 2 : 1);

function resolveCategory(categories: ClientCategory[], kind: "expense" | "income", ref: { parent: string | null; name: string } | null) {
  if (!ref) return null;
  const l = (s: string) => s.trim().toLowerCase();
  const same = categories.filter((c) => c.kind === kind);
  if (ref.parent) {
    const p = same.find((c) => !c.parentId && l(c.name) === l(ref.parent!));
    const child = p && same.find((c) => c.parentId === p.id && l(c.name) === l(ref.name));
    if (child) return child;
    const kids = same.filter((c) => c.parentId && l(c.name) === l(ref.name));
    return kids.length === 1 ? kids[0] : null;
  }
  const top = same.find((c) => !c.parentId && l(c.name) === l(ref.name));
  if (top) return top;
  const kids = same.filter((c) => c.parentId && l(c.name) === l(ref.name));
  return kids.length === 1 ? kids[0] : null;
}

export function ImportWizard() {
  const { accounts: allAccounts, categories, prefs } = useAppData();
  const fmtMoney = useMoney();
  const accounts = allAccounts.filter((a) => !a.isArchived);
  const [step, setStep] = React.useState<Step>("upload");
  const [parsed, setParsed] = React.useState<Parsed | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [mapping, setMapping] = React.useState<ImportMapping>(EMPTY_MAPPING);
  const [amountMode, setAmountMode] = React.useState<"signed" | "split">("signed");
  const [signConvention, setSignConvention] = React.useState<"negative_expense" | "positive_expense">("negative_expense");
  const [dateOverride, setDateOverride] = React.useState<DateFormat | null>(null);
  const [decimalOverride, setDecimalOverride] = React.useState<DecimalSeparator | null>(null);
  const [accountId, setAccountId] = React.useState(prefs.defaultAccountId && accounts.some((a) => a.id === prefs.defaultAccountId) ? prefs.defaultAccountId : (accounts[0]?.id ?? ""));
  const [defaultExpense, setDefaultExpense] = React.useState("");
  const [defaultIncome, setDefaultIncome] = React.useState("");
  const [createCategories, setCreateCategories] = React.useState(false);
  const [existingDupLines, setExistingDupLines] = React.useState<Set<number>>(new Set());
  const [checkingDups, setCheckingDups] = React.useState(false);
  const [forced, setForced] = React.useState<Set<number>>(new Set());
  const [filter, setFilter] = React.useState<"all" | "error" | "dup">("all");
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [result, setResult] = React.useState<Result | null>(null);
  const [fatal, setFatal] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  /* ── Step 1: file ── */

  function loadText(filename: string, text: string, hasHeader = true) {
    const r = parseCsvText(text, { hasHeader });
    if (!r.rows.length) {
      setUploadError("That file has no data rows.");
      return;
    }
    if (r.rows.length > MAX_IMPORT_ROWS) {
      setUploadError(`That file has ${r.rows.length.toLocaleString()} rows. Import up to ${MAX_IMPORT_ROWS.toLocaleString()} at a time — split it into smaller files.`);
      return;
    }
    const g = guessMapping(hasHeader ? r.headers : []);
    setParsed({ filename, ...r, hasHeader, text });
    setMapping({ ...EMPTY_MAPPING, ...Object.fromEntries(Object.entries(g).filter(([, v]) => v !== null && v !== undefined)), date: g.date ?? 0 });
    setAmountMode(g.amount === null && (g.debit !== null || g.credit !== null) ? "split" : "signed");
    setDateOverride(null);
    setDecimalOverride(null);
    setForced(new Set());
    setUploadError(null);
    setStep("map");
  }

  async function onFile(file: File | undefined | null) {
    if (!file) return;
    setUploadError(null);
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setUploadError("CSV files must be 5 MB or smaller.");
      return;
    }
    if (!/\.(csv|txt|tsv)$/i.test(file.name) && file.type && !/csv|text|excel/.test(file.type)) {
      setUploadError("Choose a .csv file. Export your statement as CSV from your bank or spreadsheet.");
      return;
    }
    try {
      loadText(file.name, await file.text());
    } catch {
      setUploadError("Couldn't read that file.");
    }
  }

  /* ── Step 2: detection ── */

  const column = React.useCallback((i: number | null) => (parsed && i !== null ? parsed.rows.map((r) => r[i] ?? "") : []), [parsed]);
  const detectedDate = React.useMemo(() => detectDateFormat(column(mapping.date)), [column, mapping.date]);
  const detectedDecimal = React.useMemo(
    () => detectDecimalSeparator([...column(mapping.amount), ...column(mapping.debit), ...column(mapping.credit)]),
    [column, mapping.amount, mapping.debit, mapping.credit],
  );
  const dateFormat: DateFormat = dateOverride ?? detectedDate.format ?? "YYYY-MM-DD";
  const decimalSeparator: DecimalSeparator = decimalOverride ?? detectedDecimal;
  const options = React.useMemo(() => ({ dateFormat, decimalSeparator, amountMode, signConvention }), [dateFormat, decimalSeparator, amountMode, signConvention]);

  const mappingError =
    amountMode === "signed" && mapping.amount === null
      ? "Choose the amount column."
      : amountMode === "split" && mapping.debit === null && mapping.credit === null
        ? "Choose the debit and/or credit column."
        : !accountId && mapping.account === null
          ? "Choose an account to import into."
          : null;

  /* ── Step 3: preview (interpreted with the same parser the server uses) ── */

  const preview: PreviewRow[] = React.useMemo(() => {
    if (!parsed || step === "upload" || step === "map") return [];
    const byName = new Map(allAccounts.map((a) => [a.name.trim().toLowerCase(), a]));
    const fallback = allAccounts.find((a) => a.id === accountId) ?? null;
    const seen = new Set<string>();
    return parsed.rows.map((cells, index) => {
      const d = interpretRow(cells, mapping, options);
      const line = lineOf(index, parsed.hasHeader);
      let acc = fallback;
      const errors = [...d.errors];
      if (d.accountName) {
        const named = byName.get(d.accountName.toLowerCase());
        if (named) acc = named;
        else if (!fallback) errors.push(`No account named "${d.accountName.slice(0, 40)}"`);
      }
      const kind = d.type === "income" ? "income" : "expense";
      const matched = resolveCategory(categories, kind, d.category);
      const def = categories.find((c) => c.id === (kind === "income" ? defaultIncome : defaultExpense));
      const categoryLabel = matched
        ? (matched.parentId ? `${categories.find((c) => c.id === matched.parentId)?.name ?? ""} › ` : "") + matched.name
        : d.category && createCategories
          ? (d.category.parent ? `${d.category.parent} › ` : "") + d.category.name
          : (def?.name ?? "Uncategorised");
      let status: Status = errors.length ? "error" : "ok";
      if (status === "ok" && acc && d.date && d.amount && d.type) {
        const key = duplicateKey(acc.id, d.date, d.type, d.amount, d.merchant ?? d.notes);
        if (seen.has(key)) status = "dup-file";
        seen.add(key);
        if (existingDupLines.has(line)) status = "dup-existing";
      }
      return { ...d, errors, line, index, status, accountId: acc?.id ?? null, accountLabel: acc?.name ?? "—", categoryLabel, categoryNew: Boolean(!matched && d.category && createCategories) };
    });
  }, [parsed, step, mapping, options, accountId, defaultExpense, defaultIncome, createCategories, existingDupLines, allAccounts, categories]);

  const counts = React.useMemo(() => {
    const c = { ok: 0, error: 0, dup: 0, forced: 0 };
    for (const r of preview) {
      if (r.status === "ok") c.ok++;
      else if (r.status === "error") c.error++;
      else {
        c.dup++;
        if (forced.has(r.line)) c.forced++;
      }
    }
    return c;
  }, [preview, forced]);

  async function goToPreview() {
    if (!parsed || mappingError) return;
    setStep("preview");
    setFilter("all");
    // Ask the server which rows already exist (fingerprints only; nothing is saved).
    setCheckingDups(true);
    try {
      const byName = new Map(allAccounts.map((a) => [a.name.trim().toLowerCase(), a.id]));
      const items = parsed.rows.flatMap((cells, index) => {
        const d = interpretRow(cells, mapping, options);
        const acc = (d.accountName && byName.get(d.accountName.toLowerCase())) || accountId;
        if (d.errors.length || !acc || !d.date || !d.amount || !d.type) return [];
        return [{ line: lineOf(index, parsed.hasHeader), accountId: acc, date: d.date, type: d.type, amount: d.amount, description: (d.merchant ?? d.notes)?.slice(0, 2000) ?? null }];
      });
      const found = new Set<number>();
      for (let i = 0; i < items.length; i += 2000) {
        const r = await checkDuplicatesAction({ rows: items.slice(i, i + 2000) });
        if (!r.ok) throw new Error(r.error);
        r.data.forEach((l) => found.add(l));
      }
      setExistingDupLines(found);
    } catch (e) {
      toast.error(e instanceof Error ? `Couldn't check for duplicates: ${e.message}` : "Couldn't check for duplicates");
    } finally {
      setCheckingDups(false);
    }
  }

  /* ── Step 4: import in chunks ── */

  async function runImport() {
    if (!parsed) return;
    setStep("importing");
    setFatal(null);
    const total = parsed.rows.length;
    setProgress({ done: 0, total });
    const agg: Result = { imported: 0, duplicates: 0, errors: 0, rows: [] };
    let batchId: string | null = null;
    try {
      const s = await startImportAction({ filename: parsed.filename.slice(0, 200), rowCount: total });
      if (!s.ok) throw new Error(s.error);
      batchId = s.data.batchId;
      // Chunks of ≤500 rows that also stay well under the server-action body limit.
      const chunks: { line: number; cells: string[] }[][] = [];
      let cur: { line: number; cells: string[] }[] = [];
      let size = 0;
      parsed.rows.forEach((cells, idx) => {
        const row = { line: lineOf(idx, parsed.hasHeader), cells: cells.map((c) => c.slice(0, 2000)) };
        const rowSize = row.cells.reduce((n, c) => n + c.length + 4, 16);
        if (cur.length && (cur.length >= IMPORT_CHUNK_SIZE || size + rowSize > 2_500_000)) {
          chunks.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(row);
        size += rowSize;
      });
      if (cur.length) chunks.push(cur);
      let done = 0;
      for (const rows of chunks) {
        const lines = new Set(rows.map((r) => r.line));
        const r = await importChunkAction({
          batchId,
          mapping,
          options: {
            ...options,
            accountId: accountId || null,
            defaultExpenseCategoryId: defaultExpense || null,
            defaultIncomeCategoryId: defaultIncome || null,
            createCategories,
            skipDuplicates: true,
            forceLines: [...forced].filter((l) => lines.has(l)),
          },
          rows,
        });
        if (!r.ok) throw new Error(r.error);
        agg.imported += r.data.imported;
        agg.duplicates += r.data.duplicates;
        agg.errors += r.data.errors;
        agg.rows.push(...r.data.rows);
        done += rows.length;
        setProgress({ done, total });
      }
    } catch (e) {
      setFatal(e instanceof Error ? e.message : "The import stopped unexpectedly.");
    } finally {
      if (batchId) await finishImportAction({ batchId });
      setResult(agg);
      setStep("done");
      if (agg.imported) toast.success(`Imported ${agg.imported.toLocaleString()} transaction${agg.imported === 1 ? "" : "s"}`);
    }
  }

  function downloadReport() {
    if (!result) return;
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = ["line,status,message", ...result.rows.map((r) => `${r.line},${r.status},${esc(r.message ?? "")}`)].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-report-${parsed?.filename.replace(/\.[^.]+$/, "") ?? "file"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    setParsed(null);
    setResult(null);
    setFatal(null);
    setExistingDupLines(new Set());
    setForced(new Set());
    setStep("upload");
    if (fileRef.current) fileRef.current.value = "";
  }

  /* ── Render ── */

  const steps: { id: Step[]; label: string }[] = [
    { id: ["upload"], label: "Upload" },
    { id: ["map"], label: "Map columns" },
    { id: ["preview"], label: "Review" },
    { id: ["importing", "done"], label: "Import" },
  ];
  const stepIndex = steps.findIndex((s) => s.id.includes(step));

  return (
    <div className="grid gap-5">
      <ol className="flex items-center gap-2 text-[13px]" aria-label="Import progress">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2" aria-current={i === stepIndex ? "step" : undefined}>
            <span className={cn("grid size-6 place-items-center rounded-full text-[12px] font-medium", i < stepIndex ? "bg-positive-soft text-positive" : i === stepIndex ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
              {i < stepIndex ? <CheckCircle2 className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn("hidden sm:inline", i === stepIndex ? "font-medium" : "text-muted-foreground")}>{s.label}</span>
            {i < steps.length - 1 && <span className="h-px w-4 bg-border sm:w-8" aria-hidden />}
          </li>
        ))}
      </ol>

      {step === "upload" && (
        <Card>
          <div className="p-5">
            <label
              htmlFor="csv-file"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void onFile(e.dataTransfer.files?.[0]);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors focus-within:border-ring hover:bg-subtle",
                dragging && "border-foreground/40 bg-subtle",
              )}
            >
              <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Upload className="size-5" aria-hidden />
              </span>
              <span className="text-[15px] font-medium">Drop a CSV file here, or click to choose</span>
              <span className="max-w-md text-[13px] text-muted-foreground">
                Up to {MAX_IMPORT_ROWS.toLocaleString()} rows and 5 MB. Comma, semicolon or tab separated; any date format your bank uses.
              </span>
              <input ref={fileRef} id="csv-file" type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
            {uploadError && (
              <p role="alert" className="mt-3 rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
                {uploadError}
              </p>
            )}
          </div>
          <CardFooter className="gap-2 text-[13px] text-muted-foreground">
            <Info className="size-4 shrink-0" aria-hidden />
            Rows that already exist in Kosh are detected and skipped, so re-importing an overlapping statement is safe.
          </CardFooter>
        </Card>
      )}

      {step === "map" && parsed && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="truncate text-sm font-medium">{parsed.filename}</p>
              <Badge>{parsed.rows.length.toLocaleString()} rows</Badge>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch checked={parsed.hasHeader} onCheckedChange={(on) => loadText(parsed.filename, parsed.text, on)} aria-label="First row contains column names" />
              First row is column names
            </label>
          </div>
          {parsed.errors.length > 0 && (
            <div role="status" className="flex gap-2 border-b bg-warning-soft px-5 py-2.5 text-[13px] text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>Some rows look malformed ({parsed.errors[0]}). They&apos;ll be flagged in the review step.</p>
            </div>
          )}
          <div className="grid gap-6 p-5">
            <fieldset className="grid gap-4">
              <legend className="mb-3 text-sm font-semibold">Amount</legend>
              <Segmented
                ariaLabel="Amount columns"
                value={amountMode}
                onChange={setAmountMode}
                options={[
                  { value: "signed", label: "One amount column" },
                  { value: "split", label: "Separate debit & credit" },
                ]}
                className="w-full sm:w-auto sm:self-start"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                {amountMode === "signed" ? (
                  <>
                    <ColumnSelect id="map-amount" label="Amount column" headers={parsed.headers} rows={parsed.rows} value={mapping.amount} onChange={(v) => setMapping((m) => ({ ...m, amount: v }))} required />
                    <Field label="Negative amounts are" htmlFor="sign">
                      <NativeSelect id="sign" value={signConvention} onChange={(e) => setSignConvention(e.target.value as typeof signConvention)}>
                        <option value="negative_expense">Expenses (bank statement style)</option>
                        <option value="positive_expense">Income / payments (card statement style)</option>
                      </NativeSelect>
                    </Field>
                  </>
                ) : (
                  <>
                    <ColumnSelect id="map-debit" label="Debit (money out)" headers={parsed.headers} rows={parsed.rows} value={mapping.debit} onChange={(v) => setMapping((m) => ({ ...m, debit: v }))} />
                    <ColumnSelect id="map-credit" label="Credit (money in)" headers={parsed.headers} rows={parsed.rows} value={mapping.credit} onChange={(v) => setMapping((m) => ({ ...m, credit: v }))} />
                  </>
                )}
                <Field label="Decimal separator" htmlFor="decimal" hint={`Detected “${detectedDecimal}” — ${detectedDecimal === "." ? "1,234.56" : "1.234,56"}`}>
                  <NativeSelect id="decimal" value={decimalSeparator} onChange={(e) => setDecimalOverride(e.target.value as DecimalSeparator)}>
                    <option value=".">Point — 1,234.56</option>
                    <option value=",">Comma — 1.234,56</option>
                  </NativeSelect>
                </Field>
              </div>
            </fieldset>

            <fieldset className="grid gap-4 border-t pt-5">
              <legend className="mb-3 text-sm font-semibold">Date</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <ColumnSelect id="map-date" label="Date column" headers={parsed.headers} rows={parsed.rows} value={mapping.date} onChange={(v) => setMapping((m) => ({ ...m, date: v ?? 0 }))} required />
                <Field
                  label="Date format"
                  htmlFor="date-format"
                  hint={
                    detectedDate.ambiguous && !dateOverride
                      ? "Day and month can't be told apart from this file — check this is right."
                      : detectedDate.format
                        ? `Detected ${detectedDate.format}`
                        : "Couldn't detect the format — pick one."
                  }
                >
                  <NativeSelect id="date-format" value={dateFormat} onChange={(e) => setDateOverride(e.target.value as DateFormat)}>
                    {DATE_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
            </fieldset>

            <fieldset className="grid gap-4 border-t pt-5">
              <legend className="mb-3 text-sm font-semibold">Details</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {FIELDS.filter((f) => f.key !== "date").map((f) => (
                  <ColumnSelect key={f.key} id={`map-${f.key}`} label={f.label} hint={f.hint} headers={parsed.headers} rows={parsed.rows} value={mapping[f.key]} onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))} />
                ))}
              </div>
            </fieldset>

            <fieldset className="grid gap-4 border-t pt-5">
              <legend className="mb-3 text-sm font-semibold">Where it goes</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={mapping.account !== null ? "Account when no name matches" : "Import into account"} htmlFor="target-account" error={!accountId && mapping.account === null ? "Required" : null}>
                  <NativeSelect id="target-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    {mapping.account !== null && <option value="">None — flag the row</option>}
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.currency})
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="hidden sm:block" />
                <Field label="Default expense category" htmlFor="def-exp" hint="For rows without a matching category.">
                  <CategoryOptions id="def-exp" kind="expense" categories={categories} value={defaultExpense} onChange={setDefaultExpense} />
                </Field>
                <Field label="Default income category" htmlFor="def-inc">
                  <CategoryOptions id="def-inc" kind="income" categories={categories} value={defaultIncome} onChange={setDefaultIncome} />
                </Field>
              </div>
              {mapping.category !== null && (
                <label className="flex items-start gap-2.5 text-[13.5px]">
                  <Checkbox checked={createCategories} onCheckedChange={(c) => setCreateCategories(c === true)} className="mt-0.5" aria-describedby="create-cats-hint" />
                  <span>
                    Create categories that don&apos;t exist yet
                    <span id="create-cats-hint" className="block text-[12.5px] text-muted-foreground">
                      Otherwise unknown categories import as the default above (or uncategorised).
                    </span>
                  </span>
                </label>
              )}
            </fieldset>
          </div>
          <CardFooter className="flex-wrap justify-between gap-3">
            <Button variant="ghost" onClick={reset}>
              <ArrowLeft /> Choose another file
            </Button>
            <div className="flex items-center gap-3">
              {mappingError && <p className="text-[13px] text-negative">{mappingError}</p>}
              <Button onClick={() => void goToPreview()} disabled={Boolean(mappingError)}>
                Review rows <ArrowRight />
              </Button>
            </div>
          </CardFooter>
        </Card>
      )}

      {step === "preview" && parsed && (
        <Card>
          <div className="grid gap-3 border-b p-5 sm:grid-cols-3">
            <Stat label="Ready to import" value={counts.ok + counts.forced} tone="positive" />
            <Stat label="Duplicates (skipped)" value={counts.dup - counts.forced} tone="warning" loading={checkingDups} />
            <Stat label="Errors (skipped)" value={counts.error} tone="negative" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <Segmented
              size="sm"
              ariaLabel="Show rows"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All rows" },
                { value: "error", label: `Errors (${counts.error})` },
                { value: "dup", label: `Duplicates (${counts.dup})` },
              ]}
            />
            <p className="text-[12.5px] text-muted-foreground">Showing up to 50 rows</p>
          </div>
          <PreviewTable
            rows={preview.filter((r) => (filter === "all" ? true : filter === "error" ? r.status === "error" : r.status.startsWith("dup"))).slice(0, 50)}
            forced={forced}
            onForce={(line, on) =>
              setForced((s) => {
                const n = new Set(s);
                if (on) n.add(line);
                else n.delete(line);
                return n;
              })
            }
            formatAmount={(a, accId) => fmtMoney(a, allAccounts.find((x) => x.id === accId)?.currency)}
            showAccount={mapping.account !== null}
          />
          <CardFooter className="flex-wrap justify-between gap-3">
            <Button variant="ghost" onClick={() => setStep("map")}>
              <ArrowLeft /> Back to mapping
            </Button>
            <Button onClick={() => void runImport()} disabled={counts.ok + counts.forced === 0 || checkingDups}>
              Import {(counts.ok + counts.forced).toLocaleString()} transaction{counts.ok + counts.forced === 1 ? "" : "s"}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === "importing" && (
        <Card className="p-8 text-center" aria-busy>
          <p className="text-[15px] font-medium">Importing…</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {progress.done.toLocaleString()} of {progress.total.toLocaleString()} rows processed. Keep this tab open.
          </p>
          <Progress value={progress.total ? progress.done / progress.total : 0} className="mx-auto mt-4 max-w-sm" label="Import progress" />
        </Card>
      )}

      {step === "done" && result && (
        <Card>
          <div className="p-6">
            <div className="flex items-start gap-3">
              {fatal ? <XCircle className="mt-0.5 size-5 shrink-0 text-negative" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-positive" aria-hidden />}
              <div>
                <p className="text-[15px] font-medium">
                  {fatal ? "The import stopped part-way" : result.imported ? `Imported ${result.imported.toLocaleString()} transaction${result.imported === 1 ? "" : "s"}` : "Nothing was imported"}
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {result.duplicates.toLocaleString()} duplicate{result.duplicates === 1 ? "" : "s"} skipped · {result.errors.toLocaleString()} row{result.errors === 1 ? "" : "s"} with errors
                </p>
                {fatal && (
                  <p role="alert" className="mt-2 text-[13px] text-negative">
                    {fatal} Rows already imported were saved; you can undo the whole import from Settings → Data.
                  </p>
                )}
              </div>
            </div>
            {result.rows.length > 0 && (
              <div className="mt-5 rounded-lg border">
                <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                  <p className="text-[13px] font-medium">Skipped rows</p>
                  <Button variant="ghost" size="sm" onClick={downloadReport}>
                    <Download /> Download report
                  </Button>
                </div>
                <ul className="max-h-72 divide-y overflow-y-auto text-[13px]">
                  {result.rows.slice(0, 200).map((r) => (
                    <li key={`${r.line}-${r.status}`} className="flex gap-3 px-4 py-2">
                      <span className="num w-16 shrink-0 text-muted-foreground">Row {r.line}</span>
                      <span className={r.status === "error" ? "text-negative" : "text-warning"}>{r.message ?? r.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <CardFooter className="flex-wrap justify-between gap-3">
            <Button variant="ghost" onClick={reset}>
              <RotateCcw /> Import another file
            </Button>
            <div className="flex gap-2">
              <Link href="/settings/data#imports" className={buttonVariants({ variant: "outline" })}>
                Import history
              </Link>
              <Link href="/transactions" className={buttonVariants({ variant: "default" })}>
                View transactions
              </Link>
            </div>
          </CardFooter>
        </Card>
      )}
    </div>
  );

}

const TONE = { positive: "text-positive", warning: "text-warning", negative: "text-negative" } as const;

function Stat({ label, value, tone, loading }: { label: string; value: number; tone: keyof typeof TONE; loading?: boolean }) {
  return (
    <div className="rounded-lg bg-subtle px-4 py-3">
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className={cn("num mt-0.5 text-[22px] font-semibold tracking-tight", value > 0 && tone !== "positive" && TONE[tone])}>{loading ? "…" : value.toLocaleString()}</p>
    </div>
  );
}

function ColumnSelect({
  id,
  label,
  hint,
  headers,
  rows,
  value,
  onChange,
  required,
}: {
  id: string;
  label: string;
  hint?: string;
  headers: string[];
  rows: string[][];
  value: number | null;
  onChange: (v: number | null) => void;
  required?: boolean;
}) {
  const sample = value !== null ? rows.slice(0, 3).map((r) => r[value] ?? "").filter(Boolean).join(" · ") : "";
  return (
    <Field label={label} htmlFor={id} optional={!required} hint={sample ? `e.g. ${sample.slice(0, 80)}` : hint}>
      <NativeSelect id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        {!required && <option value="">— Not in file —</option>}
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

function CategoryOptions({ id, kind, categories, value, onChange }: { id: string; kind: "expense" | "income"; categories: ClientCategory[]; value: string; onChange: (v: string) => void }) {
  const parents = categories.filter((c) => c.kind === kind && !c.parentId && !c.isArchived);
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Uncategorised</option>
      {parents.map((p) => (
        <optgroup key={p.id} label={p.name}>
          <option value={p.id}>{p.name}</option>
          {categories
            .filter((c) => c.parentId === p.id && !c.isArchived)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {p.name} › {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

function PreviewTable({
  rows,
  forced,
  onForce,
  formatAmount,
  showAccount,
}: {
  rows: PreviewRow[];
  forced: Set<number>;
  onForce: (line: number, on: boolean) => void;
  formatAmount: (a: string, accountId: string | null) => string;
  showAccount: boolean;
}) {
  if (!rows.length) return <p className="border-t px-5 py-10 text-center text-sm text-muted-foreground">No rows to show.</p>;
  return (
    <div className="overflow-x-auto border-t">
      <table className="w-full min-w-[640px] text-[13px]">
        <caption className="sr-only">Import preview</caption>
        <thead>
          <tr className="border-b text-left text-[12px] text-muted-foreground">
            <th scope="col" className="w-14 px-4 py-2 font-medium">
              Row
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Date
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Description
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Category
            </th>
            {showAccount && (
              <th scope="col" className="px-2 py-2 font-medium">
                Account
              </th>
            )}
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.line} className={cn(r.status === "error" && "bg-negative-soft/40", r.status.startsWith("dup") && !forced.has(r.line) && "text-muted-foreground")}>
              <td className="num px-4 py-2 text-muted-foreground">{r.line}</td>
              <td className="num px-2 py-2 whitespace-nowrap">{r.date ? formatDate(r.date, "d MMM yyyy") : "—"}</td>
              <td className="max-w-56 truncate px-2 py-2" title={r.merchant ?? r.notes ?? ""}>
                {r.merchant ?? r.notes ?? <span className="text-muted-foreground">—</span>}
              </td>
              <td className="max-w-40 truncate px-2 py-2">
                {r.categoryLabel}
                {r.categoryNew && (
                  <Badge variant="info" className="ml-1.5">
                    new
                  </Badge>
                )}
              </td>
              {showAccount && <td className="max-w-32 truncate px-2 py-2">{r.accountLabel}</td>}
              <td className={cn("num px-2 py-2 text-right whitespace-nowrap", r.type === "income" || r.type === "refund" ? "text-positive" : "")}>
                {r.amount ? `${r.type === "expense" ? "−" : "+"}${formatAmount(r.amount, r.accountId)}` : "—"}
              </td>
              <td className="px-4 py-2">
                {r.status === "ok" && <Badge variant="positive">Ready</Badge>}
                {r.status === "error" && (
                  <span className="text-negative" role="note">
                    {r.errors.join("; ")}
                  </span>
                )}
                {r.status.startsWith("dup") && (
                  <label className="flex items-center gap-2 whitespace-nowrap">
                    <Checkbox checked={forced.has(r.line)} onCheckedChange={(c) => onForce(r.line, c === true)} aria-label={`Import row ${r.line} anyway`} />
                    <span className="inline-flex items-center gap-1 text-warning">
                      <Copy className="size-3.5" aria-hidden />
                      {r.status === "dup-existing" ? "Already exists" : "Repeated"}
                    </span>
                  </label>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
