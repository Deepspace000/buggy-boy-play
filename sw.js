// Buggy Boy offline cache (made by tools/build_pages.mjs)
const CACHE = 'buggyboy-76f0465e0924';
const FILES = ['./', 'index.html', 'game.bin', 'sid-worklet.js', 'manifest.webmanifest',
               'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-64.png',
               'icon-maskable-192.png', 'icon-maskable-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('buggyboy-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  if (!own && !/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = own ? url.origin + url.pathname : req;
    const hit = await cache.match(key);
    const net = (own ? fetch(key, { cache: 'no-cache' }) : fetch(req)).then(async (res) => {
      if (res.redirected) res = new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
      if (res.ok || res.type === 'opaque') await cache.put(key, res.clone());
      return res;
    });
    if (!hit) return net;
    e.waitUntil(net.catch(() => {}));
    return Promise.race([net.catch(() => hit), new Promise((r) => setTimeout(() => r(hit), 4000))]);
  })());
});
