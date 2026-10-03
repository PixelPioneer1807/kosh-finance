import { NextResponse } from "next/server";
import { userRoute } from "@/server/safe";
import { AppError } from "@/server/errors";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { MAX_BACKUP_BYTES, restoreUserData } from "@/server/services/backup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Restore from a JSON backup (multipart: `file`, `mode` = merge|replace, `confirm`).
 * A route handler rather than a server action so files up to ~10 MB are accepted.
 */
export const POST = userRoute(async (req, { userId }) => {
  await enforceRateLimit(`backup-restore:${userId}`, 10, 3600, "Too many restores. Try again later.");
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BACKUP_BYTES + 64 * 1024) throw new AppError("VALIDATION", "Backup files must be 10 MB or smaller.");
  const form = await req.formData();
  const file = form.get("file");
  const mode = form.get("mode");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "Choose a backup file.");
  if (file.size > MAX_BACKUP_BYTES) throw new AppError("VALIDATION", "Backup files must be 10 MB or smaller.");
  if (mode !== "merge" && mode !== "replace") throw new AppError("VALIDATION", "Choose how to restore.");
  if (mode === "replace" && String(form.get("confirm") ?? "").trim() !== "REPLACE")
    throw new AppError("VALIDATION", "Type REPLACE to confirm replacing your data.", { confirm: ["Type REPLACE"] });
  let json: unknown;
  try {
    json = JSON.parse((await file.text()).replace(/^﻿/, ""));
  } catch {
    throw new AppError("VALIDATION", "That file isn't valid JSON. Choose a backup exported from Kosh.");
  }
  const summary = await restoreUserData(userId, json, mode);
  return NextResponse.json(summary);
});
