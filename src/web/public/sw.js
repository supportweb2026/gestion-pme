// Service worker : garde une copie de l'application pour l'ouvrir sans réseau.
// Les données ne passent jamais par ce cache : elles vivent dans la base locale.
const CACHE = "gestia-v3";
const SHELL = [
  "/", "/manifest.webmanifest", "/favicon.ico", "/favicon-32.png", "/icon-192.png",
  "/brand/gestia-logo.png", "/brand/gestia-logo-blanc.png",
  "/brand/gestia-logo-sans-slogan.png", "/brand/gestia-logo-sans-slogan-blanc.png",
];
// Police Montserrat (Google Fonts) : gardée en cache pour l'affichage hors ligne.
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // Ajoute aussi les fichiers JS et CSS référencés par la page (noms avec empreinte).
      const html = await (await cache.match("/")).text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(assets);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        try {
          const fresh = await fetch(event.request);
          const cache = await caches.open(CACHE);
          await cache.put(event.request, fresh.clone());
          return fresh;
        } catch {
          return Response.error();
        }
      })(),
    );
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Pages : réseau d'abord (nouvelle version), copie locale si hors ligne.
  if (event.request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(event.request);
          const cache = await caches.open(CACHE);
          await cache.put("/", fresh.clone());
          return fresh;
        } catch {
          return (await caches.match("/")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Fichiers statiques : copie locale d'abord, mise en cache au premier passage.
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const fresh = await fetch(event.request);
      if (fresh.ok && url.pathname.startsWith("/assets/")) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, fresh.clone());
      }
      return fresh;
    })(),
  );
});
