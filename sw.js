// Offline support: keep a full copy of the app on the phone so it opens with no signal (mountains, dark-sky sites).
// Pages are always served from the saved copy. Each time the app is opened online, the whole set is fetched again
// in the background and replaces the saved copy only if every file arrived, so old and new files are never mixed.
// When you add a file the app loads, add it to FILES (test/sw_test.js checks this).
const NAME = 'starfind';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png',
  'js/app.js', 'js/astro.js', 'js/catalog.js', 'js/i18n.js', 'js/orientation.js', 'js/render.js', 'js/skygl.js',
  'data/constellations.json', 'data/messier.json', 'data/milkyway.jpg', 'data/milkyway.json', 'data/stars.json',
  'i18n/languages.json', 'i18n/ja.json', 'i18n/en.json', 'i18n/ko.json', 'i18n/zh-Hans.json', 'i18n/zh-Hant.json',
];

async function fetchAll() {
  const tmp = NAME + '-next-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const next = await caches.open(tmp);
  try {
    await next.addAll(FILES.map((f) => new Request(f, { cache: 'no-cache' })));
    const main = await caches.open(NAME);
    for (const req of await next.keys()) await main.put(req, await next.match(req));
  } finally {
    await caches.delete(tmp);
  }
}

// wait a little after the page opens, so the page finishes loading its files before any of them is replaced
let refreshing = null;
const refresh = () => (refreshing ||= new Promise((r) => setTimeout(r, 5000))
  .then(fetchAll).catch(() => {}).finally(() => { refreshing = null; }));

self.addEventListener('install', (e) => {
  e.waitUntil(fetchAll().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // the same site (adfreeapps.github.io) also hosts the other apps, so only touch this app's leftovers
    for (const k of await caches.keys()) if (k.startsWith(NAME + '-next-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  url.search = ''; url.hash = ''; // test parameters (?t=…&lat=…) all open the same saved page
  if (req.mode === 'navigate') e.waitUntil(refresh());
  e.respondWith((async () => {
    const main = await caches.open(NAME);
    const hit = await main.match(url.href);
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') { const page = await main.match(new URL('./', location.href).href); if (page) return page; }
      throw err;
    }
  })());
});
