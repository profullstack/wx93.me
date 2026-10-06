// wx93 service worker. Static assets: cache first, refreshed in the background.
// Pages: network first, with the last copy (or /offline) when there is no network.
// Short links and the API are never touched: a redirect must always be live.
const VERSION = 'wx93-v1';
const ASSETS = ['/assets/app.css', '/assets/app.js', '/logo.svg', '/favicon.svg', '/icons/icon-192.png', '/manifest.webmanifest', '/offline'];
const PAGES = ['/', '/pricing', '/docs', '/account', '/signin', '/signup', '/desktop', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (ASSETS.includes(url.pathname) || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit ?? fresh;
      }),
    );
    return;
  }
  if (req.mode === 'navigate' && PAGES.includes(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) ?? (await caches.match('/offline')) ?? Response.error()),
    );
  }
});
