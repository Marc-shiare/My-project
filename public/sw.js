const shellCache = "claims-shell-v1";
const dynamicCache = "claims-dynamic-v1";
const shellAssets = ["/", "/app.css", "/app.js", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(shellCache).then((cache) => cache.addAll(shellAssets)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![shellCache, dynamicCache].includes(key))
          .map((key) => caches.delete(key)),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === "GET" && url.origin === self.location.origin && shellAssets.includes(url.pathname === "/" ? "/" : url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(dynamicCache).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request)),
    );
  }
});
