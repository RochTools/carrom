/* Carrom service worker — app-shell cache, offline first. */
const VERSION = 'carrom-v15';
const SHELL = [
  './', './index.html', './styles.css', './game.js', './manifest.webmanifest', './board/carrom-board.svg',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './pieces/striker.webp', './pieces/queen.webp', './pieces/white.webp', './pieces/black.webp',
  './menu/two-player.webp', './menu/two-vs-two-ai.webp', './menu/four-player.webp', './menu/versus-computer.webp'
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const { request } = e; if (request.method !== 'GET') return;
  e.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => {
    const net = fetch(request).then((r) => {
      if (r && r.ok && new URL(request.url).origin === self.location.origin) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
      return r;
    }).catch(() => cached);
    return cached || net;
  }));
});
