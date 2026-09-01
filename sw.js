// Versión reemplazada automáticamente por build.js en cada push (GitHub Actions)
const CACHE_NAME = 'vimeco-oc-v1788294178264';

const BASE = '/vimeco-oc';

const STATIC_ASSETS = [
  BASE + '/index.html',
  BASE + '/menu.html',
  BASE + '/compras.html',
  BASE + '/administracion.html',
  BASE + '/app.html',
  BASE + '/caja.html',
  BASE + '/css/styles.css',
  BASE + '/js/auth.js',
  BASE + '/js/app.js',
  BASE + '/js/firebase.js',
  BASE + '/js/drive.js',
  BASE + '/js/driveBackup.js',
  BASE + '/js/gemini.js',
  BASE + '/js/ocGenerator.js',
  BASE + '/js/voice.js',
  BASE + '/js/logoBase64.js',
  BASE + '/obras.html',
  BASE + '/js/obras.js',
  BASE + '/equipos.html',
  BASE + '/js/equipos.js',
  BASE + '/equipo.html',
  BASE + '/js/equipo.js',
  BASE + '/usuarios.html',
  BASE + '/js/usuarios.js',
  BASE + '/manifest.json',
  BASE + '/icono_app.png',
  BASE + '/icons/icon-192.png',
  BASE + '/icons/icon-512.png',
  BASE + '/js/jspdf.umd.min.js',
  BASE + '/historial.html',
  BASE + '/js/historial.js',
  BASE + '/js/driveQueue.js',
  BASE + '/facturas.html',
  BASE + '/js/facturas.js',
  BASE + '/remitos.html',
  BASE + '/js/remitos.js',
  BASE + '/js/entregas.js',
  BASE + '/js/icons.js',
  BASE + '/js/ui.js',
  BASE + '/js/tutoriales.js',
  BASE + '/js/tour.js',
  BASE + '/js/caja.js',
  BASE + '/js/scanner.js',
  BASE + '/actividad.html',
  BASE + '/js/actividad.js',
  BASE + '/personal-config.html',
  BASE + '/js/personal-config.js',
  BASE + '/personal.html',
  BASE + '/js/personal.js',
  BASE + '/personal-obra.html',
  BASE + '/js/personal-obra.js',
  BASE + '/autorizaciones.html',
  BASE + '/js/autorizaciones.js',
  BASE + '/reportes.html',
  BASE + '/js/reportes.js',
  BASE + '/js/resumenPDF.js',
  BASE + '/js/dolar.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'share-target').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' })))
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Web Share Target: guarda el archivo en cache y redirige a app.html
  if (event.request.method === 'POST' &&
      (url.pathname === BASE + '/app.html' || url.pathname === BASE + '/facturas.html')) {
    event.respondWith((async () => {
      const formData = await event.request.formData();
      const file = formData.get('file');
      if (file) {
        const cache = await caches.open('share-target');
        await cache.put('shared-file', new Response(file, {
          headers: { 'X-File-Name': file.name || '', 'Content-Type': file.type || '' }
        }));
      }
      return Response.redirect(BASE + '/app.html', 303);
    })());
    return;
  }

  // Network-only: Google APIs (Drive, OAuth, Gemini) y Firebase.
  // No se llama a event.respondWith(): así el navegador maneja la request
  // nativamente sin pasar por el SW. Re-hacer fetch(event.request) acá
  // rompe en iOS/Safari con bodies binarios (multipart de subida a Drive),
  // tirando "TypeError: Load failed".
  if (url.hostname.endsWith('.googleapis.com') ||
      url.hostname.endsWith('.firebaseio.com')) {
    return;
  }

  // dolarapi.com: cotización del dólar. Debe ser siempre fresca — si el SW la
  // cacheara (cache-first de terceros, más abajo) devolvería siempre el primer
  // valor. Se deja pasar a la red nativamente (y dolar.js cachea en localStorage).
  if (url.hostname.endsWith('dolarapi.com')) {
    return;
  }

  // Solo interceptamos GET; el resto lo maneja el navegador nativamente.
  if (event.request.method !== 'GET') return;

  const sameOrigin = url.origin === self.location.origin;
  const path       = url.pathname;

  // Assets pesados/inmutables → cache-first (no re-descargar en cada carga):
  // librerías vendorizadas (opencv, jscanify), jsPDF, imágenes y fuentes.
  const heavy = /\/js\/vendor\//.test(path)
             || /jspdf\.umd\.min\.js$/.test(path)
             || /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf)$/i.test(path);

  // Código de la app (HTML, JS, CSS, JSON) y navegaciones → network-first:
  // siempre trae lo último cuando hay red, y cae a la caché si estás offline.
  // Esto garantiza que la versión deployada se refleje sin depender de que
  // el SW nuevo se active (causa de que en desktop quedara pegada la versión vieja).
  const appCode = sameOrigin && !heavy &&
    (event.request.mode === 'navigate' || /\.(html|js|css|json)$/i.test(path));

  if (appCode) {
    // no-store: se saltea la caché HTTP del navegador (GitHub Pages sirve
    // max-age=600) y siempre revalida contra la red, así el deploy nuevo se ve
    // enseguida. Offline: cae a la caché del SW por el catch.
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
    return;
  }

  // Resto (assets pesados, terceros cacheables) → cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
