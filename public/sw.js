/* Kosh service worker.
 *
 * Caching policy (privacy first — this is a finance app):
 * - Navigations: network-first; when offline, show the static /offline page. Authenticated HTML
 *   is never written to the cache.
 * - Static assets (/_next/static, /icons, manifest): cache-first (they are content-hashed / immutable).
 * - API responses and everything else: never cached; the browser handles them normally.
 * Bump VERSION to drop old caches on the next activation.
 */
const VERSION = "kosh-v1";
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_CACHE = `${VERSION}-offline`;
const OFFLINE_URL = "/offline";
const MAX_STATIC_ENTRIES = 300;
const PRECACHE = ["/icons/icon.svg", "/icons/icon-192.png", "/icons/badge-72.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const staticCache = await caches.open(STATIC_CACHE);
      await staticCache.addAll(PRECACHE).catch(() => {});
      // Cache the offline page plus the CSS/JS it needs to render.
      try {
        const res = await fetch(OFFLINE_URL, { cache: "no-store", credentials: "omit" });
        if (res.ok) {
          const html = await res.clone().text();
          await (await caches.open(OFFLINE_CACHE)).put(OFFLINE_URL, res);
          const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)]+/g) || [])];
          await Promise.all(assets.map((a) => staticCache.add(a).catch(() => {})));
        }
      } catch {
        /* offline during install — the fallback below degrades to a plain response */
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest";

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

async function offlineFallback() {
  const cached = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
  return (
    cached ||
    new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Offline</title><p style='font:15px system-ui;padding:2rem'>You're offline. Reconnect to keep using Kosh.</p>", {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache API responses

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const preload = await event.preloadResponse;
          if (preload) return preload;
          return await fetch(req);
        } catch {
          return offlineFallback();
        }
      })(),
    );
    return;
  }

  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req, { cacheName: STATIC_CACHE });
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok && res.type === "basic") {
          const cache = await caches.open(STATIC_CACHE);
          await cache.put(req, res.clone());
          event.waitUntil(trim(STATIC_CACHE, MAX_STATIC_ENTRIES));
        }
        return res;
      })(),
    );
  }
});

/* ───────────── Push ───────────── */

const safePath = (u) => (typeof u === "string" && u.startsWith("/") && !u.startsWith("//") && !/[\\\s]/.test(u) ? u : "/dashboard");

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Kosh", body: event.data ? event.data.text() : "" };
  }
  const title = (data.title || "Kosh").slice(0, 120);
  event.waitUntil(
    self.registration.showNotification(title, {
      body: (data.body || "").slice(0, 300),
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: data.tag || undefined,
      data: { url: safePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (same) {
        await same.focus();
        if ("navigate" in same) return same.navigate(target).catch(() => self.clients.openWindow(target));
        return;
      }
      return self.clients.openWindow(target);
    })(),
  );
});

// The browser rotated the subscription: re-register it with the same server key.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const opts = event.oldSubscription && event.oldSubscription.options;
      if (!opts || !opts.applicationServerKey) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: opts.applicationServerKey });
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
    })().catch(() => {}),
  );
});
