/**
 * Local scheduler: calls the cron endpoint every minute, like a production scheduler would.
 *   npm run cron:local            (expects `npm run dev` on http://localhost:3210)
 *   CRON_URL=http://localhost:3000/api/cron/tick npm run cron:local
 *
 * Production scheduling
 * - vercel.json registers a daily Vercel Cron (Hobby plans allow one run per day, at an imprecise
 *   time within the hour). Vercel sends `Authorization: Bearer $CRON_SECRET` automatically.
 * - Hourly (or more frequent) runs need Vercel Pro, or any external scheduler hitting the endpoint
 *   with the secret, e.g. GitHub Actions:
 *       on: { schedule: [{ cron: "0 * * * *" }] }
 *       jobs: { tick: { runs-on: ubuntu-latest, steps: [{ run: 'curl -fsS -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" https://your-app/api/cron/tick' }] } }
 *   or cron-job.org with a custom "Authorization" header.
 * - Reminders also run lazily (throttled to every 15 minutes per user) whenever a signed-in user
 *   loads the app, so the daily cron is enough for housekeeping and users who never open the app.
 */
import "./_env";

const URL_ = process.env.CRON_URL ?? "http://localhost:3210/api/cron/tick";
const SECRET = process.env.CRON_SECRET;
const EVERY_MS = 60_000;

async function tick() {
  const started = Date.now();
  try {
    const r = await fetch(URL_, { headers: { Authorization: `Bearer ${SECRET}` } });
    const body = await r.json().catch(() => ({}));
    const stamp = new Date().toLocaleTimeString();
    if (!r.ok) console.warn(`[${stamp}] ${r.status}`, body.error ?? "");
    else
      console.log(
        `[${stamp}] users=${body.users} skipped=${body.skipped} notifications=${body.notifications} pushed=${body.pushed} posted=${body.posted} errors=${body.errors} (${Date.now() - started} ms)`,
      );
  } catch (e) {
    console.warn(`[${new Date().toLocaleTimeString()}] can't reach ${URL_} — is the dev server running?`, e instanceof Error ? e.message : "");
  }
}

if (!SECRET) {
  console.error("✗ CRON_SECRET is not set (add it to .env.local).");
  process.exit(1);
}
console.log(`Calling ${URL_} every ${EVERY_MS / 1000}s. Ctrl+C to stop.`);
void tick();
setInterval(tick, EVERY_MS);
