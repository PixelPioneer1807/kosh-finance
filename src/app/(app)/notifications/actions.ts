"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import { AppError } from "@/server/errors";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { markRead, notify } from "@/server/services/notifications";
import { markPushed, pushConfigured, sendPushToUser } from "@/server/services/push";

/** Creates an in-app notification and pushes it to all of the caller's devices (bypasses quiet hours/cap). */
export const sendTestNotificationAction = userAction(z.object({}).optional(), async (_input, { userId }) => {
  await enforceRateLimit(`push-test:${userId}`, 5, 600, "You've sent a few test notifications already. Try again in a few minutes.");
  if (!pushConfigured()) throw new AppError("UNAVAILABLE", "Push notifications aren't configured on this server.");
  const id = await notify(userId, {
    type: "system",
    title: "Test notification",
    body: "Push notifications are working on this device.",
    link: "/notifications",
    dedupeKey: `test:${Date.now()}`,
  });
  const r = await sendPushToUser(userId, {
    title: "Test notification",
    body: "Push notifications are working on this device.",
    url: "/notifications",
    tag: id ? `kosh-${id}` : "kosh-test",
  });
  if (id && r.sent > 0) await markPushed(userId, [id]);
  refresh();
  return { sent: r.sent, failed: r.failed + r.removed };
});

export const markNotificationsReadAction = userAction(z.object({ ids: z.array(z.uuid()).max(200).optional() }), async ({ ids }, { userId }) => {
  await markRead(userId, ids);
  refresh();
  return null;
});
