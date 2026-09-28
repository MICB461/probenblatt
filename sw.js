// Service Worker für das NFC-Probenblatt.
// Bei jeder Änderung an index.html o. Ä. VERSION erhöhen, damit alte Caches gelöscht werden.
const VERSION = "v8";
const CACHE = `probenblatt-${VERSION}`;

const SHELL = [
  "./",
  "index.html",
  "bearbeiten.html",
  "ndef.js",
  "pn532.js",
  "tagio.js",
  "kal.html",
  "datamatrix.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png"
];

const FONT_CSS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap";
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

// Schriften vorab laden: CSS holen und alle darin verlinkten Schriftdateien cachen.
// Schlägt das fehl (z. B. offline beim Installieren), fällt die Seite auf Systemschriften zurück.
async function precacheFonts(cache) {
  try {
    const res = await fetch(FONT_CSS);
    if (!res.ok) return;
    await cache.put(FONT_CSS, res.clone());
    const css = await res.text();
    const urls = [...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map(m => m[1]);
    await Promise.all(urls.map(async u => {
      const r = await fetch(u);
      if (r.ok) await cache.put(u, r);
    }));
  } catch (e) {
    // bewusst ignoriert
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: "reload" umgeht den HTTP-Cache (GitHub Pages: max-age=600), sonst landet die alte Fassung im neuen Cache
    await cache.addAll(SHELL.map(u => new Request(u, { cache: "reload" })));
    await precacheFonts(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("probenblatt-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Seitenaufrufe: sofort aus dem Cache antworten, im Hintergrund aktualisieren.
  // Der Teil hinter # gehört nicht zur Anfrage, daher trifft jede Tag-Adresse denselben Cache-Eintrag.
  if (req.mode === "navigate" && url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, req, "index.html"));
    return;
  }

  // Eigene Dateien (Manifest, Icons)
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, req));
    return;
  }

  // Schriften: aus dem Cache, sonst laden und ablegen
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
});

async function staleWhileRevalidate(event, req, fallback) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  if (res) return res;
  if (fallback) {
    const shell = await cache.match(fallback);
    if (shell) return shell;
  }
  return new Response("Offline und nicht im Zwischenspeicher.", {
    status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") cache.put(req, res.clone());
    return res;
  } catch (e) {
    return new Response("", { status: 504 });
  }
}
