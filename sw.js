const CACHE_NAME = "beluga-planner-v3-6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=36",
  "./app.js?v=36",
  "./manifest.webmanifest?v=36",
  "./icons/icon-192.png?v=36",
  "./icons/icon-512.png?v=36",
  "./icons/icon-1024.png?v=36",
  "./icons/apple-touch-icon.png?v=36",
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
