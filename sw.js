const CACHE_NAME = "day-planner-v3-1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=31",
  "./app.js?v=31",
  "./manifest.webmanifest?v=31",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : Promise.reject()));

      // Navigation and source files prefer the network so updates arrive promptly.
      if (event.request.mode === "navigate" || /\.(?:js|css|webmanifest)$/.test(new URL(event.request.url).pathname)) {
        return network;
      }
      return cached || network;
    })
  );
});
