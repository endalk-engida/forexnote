/**
 * FX Journal — Service Worker (sw.js)
 * Implements Cache-First strategy for app shell assets.
 * Network requests for Google APIs always go live.
 */

const CACHE_NAME    = 'fx-journal-v1';
const CACHE_TIMEOUT = 3000; // ms before falling back to cache

// App shell assets to pre-cache on install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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

  // Never intercept Google API calls — always go live
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('accounts.google.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    // For CDN resources: cache them for offline use (runtime cache)
    if (url.hostname !== 'googleapis.com' && url.hostname !== 'accounts.google.com') {
      event.respondWith(
        caches.open(CACHE_NAME).then((cache) =>
          cache.match(event.request).then((cached) => {
            const fetchPromise = fetch(event.request).then((res) => {
              if (res.ok) cache.put(event.request, res.clone());
              return res;
            }).catch(() => cached); // fallback to cache if offline
            return cached || fetchPromise;
          })
        )
      );
    }
    return; // Let Google API calls pass through
  }

  // App shell: Cache-first, then network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((res) => {
        // Cache successful GET responses
        if (event.request.method === 'GET' && res.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
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
