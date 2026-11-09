// Chordbox service worker — network-first for app shell so phones pick up fixes fast.
const CACHE = 'chordbox-v1.0.3';
const SHELL = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && /^chordbox-v/.test(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

function isShell(url) {
  const p = url.pathname;
  return p.endsWith('/') || p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css') || p.endsWith('sw.js');
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);

  // Network-first for HTML/JS/CSS so updates land; cache fallback for offline
  if (req.mode === 'navigate' || isShell(url)) {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(r => {
        if (r.ok) {
          const copy = r.clone();
          const key = req.mode === 'navigate' ? './index.html' : req;
          caches.open(CACHE).then(c => c.put(key, copy));
        }
        return r;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
