/* ==========================================================
   sw.js — Kurt Inventory PWA Service Worker
   Strategy: cache-first for shell, network-first for others
   ========================================================== */

const CACHE_VERSION = "kurt-inventory-v49";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./state.js",
  "./utils.js",
  "./auth.js",
  "./firebase.js",
  "./inventory.js",
  "./pos.js",
  "./reports.js",
  "./customers.js",
  "./labels.js",
  "./gcash.js",
  "./manifest.json",
  "./5.png",
  "./Kurt.png",
  "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js",
  "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js"
];

/* ---------- INSTALL ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { mode: "no-cors" })).catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

/* ---------- ACTIVATE ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ---------- HELPERS ---------- */
function isFirebaseRequest(url) {
  return (
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("identitytoolkit") ||
    url.hostname.includes("securetoken.googleapis.com") ||
    url.hostname.includes("firebaseinstallations") ||
    url.hostname.includes("firebasestorage")
  );
}

function isCacheable(url, request) {
  if (request.method !== "GET") return false;
  if (isFirebaseRequest(url)) return false;
  return (
    url.origin === self.location.origin ||
    url.hostname.includes("jsdelivr.net") ||
    url.hostname.includes("unpkg.com") ||
    url.hostname.includes("cloudflare.com") ||
    url.hostname.includes("gstatic.com") ||
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com")
  );
}

/* ---------- FETCH ---------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (!isCacheable(url, req)) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);

      if (req.mode === "navigate") {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone()).catch(() => {});
          return fresh;
        } catch (e) {
          return cached || caches.match("./index.html");
        }
      }

      if (cached) {
        fetch(req).then((fresh) => {
          if (fresh && fresh.status === 200) {
            caches.open(CACHE_VERSION).then((c) => c.put(req, fresh.clone())).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }

      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })()
  );
});

/* ---------- MESSAGES ---------- */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});