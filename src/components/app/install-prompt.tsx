"use client";

import * as React from "react";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/app/logo";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "kosh:install-dismissed-at";
const DISMISS_DAYS = 30;
const SHOW_AFTER_MS = 20_000;

/* A tiny module-level store: `beforeinstallprompt` fires once, early, so capture it as soon as this module loads. */
let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emit();
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
function isIOS() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/** Install state + action, usable anywhere (e.g. a Settings "Install app" button). */
export function useInstallPrompt() {
  const snapshot = React.useSyncExternalStore(
    subscribe,
    () => (installed ? "installed" : deferred ? "available" : "none"),
    () => "none" as const,
  );
  const [env, setEnv] = React.useState<{ standalone: boolean; ios: boolean }>({ standalone: false, ios: false });
  React.useEffect(() => {
    const t = setTimeout(() => setEnv({ standalone: isStandalone(), ios: isIOS() }), 0);
    return () => clearTimeout(t);
  }, []);
  const install = React.useCallback(async () => {
    const e = deferred;
    if (!e) return "unavailable" as const;
    await e.prompt();
    const { outcome } = await e.userChoice;
    deferred = null;
    emit();
    return outcome;
  }, []);
  return {
    canInstall: snapshot === "available" && !env.standalone,
    installed: snapshot === "installed" || env.standalone,
    /** iOS has no install event — show "Share → Add to Home Screen" instructions instead. */
    needsIOSInstructions: env.ios && !env.standalone,
    install,
  };
}

function recentlyDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

/**
 * Non-intrusive install suggestion: appears after the user has spent a little time in the app,
 * never on first paint, and stays dismissed for 30 days. Mount once in the app layout.
 */
export function InstallPrompt() {
  const { canInstall, installed, needsIOSInstructions, install } = useInstallPrompt();
  const [ready, setReady] = React.useState(false);
  const [hidden, setHidden] = React.useState(true);

  React.useEffect(() => {
    const t = setTimeout(() => {
      setHidden(recentlyDismissed());
      setReady(true);
    }, SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* private mode */
    }
  };

  if (!ready || hidden || installed || (!canInstall && !needsIOSInstructions)) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="install-title"
      className="no-print fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-sm rounded-xl border bg-popover p-4 shadow-lg animate-in lg:inset-x-auto lg:right-6 lg:bottom-6"
    >
      <div className="flex items-start gap-3">
        <LogoMark className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <p id="install-title" className="text-sm font-medium">
            Install Kosh
          </p>
          {canInstall ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground">Open it from your home screen or dock, full screen, with reminders.</p>
          ) : (
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Tap <Share className="inline size-3.5 align-[-2px]" aria-label="Share" /> <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1 text-muted-foreground" onClick={dismiss} aria-label="Dismiss">
          <X />
        </Button>
      </div>
      {canInstall && (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Not now
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const outcome = await install();
              if (outcome !== "accepted") dismiss();
            }}
          >
            <Download /> Install
          </Button>
        </div>
      )}
    </div>
  );
}
