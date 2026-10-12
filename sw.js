/* ==========================================================
   Trainer — service worker (makes the app work offline)
   Strategy: the app files open at once from the saved copy and are
   refreshed in the background. A new release (new CACHE name) is
   downloaded completely on install, then the page reloads quietly.
   plan.json still tries the internet first (the app also keeps a copy).
   ========================================================== */
const CACHE = 'trainer-v31';
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
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
    // 'no-cache' = always ask the server if there is a newer version
    const network = withTimeout(fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })), 5000)
      .then((res) => { if (res && res.ok) cache.put(key, res.clone()); return res; });
    const cached = await cache.match(key);
    // app files: show the saved copy now, update it for next time
    if (cached && !/\/(plan|activities)\.json$/.test(url.pathname)) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    try {
      return await network;
    } catch (err) {
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = (await cache.match(url.origin + url.pathname.replace(/[^/]*$/, ''))) || (await cache.match('./index.html'));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
