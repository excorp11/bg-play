// BG Play offline app: keeps every file the game needs on the device, so it opens and plays with no connection.
// Cache first; a new version is fetched in the background when online and taken on the next start (or via the
// page's "A new version is ready" button).
const VERSION = '2026.11.25-e3089f3f';
const CACHE = 'bgplay-' + VERSION;
const FILES = ["./", "index.html", "app.webmanifest", "rules.js", "app.js", "worker.js", "review.html", "review.js", "pa-worker.js", "engine.js", "engine.wasm", "manifest.json", "weights-bundle.wasm", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('bgplay-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./') : null);
    if (hit) return hit;
    try { return await fetch(req); } catch (err) { return (await cache.match('./')) || Response.error(); }
  })());
});
