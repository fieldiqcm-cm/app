/* FieldIQ — service worker
   Sempre que mudares ficheiros da app, aumenta a VERSAO (ex.: 'fieldiq-v78').
   Estratégia: tenta sempre a rede primeiro (as alterações aparecem logo);
   sem rede, usa a cópia guardada (a app abre na mesma). */
const VERSAO = 'fieldiq-v78';
const BASE = [
  './',
  './index.html',
  './gestao.html',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-256.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/emblema-96.png',
  './assets/fonts/mulish-latin-400-normal.woff2',
  './assets/fonts/mulish-latin-600-normal.woff2',
  './assets/fonts/mulish-latin-800-normal.woff2',
  './assets/fonts/playfair-display-latin-600-italic.woff2',
  './assets/fonts/playfair-display-latin-700-normal.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    (req.mode === 'navigate' || /\.(html|json|js|webmanifest)(\?|$)/.test(new URL(req.url).pathname) ? fetch(req.url, {cache: 'no-cache', credentials: 'same-origin'}) : fetch(req))
      .then((res) => {
        // uma resposta redirecionada não pode servir uma navegação: entrega-a como resposta normal
        if (res && res.redirected && req.mode === 'navigate') {
          res = new Response(res.body, {status: res.status, statusText: res.statusText, headers: res.headers});
        }
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});

// Avisos (notificações) enviados pelo analista
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {texto: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'FieldIQ', {
    body: d.texto || '',
    icon: './assets/icons/icon-192.png',
    badge: './assets/icons/icon-192.png',
    data: {url: d.url || './'},
    tag: d.tag || 'fieldiq-' + Date.now()
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then((ws) => {
    for (const w of ws) { if ('focus' in w) { return w.navigate(url).then((x) => (x || w).focus()).catch(() => w.focus()); } }
    return self.clients.openWindow(url);
  }));
});
