import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { receipts } from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";

export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024; // Vercel functions accept ~4.5 MB request bodies

/** Detect the real file type from magic bytes — the client-provided MIME type is never trusted. */
export function sniffMime(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

export function sanitizeFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "receipt";
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "receipt";
}

export async function saveReceipt(userId: string, file: { name: string; bytes: Buffer }, opts: { transactionId?: string | null; ocrText?: string | null } = {}) {
  if (file.bytes.length === 0) throw new AppError("VALIDATION", "The file is empty.");
  if (file.bytes.length > MAX_RECEIPT_BYTES) throw new AppError("VALIDATION", "Receipts must be 4 MB or smaller.");
  const mime = sniffMime(file.bytes);
  if (!mime) throw new AppError("VALIDATION", "Only JPEG, PNG, WebP images or PDF files can be uploaded.");
  if (opts.transactionId) {
    const { assertOwned } = await import("./ownership");
    await assertOwned(userId, { transaction: opts.transactionId });
  }
  const [row] = await db
    .insert(receipts)
    .values({
      userId,
      transactionId: opts.transactionId ?? null,
      filename: sanitizeFilename(file.name),
      mimeType: mime,
      sizeBytes: file.bytes.length,
      data: file.bytes,
      ocrText: opts.ocrText?.slice(0, 20000) ?? null,
    })
    .returning({ id: receipts.id, filename: receipts.filename, mimeType: receipts.mimeType, sizeBytes: receipts.sizeBytes });
  return row;
}

export async function getReceiptFile(userId: string, id: string) {
  const [row] = await db.select().from(receipts).where(and(eq(receipts.id, id), eq(receipts.userId, userId))).limit(1);
  if (!row) throw notFound("Receipt");
  return row;
}

export async function updateReceiptExtraction(userId: string, id: string, data: { ocrText?: string | null; extracted?: Record<string, unknown> | null }) {
  const [row] = await db
    .update(receipts)
    .set({ ocrText: data.ocrText?.slice(0, 20000) ?? undefined, extracted: data.extracted ?? undefined })
    .where(and(eq(receipts.id, id), eq(receipts.userId, userId)))
    .returning({ id: receipts.id });
  if (!row) throw notFound("Receipt");
}

export async function deleteReceipt(userId: string, id: string) {
  const [row] = await db.delete(receipts).where(and(eq(receipts.id, id), eq(receipts.userId, userId))).returning({ id: receipts.id });
  if (!row) throw notFound("Receipt");
}

export async function listReceipts(userId: string, limit = 50) {
  return db
    .select({ id: receipts.id, filename: receipts.filename, mimeType: receipts.mimeType, sizeBytes: receipts.sizeBytes, transactionId: receipts.transactionId, createdAt: receipts.createdAt })
    .from(receipts)
    .where(eq(receipts.userId, userId))
    .orderBy(desc(receipts.createdAt))
    .limit(limit);
}
