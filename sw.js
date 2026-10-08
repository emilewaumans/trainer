/* ==========================================================
   Trainer — service worker (makes the app work offline)
   Strategy: always try the internet first so you get the newest
   plan and app; if there is no connection, use the saved copy.
   ========================================================== */
const CACHE = 'trainer-v20';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './plan.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = url.origin + url.pathname; // ignore ?query so the cache stays small
    try {
      // 'no-cache' = always ask the server if there is a newer version
      const res = await withTimeout(fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })), 5000);
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(key);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = (await cache.match(url.origin + url.pathname.replace(/[^/]*$/, ''))) || (await cache.match('./index.html'));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
