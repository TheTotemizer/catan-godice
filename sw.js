/* Catan Companion — minimal service worker
 * Caches the app shell so it can launch offline once visited.
 * Bluetooth pairing of course requires being online (browser permission UI),
 * but everything else (manual mode, score tracking, stats) works offline.
 */
const CACHE = 'catan-companion-v1';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'godice-adapter.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for jsDelivr (so we get fresh godice.js if available),
  // cache-first for our own assets.
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(c => c || fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match('./')))
    );
  }
});
