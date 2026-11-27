/* Pottery Log service worker: lets the app open and show your pieces without internet.
   - The app's own pages: always fetched fresh when online, the saved copy is used offline.
   - The login/database library: saved copy used, refreshed in the background.
   - Photos: saved after first view, so they show offline too.
   - Everything else (saving, logging in, Google) always goes to the network. */
const SHELL_CACHE = 'pl-shell-v1';
const PHOTO_CACHE = 'pl-photos-v1';
const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
const SHELL = ['./', './index.html', './privacy.html', './terms.html', './manifest.webmanifest', './icon-180.png', './icon-512.png'];
const MAX_PHOTOS = 400;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.all([...SHELL, LIB].map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL_CACHE && k !== PHOTO_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function networkFirst(req) {
  const c = await caches.open(SHELL_CACHE);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch (err) {
    const hit = (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await c.match('./index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(SHELL_CACHE);
  const hit = await c.match(req);
  const fresh = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

// Photo links change every time (they carry a temporary key), so photos are stored by their path only.
async function photo(req) {
  const c = await caches.open(PHOTO_CACHE);
  const key = new URL(req.url); key.search = '';
  const hit = await c.match(key.href);
  if (hit) return hit;
  const r = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));
  if (r.ok) {
    await c.put(key.href, r.clone());
    const keys = await c.keys();
    for (let i = 0; i < keys.length - MAX_PHOTOS; i++) await c.delete(keys[i]);
  }
  return r;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) return e.respondWith(networkFirst(req));
  if (req.url === LIB) return e.respondWith(staleWhileRevalidate(req));
  if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/storage/v1/object/sign/photos/')) return e.respondWith(photo(req));
});
