import { NextResponse } from "next/server";
import { userRoute } from "@/server/safe";
import { AppError } from "@/server/errors";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { saveReceipt, MAX_RECEIPT_BYTES } from "@/server/services/receipts";

export const POST = userRoute(async (req, { userId }) => {
  await enforceRateLimit(`receipt-upload:${userId}`, 60, 3600);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_RECEIPT_BYTES + 64 * 1024) throw new AppError("VALIDATION", "Receipts must be 4 MB or smaller.");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "Attach a file.");
  const tx = form.get("transactionId");
  const ocr = form.get("ocrText");
  const saved = await saveReceipt(
    userId,
    { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
    { transactionId: typeof tx === "string" && tx ? tx : null, ocrText: typeof ocr === "string" ? ocr : null },
  );
  return NextResponse.json(saved, { status: 201 });
});
