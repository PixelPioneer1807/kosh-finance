"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { toFailure, userAction, type ActionResult } from "@/server/safe";
import { AppError } from "@/server/errors";
import { changePassword, deleteOwnAccount } from "@/server/services/auth";
import { deleteUserSession, invalidateUserSessions } from "@/server/auth/sessions";
import { clearSessionCookie, requireUser } from "@/server/auth/current";
import { enforceRateLimit } from "@/server/auth/rate-limit";

export const changePasswordAction = userAction(
  z
    .object({
      currentPassword: z.string().min(1, "Enter your current password").max(200),
      newPassword: z.string().min(1, "Choose a new password").max(128),
      confirmPassword: z.string().max(128),
    })
    .refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: "Passwords don't match" }),
  async ({ currentPassword, newPassword }, { userId, session }) => {
    // Signs out every other device; keeps this one.
    await changePassword(userId, currentPassword, newPassword, session.sessionId);
    refresh();
    return null;
  },
);

export const revokeSessionAction = userAction(z.object({ id: z.string().min(10).max(128) }), async ({ id }, { userId, session }) => {
  if (id === session.sessionId) throw new AppError("VALIDATION", "To end this session, sign out instead.");
  await deleteUserSession(userId, id);
  refresh();
  return null;
});

export const signOutOtherSessionsAction = userAction(z.object({}), async (_input, { userId, session }) => {
  await invalidateUserSessions(userId, session.sessionId);
  refresh();
  return null;
});

const deleteSchema = z.object({
  password: z.string().min(1, "Enter your password").max(200),
  confirm: z.string().refine((v) => v.trim() === "DELETE", "Type DELETE to confirm"),
});

/** Permanently deletes the account, clears the cookie and leaves the app. */
export async function deleteAccountAction(input: z.input<typeof deleteSchema>): Promise<ActionResult> {
  try {
    const session = await requireUser();
    const data = deleteSchema.parse(input);
    await enforceRateLimit(`delete-account:${session.user.id}`, 5, 3600);
    await deleteOwnAccount(session.user.id, data.password);
    await clearSessionCookie();
  } catch (e) {
    return toFailure(e);
  }
  redirect("/login?deleted=1");
}
