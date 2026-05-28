// Service Worker for the Kitchen Display System.
//
// Goals:
//   1. Cache the app shell so the kiosk keeps rendering through WiFi blips.
//   2. Fall back to the last successful /api/orders/active response when the
//      network is unreachable — kitchen sees stale data + OFFLINE banner
//      rather than a white screen.
//
// We DO NOT queue mutations (status changes) offline in Phase 1. Replaying a
// stale "mark ready" tap against an order the manager already cancelled is
// worse than blocking the action and showing OFFLINE.

const SHELL_CACHE = "kds-shell-v1";
const ORDERS_CACHE = "kds-orders-v1";
const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ORDERS_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    // Mutations always hit the network. If they fail, the UI surfaces the
    // OFFLINE banner — we don't try to be clever.
    return;
  }

  // Special-case the active-orders endpoint: network-first, fall back to
  // cache; tag the cache response so the UI can show "STALE — last seen".
  if (url.pathname === "/api/orders/active") {
    event.respondWith(networkFirstWithCache(request));
    return;
  }

  // Shell + assets: cache-first, network as backup.
  if (request.mode === "navigate" || SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request))
    );
  }
});

async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const clone = response.clone();
      caches.open(ORDERS_CACHE).then((cache) => cache.put(request, clone));
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-KDS-Stale", "true");
      const body = await cached.text();
      return new Response(body, {
        status: 200,
        headers
      });
    }
    return new Response(
      JSON.stringify({ orders: [], server_now: new Date().toISOString(), offline: true }),
      { status: 503, headers: { "Content-Type": "application/json", "X-KDS-Stale": "offline" } }
    );
  }
}
