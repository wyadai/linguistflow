/*
 * LinguistFlow — Service Worker
 *
 * Strategy:
 *   - App shell (HTML/JS/CSS/data + manifest): cache-first, precached on install
 *   - Original sentence audio (es_guate_*.mp3): cache-first when seen
 *   - User audio from Supabase Storage: stale-while-revalidate (cache fast,
 *     network in background to keep fresh)
 *   - Supabase Storage URLs are recognized by hostname (...supabase.co...) and
 *     pathname containing /audios/
 *   - Other Supabase API calls (auth, postgres) pass straight through to
 *     network — we never want to cache user data or auth tokens
 *
 * Bump VERSION whenever the app shell changes (or whenever you ship new code
 * via GitHub Pages). All older caches are deleted on activate.
 *
 * Paths are RELATIVE so this works on GitHub Pages sub-paths
 * (e.g. https://<user>.github.io/<repo>/) without changes.
 */

const VERSION = "lf-v9-2026-05-22-offline-prep";
const SHELL_CACHE = "shell-" + VERSION;
const AUDIO_CACHE = "audio-" + VERSION;

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
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
      // Use individual adds so that if one optional asset fails (e.g. an icon
      // isn't deployed yet), the rest still get cached.
      return Promise.all(
        APP_SHELL.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn("[SW] precache failed for", url, err);
          });
        })
      );
    })
  );
  // Activate this version immediately, don't wait for old tabs to close.
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
  // Pathname ends with one of the shell-asset filenames.
  // (We can't compare full URLs because the deployed prefix varies.)
  const tails = [
    "/", "/index.html", "/app.js", "/styles.css", "/data.js",
    "/manifest.json",
    "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png",
    "/icon.svg", "/icon-180.png", "/favicon-32.png",
  ];
  return tails.some(function (t) {
    return url.pathname === t || url.pathname.endsWith(t);
  });
}

function isOriginalAudio(url) {
  // Original 84 sentence audios: /es_guate_NN.mp3 in the repo
  return /\/es_guate_\d+\.mp3$/i.test(url.pathname);
}

function isUserAudio(url) {
  // User-generated audios live in Supabase Storage under /storage/v1/object/public/audios/...
  return url.hostname.indexOf("supabase.co") !== -1
    && url.pathname.indexOf("/audios/") !== -1;
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // App shell — cache-first, network fallback
  if (isShellRequest(url)) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        return cached || fetch(event.request).then(function (resp) {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(event.request, copy); });
          }
          return resp;
        });
      })
    );
    return;
  }

  // Original 84 sentence audios — cache-first, fill on first request
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
        });
      })
    );
    return;
  }

  // User audios from Supabase Storage — stale-while-revalidate
  if (isUserAudio(url)) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        const networkFetch = fetch(event.request).then(function (resp) {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(AUDIO_CACHE).then(function (c) { c.put(event.request, copy); });
          }
          return resp;
        }).catch(function () { return cached; });
        return cached || networkFetch;
      })
    );
    return;
  }

  // Everything else (Supabase Postgres, Auth, ElevenLabs, Anthropic): pass-through.
  // We deliberately do NOT cache API responses — they contain tokens and per-request data.
});

// Allow the page to ping the SW (e.g. to trigger skipWaiting after an update).
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
