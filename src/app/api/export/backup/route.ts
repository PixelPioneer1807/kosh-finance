import { userRoute } from "@/server/safe";
import { db } from "@/server/db";
import { auditLogs } from "@/server/db/schema";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { exportUserData } from "@/server/services/backup";

export const dynamic = "force-dynamic";

/** Full JSON backup of the signed-in user's data, as a file download. */
export const GET = userRoute(async (_req, { userId, meta }) => {
  await enforceRateLimit(`backup-export:${userId}`, 20, 3600, "You've exported a lot recently. Try again in a while.");
  const data = await exportUserData(userId);
  await db.insert(auditLogs).values({ actorId: userId, targetUserId: userId, action: "data.exported", meta: { transactions: data.transactions.length }, ipAddress: meta.ip });
  const stamp = data.exportedAt.slice(0, 10);
  return new Response(JSON.stringify(data, null, 1), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="kosh-backup-${stamp}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
