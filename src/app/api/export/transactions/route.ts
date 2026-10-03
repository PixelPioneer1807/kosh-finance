import { userRoute } from "@/server/safe";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { getPreferences } from "@/server/services/preferences";
import { transactionCsvChunks, transactionFiltersFromParams } from "@/server/services/exports";

/**
 * CSV of transactions matching the same filters as the Transactions page (see
 * `transactionFiltersFromParams`). Streams page by page so large exports stay memory-flat.
 */
export const GET = userRoute(async (req, { userId }) => {
  await enforceRateLimit(`export:tx:${userId}`, 30, 3600, "Too many exports. Try again in a little while.");
  const prefs = await getPreferences(userId);
  const filters = transactionFiltersFromParams(new URL(req.url).searchParams, prefs);
  const chunks = transactionCsvChunks(userId, filters, prefs.currency);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (e) {
        console.error("[export] transactions failed", e);
        controller.error(e);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  const name = `kosh-transactions-${filters.from ?? "all"}${filters.to ? `-to-${filters.to}` : ""}.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
