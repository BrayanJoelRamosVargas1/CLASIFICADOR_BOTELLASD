/**
 * EcoLens AI v4.0 Pro — Service Worker Cache Invalidator
 * Garantiza que ningún caché viejo bloquee la carga de nuevas versiones del modelo.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          console.log('[EcoLens SW] Eliminando caché obsoleta:', key);
          return caches.delete(key);
        })
      );
    }).then(() => {
      return self.registration.unregister();
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Siempre ir a la red directamente para evitar servir código desactualizado
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
