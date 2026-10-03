import { NextResponse } from "next/server";
import { z } from "zod";
import { userRoute } from "@/server/safe";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { pushSubscriptionInput, subscribePush, unsubscribePush } from "@/server/services/push";

/** Register this device for Web Push. */
export const POST = userRoute(async (req, { userId, meta }) => {
  await enforceRateLimit(`push-subscribe:${userId}`, 20, 3600);
  const input = pushSubscriptionInput.parse(await req.json().catch(() => null));
  await subscribePush(userId, input, meta.userAgent);
  return NextResponse.json({ ok: true });
});

/** Remove this device's subscription (only ever the caller's own). */
export const DELETE = userRoute(async (req, { userId }) => {
  const { endpoint } = z.object({ endpoint: z.string().min(10).max(1000) }).parse(await req.json().catch(() => null));
  await unsubscribePush(userId, endpoint);
  return NextResponse.json({ ok: true });
});
