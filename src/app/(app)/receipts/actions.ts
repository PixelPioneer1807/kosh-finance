"use server";

import { z } from "zod";
import { userAction } from "@/server/safe";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { extractReceipt, MAX_OCR_CHARS } from "@/server/ai/receipt";

/** Extract merchant/date/total/… from OCR text of an uploaded receipt (AI with regex fallback). */
export const extractReceiptAction = userAction(
  z.object({ receiptId: z.uuid(), text: z.string().max(MAX_OCR_CHARS * 2) }),
  async ({ receiptId, text }, { userId }) => {
    await enforceRateLimit(`receipt-extract:${userId}`, 60, 3600, "Too many receipts scanned in a short time. Try again later.");
    return extractReceipt(userId, receiptId, text);
  },
);
