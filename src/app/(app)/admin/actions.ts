"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireAdmin, getRequestMeta } from "@/server/auth/current";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { toFailure, type ActionResult } from "@/server/safe";
import { adminCreateResetLink, createInvite, inviteInput, revokeInvite, setUserRole, setUserStatus } from "@/server/services/admin";

type AdminCtx = { userId: string; meta: { ip: string } };

/**
 * Like `userAction`, but requires an admin session. The services re-check the actor's role in the
 * database as well, so a stale or forged session role can never perform an admin mutation.
 */
function adminAction<S extends z.ZodType, R>(schema: S, handler: (input: z.output<S>, ctx: AdminCtx) => Promise<R>) {
  return async (input: z.input<S>): Promise<ActionResult<R>> => {
    try {
      const session = await requireAdmin();
      const parsed = schema.parse(input);
      const { ip } = await getRequestMeta();
      return { ok: true, data: await handler(parsed, { userId: session.user.id, meta: { ip } }) };
    } catch (e) {
      return toFailure(e);
    }
  };
}

export const createInviteAction = adminAction(inviteInput, async (input, { userId, meta }) => {
  await enforceRateLimit(`admin-invite:${userId}`, 60, 3600, "You've created a lot of invites recently. Try again later.");
  const r = await createInvite(userId, input, meta);
  refresh();
  return { code: r.code, link: r.link, expiresAt: r.expiresAt.toISOString(), role: r.role, maxUses: r.maxUses };
});

export const revokeInviteAction = adminAction(z.object({ id: z.uuid() }), async ({ id }, { userId, meta }) => {
  const r = await revokeInvite(userId, id, meta);
  refresh();
  return r;
});

export const setUserStatusAction = adminAction(
  z.object({ id: z.uuid(), status: z.enum(["active", "disabled"]) }),
  async ({ id, status }, { userId, meta }) => {
    const r = await setUserStatus(userId, id, status, meta);
    refresh();
    return r;
  },
);

export const setUserRoleAction = adminAction(z.object({ id: z.uuid(), role: z.enum(["user", "admin"]) }), async ({ id, role }, { userId, meta }) => {
  const r = await setUserRole(userId, id, role, meta);
  refresh();
  return r;
});

export const createResetLinkAction = adminAction(z.object({ id: z.uuid() }), async ({ id }, { userId, meta }) => {
  await enforceRateLimit(`admin-reset:${userId}`, 30, 3600, "Too many reset links created recently. Try again later.");
  return adminCreateResetLink(userId, id, meta);
});
