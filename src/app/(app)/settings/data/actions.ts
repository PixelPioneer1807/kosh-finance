"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import { undoImportBatch } from "@/server/services/import";

export const undoImportAction = userAction(z.object({ batchId: z.uuid() }), async ({ batchId }, { userId }) => {
  const r = await undoImportBatch(userId, batchId);
  refresh();
  return r;
});
