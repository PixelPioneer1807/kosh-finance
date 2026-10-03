"use client";

import * as React from "react";
import { WifiOff } from "lucide-react";

function subscribe(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/** Thin banner shown while the device is offline. Changes can't be saved offline, so say so plainly. */
export function OfflineBanner() {
  const online = React.useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  return (
    <div role="status" aria-live="polite" className="no-print">
      {!online && (
        <div className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-warning px-4 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-center text-[13px] font-medium text-white shadow-sm dark:text-black">
          <WifiOff className="size-3.5 shrink-0" aria-hidden />
          <span>You&apos;re offline. You can browse open pages, but changes won&apos;t be saved until you reconnect.</span>
        </div>
      )}
    </div>
  );
}
