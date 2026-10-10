/*
 * Service Worker - Gestión Técnica
 * Estrategia:
 * - HTML y archivos locales: red primero; caché como respaldo.
 * - Solo cachea solicitudes del mismo origen.
 * - No cachea llamadas a Supabase ni recursos de otros dominios.
 *
 * Para una actualización manual futura, cambia CACHE_VERSION (por ejemplo, v2).
 */
const CACHE_VERSION = "gestion-tecnica-v3";
const CACHE_NAME = `gestion-tecnica-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/config.js",
  "./js/app.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((error) => {
        // Si algún archivo no existe o no puede precargarse, no bloquear la instalación.
        console.warn("No se pudo precargar todo el caché de Gestión Técnica:", error);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) =>
              key.startsWith("gestion-tecnica-") && key !== CACHE_NAME
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Solo solicitudes GET del mismo origen. No interceptar Supabase/CDN ni otras APIs.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // No almacenar documentos de navegación de forma permanente: buscar la versión actual.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(async () => {
          return (await caches.match(request)) ||
                 (await caches.match("./index.html")) ||
                 Response.error();
        })
    );
    return;
  }

  // Archivos locales: red primero para que las actualizaciones se vean pronto.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        return (await caches.match(request)) || Response.error();
      })
  );
});
