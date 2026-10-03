"use client";

import * as React from "react";
import { BellRing, Info, Send, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { useAppData } from "@/components/app/user-context";
import { sendTestNotificationAction } from "@/app/(app)/notifications/actions";

type Status = "checking" | "unsupported" | "ios-install" | "not-configured" | "denied" | "off" | "on";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIOS() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Service worker did not start")), 10_000)),
  ]);
}

async function postSubscription(sub: PushSubscription) {
  const r = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? "Couldn't save this device.");
  }
}

/**
 * Per-device Web Push opt-in. Explains the value first; the browser permission prompt only
 * appears after the user explicitly asks for it.
 */
export function PushToggle() {
  const { vapidPublicKey } = useAppData();
  const [status, setStatus] = React.useState<Status>("checking");
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const set = (s: Status) => !cancelled && setStatus(s);
      if (typeof window === "undefined") return;
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (isIOS() && !isStandalone()) return set("ios-install");
      if (!supported) return set("unsupported");
      if (!vapidPublicKey) return set("not-configured");
      if (Notification.permission === "denied") return set("denied");
      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = await reg?.pushManager.getSubscription();
        if (sub && Notification.permission === "granted") {
          // Re-sync so the server and this device agree (e.g. after signing in as someone else here).
          postSubscription(sub).catch(() => {});
          return set("on");
        }
      } catch {
        /* fall through */
      }
      set("off");
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey]);

  async function enable() {
    if (!vapidPublicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setStatus("denied");
        return;
      }
      if (permission !== "granted") {
        toast("Notifications weren't enabled", { description: "You can turn them on any time from here." });
        return;
      }
      const reg = await getRegistration();
      const key = urlBase64ToUint8Array(vapidPublicKey);
      let sub: PushSubscription;
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch (e) {
        // A subscription made with an old server key blocks a new one — replace it.
        const old = await reg.pushManager.getSubscription();
        if (!old) throw e;
        await old.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      try {
        await postSubscription(sub);
      } catch (e) {
        await sub.unsubscribe().catch(() => {});
        throw e;
      }
      setStatus("on");
      toast.success("Push notifications are on for this device");
    } catch (e) {
      toast.error("Couldn't turn on notifications", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setStatus("off");
      toast("Push notifications are off for this device");
    } catch {
      toast.error("Couldn't turn off notifications. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    const r = await sendTestNotificationAction(undefined);
    setTesting(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.sent > 0) toast.success("Test notification sent", { description: "It should arrive in a few seconds." });
    else toast.error("No device received it", { description: "Turn notifications off and on again on this device." });
  }

  const checked = status === "on";
  const canToggle = status === "on" || status === "off";

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground" aria-hidden>
          <BellRing className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <label htmlFor="push-toggle" className="text-sm font-medium">
            Push notifications on this device
          </label>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Get bill reminders, budget alerts and your daily nudge even when Kosh is closed. Quiet hours and your daily limit always apply.
          </p>
        </div>
        <Switch
          id="push-toggle"
          checked={checked}
          disabled={!canToggle || busy}
          onCheckedChange={(v) => (v ? enable() : disable())}
          aria-describedby="push-status"
          className="mt-1"
        />
      </div>

      <div id="push-status" aria-live="polite">
        {status === "ios-install" && (
          <Notice icon={<Smartphone />}>
            On iPhone and iPad, notifications work once Kosh is on your Home Screen: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>, and open
            Kosh from there (iOS 16.4 or later).
          </Notice>
        )}
        {status === "unsupported" && <Notice icon={<Info />}>This browser doesn&apos;t support push notifications. You&apos;ll still see everything in the bell.</Notice>}
        {status === "not-configured" && <Notice icon={<Info />}>Push notifications aren&apos;t set up on this server yet.</Notice>}
        {status === "denied" && (
          <Notice icon={<Info />}>
            Notifications are blocked for this site. Allow them in your browser&apos;s site settings (the icon next to the address bar), then reload this page.
          </Notice>
        )}
        {status === "off" && (
          <p className="text-[13px] text-muted-foreground">Your browser will ask for permission when you turn this on. You can turn it off any time.</p>
        )}
        {status === "on" && (
          <Button variant="outline" size="sm" onClick={sendTest} loading={testing}>
            <Send /> Send test notification
          </Button>
        )}
      </div>
    </div>
  );
}

function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5 text-[13px] text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
      {icon}
      <p>{children}</p>
    </div>
  );
}
