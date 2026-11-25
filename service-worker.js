// Schooled service worker: keeps the app opening when offline.
// Network first, so new uploads show up right away; falls back to the saved copy.
const CACHE = 'schooled-shell-v133';
const SHELL = [
  'species.json',
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'logo-mark.png',
  'logo-schooled.png',
  'logo-wordmark.jpg',
  'logo-banner.jpg',
  'logo-watermark.png',
  'icon-maskable.png',
  'example-tank.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only handle our own files. Photo scans to the Worker are never cached.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'no-cache' }) // always check with the server, so a new page never pairs with an old app.js from the browser's own cache
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
