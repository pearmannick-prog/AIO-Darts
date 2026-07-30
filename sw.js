// sw.js - service worker, purely so the app can be installed and still open
// without a connection. It is NOT a performance optimisation.
//
// Strategy: NETWORK FIRST, cache as fallback.
//
// That choice matters. The obvious PWA pattern is cache-first, which is
// faster - but this app is deployed continuously, and cache-first would
// happily serve yesterday's JavaScript to someone who just pushed a fix,
// producing exactly the kind of "I changed it and nothing happened" bug
// that's miserable to diagnose. Network-first means an online player always
// gets current code; the cache only steps in when the network doesn't answer.
//
// The app is a few hundred KB of static files, so the cost of going to the
// network every load is negligible.

const CACHE = "aio-darts-v1";

// Cached up front so a first-run install works offline immediately, rather
// than only after the player has happened to load each file once.
const PRECACHE = [
  "./",
  "./index.html",
  "./game.js",
  "./online.js",
  "./granboard.js",
  "./scoring.js",
  "./cricket.js",
  "./medley.js",
  "./dartboard.js",
  "./quickentry.js",
  "./version.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  // Take over straight away rather than waiting for every existing tab to
  // close - otherwise a fixed bug can sit unapplied for days.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Individually, so one missing file can't fail the whole install.
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GETs are cacheable, and only this origin - fonts and any other
  // cross-origin request are left entirely alone rather than stored as
  // opaque responses of unknown validity.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Runtime config and the build stamp must never come from cache - a stale
  // signalingUrl would point players at the wrong server, and a stale
  // version.json would misreport which build is running.
  const alwaysFresh = url.pathname.endsWith("/config.json") || url.pathname.endsWith("/version.json");

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && !alwaysFresh) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // A navigation with nothing cached for that exact URL still gets
          // the app shell, so the installed app opens offline instead of
          // showing a browser error page.
          if (request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
