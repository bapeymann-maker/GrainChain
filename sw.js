// sw.js
// Caches the app shell (HTML/JS/CSS) so the kiosk can launch and run with
// zero connectivity. Data (loads, reference tables) is handled separately
// by db.js/sync.js via IndexedDB — this service worker is only responsible
// for making sure the app itself always loads.

const CACHE_NAME = "kiosk-shell-v12";
const SHELL_FILES = [
  "/index.html",
  "/manifest.json",
  "/src/db.js",
  "/src/sync.js",
  "/src/app.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache Supabase API calls — those are handled online/offline
  // by sync.js's own queueing logic, not by the service worker.
  if (url.hostname.endsWith("supabase.co")) return;

  // Cache-first for the app shell; falls back to network for anything
  // not pre-cached (e.g. during development).
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
