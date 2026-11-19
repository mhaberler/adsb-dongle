// Service worker template - turned into dist/sw.js by the build (see
// vite.config.ts serviceWorker()), which fills in __VERSION__ and
// __ASSETS__. Not bundled, not type-checked: plain JS on purpose.
//
// Offline-first: every file of the build is precached on install, and
// same-origin GETs are answered from that cache (network only as fallback).
// Map tiles and the aircraft database are cross-origin and go straight to
// the network - they have their own IndexedDB caches (tile-cache.ts,
// aircraft-db.ts).

const CACHE = "adsb-__VERSION__";
const ASSETS = __ASSETS__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const path of ASSETS) {
        const url = new URL(path, self.registration.scope);
        // cache: "reload" bypasses the HTTP cache so the new version is
        // really fetched. A redirect means the server's login gate answered
        // instead of the file - fail the install rather than cache the
        // login page; the old version stays active.
        const res = await fetch(url, { cache: "reload", credentials: "same-origin" });
        if (!res.ok || res.redirected) throw new Error(`precache failed: ${path}`);
        await cache.put(url, res);
      }
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("adsb-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Any page navigation inside the scope gets the app shell.
      const key = req.mode === "navigate" ? new URL("./", self.registration.scope) : req;
      // ignoreVary: servers may send "Vary: Origin"; the module script and
      // stylesheet requests carry an Origin header (crossorigin attribute),
      // the precache fetches don't - without it nothing matches offline.
      const hit = await cache.match(key, { ignoreSearch: req.mode === "navigate", ignoreVary: true });
      return hit ?? fetch(req);
    })(),
  );
});
