/* 语卡 service worker — network-first for app code so updates land immediately */
const CACHE = 'yuka-v104';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=104',
  './core.js?v=104',
  './sync.js?v=104',
  './app.js?v=104',
  './movies.js?v=104',
  './movie-path.json?v=104',
  './song-path.json?v=104',
  ...[1, 2, 3, 4, 5, 6, 7].map(step => `./reading/${step}.json?v=104`),
  './manifest.webmanifest',
  './seed.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('yuka-v') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
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
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  const isCode = /\.(html|css|js|webmanifest|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isCode) {
    e.respondWith(
      fetch(request, { cache: 'no-cache' }).then(async response => {
        if (!response.ok) throw new Error(`App asset returned ${response.status}`);
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone()).catch(() => {});
        return response;
      }).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(request))
          || (request.mode === 'navigate' && await cache.match('./index.html'))
          || Response.error();
      })
    );
    return;
  }
  e.respondWith(caches.match(request).then(cached => cached || fetch(request).then(r => {
    const cp = r.clone(); caches.open(CACHE).then(c => c.put(request, cp)); return r;
  })));
});
