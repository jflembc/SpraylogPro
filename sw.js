// SprayLog Pro Service Worker — offline app shell
const CACHE = 'spraylog-v1';
const SHELL = ['/', '/index.html'];

// Install — cache the app shell
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Activate — clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - App shell (navigation/HTML): network-first, fall back to cache when offline
// - Supabase / API calls: always network (never cache data), fail gracefully
// - Static assets (fonts, cdn): cache-first
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept Supabase or Google API calls — let them hit network / fail naturally
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('openweathermap.org')) {
    return; // default browser handling
  }

  // App navigation — network first, cache fallback (so updates deploy, but offline still works)
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets — cache first
  if (['style', 'script', 'font', 'image'].includes(e.request.destination)) {
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        }).catch(() => cached)
      )
    );
  }
});
