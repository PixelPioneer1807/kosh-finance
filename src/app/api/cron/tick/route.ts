import { NextResponse } from "next/server";
import { safeEqual } from "@/server/auth/tokens";
import { runCronTick } from "@/server/services/cron";

/**
 * Scheduled tick: reminders, push delivery, snapshots and housekeeping for every active user.
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron sends this automatically when the
 * CRON_SECRET env var is set). Responses carry aggregate counts only.
 */
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

function isAuthorizedCron(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  return safeEqual(header, `Bearer ${secret}`);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    return NextResponse.json({ error: "Cron is not configured." }, { status: 503, headers: noStore });
  }
  if (!isAuthorizedCron(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  }
  try {
    const r = await runCronTick({ timeBudgetMs: 45_000 });
    return NextResponse.json(
      {
        ok: true,
        users: r.users,
        skipped: r.skipped,
        notifications: r.notifications,
        pushed: r.pushed,
        posted: r.posted,
        snapshots: r.snapshots,
        errors: r.errors,
        housekeeping: r.housekeeping,
        durationMs: r.durationMs,
      },
      { headers: noStore },
    );
  } catch (e) {
    console.error("[cron] tick failed", e);
    return NextResponse.json({ ok: false, error: "Tick failed." }, { status: 500, headers: noStore });
  }
}
