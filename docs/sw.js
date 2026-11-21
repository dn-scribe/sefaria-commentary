// Offline app shell. Precaches every static file under a cache named after
// SC.APP_VERSION, so shipping a new version swaps the whole cache atomically.
// Sefaria text is NOT cached here - it lives in IndexedDB (see api.js).
self.window = self; // version.js assigns onto window.SC
importScripts("js/version.js");

const CACHE = "sc-shell-" + self.SC.APP_VERSION;
const SHELL = self.SC.SHELL_FILES;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache: "reload" bypasses the HTTP cache so a new version never
      // precaches stale files.
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sc-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === "navigate") return caches.match("index.html");
      return fetch(req);
    })
  );
});
