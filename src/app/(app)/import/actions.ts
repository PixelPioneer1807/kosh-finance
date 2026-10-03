"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { MAX_IMPORT_ROWS } from "@/lib/csv-import";
import { duplicateCheckInput, finishImportBatch, findExistingDuplicates, importChunk, importChunkInput, startImportBatch } from "@/server/services/import";

export const startImportAction = userAction(
  z.object({ filename: z.string().max(200).nullable(), rowCount: z.number().int().min(1).max(MAX_IMPORT_ROWS) }),
  async (input, { userId }) => {
    await enforceRateLimit(`import:${userId}`, 30, 3600, "You've started a lot of imports recently. Try again later.");
    const b = await startImportBatch(userId, input);
    return { batchId: b.id };
  },
);

/** One chunk of ≤500 raw rows; the server re-parses and validates every row. */
export const importChunkAction = userAction(importChunkInput, async (input, { userId }) => importChunk(userId, input));

export const finishImportAction = userAction(z.object({ batchId: z.uuid() }), async ({ batchId }, { userId }) => {
  const b = await finishImportBatch(userId, batchId);
  refresh();
  return { importedCount: b.importedCount, skippedCount: b.skippedCount };
});

export const checkDuplicatesAction = userAction(duplicateCheckInput, async (input, { userId }) => {
  await enforceRateLimit(`import-dupes:${userId}`, 300, 3600);
  return findExistingDuplicates(userId, input);
});
