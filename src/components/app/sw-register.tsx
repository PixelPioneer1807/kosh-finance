"use client";

import * as React from "react";
import { toast } from "sonner";

const ENABLED = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_SW === "1";

/**
 * Registers /sw.js (production, or dev with NEXT_PUBLIC_ENABLE_SW=1) and offers a reload when a
 * new version is waiting. Mount once in the authenticated app layout. Renders nothing.
 */
export function ServiceWorkerRegister() {
  React.useEffect(() => {
    if (!ENABLED || !("serviceWorker" in navigator)) return;
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    const promptUpdate = (worker: ServiceWorker) => {
      toast("A new version of Kosh is available", {
        duration: Infinity,
        action: {
          label: "Reload",
          onClick: () => {
            navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
            worker.postMessage({ type: "SKIP_WAITING" });
          },
        },
      });
    };

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          sw?.addEventListener("statechange", () => {
            // Only prompt for updates — not on the very first install.
            if (sw.state === "installed" && navigator.serviceWorker.controller) promptUpdate(sw);
          });
        });
        // Check for updates when the app comes back to the foreground.
        const onVisible = () => document.visibilityState === "visible" && reg.update().catch(() => {});
        document.addEventListener("visibilitychange", onVisible);
      } catch (e) {
        console.warn("[sw] registration failed", e);
      }
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", () => void register(), { once: true });
  }, []);
  return null;
}
