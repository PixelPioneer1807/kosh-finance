import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { Logo } from "@/components/app/logo";
import { RetryButton } from "./retry-button";

export const metadata: Metadata = { title: "Offline" };

/** Static fallback served by the service worker when a page can't be loaded. No auth, no data. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-16 text-center">
      <Logo className="mb-10" />
      <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <WifiOff className="size-5" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">You&apos;re offline</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Kosh needs a connection to load your data and save changes. Nothing you&apos;ve already saved is lost — reconnect and try again.
      </p>
      <RetryButton />
    </main>
  );
}
