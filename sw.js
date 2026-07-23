/* 语卡 service worker — network-first for app code so updates land immediately */
const CACHE = 'yuka-v16';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './app.js',
  './manifest.webmanifest',
  './seed.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

// Network-first for HTML/CSS/JS/seed so a reload always fetches fresh code when online,
// falling back to cache when offline. Static icons stay cache-first.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isCode = /\.(html|css|js|webmanifest|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isCode) {
    e.respondWith(
      fetch(request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(request, cp)); return r; })
        .catch(() => caches.match(request).then(c => c || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(caches.match(request).then(cached => cached || fetch(request).then(r => {
    const cp = r.clone(); caches.open(CACHE).then(c => c.put(request, cp)); return r;
  })));
});
