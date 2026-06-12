/*
 * LinguistFlow — core.js (Juni 2026)
 *
 * Reine, zustandslose Logik-Funktionen, ausgelagert aus app.js.
 * Zweck: (a) testbar ohne DOM/Supabase — tests.html lädt NUR diese Datei,
 * (b) erster Schritt der app.js-Aufteilung (kein Build-Step: einfache
 * <script>-Reihenfolge in index.html, core.js VOR data.js/app.js).
 *
 * Regeln für diese Datei:
 *   - KEINE DOM-Zugriffe, KEIN state, KEIN localStorage, KEIN Supabase.
 *   - Funktionen nehmen Input, geben Output — sonst nichts.
 *   - Jede neue Funktion hier bekommt Tests in tests.html.
 */

// ===== HTML-Escaping =====
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// ===== Datums-Helfer (SRS) =====
// Lokales Datum, keine UTC-Verschiebung — der User denkt in lokalen Tagen.
function isoToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}
function isoAddDays(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// ===== Satz-Teilung (Szenen) =====
// Trennt NUR an Satzgrenzen (. ! ?), nie am Komma — Shadowing + Recall
// brauchen kurze, in einem Atemzug nachsprechbare Einheiten.
function splitIntoSentences(text) {
  if (!text) return [];
  const m = ("" + text).match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  if (!m) { const t = ("" + text).trim(); return t ? [t] : []; }
  return m.map(function (p) { return p.trim(); }).filter(Boolean);
}

// ===== Shadow-Mode-Sortierung =====
// sortKey: "random" (Fisher-Yates) | "newest" | "oldest".
// "newest": User-Sätze (ID >= 85) nach created_at DESC zuerst, dann Originale
// ID ASC. "oldest" ist das Spiegelbild. Details siehe CLAUDE.md.
function carSortEligible(eligible, sortKey) {
  const arr = eligible.slice();
  if (sortKey !== "newest" && sortKey !== "oldest") {
    // random / unknown → Fisher-Yates
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  const newest = sortKey === "newest";
  arr.sort(function (a, b) {
    const aUser = a.id >= 85;
    const bUser = b.id >= 85;
    if (aUser !== bUser) {
      // "newest": User-Sätze vorne; "oldest": Originale vorne
      if (newest) return aUser ? -1 : 1;
      return aUser ? 1 : -1;
    }
    if (aUser) {
      const at = a.created_at ? Date.parse(a.created_at) : NaN;
      const bt = b.created_at ? Date.parse(b.created_at) : NaN;
      const aHas = !isNaN(at);
      const bHas = !isNaN(bt);
      if (aHas && bHas && at !== bt) return newest ? (bt - at) : (at - bt);
      if (aHas !== bHas) {
        // Karte mit Datum kommt zuerst (egal welcher Modus) — die ohne Datum
        // sind älteste Migrations-Reste und fallen ans Ende des User-Blocks.
        return aHas ? -1 : 1;
      }
      // Tie-break per ID
      return newest ? (b.id - a.id) : (a.id - b.id);
    }
    // Beide Originale → stabile ID-Reihenfolge (1, 2, 3, …) in beiden Modi
    return a.id - b.id;
  });
  return arr;
}

// ===== SRS-Graduation (Juni 2026) =====
// Berechnet das nächste Intervall in Tagen. Regeln:
//   - 1★/2★ = Lapse → BRUTALER Reset aufs Basis-Intervall (1d/3d), egal wo
//     die Karte vorher war. (Bewusste Design-Entscheidung, nicht ändern.)
//   - 3★/learned = Erfolg → Intervall wächst: wenn die Karte FÄLLIG war,
//     verdoppelt sich das bisherige Intervall (mind. Basis-Intervall des
//     Ratings); Cap bei capDays (180). Ohne Graduation käme jede gelernte
//     Karte für immer alle 30 Tage zurück — Review-Last wüchse linear mit
//     dem Korpus.
//   - Erfolg auf eine NICHT fällige Karte (z.B. Stern-Klick beim Browsen):
//     Intervall bleibt erhalten (verdoppelt nicht, schrumpft aber auch NIE
//     unter das bisherige) — sonst würde ein beiläufiger 3★-Klick eine
//     120d-Karte auf 7d zurückwerfen.
// Rückgabe: Tage (number) oder null bei unbekanntem Rating.
function srsNextInterval(prevState, rating, isDue, intervals, capDays) {
  const base = intervals[rating];
  if (typeof base !== "number") return null;
  const isLapse = (rating === 1 || rating === 2 || rating === "1" || rating === "2");
  if (isLapse) return base;
  const prev = (prevState && typeof prevState.interval_days === "number" && prevState.interval_days > 0)
    ? prevState.interval_days : 0;
  let next = base;
  if (prev > 0) next = Math.max(base, isDue ? prev * 2 : prev);
  return Math.min(next, capDays);
}

// ===== Sync-Merge-Logik (Juni 2026) =====
// Reine Merge-Funktionen — mergeCardData() in app.js wendet sie auf den
// State an. Merge-Regeln siehe CLAUDE.md → "Profile sync ist merge-basiert".

// cardState + ratings: pro Karte gewinnt der neuere last_reviewed_at
// (Gleichstand/unklar → Cloud). ratings folgen der cardState-Entscheidung.
function mergeCardStateAndRatings(localCardState, localRatings, cloudCardState, cloudRatings) {
  localCardState = localCardState || {};
  localRatings = localRatings || {};
  cloudCardState = cloudCardState || {};
  cloudRatings = cloudRatings || {};
  const mergedCardState = Object.assign({}, localCardState);
  const mergedRatings = Object.assign({}, localRatings);
  Object.keys(cloudCardState).forEach(function (id) {
    const l = localCardState[id];
    const c = cloudCardState[id];
    const localNewer = l && l.last_reviewed_at &&
      (!c.last_reviewed_at || l.last_reviewed_at > c.last_reviewed_at);
    if (!localNewer) {
      mergedCardState[id] = c;
      if (cloudRatings[id] !== undefined) mergedRatings[id] = cloudRatings[id];
    }
  });
  // Cloud-Ratings ohne cardState-Eintrag (Alt-Daten vor SRS Phase A):
  // nur ergänzen, lokal Vorhandenes nicht überschreiben.
  Object.keys(cloudRatings).forEach(function (id) {
    if (mergedRatings[id] === undefined) mergedRatings[id] = cloudRatings[id];
  });
  return { cardState: mergedCardState, ratings: mergedRatings };
}

// introCounts: explizite Einträge gewinnen über fehlende (fehlend = 5 =
// graduiert); sind beide explizit, gewinnt der höhere Fortschritt.
function mergeIntroCounts(localIntro, cloudIntro) {
  localIntro = localIntro || {};
  cloudIntro = cloudIntro || {};
  const merged = Object.assign({}, cloudIntro);
  Object.keys(localIntro).forEach(function (id) {
    if (merged[id] === undefined) merged[id] = localIntro[id];
    else merged[id] = Math.max(Number(merged[id]) || 0, Number(localIntro[id]) || 0);
  });
  return merged;
}

// stats: pro Tag, pro Metrik Max(); all_time.longest_streak per Max,
// first_active_date per Min (= früher).
function mergeStats(localStats, cloudStats) {
  localStats = localStats || {};
  cloudStats = cloudStats || {};
  const localDaily = localStats.daily || {};
  const cloudDaily = cloudStats.daily || {};
  const mergedDaily = {};
  const allDays = new Set(Object.keys(localDaily).concat(Object.keys(cloudDaily)));
  allDays.forEach(function (day) {
    const l = localDaily[day] || {};
    const c = cloudDaily[day] || {};
    const keys = new Set(Object.keys(l).concat(Object.keys(c)));
    const merged = {};
    keys.forEach(function (k) {
      merged[k] = Math.max(Number(l[k]) || 0, Number(c[k]) || 0);
    });
    mergedDaily[day] = merged;
  });
  const localAll = localStats.all_time || {};
  const cloudAll = cloudStats.all_time || {};
  const mergedAll = Object.assign({}, cloudAll);
  if (typeof localAll.longest_streak === "number") {
    mergedAll.longest_streak = Math.max(
      Number(cloudAll.longest_streak) || 0,
      localAll.longest_streak
    );
  }
  if (localAll.first_active_date) {
    if (!mergedAll.first_active_date || localAll.first_active_date < mergedAll.first_active_date) {
      mergedAll.first_active_date = localAll.first_active_date;
    }
  }
  return { daily: mergedDaily, all_time: mergedAll };
}
