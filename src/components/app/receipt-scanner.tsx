"use client";

/**
 * Receipt scanner: photo/PDF → on-device OCR → upload → field extraction → user review.
 *
 * - Images are downscaled/compressed in a canvas (JPEG ≤ 4 MB) and read with tesseract.js in
 *   the browser (lazy-loaded; worker/core/language data come from jsDelivr, allowed by the CSP).
 * - Text-based PDFs are read client-side when possible (src/lib/pdf-text.ts); otherwise the PDF
 *   is still attached and the user fills in the details.
 * - The server extracts merchant/date/total (AI with a regex fallback) and stores the receipt.
 * - Nothing is saved as a transaction here: the reviewed values open the add-transaction form
 *   (or are handed to `onComplete`).
 */
import * as React from "react";
import { Camera, FileText, ImageUp, Loader2, Paperclip, ScanLine, TriangleAlert } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Progress } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { formatMoney, toInputValue } from "@/lib/money";
import { extractPdfText } from "@/lib/pdf-text";
import { evalAmount } from "@/lib/amount-expr";
import { useShellOptional } from "@/components/shell/shell-context";
import { extractReceiptAction } from "@/app/(app)/receipts/actions";
import { useAppData } from "./user-context";

export type ScannedReceipt = {
  receipt: { id: string; filename: string };
  /** Plain decimal for the amount input ("12.5"), or null when unknown. */
  amount: string | null;
  merchant: string | null;
  date: string | null;
  notes: string | null;
  paymentMethodId: string | null;
  /** Currency printed on the receipt, if detected. */
  currency: string | null;
};

type Extracted = {
  merchant: string | null;
  date: string | null;
  total: string | null;
  tax: string | null;
  currency: string | null;
  paymentMethod: string | null;
  items: { name: string; amount: string }[];
  parser: "ai" | "local" | "none";
};

type Stage =
  | { s: "pick" }
  | { s: "working"; step: string; progress?: number }
  | { s: "review"; receipt: { id: string; filename: string }; x: Extracted; textFound: boolean; note: string | null; preview: string | null }
  | { s: "error"; message: string };

const MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024;
const EMPTY: Extracted = { merchant: null, date: null, total: null, tax: null, currency: null, paymentMethod: null, items: [], parser: "none" };

async function prepareImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This image format can't be read here. Try a JPEG or PNG photo.");
  }
  let maxSide = 2200;
  let quality = 0.85;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Your browser can't process images.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
      if (blob && blob.size <= MAX_BYTES) return blob;
      if (quality > 0.6) quality -= 0.1;
      else maxSide = Math.round(maxSide * 0.8);
    }
  } finally {
    bitmap.close();
  }
  throw new Error("Couldn't shrink this image below 4 MB.");
}

type OcrWorker = { recognize: (img: Blob) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };

const baseName = (name: string) => name.replace(/\.[^.]+$/, "").slice(0, 80) || "receipt";

export function ReceiptScanner({ open, onOpenChange, onComplete }: { open: boolean; onOpenChange: (o: boolean) => void; onComplete?: (r: ScannedReceipt) => void }) {
  const { prefs, paymentMethods } = useAppData();
  const shell = useShellOptional();
  const [stage, setStage] = React.useState<Stage>({ s: "pick" });
  const [form, setForm] = React.useState({ merchant: "", date: "", total: "" });
  const [dragging, setDragging] = React.useState(false);
  const workerRef = React.useRef<OcrWorker | null>(null);
  const runRef = React.useRef(0);

  const reset = React.useCallback(() => {
    runRef.current++;
    void workerRef.current?.terminate();
    workerRef.current = null;
    setStage((st) => {
      if (st.s === "review" && st.preview) URL.revokeObjectURL(st.preview);
      return { s: "pick" };
    });
  }, []);

  const handleOpenChange = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  async function ocr(blob: Blob, run: number): Promise<string> {
    const { createWorker } = await import("tesseract.js");
    const worker = (await createWorker("eng", 1, {
      logger: (m: { status: string; progress: number }) => {
        if (runRef.current === run && m.status === "recognizing text") setStage({ s: "working", step: "Reading the text…", progress: m.progress });
      },
    })) as unknown as OcrWorker;
    workerRef.current = worker;
    try {
      const { data } = await worker.recognize(blob);
      return data.text ?? "";
    } finally {
      await worker.terminate().catch(() => {});
      if (workerRef.current === worker) workerRef.current = null;
    }
  }

  async function handle(file: File) {
    const run = ++runRef.current;
    const alive = () => runRef.current === run;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isImage = file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
    if (!isPdf && !isImage) return setStage({ s: "error", message: "Choose a photo (JPEG, PNG or WebP) or a PDF." });
    try {
      let upload: Blob = file;
      let filename = file.name;
      let text = "";
      let note: string | null = null;
      let preview: string | null = null;
      if (isImage) {
        setStage({ s: "working", step: "Preparing the image…" });
        upload = await prepareImage(file);
        filename = `${baseName(file.name)}.jpg`;
        preview = URL.createObjectURL(upload);
        if (!alive()) return;
        setStage({ s: "working", step: "Loading the text reader…", progress: 0 });
        try {
          text = await ocr(upload, run);
        } catch (e) {
          console.warn("[receipt] OCR failed", e);
          note = "Couldn't read text from this photo — please enter the details.";
        }
      } else {
        if (file.size > MAX_BYTES) throw new Error("PDFs must be 4 MB or smaller.");
        setStage({ s: "working", step: "Reading the PDF…" });
        text = await extractPdfText(await file.arrayBuffer()).catch(() => "");
        if (!text) note = "This PDF has no readable text (it may be a scan), so OCR isn't available for it. It's attached — please enter the details.";
      }
      if (!alive()) return;

      setStage({ s: "working", step: "Uploading…" });
      const fd = new FormData();
      fd.append("file", upload, filename);
      if (text) fd.append("ocrText", text.slice(0, 20000));
      const res = await fetch("/api/receipts", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Upload failed. Please try again.");
      const receipt = { id: j.id as string, filename: j.filename as string };
      if (!alive()) return;

      let x: Extracted = EMPTY;
      if (text.trim()) {
        setStage({ s: "working", step: "Finding the details…" });
        const r = await extractReceiptAction({ receiptId: receipt.id, text });
        if (r.ok) x = r.data;
        else note = `${r.error} You can still enter the details yourself.`;
      }
      if (!alive()) return;
      if (text.trim() && !x.total && !note) note = "Couldn't find the total — please check the amount.";
      setForm({ merchant: x.merchant ?? "", date: x.date ?? prefs.today, total: x.total ? toInputValue(x.total) : "" });
      setStage({ s: "review", receipt, x, textFound: Boolean(text.trim()), note, preview });
    } catch (e) {
      if (alive()) setStage({ s: "error", message: e instanceof Error ? e.message : "Something went wrong reading the receipt." });
    }
  }

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) void handle(f);
  }

  function complete() {
    if (stage.s !== "review") return;
    const { x, receipt } = stage;
    const amount = evalAmount(form.total);
    const pmType = x.paymentMethod === "card" ? ["credit_card", "debit_card"] : x.paymentMethod ? [x.paymentMethod] : [];
    const pm = paymentMethods.find((p) => pmType.includes(p.type));
    const names = x.items.map((i) => i.name);
    const notes = names.length ? (names.slice(0, 6).join(", ") + (names.length > 6 ? ", …" : "")).slice(0, 200) : null;
    const result: ScannedReceipt = {
      receipt,
      amount: amount ? toInputValue(amount) : null,
      merchant: form.merchant.trim() || null,
      date: form.date || null,
      notes,
      paymentMethodId: pm?.id ?? null,
      currency: x.currency,
    };
    handleOpenChange(false);
    if (onComplete) onComplete(result);
    else
      shell?.openQuickAdd({
        type: "expense",
        amount: result.amount ?? undefined,
        merchant: result.merchant,
        date: result.date ?? undefined,
        notes: result.notes,
        paymentMethodId: result.paymentMethodId,
        receipt,
      });
  }

  const money = (v: string) => formatMoney(v, stage.s === "review" && stage.x.currency ? stage.x.currency : prefs.currency, { locale: prefs.locale });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent onKeyDown={(e) => e.stopPropagation()} title="Scan a receipt" description={stage.s === "review" ? "Check the details, then continue to save the expense." : "Text is read on your device; the receipt is stored with the transaction."} size="md">
        {stage.s === "pick" && (
          <div
            className={cn("grid gap-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors", dragging && "border-accent bg-accent-soft/40")}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handle(f);
            }}
          >
            <span className="mx-auto grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
              <ScanLine className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-medium">Take a photo or choose a file</p>
              <p className="mt-1 text-[13px] text-muted-foreground">JPEG, PNG, WebP or PDF. Large photos are compressed automatically.</p>
            </div>
            <div className="flex flex-col justify-center gap-2 sm:flex-row">
              <label className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring sm:hidden">
                <Camera className="size-4" /> Take photo
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={pick} />
              </label>
              <label className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border-strong bg-card px-4 text-sm font-medium shadow-xs hover:bg-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
                <ImageUp className="size-4" /> Choose file
                <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" className="sr-only" onChange={pick} />
              </label>
            </div>
          </div>
        )}

        {stage.s === "working" && (
          <div className="grid gap-3 py-8 text-center" role="status" aria-live="polite">
            <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
            <p className="text-[14px] font-medium">{stage.step}</p>
            {stage.progress !== undefined && <Progress value={stage.progress} className="mx-auto max-w-56" label="Text recognition progress" />}
            <Button variant="ghost" size="sm" className="mx-auto" onClick={reset}>
              Cancel
            </Button>
          </div>
        )}

        {stage.s === "error" && (
          <div className="grid gap-4 py-2">
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-negative-soft px-3 py-2.5 text-sm text-negative">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <p>{stage.message}</p>
            </div>
            <DialogFooter className="mt-0">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
              <Button onClick={reset}>Try another file</Button>
            </DialogFooter>
          </div>
        )}

        {stage.s === "review" && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation(); // React events bubble through portals into a parent form
              complete();
            }}
          >
            <div className="flex items-center gap-3 rounded-lg bg-subtle p-2.5">
              {stage.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local blob preview
                <img src={stage.preview} alt="Receipt preview" className="size-14 shrink-0 rounded-md border object-cover" />
              ) : (
                <span className="grid size-14 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
                  <FileText className="size-5" />
                </span>
              )}
              <div className="min-w-0 text-[13px]">
                <p className="flex items-center gap-1.5 font-medium">
                  <Paperclip className="size-3.5" />
                  <span className="truncate">{stage.receipt.filename}</span>
                </p>
                <p className="text-muted-foreground">
                  {stage.x.parser === "ai" ? "Details found with AI from the scanned text" : stage.x.parser === "local" ? "Details found from the scanned text" : "Attached — enter the details below"}
                </p>
              </div>
            </div>
            {stage.note && (
              <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
                {stage.note}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Merchant" htmlFor="rc-merchant" className="sm:col-span-2">
                <Input id="rc-merchant" value={form.merchant} onChange={(e) => setForm((f) => ({ ...f, merchant: e.target.value }))} maxLength={80} placeholder="Where was this?" />
              </Field>
              <Field label="Total" htmlFor="rc-total" hint={stage.x.tax ? `Includes tax of ${money(stage.x.tax)}` : undefined}>
                <Input id="rc-total" inputMode="decimal" className="num" value={form.total} onChange={(e) => setForm((f) => ({ ...f, total: e.target.value }))} placeholder="0.00" />
              </Field>
              <Field label="Date" htmlFor="rc-date">
                <Input id="rc-date" type="date" max={prefs.today} value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
              </Field>
            </div>
            {stage.x.currency && stage.x.currency !== prefs.currency && (
              <p className="text-[13px] text-muted-foreground">
                This receipt looks like it&apos;s in <strong>{stage.x.currency}</strong>. If your account is in {prefs.currency}, use &quot;Paid in another currency&quot; in the next step.
              </p>
            )}
            {stage.x.items.length > 0 && (
              <details className="rounded-lg border px-3 py-2 text-[13px]">
                <summary className="cursor-pointer font-medium">{stage.x.items.length} line items</summary>
                <ul className="mt-2 grid gap-1">
                  {stage.x.items.map((i, k) => (
                    <li key={k} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">{i.name}</span>
                      <span className="num shrink-0">{money(i.amount)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <DialogFooter className="mt-1">
              <Button type="button" variant="outline" onClick={reset}>
                Scan another
              </Button>
              <Button type="submit">Continue</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A button that opens the scanner; by default the result opens the global add-transaction sheet. */
export function ScanReceiptButton({ onComplete, children, ...props }: Omit<ButtonProps, "onClick"> & { onComplete?: (r: ScannedReceipt) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" {...props} onClick={() => setOpen(true)}>
        {children ?? (
          <>
            <ScanLine /> Scan receipt
          </>
        )}
      </Button>
      <ReceiptScanner open={open} onOpenChange={setOpen} onComplete={onComplete} />
    </>
  );
}
