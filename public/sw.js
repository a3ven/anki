const V = "v3";
const SHELL = ["/", "/manifest.json", "/icon.svg"];
const LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js",
  "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm",
];
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(V).then(async (c) => {
      await c.addAll(SHELL);
      await Promise.all(LIBS.map((u) => c.add(u).catch(() => {})));
    })
  );
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.pathname.startsWith("/api/")) return;
  if (r.mode === "navigate") {
    e.respondWith(
      fetch(r).then((x) => { const cp = x.clone(); caches.open(V).then((c) => c.put("/", cp)); return x; })
        .catch(() => caches.match("/"))
    );
    return;
  }
  e.respondWith(
    caches.match(r).then((h) => h || fetch(r).then((x) => {
      if (x.ok) { const cp = x.clone(); caches.open(V).then((c) => c.put(r, cp)); }
      return x;
    }))
  );
});
