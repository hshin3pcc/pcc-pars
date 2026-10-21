/* Service worker: cache the app shell so capture works fully OFFLINE at the rehearsal hall.
   Data lives in localStorage, never here.
   BUMP CACHE whenever index.html gains an element a script relies on: the per-file background refresh
   below can leave an OLD page with a NEW script for one load (2026-10-21: app.js threw on a button the
   cached index.html didn't have yet → blank app). A new CACHE name installs the whole shell at once,
   and index.html reloads itself when the new worker takes over, so the swap is atomic. */
const CACHE = 'pars-pwa-v2';
const SHELL = ['./', 'index.html', 'style.css', 'core.js', 'app.js', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Stale-while-revalidate: serve the cached shell instantly (fast + offline), but ALSO refetch in the
// background and update the cache, so a redeployed fix is picked up on the next online open — no need to
// remember to bump CACHE for every shell edit.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then((cache) =>
    cache.match(e.request).then((hit) => {
      const fetched = fetch(e.request)
        .then((res) => { cache.put(e.request, res.clone()).catch(() => {}); return res; })
        .catch(() => hit || cache.match('index.html'));
      e.waitUntil(fetched.catch(() => {}));   // keep the SW alive to finish the background refresh
      return hit || fetched;
    })
  ));
});
