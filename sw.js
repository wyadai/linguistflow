/*
 * LinguistFlow — Service Worker
 *
 * Strategie (Juni 2026 — Rework nach Entfernung des Offline-Modus):
 *   - App shell (HTML/JS/CSS/data/manifest/icons): NETWORK-FIRST mit
 *     Cache-Fallback. Damit ist nach jedem Deploy automatisch die neue
 *     Version live — ein vergessener VERSION-Bump kann den Browser nicht
 *     mehr dauerhaft auf altem Code festnageln (das war vorher mit
 *     cache-first der einzige Update-Pfad und ein Single Point of Failure).
 *     Der Cache dient nur noch als Fallback bei kurzen Netz-Aussetzern.
 *   - Original sentence audio (es_guate_*.mp3): cache-first — die Dateien
 *     sind unveränderlich, einmal gehört = gecacht, spart Bandbreite.
 *   - User audio aus Supabase Storage: stale-while-revalidate (Cache sofort,
 *     Netz im Hintergrund) — spart Supabase-Egress bei jedem Replay.
 *   - Der AUDIO-Cache ist UNVERSIONIERT ("audio-v1") und überlebt Deploys.
 *     Vorher hing er an VERSION und wurde bei jedem Bump komplett gelöscht.
 *   - Andere Supabase-Calls (Auth, Postgres), ElevenLabs, Anthropic:
 *     pass-through, niemals cachen (Tokens, User-Daten).
 *
 * VERSION steuert nur noch das Aufräumen alter Shell-Caches beim Activate —
 * fürs Ausliefern neuer Code-Stände ist sie dank network-first nicht mehr
 * kritisch. Trotzdem bei Code-Änderungen mitbumpen (Konvention + sauberes
 * Cache-Housekeeping). Format: lf-vN-YYYY-MM-DD-<kurz-beschreibung>.
 *
 * Pfade sind RELATIV, damit GitHub-Pages-Subpaths funktionieren.
 */

const VERSION = "lf-v32-2026-06-12-intro-graduation-fix";
const SHELL_CACHE = "shell-" + VERSION;
const AUDIO_CACHE = "audio-v1"; // bewusst OHNE Version — überlebt Deploys

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./core.js",
  "./styles.css",
  "./data.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icon.svg",
  "./icon-180.png",
  "./favicon-32.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Einzelne adds, damit ein fehlendes optionales Asset (z.B. Icon)
      // nicht den ganzen Precache scheitern lässt.
      return Promise.all(
        APP_SHELL.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn("[SW] precache failed for", url, err);
          });
        })
      );
    })
  );
  // Neue Version sofort aktivieren, nicht auf Tab-Schließung warten.
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== SHELL_CACHE && k !== AUDIO_CACHE; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function isShellRequest(url) {
  // Nur eigene Origin — verhindert, dass z.B. fremde /app.js-Pfade matchen.
  if (url.origin !== self.location.origin) return false;
  const tails = [
    "/", "/index.html", "/app.js", "/core.js", "/styles.css", "/data.js",
    "/manifest.json",
    "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png",
    "/icon.svg", "/icon-180.png", "/favicon-32.png",
  ];
  return tails.some(function (t) {
    return url.pathname === t || url.pathname.endsWith(t);
  });
}

function isOriginalAudio(url) {
  // Original-Satz-Audios: /es_guate_NN.mp3 im Repo (eigene Origin)
  return url.origin === self.location.origin
    && /\/es_guate_\d+\.mp3$/i.test(url.pathname);
}

function isUserAudio(url) {
  // User-Audios in Supabase Storage: /storage/v1/object/public/audios/...
  return url.hostname.indexOf("supabase.co") !== -1
    && url.pathname.indexOf("/audios/") !== -1;
}

// Synthetische Fehler-Response statt respondWith(undefined) — sauberer
// Netzwerkfehler-Pfad, wenn weder Netz noch Cache etwas liefern.
function offlineResponse() {
  return new Response("Offline — Inhalt nicht verfügbar.", {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // App shell — NETWORK-FIRST, Cache nur als Fallback.
  // ignoreSearch beim Cache-Match: historische ?v=-Query-Suffixe (inzwischen
  // aus index.html entfernt) dürfen den Fallback nicht verfehlen lassen.
  if (isShellRequest(url)) {
    event.respondWith(
      fetch(event.request).then(function (resp) {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(event.request, copy); });
        }
        return resp;
      }).catch(function () {
        return caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
          return cached || offlineResponse();
        });
      })
    );
    return;
  }

  // Original-Audios — cache-first (unveränderlich), Fill beim ersten Hören
  if (isOriginalAudio(url)) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        if (cached) return cached;
        return fetch(event.request).then(function (resp) {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(AUDIO_CACHE).then(function (c) { c.put(event.request, copy); });
          }
          return resp;
        }).catch(function () { return offlineResponse(); });
      })
    );
    return;
  }

  // User-Audios aus Supabase Storage — stale-while-revalidate
  if (isUserAudio(url)) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        const networkFetch = fetch(event.request).then(function (resp) {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(AUDIO_CACHE).then(function (c) { c.put(event.request, copy); });
          }
          return resp;
        }).catch(function () { return cached || offlineResponse(); });
        return cached || networkFetch;
      })
    );
    return;
  }

  // Alles andere (Supabase Postgres/Auth, ElevenLabs, Anthropic, Fonts):
  // pass-through. API-Responses werden NIEMALS gecacht (Tokens, User-Daten).
});

// Seite kann den SW anpingen (z.B. SKIP_WAITING nach einem Update).
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
