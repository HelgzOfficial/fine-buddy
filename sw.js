// Minimal service worker so the browser considers Fine Buddy installable.
// It doesn't cache anything aggressively — every load still checks the
// network first, so admins/players always see fresh fines & payments.
const CACHE = 'fine-buddy-v1';
const SHELL = ['./', './index.html', './app.js', './config.js', './manifest.json', './icon-192.png', './icon-512.png'];

// app.js also keeps a small Cache Storage entry, 'fine-buddy-session-bridge-v1',
// used to carry a signed-in session between Safari and this same site "saved
// to Home Screen" on iOS (those two contexts don't share localStorage, but
// they DO share Cache Storage). Cache cleanup below must never touch it, or
// every service-worker update would silently sign people back out.
const KEEP_CACHES = [CACHE, 'fine-buddy-session-bridge-v1'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => !KEEP_CACHES.includes(k)).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first for everything so data is always live; fall back to cache offline.
  event.respondWith(
    fetch(event.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(event.request))
  );
});
