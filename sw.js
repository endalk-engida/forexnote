/**
 * FX Journal — Service Worker (sw.js)
 * Implements Cache-First strategy for app shell assets.
 * Network requests for Google APIs always go live.
 */

const CACHE_NAME    = 'fx-journal-v2';
const CACHE_TIMEOUT = 3000; // ms before falling back to cache

// App shell assets to pre-cache on install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './icon-192.png',
  './icon-512.png',
  // CDN assets are cached on first fetch (runtime caching)
];

/* ── Install: pre-cache app shell ── */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing…');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching app shell');
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

/* ── Activate: clean up old caches ── */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: serve from cache, update in background ── */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept — always let these go straight to network:
  //   • Google APIs / auth
  //   • CORS proxy services (allorigins, corsproxy, etc.)
  //   • Gemini / generativelanguage
  //   • CDN resources (unpkg, cdnjs, tailwind, fonts)
  const PASSTHROUGH_HOSTS = [
    'googleapis.com',
    'accounts.google.com',
    'generativelanguage.googleapis.com',
    'allorigins.win',
    'api.allorigins.win',
    'corsproxy.io',
    'thingproxy.freeboard.io',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'cdn.tailwindcss.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
  ];

  if (PASSTHROUGH_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    // CDN assets only: cache on first fetch so they work offline
    const isCDN = ['unpkg.com','cdnjs.cloudflare.com','cdn.tailwindcss.com',
                    'fonts.googleapis.com','fonts.gstatic.com'].some(
                      h => url.hostname === h || url.hostname.endsWith('.' + h));
    if (isCDN) {
      event.respondWith(
        caches.open(CACHE_NAME).then(cache =>
          cache.match(event.request).then(cached => {
            const fetchPromise = fetch(event.request).then(res => {
              if (res.ok) {
                const toCache = res.clone(); // clone BEFORE consuming
                cache.put(event.request, toCache);
              }
              return res;
            }).catch(() => cached);
            return cached || fetchPromise;
          })
        )
      );
    }
    // All other passthrough (Google APIs, proxy services): do nothing — let browser handle
    return;
  }

  // App shell: Cache-first, then network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((res) => {
        // Cache successful GET responses — clone BEFORE returning
        if (event.request.method === 'GET' && res.ok) {
          const toCache = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
        }
        return res;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
