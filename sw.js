/* Catan Companion — service worker
 *
 * NETWORK-FIRST strategy. Users always get the latest version on reload
 * (so bug fixes deploy quickly), with cache fallback only when offline.
 * The previous version used cache-first, which trapped users on broken
 * builds across deployments.
 *
 * Bump CACHE_VERSION whenever you ship — old caches get evicted on activate.
 */
const CACHE_VERSION = 'v3-2026-05';
const CACHE = 'catan-companion-' + CACHE_VERSION;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'godice-adapter.js',
  'godice.js',
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
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // never intercept CDN URLs
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request).then(c => c || caches.match('./')))
  );
});
