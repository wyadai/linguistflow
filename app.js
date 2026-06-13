// App-Version (in sync mit sw.js VERSION). Wird im Auto-Modus angezeigt,
// damit auf dem Handy verifizierbar ist welche Build-Version live ist.
const APP_VERSION = "v34-2026-06-13-shadow-bg-pausen";

// ===== Supabase configuration =====
const SUPABASE_URL = "https://cxbgqtvlhwfynfqddxwk.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4YmdxdHZsaHdmeW5mcWRkeHdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4Nzk2NzMsImV4cCI6MjA5NDQ1NTY3M30.IIJLdLMZF80Sdrdv9zr90qxRyPalkaXNbwQu1T_NAsQ";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentUser = null;
let _suppressSync = false;  // Used during data pull to avoid pushing back what we just pulled

// ===== State =====
const state = {
  filteredIds: [],
  currentIdx: 0,
  isPlaying: false,
  showTranslation: true,
  autoPlay: loadJSON("hl_autoplay", true),
  activeCats: new Set(),
  activeRatings: new Set(),
  search: "",
  speed: 1.0,
  speeds: [0.75, 0.85, 0.95, 1.0],
  repeat: 1,
  repeats: [1, 2, 3],
  ratings: loadJSON("hl_ratings", {}),
  mnemonics: loadJSON("hl_mnemonics", {}),
  shownMnemonics: new Set(loadJSON("hl_shown_mnemonics", [])),
  editingMnemonics: new Set(),
  // Lifecycle: per-card intro_count.
  // Default (no entry) = 5 = active. Explicit 0 = backlog. 1..4 = intro stage.
  // This way no migration is needed for existing cards — they're all "active" by default.
  // Only cards explicitly put into Einführung get a 0 entry; on graduation the entry is removed.
  introCounts: loadJSON("hl_intro_counts", {}),
  // SRS Phase A: per-card spaced-repetition state.
  // Shape: { [id]: { interval_days, due_at: "YYYY-MM-DD", last_reviewed_at: "YYYY-MM-DD" } }
  // Cards without an entry are treated as "never reviewed" — they appear in the
  // Recall queue automatically (so you can give them their first assessment).
  // Persisted in cloud under profiles.settings.card_state (parallel to intro_counts).
  cardState: loadJSON("hl_card_state", {}),
  // Basis-Statistiken: pro-Tag-Aggregate. Counter werden in play/reveal/setRating
  // inkrementiert. Format: { daily: { "YYYY-MM-DD": { plays, reveals, rated } },
  // all_time: { longest_streak, first_active_date } }.
  // Persisted in cloud under profiles.settings.stats.
  stats: loadJSON("hl_stats", { daily: {}, all_time: {} }),
  mode: "listen",
  repeatCount: 0,
  revealed: new Set(),
  userSentences: loadJSON("hl_user_sentences", []),
  // Szenen-Feature v1 (Mai 2026): zusammenhängende Dialog-Sätze als narrative
  // Klammer. Jede Szene hat 5–15 Sätze, identifiziert über user_sentences.scene_id.
  // Cache analog hl_user_sentences — debounced push, Pull bei Login.
  // Shape: { id, title, setting, participants, status, practice_count,
  //          last_practiced_at, source, created_at }
  scenes: loadJSON("hl_scenes", []),
  // UI-State der Szenen-Liste (persisted in localStorage als Komfort-Win)
  scenesFilter: localStorage.getItem("hl_scenes_filter") || "active",
  scenesSort: localStorage.getItem("hl_scenes_sort") || "last_practiced",
  newSentenceCats: new Set(),
  apiKey: localStorage.getItem("hl_api_key") || "",
  elKey: localStorage.getItem("hl_el_key") || "",
  elVoice: localStorage.getItem("hl_el_voice") || "21m00Tcm4TlvDq8ikWAM",
  // Sort for the Meine-Sätze page (newest/oldest/random).
  // Persisted under legacy key `hl_us_sort` for backward compat.
  usSort: localStorage.getItem("hl_us_sort") || "newest",
  // Filter for the Meine-Sätze page: "translated" | "pending" | "archived"
  saetzeFilter: "translated",
  // ID of the sentence currently being edited on the Meine-Sätze page (ES only).
  // Runtime-only — not persisted. Null when nothing is being edited.
  saetzeEditingId: null,
  mainSort: localStorage.getItem("hl_main_sort") || "oldest",
  // Engagement-Layer (Mai 2026): "Dein Warum" — persönlicher Motivations-Anker,
  // dezent oben in der App sichtbar. Synced via profiles.settings.why_text.
  whyText: localStorage.getItem("hl_why_text") || "",
};

// ===== User-generated audio blobs (IndexedDB) =====
const userAudioUrls = {};
let _audioDb = null;
function initAudioDB() {
  return new Promise(function (resolve) {
    const req = indexedDB.open("hl_audios_db", 1);
    req.onupgradeneeded = function (e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("audios")) db.createObjectStore("audios", { keyPath: "id" });
    };
    req.onsuccess = function (e) {
      _audioDb = e.target.result;
      const tx = _audioDb.transaction("audios", "readonly");
      const store = tx.objectStore("audios");
      const getAll = store.getAll();
      getAll.onsuccess = function () {
        for (const item of getAll.result) {
          userAudioUrls[item.id] = URL.createObjectURL(item.blob);
        }
        resolve();
      };
      getAll.onerror = function () { resolve(); };
    };
    req.onerror = function () { console.error("IDB open failed"); resolve(); };
  });
}
function saveAudioToIDB(id, blob) {
  return new Promise(function (resolve, reject) {
    if (!_audioDb) { reject(new Error("DB nicht bereit")); return; }
    const tx = _audioDb.transaction("audios", "readwrite");
    const store = tx.objectStore("audios");
    const req = store.put({ id: id, blob: blob });
    req.onsuccess = function () {
      if (userAudioUrls[id]) URL.revokeObjectURL(userAudioUrls[id]);
      userAudioUrls[id] = URL.createObjectURL(blob);
      resolve();
    };
    req.onerror = function () { reject(req.error); };
  });
}
function deleteAudioFromIDB(id) {
  return new Promise(function (resolve) {
    if (!_audioDb) { resolve(); return; }
    const tx = _audioDb.transaction("audios", "readwrite");
    const store = tx.objectStore("audios");
    const req = store.delete(id);
    req.onsuccess = function () {
      if (userAudioUrls[id]) { URL.revokeObjectURL(userAudioUrls[id]); delete userAudioUrls[id]; }
      resolve();
    };
    req.onerror = function () { resolve(); };
  });
}
// Returns all audio blobs from IDB as [{id, blob}, ...]. Used for one-time
// migration to Supabase Storage. Resolves to [] if DB not ready.
function getAllAudiosFromIDB() {
  return new Promise(function (resolve) {
    if (!_audioDb) { resolve([]); return; }
    const tx = _audioDb.transaction("audios", "readonly");
    const store = tx.objectStore("audios");
    const req = store.getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { resolve([]); };
  });
}
// Promise that resolves once IDB is ready. Set when initAudioDB() is called at boot.
let _audioDbReady = null;

// ===== Audio source resolution =====
// Single source of truth for "where does this sentence's audio come from?"
// Priority:
//   1. Supabase Storage public URL (s.audio_path)  — synced across devices
//   2. IDB-cached blob URL (userAudioUrls)         — user-generated audio, this device / offline cache
//   3. sentence.audio                               — original 84 sentences (repo files)
//   4. null                                         — no audio available
function audioSrcFor(s) {
  if (!s) return null;
  if (s.audio_path) {
    try {
      const { data } = sb.storage.from("audios").getPublicUrl(s.audio_path);
      if (data && data.publicUrl) return data.publicUrl;
    } catch (e) {
      console.warn("getPublicUrl failed for", s.audio_path, e);
    }
  }
  return userAudioUrls[s.id] || s.audio || null;
}
function hasAudio(s) {
  return !!audioSrcFor(s);
}

// =====================================================================
// Pre-load helpers (Android-MediaSession-Flicker-Fix)
// =====================================================================
// Wenn wir den nächsten Satz schon in den Cache (Service Worker / Browser-
// Cache) holen, ist der src-Wechsel zwischen Sätzen praktisch instant. Das
// verkürzt die Lücke, in der Android die Media-Notification ausblenden
// könnte. Fire-and-forget: Fehler werden geschluckt.
function _preloadAudioUrl(url) {
  if (!url) return;
  // Blob-URLs (IDB-Cache) sind eh schon im Speicher; data:/blob: skippen.
  if (url.indexOf("blob:") === 0 || url.indexOf("data:") === 0) return;
  try {
    fetch(url, { cache: "default", credentials: "omit" }).catch(function () {});
  } catch (e) { /* ignore */ }
}
function preloadNextSentenceAudio() {
  if (!state || !Array.isArray(state.filteredIds) || state.filteredIds.length < 2) return;
  const nextIdx = (state.currentIdx + 1) % state.filteredIds.length;
  const nextId = state.filteredIds[nextIdx];
  const nextS = (typeof getSentenceById === "function") ? getSentenceById(nextId) : null;
  if (!nextS) return;
  _preloadAudioUrl(audioSrcFor(nextS));
}
function preloadNextCarAudio() {
  if (typeof car === "undefined" || !car || !Array.isArray(car.queue) || car.queue.length < 2) return;
  const nextIdx = (car.idx + 1) % car.queue.length;
  const nextId = car.queue[nextIdx];
  const nextS = (typeof getSentenceById === "function") ? getSentenceById(nextId) : null;
  if (!nextS) return;
  _preloadAudioUrl(audioSrcFor(nextS));
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
  if (!currentUser || _suppressSync) return;
  if (key === "hl_user_sentences") queuePushSentences();
  else if (key === "hl_scenes") queuePushScenes();
  else if (key === "hl_ratings" || key === "hl_mnemonics" ||
           key === "hl_shown_mnemonics" || key === "hl_autoplay" ||
           key === "hl_intro_counts" ||
           key === "hl_card_state" ||
           key === "hl_stats") queuePushProfile();
}

// ===== Sync-Tombstones (Juni 2026) =====
// Cloud-Deletes passieren nur noch für IDs, die LOKAL explizit gelöscht
// wurden. Vorher rechnete pushUserSentences "cloudIds − localIds" und löschte
// die Differenz — ein Gerät mit veraltetem lokalen Stand (z.B. Handy-PWA,
// die seit Wochen nicht neu gepullt hat) löschte damit Sätze, die ein
// ANDERES Gerät neu angelegt hatte. Realer Datenverlust-Pfad im
// PC+Handy-Setup. Keys: hl_deleted_ids (Sätze), hl_deleted_scene_ids (Szenen).
function addTombstone(key, id) {
  const list = loadJSON(key, []);
  if (list.indexOf(id) < 0) {
    list.push(id);
    localStorage.setItem(key, JSON.stringify(list));
  }
}
function clearTombstones(key, ids) {
  if (!ids || !ids.length) return;
  const list = loadJSON(key, []).filter(function (id) { return ids.indexOf(id) < 0; });
  localStorage.setItem(key, JSON.stringify(list));
}

// ===== Lifecycle helpers (Einführungs-Modus) =====
// Each card has an intro_count value driving its lifecycle stage:
//   - explicit 0      → "backlog" (sent to Einführung, not yet seen)
//   - 1..4            → "intro" (in active introduction)
//   - 5+ or no entry  → "active" (in normal Listen/Recall/Focus rotation)
// Default for cards with NO entry is 5 (active) — this avoids needing a one-off
// migration for the 92 pre-existing cards. They simply don't appear in
// introCounts and are treated as already-graduated.
function getIntroCount(id) {
  const v = state.introCounts[id];
  return typeof v === "number" ? v : 5;
}
function setIntroCount(id, value) {
  // BUGFIX Juni 2026: Graduation wird EXPLIZIT als 5 gespeichert. Vorher
  // wurde der Key gelöscht ("Storage-Minimierung: >=5 = Default → drop") —
  // aber der Sync-Merge (mergeIntroCounts: explizit gewinnt über fehlend)
  // konnte "gelöscht = graduiert" nicht von "war nie in Einführung"
  // unterscheiden. Ein veralteter expliziter Wert (z.B. 4) von der Cloud /
  // vom anderen Gerät hat die Graduation deshalb bei JEDEM Sync rückgängig
  // gemacht — Symptom: immer dieselben 5 Sätze in der Einführung, auf allen
  // Geräten. Explizite 5 gewinnt im Max-Merge gegen jeden alten Stand.
  // NIEMALS auf das Key-Löschen zurückbauen, solange der Merge existiert.
  if (value >= 5) state.introCounts[id] = 5;
  else state.introCounts[id] = value;
  saveJSON("hl_intro_counts", state.introCounts);
}
function stageOf(id) {
  const n = getIntroCount(id);
  if (n <= 0) return "backlog";
  if (n < 5) return "intro";
  return "active";
}
// Returns how many cards are currently in backlog or intro (NOT active).
function introPoolCount() {
  let n = 0;
  for (const s of allSentences()) {
    if (s.archived || s.pending || !s.es) continue;
    if (stageOf(s.id) !== "active") n++;
  }
  return n;
}

// ===== Unified sentence access =====
function allSentences() { return DATA.sentences.concat(state.userSentences); }
function getSentenceById(id) {
  if (id >= 1 && id <= DATA.sentences.length) return DATA.sentences[id - 1];
  return state.userSentences.find(function (s) { return s.id === id; });
}
function nextUserId() {
  let maxId = DATA.sentences.length;
  for (const s of state.userSentences) if (s.id > maxId) maxId = s.id;
  // Hochwasser-Marke (Juni 2026): IDs werden NIE wiederverwendet — auch dann
  // nicht, wenn der Satz mit der höchsten ID gelöscht wurde. Vorher konnte
  // eine neue Karte die ID einer gelöschten erben (inkl. verwaister
  // Storage-Audios und Tombstone-Kollisionen). Die Marke ist monoton
  // wachsend und wird zusätzlich beim Cloud-Pull angehoben — das senkt auch
  // das Kollisionsrisiko, wenn auf zwei Geräten parallel Sätze entstehen.
  const hwm = Number(localStorage.getItem("hl_max_id_ever")) || 0;
  if (hwm > maxId) maxId = hwm;
  const next = maxId + 1;
  localStorage.setItem("hl_max_id_ever", String(next));
  return next;
}
function isUserSentence(id) { return id > DATA.sentences.length; }

// ===== Szenen-Helpers =====
// `scene_role === "other"` markiert Linien der Gegenseite in einer Szene
// (z.B. die Antworten des Bäckers). Die hört der User nur, aber er soll sie
// nicht aktiv produzieren — also: KEINE SRS-Queue, KEIN Recall, KEIN Fokus.
// Dieser Helper bündelt alle "Karte ist im normalen Üben-Pool"-Checks an
// einer Stelle, damit man die other-Filterung nicht an drei Stellen vergisst.
function isPracticeable(s) {
  if (!s) return false;
  if (s.archived) return false;
  if (s.pending) return false;
  if (s.scene_role === "other") return false;
  return true;
}

function getSceneById(id) {
  if (!id) return null;
  return state.scenes.find(function (x) { return x.id === id; }) || null;
}

// Eindeutige ID für neue Szenen — analog nextUserId().
// Server-seitig wäre die DB-Sequenz autoritativ, aber wir vergeben IDs
// client-seitig (wie bei user_sentences), weil der Code überall mit
// numerischen Refs arbeitet und ein Round-Trip vor dem Insert das UI
// verlangsamen würde.
function nextSceneId() {
  let maxId = 0;
  for (const sc of state.scenes) if (sc.id > maxId) maxId = sc.id;
  // Hochwasser-Marke analog nextUserId() (Juni 2026): keine ID-Wiederverwendung.
  const hwm = Number(localStorage.getItem("hl_max_scene_id_ever")) || 0;
  if (hwm > maxId) maxId = hwm;
  const next = maxId + 1;
  localStorage.setItem("hl_max_scene_id_ever", String(next));
  return next;
}

// ===== DOM refs =====
const audioEl = document.getElementById("audio");
const cardsEl = document.getElementById("cards");
const noResultsEl = document.getElementById("no-results");
const catFilterEl = document.getElementById("cat-filter");
const ratingFilterEl = document.getElementById("rating-filter");
const playerNumEl = document.getElementById("player-num");
const playerEsEl = document.getElementById("player-text-es");
const playerDeEl = document.getElementById("player-text-de");
const playIcon = document.getElementById("play-icon");
const pauseIcon = document.getElementById("pause-icon");
const progressText = document.getElementById("progress-text");
const progressPercent = document.getElementById("progress-percent");
const progressFill = document.getElementById("progress-fill");
const translateToggle = document.getElementById("translate-toggle");
const autoplayToggle = document.getElementById("autoplay-toggle");
const autoplayWrap = document.getElementById("autoplay-wrap");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const speedBtn = document.getElementById("speed-btn");
const repeatBtn = document.getElementById("repeat-btn");
const listenBtn = document.getElementById("listen-mode-btn");
const recallBtn = document.getElementById("recall-mode-btn");
const introBtn = document.getElementById("intro-mode-btn");
const introCountBadge = document.getElementById("intro-mode-count");
const recallCountBadge = document.getElementById("recall-mode-count");
const modeHint = document.getElementById("mode-hint");
const hamburgerBtn = document.getElementById("hamburger-btn");
const sidePanel = document.getElementById("side-panel");
const sideOverlay = document.getElementById("side-overlay");
const closeSidePanelBtn = document.getElementById("close-side-panel");
// ----- Neuer-Satz Seite -----
const nsPageEl = document.getElementById("new-sentence-page");
const nsBackBtn = document.getElementById("ns-back-btn");
const nsTabsEl = document.getElementById("ns-tabs");
const nsDeInput = document.getElementById("ns-de-input");
const nsEsInput = document.getElementById("ns-es-input");
const nsMnemonicInput = document.getElementById("ns-mnemonic-input");
const nsMultiInput = document.getElementById("ns-multi-input");
const nsMultiCountEl = document.getElementById("ns-multi-count");
const nsBulkAutoAudioEl = document.getElementById("ns-bulk-auto-audio");
const nsCatPickerEl = document.getElementById("ns-cat-picker");
const nsCatPickerMultiEl = document.getElementById("ns-cat-picker-multi");
const nsAddBtn = document.getElementById("ns-add-btn");
const nsAddBtnLabel = document.getElementById("ns-add-btn-label");
const nsAddContinueBtn = document.getElementById("ns-add-continue-btn");
const nsAdvancedEl = document.getElementById("ns-advanced-single");
const nsRecentListEl = document.getElementById("ns-recent-list");
const nsRecentAllBtn = document.getElementById("ns-recent-all");
const nsHintEl = document.getElementById("ns-hint");
const sideNewSentenceLink = document.getElementById("side-new-sentence-link");
state.nsTab = "single"; // "single" | "multi" | "claude"
const copyPromptBtn = document.getElementById("copy-prompt-btn");
const pasteTranslationsEl = document.getElementById("paste-translations");
const applyTranslationsBtn = document.getElementById("apply-translations-btn");
const pendingCountEl = document.getElementById("pending-count");
const toastEl = document.getElementById("toast");
const elKeyInput = document.getElementById("el-key-input");
const elVoiceInput = document.getElementById("el-voice-input");
const elKeyStatus = document.getElementById("el-key-status");
const saveElBtn = document.getElementById("save-el-btn");
const clearElBtn = document.getElementById("clear-el-btn");
const generateAllAudioBtn = document.getElementById("generate-all-audio-btn");
const generateAllAudioText = document.getElementById("generate-all-audio-text");
// Meine-Sätze page elements
const sideSaetzeLink = document.getElementById("side-saetze-link");
const saetzePage = document.getElementById("saetze-page");
const saetzeBackBtn = document.getElementById("saetze-back-btn");
const saetzeListEl = document.getElementById("saetze-list");
const saetzeEmptyEl = document.getElementById("saetze-empty");
const saetzeEmptyTextEl = document.getElementById("saetze-empty-text");
const saetzeFooterInfoEl = document.getElementById("saetze-footer-info");
const saetzeFilterEl = document.getElementById("saetze-filter");
const saetzeSortEl = document.getElementById("saetze-sort");
const mainSortEl = document.getElementById("main-sort");
const apiKeyInput = document.getElementById("api-key-input");
const apiKeyStatus = document.getElementById("api-key-status");
const saveApiKeyBtn = document.getElementById("save-api-key-btn");
const clearApiKeyBtn = document.getElementById("clear-api-key-btn");
const translateApiBtn = document.getElementById("translate-api-btn");
const translateApiBtnText = document.getElementById("translate-api-btn-text");

// ===== Icons =====
const ICON_STAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
const ICON_BRAIN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg>';
const ICON_SPEAKER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const ICON_M = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V4l8 10 8-10v16"/></svg>';
const ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

// ===== Toast =====
let toastTimer = null;
function showToast(msg, ms) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, ms || 2500);
}

// ===== Side panel =====
function openSidePanel() { sidePanel.classList.add("open"); sideOverlay.classList.add("open"); }
function closeSidePanel() { sidePanel.classList.remove("open"); sideOverlay.classList.remove("open"); }
hamburgerBtn.onclick = openSidePanel;
sideOverlay.onclick = closeSidePanel;
closeSidePanelBtn.onclick = closeSidePanel;

// FAB & sidebar entry: navigate to the dedicated "Neuer Satz" page.
const fabAddBtn = document.getElementById("fab-add-sentence");
if (fabAddBtn) fabAddBtn.onclick = function () { openNewSentencePage(); };
if (sideNewSentenceLink) sideNewSentenceLink.onclick = function () {
  closeSidePanel();
  openNewSentencePage();
};
if (nsBackBtn) nsBackBtn.onclick = function () { closeNewSentencePage(); };

// Remembered mode so we can restore it when the user navigates back.
let _modeBeforeNewSentence = null;

function openNewSentencePage() {
  // Remember current mode to restore on close
  _modeBeforeNewSentence = document.body.classList.contains("focus")
    ? "focus"
    : (document.body.classList.contains("recall") ? "recall" : "listen");
  // Make sure focus/recall body classes don't bleed into the page styles
  document.body.classList.remove("focus");
  document.body.classList.remove("recall");
  document.body.classList.remove("saetze");
  document.body.classList.remove("stats");
  document.body.classList.remove("scenes");
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  document.body.classList.add("new-sentence");
  buildNsCatPickers();
  renderNsRecent();
  updateNsMultiCount();
  // Default to single tab when reopening
  setNsTab("single");
  // Focus the right input shortly after layout/transition
  setTimeout(function () {
    if (state.nsTab === "single" && nsDeInput) nsDeInput.focus();
  }, 60);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function closeNewSentencePage() {
  document.body.classList.remove("new-sentence");
  // Restore the prior mode
  if (_modeBeforeNewSentence === "focus" && typeof setFocusModeActive === "function") {
    setFocusModeActive();
  } else if (_modeBeforeNewSentence === "recall") {
    document.body.classList.add("recall");
  }
  _modeBeforeNewSentence = null;
}

// User avatar dropdown (topbar right)
const userAvatarBtn = document.getElementById("user-avatar-btn");
const userMenu = document.getElementById("user-menu");
const userMenuLogout = document.getElementById("user-menu-logout");
if (userAvatarBtn && userMenu) {
  userAvatarBtn.onclick = function (e) {
    e.stopPropagation();
    userMenu.classList.toggle("open");
  };
  // Click outside closes the menu
  document.addEventListener("click", function (e) {
    if (!userMenu.classList.contains("open")) return;
    if (!userMenu.contains(e.target) && !userAvatarBtn.contains(e.target)) {
      userMenu.classList.remove("open");
    }
  });
  // Escape closes the menu
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && userMenu.classList.contains("open")) {
      userMenu.classList.remove("open");
    }
  });
}
if (userMenuLogout) {
  userMenuLogout.onclick = function () {
    if (userMenu) userMenu.classList.remove("open");
    signOut();
  };
}

// ===== API Key UI =====
function updateApiKeyUI() {
  if (state.apiKey) {
    apiKeyInput.value = "••••••••" + state.apiKey.slice(-4);
    apiKeyStatus.textContent = "✓ gespeichert";
    apiKeyStatus.className = "api-status set";
    translateApiBtn.disabled = false;
  } else {
    apiKeyInput.value = "";
    apiKeyStatus.textContent = "nicht gesetzt";
    apiKeyStatus.className = "api-status unset";
    translateApiBtn.disabled = true;
  }
}
apiKeyInput.onfocus = function () {
  // Show real value for editing
  if (state.apiKey && apiKeyInput.value.startsWith("••")) apiKeyInput.value = "";
};
saveApiKeyBtn.onclick = function () {
  const v = apiKeyInput.value.trim();
  if (!v) { showToast("Bitte API Key eingeben."); return; }
  if (!v.startsWith("sk-ant-")) {
    if (!confirm("Der Key sieht ungewöhnlich aus (sollte mit sk-ant- beginnen). Trotzdem speichern?")) return;
  }
  state.apiKey = v;
  localStorage.setItem("hl_api_key", v);
  updateApiKeyUI();
  showToast("API Key gespeichert.");
};
clearApiKeyBtn.onclick = function () {
  if (!state.apiKey) return;
  if (!confirm("API Key wirklich löschen?")) return;
  state.apiKey = "";
  localStorage.removeItem("hl_api_key");
  updateApiKeyUI();
  showToast("API Key gelöscht.");
};

// ===== ElevenLabs API Key UI =====
function updateElKeyUI() {
  if (state.elKey) {
    elKeyInput.value = "••••••••" + state.elKey.slice(-4);
    elKeyStatus.textContent = "✓ gespeichert";
    elKeyStatus.className = "api-status set";
  } else {
    elKeyInput.value = "";
    elKeyStatus.textContent = "nicht gesetzt";
    elKeyStatus.className = "api-status unset";
  }
  elVoiceInput.value = state.elVoice;
  updateGenerateAllAudioBtn();
}
elKeyInput.onfocus = function () {
  if (state.elKey && elKeyInput.value.startsWith("••")) elKeyInput.value = "";
};
saveElBtn.onclick = function () {
  const k = elKeyInput.value.trim();
  const v = elVoiceInput.value.trim();
  if (!k && !v) { showToast("Bitte API Key und/oder Voice ID eingeben."); return; }
  if (k && !k.startsWith("••")) {
    state.elKey = k;
    localStorage.setItem("hl_el_key", k);
  }
  if (v) {
    state.elVoice = v;
    localStorage.setItem("hl_el_voice", v);
  }
  updateElKeyUI();
  showToast("ElevenLabs-Konfiguration gespeichert.");
};
clearElBtn.onclick = function () {
  if (!state.elKey && state.elVoice === "21m00Tcm4TlvDq8ikWAM") return;
  if (!confirm("ElevenLabs Key & Voice ID wirklich zurücksetzen?")) return;
  state.elKey = "";
  state.elVoice = "21m00Tcm4TlvDq8ikWAM";
  localStorage.removeItem("hl_el_key");
  localStorage.removeItem("hl_el_voice");
  updateElKeyUI();
  showToast("Zurückgesetzt.");
};

// ===== Audio generation via ElevenLabs =====
async function generateAudioFor(id) {
  const s = getSentenceById(id);
  if (!s || !s.es) { showToast("Satz braucht erst eine spanische Übersetzung."); return false; }
  if (!state.elKey) { showToast("Bitte ElevenLabs API Key eingeben."); return false; }
  const url = "https://api.elevenlabs.io/v1/text-to-speech/" + state.elVoice;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": state.elKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text: s.es,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      }),
    });
    if (!resp.ok) {
      let errMsg = "ElevenLabs " + resp.status;
      try { const ej = await resp.json(); if (ej.detail) errMsg += ": " + (typeof ej.detail === "string" ? ej.detail : JSON.stringify(ej.detail).slice(0, 150)); } catch (e) {}
      showToast(errMsg, 5000);
      return false;
    }
    const blob = await resp.blob();

    // Try to upload to Supabase Storage so the audio is available on all devices.
    // Only for user sentences and only when logged in. Fails gracefully → IDB-only fallback.
    if (currentUser && isUserSentence(id)) {
      const path = currentUser.id + "/sentence_" + id + ".mp3";
      try {
        const { error: upErr } = await sb.storage.from("audios")
          .upload(path, blob, { upsert: true, contentType: "audio/mpeg" });
        if (upErr) throw upErr;
        // Persist audio_path on the sentence: state, cloud, localStorage cache
        const s = getSentenceById(id);
        if (s) s.audio_path = path;
        const { error: dbErr } = await sb.from("user_sentences")
          .update({ audio_path: path }).eq("id", id).eq("user_id", currentUser.id);
        if (dbErr) console.warn("audio_path DB update failed:", dbErr);
        localStorage.setItem("hl_user_sentences", JSON.stringify(state.userSentences));
      } catch (storageErr) {
        console.warn("Storage upload failed, IDB-only fallback:", storageErr);
        // No toast — IDB cache below still gives a working local experience.
      }
    }

    // Always save to IDB as offline cache (also used when audio_path is empty)
    await saveAudioToIDB(id, blob);
    return true;
  } catch (e) {
    showToast("Audio-Fehler: " + e.message, 5000);
    console.error(e);
    return false;
  }
}

// Parallel-Sperre (Bugfix Juni 2026): Bulk-Import-Queue und der
// „Alle generieren"-Button konnten gleichzeitig laufen und denselben Satz
// doppelt generieren → doppelte ElevenLabs-Kosten + konkurrierende
// Storage-Uploads. Ein simples globales Flag reicht (Single-User-App).
let _audioGenRunning = false;

// Background audio queue for bulk imports. Sequential (ElevenLabs rate-limits +
// gentler on the user's quota). Each item already uploads to Storage via
// generateAudioFor. Progress is shown via toast updates.
async function generateBulkAudios(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (!state.elKey) { showToast("ElevenLabs Key fehlt — Audios nicht generiert.", 4000); return; }
  if (_audioGenRunning) { showToast("Audio-Generierung läuft bereits — bitte warten.", 4000); return; }
  _audioGenRunning = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < ids.length; i++) {
    showToast("Audio " + (i + 1) + " / " + ids.length + " …", 60000);
    const success = await generateAudioFor(ids[i]);
    if (success) ok++; else fail++;
    // Re-render so each card shows the new audio icon as it finishes
    renderCards();
    buildUserSentencesList();
    // Small pause to avoid hammering ElevenLabs
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  _audioGenRunning = false;
  updateGenerateAllAudioBtn();
  const summary = "Audio-Generierung fertig: " + ok + " erfolgreich"
    + (fail ? ", " + fail + " fehlgeschlagen" : "");
  showToast(summary, 4000);
}

async function generateAllPendingAudios() {
  const candidates = state.userSentences.filter(function (s) {
    return !s.archived && s.es && !s.pending && !hasAudio(s);
  });
  if (candidates.length === 0) { showToast("Keine ausstehenden Audios."); return; }
  if (!state.elKey) { showToast("Bitte ElevenLabs API Key eingeben."); return; }
  if (_audioGenRunning) { showToast("Audio-Generierung läuft bereits — bitte warten.", 4000); return; }
  _audioGenRunning = true;
  generateAllAudioBtn.disabled = true;
  generateAllAudioBtn.classList.add("loading");
  let ok = 0, fail = 0;
  for (let i = 0; i < candidates.length; i++) {
    generateAllAudioText.textContent = "Generiere " + (i + 1) + " / " + candidates.length + " ...";
    const success = await generateAudioFor(candidates[i].id);
    if (success) { ok++; } else { fail++; break; }
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  _audioGenRunning = false;
  generateAllAudioBtn.disabled = false;
  generateAllAudioBtn.classList.remove("loading");
  updateGenerateAllAudioBtn();
  renderCards();
  buildUserSentencesList();
  showToast(ok + " Audio(s) generiert" + (fail ? ", " + fail + " fehlgeschlagen" : "") + ".");
}
generateAllAudioBtn.onclick = generateAllPendingAudios;

// Die „Offline-Vorbereitung" (Audio-Pre-Fetch in den SW-Cache, Mai 2026)
// wurde im Juni 2026 entfernt — User-Entscheidung: Offline-Nutzung ist kein
// reales Szenario (zu 90% online). Audios werden weiterhin beim ERSTEN
// Abspielen automatisch vom SW gecacht (spart Egress/Bandbreite), aber es
// gibt keinen manuellen Prefetch-Button mehr. Hintergrund-Audio (Shadowing
// bei gesperrtem Screen) ist davon unabhängig und bleibt voll erhalten.

function updateGenerateAllAudioBtn() {
  const candidates = state.userSentences.filter(function (s) {
    return !s.archived && s.es && !s.pending && !hasAudio(s);
  });
  generateAllAudioBtn.disabled = !state.elKey || candidates.length === 0;
  if (!state.elKey) generateAllAudioText.textContent = "ElevenLabs Key fehlt";
  else if (candidates.length === 0) generateAllAudioText.textContent = "Keine ausstehenden Audios";
  else generateAllAudioText.textContent = "Audios für alle generieren (" + candidates.length + ")";
}

// ===== Translation prompt builder =====
function pendingSentences() {
  return state.userSentences.filter(function (s) { return s.pending && s.de; });
}
function buildTranslationPrompt() {
  const pending = pendingSentences();
  if (pending.length === 0) return null;
  let text = "Bitte übersetze die folgenden deutschen Sätze auf Guatemala-Spanisch (informelle tú-Form, alltagsnah, wie in Guatemala gesprochen). Behalte das exakte Format bei und antworte mit \"ES:\" statt \"DE:\" für jeden Satz.\n\n";
  for (const s of pending) text += "ID: " + s.id + "\nDE: " + s.de + "\n\n";
  return text.trim();
}

// ===== Translation via Anthropic API =====
async function translateViaAPI() {
  const pending = pendingSentences();
  if (pending.length === 0) { showToast("Keine ausstehenden Sätze."); return; }
  if (!state.apiKey) { showToast("Bitte API Key eingeben."); return; }

  translateApiBtn.disabled = true;
  translateApiBtn.classList.add("loading");
  translateApiBtnText.textContent = "Übersetze " + pending.length + " Sätze...";

  const systemPrompt = "Du übersetzt deutsche Sätze ins Spanisch, wie in Guatemala gesprochen (informelle tú-Form, alltagsnah, mit guatemaltekischen Ausdrücken wo passend). Antworte AUSSCHLIESSLICH im exakten Format unten — keine Einleitung, kein Kommentar.\n\nFormat:\nID: <nummer>\nES: <spanische Übersetzung>\n\n(eine Leerzeile zwischen Sätzen)";
  const userPrompt = pending.map(function (s) { return "ID: " + s.id + "\nDE: " + s.de; }).join("\n\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": state.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!response.ok) {
      let errMsg = "API Fehler: " + response.status;
      try { const ej = await response.json(); if (ej.error && ej.error.message) errMsg += " — " + ej.error.message; } catch (e) {}
      showToast(errMsg, 5000);
      return;
    }
    const data = await response.json();
    const text = (data.content && data.content[0] && data.content[0].text) || "";
    if (!text) { showToast("Leere Antwort von der API."); return; }
    parseAndApplyTranslations(text);
  } catch (e) {
    showToast("Netzwerkfehler: " + e.message, 5000);
    console.error(e);
  } finally {
    translateApiBtn.disabled = false;
    translateApiBtn.classList.remove("loading");
    translateApiBtnText.textContent = "Mit Claude API übersetzen";
  }
}
translateApiBtn.onclick = translateViaAPI;

// ===== Apply translations (shared) =====
function parseAndApplyTranslations(text) {
  const lines = text.split("\n");
  let curId = null;
  let applied = 0;
  for (const line of lines) {
    const idMatch = line.match(/^\s*ID:\s*(\d+)/i);
    if (idMatch) { curId = parseInt(idMatch[1], 10); continue; }
    const esMatch = line.match(/^\s*ES:\s*(.+)$/i);
    if (esMatch && curId !== null) {
      const sent = state.userSentences.find(function (s) { return s.id === curId; });
      if (sent) {
        sent.es = esMatch[1].trim();
        sent.pending = false;
        applied++;
      }
      curId = null;
    }
  }
  if (applied === 0) { showToast("Keine Übersetzungen erkannt. Format prüfen."); return; }
  saveJSON("hl_user_sentences", state.userSentences);
  applyFilter();
  updatePendingBadge();
  buildUserSentencesList();
  showToast(applied + " Übersetzungen angewendet.");
}

// ===== Category filter (sidebar) =====
function buildCatFilter() {
  catFilterEl.innerHTML = "";
  const allChip = document.createElement("button");
  allChip.className = "cat-chip" + (state.activeCats.size === 0 ? " active" : "");
  allChip.innerHTML = '<span class="checkmark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span>Alle Kategorien</span>';
  allChip.onclick = function () { state.activeCats.clear(); buildCatFilter(); applyFilter(); };
  catFilterEl.appendChild(allChip);
  for (const cat of DATA.categories) {
    const chip = document.createElement("button");
    chip.className = "cat-chip" + (state.activeCats.has(cat.key) ? " active" : "");
    chip.innerHTML = '<span class="checkmark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span>' + cat.label + '</span>';
    chip.onclick = function () {
      if (state.activeCats.has(cat.key)) state.activeCats.delete(cat.key);
      else state.activeCats.add(cat.key);
      buildCatFilter(); applyFilter();
    };
    catFilterEl.appendChild(chip);
  }
}

// Material Symbols icon for each category key.
const NS_CAT_ICONS = {
  Arbeit:                  "work",
  Baby:                    "child_care",
  Familie_Freunde:         "group",
  Gesundheit_Koerper:      "ecg_heart",
  Hobby_Freizeit:          "sports_esports",
  Kueche_Essen:            "restaurant",
  Reisen_Verkehr:          "directions_car",
  Smalltalk_Hoeflichkeit:  "chat_bubble",
  Wetter_Natur:            "cloud",
  Wohnen_Haushalt:         "home",
};

function buildNsCatPickers() {
  buildNsCatPicker(nsCatPickerEl);
  buildNsCatPicker(nsCatPickerMultiEl);
}
function buildNsCatPicker(containerEl) {
  if (!containerEl) return;
  containerEl.innerHTML = "";
  for (const cat of DATA.categories) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ns-cat-chip" + (state.newSentenceCats.has(cat.key) ? " active" : "");
    const iconName = NS_CAT_ICONS[cat.key] || "label";
    chip.innerHTML =
      '<span class="material-symbols-outlined ns-cat-icon">' + iconName + '</span>' +
      '<span>' + cat.label + '</span>';
    chip.onclick = function () {
      if (state.newSentenceCats.has(cat.key)) state.newSentenceCats.delete(cat.key);
      else state.newSentenceCats.add(cat.key);
      buildNsCatPickers();
    };
    containerEl.appendChild(chip);
  }
}

// Tab switching
function setNsTab(tab) {
  state.nsTab = tab;
  nsTabsEl.querySelectorAll(".ns-tab").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.nsTab === tab);
  });
  document.querySelectorAll(".ns-tab-content").forEach(function (el) {
    el.style.display = el.dataset.nsContent === tab ? "" : "none";
  });
  // Adjust the action row for the current tab
  if (tab === "claude") {
    nsAddBtn.disabled = true;
    nsAddContinueBtn.disabled = true;
    nsAddBtnLabel.textContent = "Bald verfügbar";
    nsHintEl.textContent = "Dieser Modus ist noch nicht aktiv.";
  } else if (tab === "multi") {
    nsAddBtn.disabled = false;
    nsAddContinueBtn.disabled = true; // continue makes no sense after bulk
    nsAddBtnLabel.textContent = "Alle hinzufügen";
    nsHintEl.textContent = "Übersetzungen laufen im Hintergrund";
  } else {
    nsAddBtn.disabled = false;
    nsAddContinueBtn.disabled = false;
    nsAddBtnLabel.textContent = "Hinzufügen";
    nsHintEl.textContent = "Übersetzung läuft im Hintergrund";
  }
}
if (nsTabsEl) {
  nsTabsEl.querySelectorAll(".ns-tab").forEach(function (btn) {
    btn.onclick = function () {
      if (btn.classList.contains("disabled") || btn.disabled) return;
      setNsTab(btn.dataset.nsTab);
    };
  });
}

// Multi-mode: live count of parsed sentences.
// Returns [{de, es}, ...]. Each line:
//   - With TAB → first part = DE, rest joined back together = ES (paired import)
//   - Without TAB → only DE, ES empty (will be translated later via Claude API)
function parseMultiLines() {
  if (!nsMultiInput) return [];
  return nsMultiInput.value.split("\n")
    .map(function (rawLine) {
      const line = rawLine.replace(/\r$/, ""); // tolerate Windows line endings
      if (!line.trim()) return null;
      const tabIdx = line.indexOf("\t");
      if (tabIdx >= 0) {
        const de = line.slice(0, tabIdx).trim();
        const es = line.slice(tabIdx + 1).trim();
        return { de: de, es: es };
      }
      return { de: line.trim(), es: "" };
    })
    .filter(function (p) { return p && p.de.length > 0; });
}
function updateNsMultiCount() {
  if (!nsMultiCountEl || !nsMultiInput) return;
  const parsed = parseMultiLines();
  const n = parsed.length;
  const withEs = parsed.filter(function (p) { return p.es.length > 0; }).length;
  if (n === 0) {
    nsMultiCountEl.textContent = "0 Sätze erkannt";
  } else if (withEs === 0) {
    // Pure DE-only paste — keep the old, calm label
    nsMultiCountEl.textContent = n === 1 ? "1 Satz erkannt" : (n + " Sätze erkannt");
  } else {
    // Mixed or all-paired — show breakdown so the user knows TAB was detected
    const pending = n - withEs;
    let detail = withEs + " mit Übersetzung";
    if (pending > 0) detail += ", " + pending + " ausstehend";
    nsMultiCountEl.textContent = n + " Sätze erkannt (" + detail + ")";
  }
}
if (nsMultiInput) nsMultiInput.addEventListener("input", updateNsMultiCount);

// Core: add one user sentence and persist + sync.
// Returns the new id, or null if validation failed.
function addUserSentence(opts) {
  const de = (opts.de || "").trim();
  if (!de) return null;
  const id = nextUserId();
  const es = (opts.es || "").trim();
  // Szenen-Felder (v1) — alle drei optional, nullable in DB
  const sceneId = opts.scene_id || null;
  const sceneOrder = (typeof opts.scene_order === "number") ? opts.scene_order : null;
  const sceneRole = opts.scene_role || null;
  state.userSentences.push({
    id: id,
    de: de,
    es: es,
    cats: opts.cats ? [...opts.cats] : [],
    audio: "",
    pending: es ? false : true,
    scene_id: sceneId,
    scene_order: sceneOrder,
    scene_role: sceneRole,
  });
  if (opts.mnemonic && opts.mnemonic.trim()) {
    state.mnemonics[id] = opts.mnemonic.trim();
    saveJSON("hl_mnemonics", state.mnemonics);
  }
  // New cards automatically enter the Einführungs-Pool (intro_count = 0 = backlog).
  // Existing cards keep their default of 5 (active) since they have no entry.
  // Other-Linien einer Szene werden NICHT in den Pool gelegt (sie sind nicht
  // für SRS gedacht) — wir setzen sie auf 5 (active=neutral), damit sie aus
  // Listen/Auto trotzdem hörbar bleiben, aber nicht im Einführungs-Modus
  // erscheinen.
  if (sceneRole === "other") {
    setIntroCount(id, 5);
  } else {
    setIntroCount(id, 0);
  }
  saveJSON("hl_user_sentences", state.userSentences);
  // Statistik-Counter: echte neue Lernsätze. Szenen-"other"-Linien sind keine
  // eigenständigen Lernkarten und zählen daher nicht. (Seit Juni 2026 keine
  // Tagesziel-Pflichtaufgabe mehr — Counter bleibt für Stats/Sync erhalten.)
  if (sceneRole !== "other" && typeof incrementStat === "function") {
    incrementStat("new_sentences");
  }
  return id;
}

// ===== Szenen-Lifecycle: Erstellen + Update =====
// addScene(opts) — legt eine neue Szene an. Reicht für Phase 2 (Import).
// state.scenes wird mutiert, saveJSON triggert den Cloud-Push.
// opts: { title, setting?, participants?, status?, source? }
function addScene(opts) {
  if (!opts || !opts.title) return null;
  const id = nextSceneId();
  const sc = {
    id: id,
    title: opts.title,
    setting: opts.setting || "",
    participants: opts.participants ? [...opts.participants] : [],
    status: opts.status || "draft",
    practice_count: 0,
    last_practiced_at: null,
    source: opts.source || "conversation",
    created_at: new Date().toISOString(),
  };
  state.scenes.push(sc);
  saveJSON("hl_scenes", state.scenes);
  return id;
}

function updateScene(id, patch) {
  const sc = getSceneById(id);
  if (!sc) return false;
  Object.assign(sc, patch);
  saveJSON("hl_scenes", state.scenes);
  return true;
}

function deleteScene(id) {
  // Sätze werden NICHT gelöscht — sie verlieren nur die Bindung
  // (DB-Constraint: on delete set null). Lokal müssen wir das selbst tun.
  for (const s of state.userSentences) {
    if (s.scene_id === id) {
      s.scene_id = null;
      s.scene_order = null;
      s.scene_role = null;
    }
  }
  state.scenes = state.scenes.filter(function (sc) { return sc.id !== id; });
  // Tombstone (Juni 2026): analog zu Sätzen — pushScenes löscht nur noch
  // explizit lokal gelöschte Szenen aus der Cloud.
  addTombstone("hl_deleted_scene_ids", id);
  saveJSON("hl_user_sentences", state.userSentences);
  saveJSON("hl_scenes", state.scenes);
}

// Helper für die Szenen-Liste: pro Szene die abgeleiteten Stats berechnen
// (Satz-Anzahl, self-Anzahl, runs, durchschnittlicher Lern-Fortschritt).
function sceneStats(scene) {
  if (!scene) return null;
  const sentences = state.userSentences.filter(function (s) {
    return s.scene_id === scene.id && !s.archived;
  });
  const selfSentences = sentences.filter(function (s) {
    return s.scene_role !== "other"; // self oder unset
  });
  // Durchschnittlicher Lern-Fortschritt = mean(intro_count / 5) über self-Karten,
  // gecapped bei 1.0. Eine Karte ohne Eintrag (intro_count=5 default) zählt als
  // voll fortgeschritten.
  let avgProgress = 1.0;
  if (selfSentences.length > 0) {
    let sum = 0;
    for (const s of selfSentences) {
      const ic = getIntroCount(s.id);
      sum += Math.min(1, ic / 5);
    }
    avgProgress = sum / selfSentences.length;
  }
  // "Zuletzt geübt" als relative Zeit
  let lastPracticedAgo = null;
  if (scene.last_practiced_at) {
    const t = new Date(scene.last_practiced_at).getTime();
    if (!isNaN(t)) {
      const diffMs = Date.now() - t;
      const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (days <= 0) lastPracticedAgo = "heute";
      else if (days === 1) lastPracticedAgo = "gestern";
      else if (days < 7) lastPracticedAgo = "vor " + days + " Tagen";
      else if (days < 30) lastPracticedAgo = "vor " + Math.floor(days / 7) + " Wochen";
      else lastPracticedAgo = "vor " + Math.floor(days / 30) + " Monaten";
    }
  }
  return {
    sentences: sentences,
    sentenceCount: sentences.length,
    selfCount: selfSentences.length,
    runs: scene.practice_count || 0,
    avgProgress: avgProgress,
    lastPracticedAgo: lastPracticedAgo,
  };
}

function clearNsForm() {
  if (nsDeInput) nsDeInput.value = "";
  if (nsEsInput) nsEsInput.value = "";
  if (nsMnemonicInput) nsMnemonicInput.value = "";
  state.newSentenceCats.clear();
  if (nsAdvancedEl) nsAdvancedEl.open = false;
  buildNsCatPickers();
}

function submitNsForm(continueMode) {
  if (state.nsTab === "claude") return;

  if (state.nsTab === "multi") {
    const parsed = parseMultiLines();
    if (parsed.length === 0) {
      showToast("Bitte mindestens einen Satz eingeben.");
      return;
    }
    const ids = [];
    const idsWithEs = [];
    for (const pair of parsed) {
      const id = addUserSentence({ de: pair.de, es: pair.es, cats: state.newSentenceCats });
      if (id) {
        ids.push(id);
        if (pair.es) idsWithEs.push(id);
      }
    }
    if (nsMultiInput) nsMultiInput.value = "";
    state.newSentenceCats.clear();
    buildNsCatPickers();
    updateNsMultiCount();
    applyFilter();
    updatePendingBadge();
    updateProgress();
    buildUserSentencesList();
    renderNsRecent();
    const range = ids.length > 1 ? "#" + ids[0] + "–#" + ids[ids.length - 1] : "#" + ids[0];
    showToast(ids.length + " Sätze hinzugefügt (" + range + ").");
    // If auto-audio is on AND at least one sentence has ES → run the background queue.
    const autoAudio = nsBulkAutoAudioEl && nsBulkAutoAudioEl.checked;
    if (autoAudio && idsWithEs.length > 0 && state.elKey) {
      // Fire-and-forget; the queue updates UI on its own as it runs.
      generateBulkAudios(idsWithEs);
    } else if (autoAudio && idsWithEs.length > 0 && !state.elKey) {
      showToast("ElevenLabs Key fehlt — Audios nicht generiert.", 4000);
    }
    closeNewSentencePage();
    return;
  }

  // Single mode
  const de = nsDeInput ? nsDeInput.value.trim() : "";
  if (!de) {
    showToast("Bitte einen deutschen Satz eingeben.");
    if (nsDeInput) nsDeInput.focus();
    return;
  }
  const es = nsEsInput ? nsEsInput.value : "";
  const mnemonic = nsMnemonicInput ? nsMnemonicInput.value : "";
  const id = addUserSentence({
    de: de,
    es: es,
    cats: state.newSentenceCats,
    mnemonic: mnemonic,
  });

  applyFilter();
  updatePendingBadge();
  updateProgress();
  buildUserSentencesList();
  renderNsRecent();
  showToast("Satz #" + id + " hinzugefügt.");

  if (continueMode) {
    clearNsForm();
    if (nsDeInput) nsDeInput.focus();
  } else {
    clearNsForm();
    closeNewSentencePage();
  }
}

if (nsAddBtn) nsAddBtn.onclick = function () { submitNsForm(false); };
if (nsAddContinueBtn) nsAddContinueBtn.onclick = function () { submitNsForm(true); };

// Cmd/Ctrl+Enter to submit (and Shift+Enter on the DE input keeps you in the form).
function handleNsKeydown(e) {
  if (!document.body.classList.contains("new-sentence")) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    submitNsForm(e.shiftKey);
  } else if (e.key === "Escape") {
    if (state.nsTab !== "single" && state.nsTab !== "multi") return;
    e.preventDefault();
    closeNewSentencePage();
  }
}
document.addEventListener("keydown", handleNsKeydown);

// Recent additions list
function renderNsRecent() {
  if (!nsRecentListEl) return;
  // Last 5 non-archived user sentences, newest first
  const recent = state.userSentences
    .filter(function (s) { return !s.archived; })
    .slice()
    .sort(function (a, b) { return b.id - a.id; })
    .slice(0, 5);

  nsRecentListEl.innerHTML = "";
  if (recent.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ns-recent-empty";
    empty.textContent = "Noch keine eigenen Sätze. Schreib oben deinen ersten.";
    nsRecentListEl.appendChild(empty);
    return;
  }
  for (const s of recent) {
    const row = document.createElement("div");
    row.className = "ns-recent-row";
    const esEl = s.es
      ? '<div class="ns-recent-es">' + escapeHtml(s.es) + '</div>'
      : '<div class="ns-recent-es-placeholder">— Übersetzung ausstehend —</div>';
    const statusCls = s.pending ? "pending" : "ready";
    const statusTxt = s.pending ? "Pending" : "Fertig";
    row.innerHTML =
      '<span class="ns-recent-id">#' + s.id + '</span>' +
      '<span class="ns-recent-status ' + statusCls + '">' + statusTxt + '</span>' +
      '<div class="ns-recent-text">' +
        esEl +
        '<div class="ns-recent-de">' + escapeHtml(s.de) + '</div>' +
      '</div>' +
      '<span class="material-symbols-outlined ns-recent-icon">volume_up</span>';
    nsRecentListEl.appendChild(row);
  }
}

// Tiny HTML escape helper for recent rows
// escapeHtml() lebt seit Juni 2026 in core.js (testbar).

// "Alle ansehen" → Meine-Sätze-Page öffnen (Bugfix Juni 2026: zeigte vorher
// auf die in Phase 0 entfernte Sidebar-Sektion #my-sentences-section und
// öffnete damit nur eine leere Sidebar).
if (nsRecentAllBtn) nsRecentAllBtn.onclick = function () {
  closeNewSentencePage();
  if (typeof openSaetzePage === "function") openSaetzePage();
};

copyPromptBtn.onclick = function () {
  const text = buildTranslationPrompt();
  if (!text) { showToast("Keine ausstehenden Übersetzungen."); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      const n = pendingSentences().length;
      showToast(n + " Sätze in Zwischenablage.");
    }).catch(function () { fallbackCopy(text); });
  } else { fallbackCopy(text); }
};
function fallbackCopy(text) {
  pasteTranslationsEl.value = text;
  pasteTranslationsEl.select();
  showToast("Bitte manuell kopieren (Ctrl+C).", 4000);
}
applyTranslationsBtn.onclick = function () {
  const text = pasteTranslationsEl.value;
  if (!text.trim()) { showToast("Nichts zum Anwenden."); return; }
  parseAndApplyTranslations(text);
  pasteTranslationsEl.value = "";
};

function updatePendingBadge() {
  const n = pendingSentences().length;
  pendingCountEl.textContent = n > 0 ? n : "";
  translateApiBtn.disabled = !state.apiKey || n === 0;
  if (n === 0) translateApiBtnText.textContent = "Keine ausstehenden Sätze";
  else if (!state.apiKey) translateApiBtnText.textContent = "API Key fehlt";
  else translateApiBtnText.textContent = "Mit Claude API übersetzen (" + n + ")";
}

function archiveOrDelete(id) {
  const s = state.userSentences.find(function (x) { return x.id === id; });
  if (!s) return;
  if (s.pending) {
    if (!confirm("Satz „" + s.de.slice(0, 40) + "…“ wirklich löschen?")) return;
    permanentDeleteUserSentence(id, true);
  } else {
    if (!confirm("Karte „" + s.de.slice(0, 40) + "…“ ins Archiv verschieben?")) return;
    archiveUserSentence(id);
  }
}

function archiveUserSentence(id) {
  const s = state.userSentences.find(function (x) { return x.id === id; });
  if (!s) return;
  s.archived = true;
  saveJSON("hl_user_sentences", state.userSentences);
  applyFilter();
  buildUserSentencesList();
  showToast("Ins Archiv verschoben.");
}

function restoreUserSentence(id) {
  const s = state.userSentences.find(function (x) { return x.id === id; });
  if (!s) return;
  s.archived = false;
  saveJSON("hl_user_sentences", state.userSentences);
  applyFilter();
  buildUserSentencesList();
  showToast("Wiederhergestellt.");
}

function permanentDeleteUserSentence(id, silent) {
  const s = state.userSentences.find(function (x) { return x.id === id; });
  if (!s) return;
  if (!silent && !confirm("Karte DAUERHAFT löschen? Diese Aktion kann nicht rückgängig gemacht werden.\n\n„" + s.de.slice(0, 80) + "…“")) return;
  const audioPathToDelete = s.audio_path || "";
  state.userSentences = state.userSentences.filter(function (x) { return x.id !== id; });
  delete state.ratings[id];
  delete state.mnemonics[id];
  delete state.cardState[id];
  // Orphan-Cleanup (Juni 2026): introCounts wurde hier vorher vergessen.
  delete state.introCounts[id];
  state.shownMnemonics.delete(id);
  state.editingMnemonics.delete(id);
  // Tombstone (Juni 2026): merkt sich die Löschung für pushUserSentences,
  // damit der Cloud-Delete gezielt nur diese ID trifft (kein Diff-Delete mehr).
  addTombstone("hl_deleted_ids", id);
  saveJSON("hl_user_sentences", state.userSentences);
  saveJSON("hl_ratings", state.ratings);
  saveJSON("hl_mnemonics", state.mnemonics);
  saveJSON("hl_card_state", state.cardState);
  saveJSON("hl_intro_counts", state.introCounts);
  saveShownMnemonics();
  deleteAudioFromIDB(id);
  // Also delete from Supabase Storage if this card had a cloud audio file.
  // Fire-and-forget: a Storage cleanup failure shouldn't block the local delete.
  if (audioPathToDelete && currentUser) {
    sb.storage.from("audios").remove([audioPathToDelete]).then(function (res) {
      if (res && res.error) console.warn("Storage delete failed for", audioPathToDelete, res.error);
    }).catch(function (e) { console.warn("Storage delete error:", e); });
  }
  applyFilter();
  updatePendingBadge();
  updateProgress();
  buildUserSentencesList();
  if (!silent) showToast("Endgültig gelöscht.");
  else showToast("Gelöscht.");
}

function deleteUserSentence(id) { archiveOrDelete(id); }

// ===== Rating =====
function getRating(id) { return state.ratings[id] || null; }
function setRating(id, value) {
  if (value === null) delete state.ratings[id];
  else state.ratings[id] = value;
  saveJSON("hl_ratings", state.ratings);
  // SRS Phase A: jede Rating-Setzung scheduled die Karte neu.
  // Lapse-Regel ist brutal-simpel: das neue Intervall überschreibt den alten
  // due_at, egal wie weit die Karte vorher war. 1★ auf einer 30d-Karte = morgen.
  if (value !== null) {
    scheduleNext(id, value);
    incrementStat("rated");
  } else {
    clearCardState(id);
  }
  buildRatingFilter();
  updateProgress();
  if (typeof updateRecallModeBtn === "function") updateRecallModeBtn();
}

// =====================================================================
// SRS · Phase A + Graduation (Juni 2026)
// =====================================================================
// Basis-Intervalle: 1★ = nochmal morgen, 2★ = in 3 Tagen, 3★ = in einer
// Woche, gelernt = in 30 Tagen. Keine Ease-Factor-Berechnung, keine
// Lapse-Historie. Seit Juni 2026 mit GRADUATION: Erfolg (3★/gelernt) auf
// eine fällige Karte verdoppelt das bisherige Intervall (30 → 60 → 120 →
// 180d-Cap) — sonst würde die tägliche Review-Last linear mit dem Korpus
// wachsen. Lapse (1★/2★) bleibt brutal: Reset aufs Basis-Intervall, egal
// wo die Karte war. Rechen-Logik: core.js → srsNextInterval().

const SRS_INTERVALS = { 1: 1, 2: 3, 3: 7, learned: 30 };
// Graduation-Cap (Juni 2026): Erfolgs-Intervalle verdoppeln sich bis max.
// 180 Tage. Logik in core.js → srsNextInterval() (getestet via tests.html).
const SRS_MAX_INTERVAL_DAYS = 180;

// isoToday() / isoAddDays() leben seit Juni 2026 in core.js (testbar).

function scheduleNext(id, rating) {
  const today = isoToday();
  const prev = state.cardState[id] || null;
  // Karte gilt als fällig, wenn kein Eintrag existiert (nie bewertet) oder
  // due_at erreicht/überschritten ist — gleiche Semantik wie isDueToday().
  const isDue = !prev || !prev.due_at || prev.due_at <= today;
  const days = srsNextInterval(prev, rating, isDue, SRS_INTERVALS, SRS_MAX_INTERVAL_DAYS);
  if (days === null) return; // unbekanntes Rating → nichts tun
  state.cardState[id] = {
    interval_days: days,
    due_at: isoAddDays(today, days),
    last_reviewed_at: today,
  };
  saveJSON("hl_card_state", state.cardState);
}

function clearCardState(id) {
  if (state.cardState[id]) {
    delete state.cardState[id];
    saveJSON("hl_card_state", state.cardState);
  }
}

// Heute-fällig-Logik: ohne card_state-Eintrag gilt eine aktive Karte als "fällig"
// (noch nie bewertet → muss erstmal eingeschätzt werden). Sonst gilt der due_at.
function isDueToday(id) {
  const cs = state.cardState[id];
  if (!cs || !cs.due_at) return true;
  return cs.due_at <= isoToday();
}

// Liefert die Karten-Queue für den Recall-Modus.
// Logik: alle aktiven (intro_count >= 5), nicht archivierten Karten als Pool;
// erst die heute-fälligen; wenn weniger als minCount (5), mit den nächst-fälligen
// auffüllen (Smart Fallback — damit Recall sich nie leer anfühlt).
function recallQueue(minCount) {
  if (typeof minCount !== "number") minCount = 5;
  const today = isoToday();
  const active = allSentences().filter(function (s) {
    if (!isPracticeable(s)) return false; // archiviert, pending, oder Szenen-other-Linie
    if (stageOf(s.id) !== "active") return false;
    return true;
  });
  const due = active.filter(function (s) { return isDueToday(s.id); });
  if (due.length >= minCount) return due.map(function (s) { return s.id; });
  // Smart Fallback: ergänze mit den nächst-fälligen, bis minCount erreicht ist.
  // Karten ohne card_state sind schon in `due`, fallen also hier raus.
  const others = active
    .filter(function (s) { return !isDueToday(s.id); })
    .sort(function (a, b) {
      const da = (state.cardState[a.id] && state.cardState[a.id].due_at) || "9999-99-99";
      const db = (state.cardState[b.id] && state.cardState[b.id].due_at) || "9999-99-99";
      return da.localeCompare(db);
    });
  return due.concat(others.slice(0, Math.max(0, minCount - due.length)))
            .map(function (s) { return s.id; });
}

// Anzahl der heute-tatsächlich-fälligen Karten (ohne Smart-Fallback-Auffüllung)
// — für den Counter auf dem Recall-Mode-Button.
function dueCount() {
  let n = 0;
  for (const s of allSentences()) {
    if (!isPracticeable(s)) continue;
    if (stageOf(s.id) !== "active") continue;
    if (isDueToday(s.id)) n++;
  }
  return n;
}

// Anzahl Karten, die bis MORGEN fällig sind (heute noch offene inklusive) —
// für den „Morgen"-Ausblick auf der Session-Postkarte (Open Loop, B2/E1).
function dueCountTomorrow() {
  const tomorrow = isoAddDays(isoToday(), 1);
  let n = 0;
  for (const s of allSentences()) {
    if (!isPracticeable(s)) continue;
    if (stageOf(s.id) !== "active") continue;
    const cs = state.cardState[s.id];
    if (!cs || !cs.due_at || cs.due_at <= tomorrow) n++;
  }
  return n;
}

// ===== Reveal-Cue (B1 · Motivations-Sprint Juni 2026) =====
// Variable Reward: Wenn eine aufgedeckte Karte lange weg war (21+ Tage),
// kurzer grüner Glow + Mikro-Label „Seit N Tagen weg — und du kannst ihn
// noch." Kein Toast, kein Modal — ein echtes Aha statt Zufalls-Gimmick.
const REVEAL_CUE_MIN_DAYS = 21;
function srsGapDays(id) {
  const cs = state.cardState[id];
  if (!cs || !cs.last_reviewed_at) return 0;
  const ms = Date.parse(isoToday() + "T00:00:00") - Date.parse(cs.last_reviewed_at + "T00:00:00");
  return Math.max(0, Math.round(ms / 86400000));
}
// containerEl = .card (Recall-Liste) oder .focus-card (Fokus-Session).
function maybeShowRevealCue(containerEl, id, isFocus) {
  if (!containerEl) return;
  const gap = srsGapDays(id);
  if (gap < REVEAL_CUE_MIN_DAYS) return;
  const old = containerEl.querySelector(".reveal-cue, .focus-reveal-cue");
  if (old) old.remove();
  const cue = document.createElement("div");
  cue.className = isFocus ? "focus-reveal-cue" : "reveal-cue";
  cue.textContent = "Seit " + gap + " Tagen weg — und du kannst ihn noch.";
  if (isFocus) {
    // Nach der ES-Seite einfügen
    const esSide = containerEl.querySelector("#focus-side-es");
    if (esSide && esSide.parentNode) esSide.parentNode.insertBefore(cue, esSide.nextSibling);
    else containerEl.appendChild(cue);
  } else {
    containerEl.appendChild(cue); // Flex-Order (CSS) positioniert nach .es
  }
  containerEl.classList.add("reveal-cue-glow");
  setTimeout(function () { containerEl.classList.remove("reveal-cue-glow"); }, 1500);
}

// ===== App-Icon-Badge (H5 · Motivations-Sprint Juni 2026) =====
// Zeigt die Anzahl heute fälliger Karten auf dem installierten PWA-Icon
// (Badging API; Android Chrome + Desktop Chrome/Edge). Passiver täglicher
// Trigger ohne Push-Notification — User-Problem war „App wird gar nicht
// erst geöffnet". Wird in updateProgress() aktualisiert (läuft bei jeder
// Rating-/Karten-Änderung) und einmal beim Boot.
function updateAppBadge() {
  if (!("setAppBadge" in navigator)) return;
  try {
    const n = dueCount();
    if (n > 0) navigator.setAppBadge(Math.min(n, 99)).catch(function () {});
    else navigator.clearAppBadge().catch(function () {});
  } catch (e) { /* Badging nicht verfügbar — egal */ }
}

// =====================================================================
// Basis-Statistiken — Counter pro Tag
// =====================================================================
// Inkrementelle Aggregation pro Tag, gepuscht in profiles.settings.stats.
// Granularität: nur Tages-Counter, keine Event-Logs. Reicht für Streak,
// Heatmap und Wochenzahlen.

function ensureStatsDay(date) {
  if (!state.stats.daily) state.stats.daily = {};
  if (!state.stats.all_time) state.stats.all_time = {};
  if (!state.stats.daily[date]) state.stats.daily[date] = { plays: 0, reveals: 0, rated: 0 };
  if (!state.stats.all_time.first_active_date) state.stats.all_time.first_active_date = date;
  return state.stats.daily[date];
}

function incrementStat(key, amount) {
  if (typeof amount !== "number") amount = 1;
  const today = isoToday();
  const day = ensureStatsDay(today);
  if (typeof day[key] !== "number") day[key] = 0;
  day[key] += amount;
  // Update longest_streak periodisch (nicht bei jedem Inc — nur wenn Reveal oder
  // Rated dazukommt, weil das die einzigen Wege sind den Streak zu starten/halten)
  if (key !== "plays") {
    const cur = computeStreak();
    if (cur > (state.stats.all_time.longest_streak || 0)) {
      state.stats.all_time.longest_streak = cur;
    }
  }
  saveJSON("hl_stats", state.stats);
  // Engagement-Layer: Streak-Kette + Hero-Sub auf Real-Time-Update reagieren lassen,
  // damit der "Heute aktiv"-Dot beim ersten Play des Tages sofort leuchtet.
  try {
    if (typeof renderStreakChain === "function") renderStreakChain();
    if (typeof renderDailyGoal === "function") renderDailyGoal();
  } catch (e) { /* ignore — engagement layer ist optional */ }
}

function dateKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// Streak = aufeinanderfolgende Tage ab heute rückwärts mit irgendeiner Aktivität
// (plays >= 1 ODER reveals >= 1 ODER rated >= 1). Heute zählt erst, sobald es eine
// Aktivität gibt — sonst startet der Streak bei gestern.
function computeStreak() {
  if (!state.stats.daily) return 0;
  let streak = 0;
  const today = new Date();
  for (let offset = 0; offset < 400; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    const dateKey = dateKeyFromDate(d);
    const day = state.stats.daily[dateKey];
    const active = day && (day.plays >= 1 || day.reveals >= 1 || day.rated >= 1 || (day.scene_runs || 0) >= 1);
    if (active) streak++;
    else if (offset === 0) continue; // Heute leer = noch nicht aktiv, weiter rückwärts
    else break;
  }
  return streak;
}

// Lokale Migration: wenn cardState leer aber ratings vorhanden, rebuilden.
// Idempotent — läuft nur wenn cardState wirklich leer ist. Wird beim App-Init
// VOR pullCloudData aufgerufen, damit der Recall-Modus auch offline / vor
// dem ersten Cloud-Pull sinnvolle Daten hat.
function maybeMigrateCardStateLocal() {
  if (Object.keys(state.cardState).length > 0) return;
  if (Object.keys(state.ratings).length === 0) return;
  let migrated = 0;
  for (const id in state.ratings) {
    const r = state.ratings[id];
    if (typeof SRS_INTERVALS[r] !== "number") continue;
    const days = SRS_INTERVALS[r];
    const today = isoToday();
    state.cardState[id] = {
      interval_days: days,
      due_at: isoAddDays(today, days),
      last_reviewed_at: today,
    };
    migrated++;
  }
  if (migrated > 0) {
    saveJSON("hl_card_state", state.cardState);
    console.info("[SRS] local migrate: " + migrated + " ratings → card_state");
  }
}
function ratingMatches(id, key) {
  const r = getRating(id);
  if (key === "unrated") return r === null;
  if (key === "learned") return r === "learned";
  return r === parseInt(key);
}
function countByRating(key) {
  let n = 0;
  for (const s of allSentences()) if (ratingMatches(s.id, key)) n++;
  return n;
}
function buildRatingFilter() {
  ratingFilterEl.innerHTML = "";
  const items = [
    { key: "all", label: "Alle", stars: 0, brain: false, unrated: false },
    { key: "unrated", label: "Unrated", stars: 0, brain: false, unrated: true },
    { key: "1", label: "Schwierig", stars: 1, brain: false, unrated: false },
    { key: "2", label: "Okay", stars: 2, brain: false, unrated: false },
    { key: "3", label: "Easy", stars: 3, brain: false, unrated: false },
    { key: "learned", label: "Gelernt", stars: 0, brain: true, unrated: false },
  ];
  for (const it of items) {
    const chip = document.createElement("button");
    const isAll = it.key === "all";
    const active = isAll ? state.activeRatings.size === 0 : state.activeRatings.has(it.key);
    chip.className = "rating-chip" + (active ? " active" : "");
    let icon = "";
    if (it.stars > 0) {
      let stars = '<span class="chip-stars">';
      for (let i = 0; i < it.stars; i++) {
        stars += '<svg class="filled" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
      }
      stars += '</span>';
      icon = stars;
    } else if (it.brain) {
      icon = '<span class="chip-brain"><svg class="filled" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg></span>';
    } else if (it.unrated) {
      icon = '<span class="chip-stars"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg></span>';
    }
    let count = "";
    if (!isAll) count = ' <span class="rating-count">(' + countByRating(it.key) + ')</span>';
    chip.innerHTML = icon + '<span>' + it.label + count + '</span>';
    chip.onclick = function () {
      if (isAll) state.activeRatings.clear();
      else if (state.activeRatings.has(it.key)) state.activeRatings.delete(it.key);
      else state.activeRatings.add(it.key);
      buildRatingFilter(); applyFilter();
    };
    ratingFilterEl.appendChild(chip);
  }
}

function applyFilter() {
  const q = state.search.trim().toLowerCase();

  // Recall mode: Queue kommt aus dem SRS-System (heute-fällig + Smart Fallback).
  // User-Filter (cats / ratings / search) werden trotzdem ANGEWENDET — der User
  // kann z.B. „Recall im Bereich Küche" machen, wenn er will. Default ohne
  // Filter zeigt einfach alle fälligen Karten über alle Kategorien.
  if (state.mode === "recall") {
    let queueIds = recallQueue(5);
    queueIds = queueIds.filter(function (id) {
      const s = getSentenceById(id);
      if (!s) return false;
      if (state.activeCats.size > 0 && !s.cats.some(function (c) { return state.activeCats.has(c); })) return false;
      if (q && !(s.de.toLowerCase().includes(q) || (s.es && s.es.toLowerCase().includes(q)))) return false;
      return true;
    });
    state.filteredIds = queueIds;
    // Apply sort wie sonst auch
    if (state.mainSort === "newest") state.filteredIds.sort(function (a, b) { return b - a; });
    else if (state.mainSort === "oldest") state.filteredIds.sort(function (a, b) { return a - b; });
    else if (state.mainSort === "random") {
      for (let i = state.filteredIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = state.filteredIds[i]; state.filteredIds[i] = state.filteredIds[j]; state.filteredIds[j] = tmp;
      }
    }
    state.currentIdx = 0;
    renderCards();
    updatePlayer();
    return;
  }

  state.filteredIds = allSentences().filter(function (s) {
    if (s.archived) return false;
    // Intro/backlog cards live in Einführungs-Modus, not in the normal list
    if (stageOf(s.id) !== "active") return false;
    if (state.activeCats.size > 0 && !s.cats.some(function (c) { return state.activeCats.has(c); })) return false;
    if (state.activeRatings.size > 0) {
      let match = false;
      for (const key of state.activeRatings) if (ratingMatches(s.id, key)) { match = true; break; }
      if (!match) return false;
    }
    if (q && !(s.de.toLowerCase().includes(q) || (s.es && s.es.toLowerCase().includes(q)))) return false;
    return true;
  }).map(function (s) { return s.id; });

  // SAFETY NET: if no filters active but result is empty, something went wrong.
  // Recover by showing all non-archived sentences and log diagnostics.
  if (state.filteredIds.length === 0 && state.activeCats.size === 0 && state.activeRatings.size === 0 && !q) {
    const allActive = allSentences().filter(function (s) { return !s.archived; });
    if (allActive.length > 0) {
      console.warn("[applyFilter] empty result with no active filters — falling back to all", {
        totalSentences: allSentences().length,
        archivedCount: allSentences().filter(function (s) { return s.archived; }).length,
        userSentencesCount: state.userSentences.length,
        currentUser: currentUser ? currentUser.email : null,
        mode: state.mode,
      });
      state.filteredIds = allActive.map(function (s) { return s.id; });
    }
  }

  // Apply main sort
  if (state.mainSort === "newest") state.filteredIds.sort(function (a, b) { return b - a; });
  else if (state.mainSort === "oldest") state.filteredIds.sort(function (a, b) { return a - b; });
  else if (state.mainSort === "random") {
    for (let i = state.filteredIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = state.filteredIds[i]; state.filteredIds[i] = state.filteredIds[j]; state.filteredIds[j] = tmp;
    }
  }

  state.currentIdx = 0;
  renderCards();
  updatePlayer();
}

function renderCards() {
  cardsEl.innerHTML = "";
  if (state.filteredIds.length === 0) { noResultsEl.style.display = "block"; return; }
  noResultsEl.style.display = "none";
  for (const id of state.filteredIds) cardsEl.appendChild(buildCard(id));
  highlightCurrent();
}

function buildCard(id) {
  const s = getSentenceById(id);
  if (!s) return document.createElement("div");
  const card = document.createElement("div");
  const rating = getRating(id);
  const userCard = isUserSentence(id);
  card.className = "card" + (state.revealed.has(id) ? " revealed" : "") + (rating === "learned" ? " rated-learned" : "") + (userCard ? " user-card" : "") + (s.pending ? " pending" : "");
  card.dataset.id = id;

  const header = document.createElement("div");
  header.className = "card-header";
  const num = document.createElement("span");
  num.className = "card-num";
  num.textContent = "#" + s.id;
  header.appendChild(num);

  if (userCard) {
    const badge = document.createElement("span");
    badge.className = "card-badge-new";
    badge.textContent = "neu";
    header.appendChild(badge);
  }

  const playBtn = document.createElement("button");
  playBtn.className = "icon-card-btn";
  playBtn.title = "Abspielen";
  playBtn.innerHTML = ICON_SPEAKER;
  const _hasAudio = hasAudio(s);
  if (!_hasAudio) playBtn.disabled = true;
  playBtn.onclick = function (e) { e.stopPropagation(); jumpToAndPlay(id); };
  header.appendChild(playBtn);

  if (userCard && !_hasAudio && s.es && !s.pending) {
    const genBtn = document.createElement("button");
    genBtn.className = "icon-card-btn gen-audio";
    genBtn.title = "Audio via ElevenLabs generieren";
    genBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><circle cx="19" cy="6" r="3"/><line x1="17.5" y1="6" x2="20.5" y2="6"/><line x1="19" y1="4.5" x2="19" y2="7.5"/></svg>';
    genBtn.onclick = async function (e) {
      e.stopPropagation();
      genBtn.disabled = true;
      genBtn.classList.add("loading");
      const ok = await generateAudioFor(id);
      genBtn.disabled = false;
      genBtn.classList.remove("loading");
      if (ok) { renderCards(); buildUserSentencesList(); updateGenerateAllAudioBtn(); showToast("Audio generiert."); }
    };
    header.appendChild(genBtn);
  }

  const mBtn = document.createElement("button");
  const hasMnemonic = !!state.mnemonics[id];
  const mShown = state.shownMnemonics.has(id);
  mBtn.className = "icon-card-btn m-button" + (hasMnemonic ? " has-content" : "") + (mShown ? " shown" : "");
  mBtn.title = !hasMnemonic ? "Eselsbrücke hinzufügen" : (mShown ? "Eselsbrücke ausblenden" : "Eselsbrücke anzeigen");
  mBtn.innerHTML = ICON_M;
  mBtn.onclick = function (e) { e.stopPropagation(); toggleMnemonicPanel(id, card); };
  header.appendChild(mBtn);

  if (userCard) {
    const delBtn = document.createElement("button");
    delBtn.className = "icon-card-btn delete-btn";
    delBtn.title = "Löschen";
    delBtn.innerHTML = ICON_TRASH;
    delBtn.onclick = function (e) { e.stopPropagation(); deleteUserSentence(id); };
    header.appendChild(delBtn);
  }

  const rc = document.createElement("div");
  rc.className = "rating-controls";
  for (let i = 1; i <= 3; i++) {
    const sbtn = document.createElement("button");
    const filled = typeof rating === "number" && rating >= i;
    sbtn.className = "star-btn" + (filled ? " filled" : "");
    sbtn.title = i + (i === 1 ? " Stern (Schwierig)" : " Sterne (" + (i === 2 ? "Okay" : "Easy") + ")");
    sbtn.innerHTML = ICON_STAR;
    sbtn.onclick = function (e) {
      e.stopPropagation();
      if (rating === i) setRating(id, null);
      else setRating(id, i);
      renderCards();
    };
    rc.appendChild(sbtn);
  }
  const brainBtn = document.createElement("button");
  brainBtn.className = "brain-btn" + (rating === "learned" ? " active" : "");
  brainBtn.title = "Gelernt";
  brainBtn.innerHTML = ICON_BRAIN;
  brainBtn.onclick = function (e) {
    e.stopPropagation();
    if (rating === "learned") setRating(id, null);
    else setRating(id, "learned");
    renderCards();
  };
  rc.appendChild(brainBtn);
  header.appendChild(rc);
  card.appendChild(header);

  const esEl = document.createElement("div");
  esEl.className = "es" + (s.pending ? " pending" : "");
  esEl.textContent = s.pending ? "(Übersetzung ausstehend — siehe Menü → Übersetzungen)" : s.es;
  card.appendChild(esEl);

  const deEl = document.createElement("div");
  deEl.className = "de" + (state.showTranslation ? "" : " hidden");
  deEl.textContent = s.de;
  card.appendChild(deEl);

  const revealPrompt = document.createElement("div");
  revealPrompt.className = "reveal-prompt";
  revealPrompt.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Aufdecken — <kbd style="font-family:inherit;background:#fff;border:1px solid #d1d5db;border-radius:3px;padding:1px 5px;font-size:11px;">Tab</kbd> oder Klick</span>';
  revealPrompt.onclick = function (e) { e.stopPropagation(); revealCard(id); };
  card.appendChild(revealPrompt);

  if (state.editingMnemonics.has(id)) {
    card.appendChild(buildMnemonicEditor(id, card));
  } else if (state.shownMnemonics.has(id) && state.mnemonics[id]) {
    card.appendChild(buildMnemonicDisplay(id, card));
  }

  if (s.cats && s.cats.length) {
    const catsEl = document.createElement("div");
    catsEl.className = "cats";
    for (const c of s.cats) {
      const tag = document.createElement("span");
      tag.className = "cat-tag";
      const catDef = DATA.categories.find(function (cd) { return cd.key === c; });
      tag.textContent = catDef ? catDef.label : c;
      catsEl.appendChild(tag);
    }
    card.appendChild(catsEl);
  }

  card.onclick = function () {
    if (state.mode === "recall" && !state.revealed.has(id)) revealCard(id);
    else selectCardOnly(id);
  };
  return card;
}

// ===== Mnemonics =====
function saveShownMnemonics() { saveJSON("hl_shown_mnemonics", [...state.shownMnemonics]); }

function toggleMnemonicPanel(id, cardEl) {
  // If currently editing, treat M-click as cancel
  if (state.editingMnemonics.has(id)) {
    state.editingMnemonics.delete(id);
    if (state.mnemonics[id]) state.shownMnemonics.add(id);
    saveShownMnemonics();
    updateMnemonicPanel(id, cardEl);
    return;
  }
  if (state.mnemonics[id]) {
    // Has a mnemonic → toggle subtle display on the card
    if (state.shownMnemonics.has(id)) state.shownMnemonics.delete(id);
    else state.shownMnemonics.add(id);
    saveShownMnemonics();
  } else {
    // No mnemonic yet → open the editor
    state.editingMnemonics.add(id);
  }
  updateMnemonicPanel(id, cardEl);
}

function updateMnemonicPanel(id, cardEl) {
  const existing = cardEl.querySelector(".mnemonic-panel");
  if (existing) existing.remove();
  let newPanel = null;
  if (state.editingMnemonics.has(id)) {
    newPanel = buildMnemonicEditor(id, cardEl);
  } else if (state.shownMnemonics.has(id) && state.mnemonics[id]) {
    newPanel = buildMnemonicDisplay(id, cardEl);
  }
  if (newPanel) {
    const cats = cardEl.querySelector(".cats");
    if (cats) cardEl.insertBefore(newPanel, cats);
    else cardEl.appendChild(newPanel);
  }
  // Update the M-button visual state
  const mBtn = cardEl.querySelector(".m-button");
  if (mBtn) {
    const has = !!state.mnemonics[id];
    const shown = state.shownMnemonics.has(id);
    mBtn.classList.toggle("has-content", has);
    mBtn.classList.toggle("shown", shown);
    mBtn.title = !has ? "Eselsbrücke hinzufügen" : (shown ? "Eselsbrücke ausblenden" : "Eselsbrücke anzeigen");
  }
}

function buildMnemonicDisplay(id, cardEl) {
  const panel = document.createElement("div");
  panel.className = "mnemonic-panel mnemonic-display open";
  const text = state.mnemonics[id] || "";

  const textEl = document.createElement("div");
  textEl.className = "mnemonic-display-text";
  textEl.textContent = text;

  const actions = document.createElement("div");
  actions.className = "mnemonic-actions-mini";

  const editBtn = document.createElement("button");
  editBtn.className = "mnemonic-btn-icon";
  editBtn.title = "Bearbeiten";
  editBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  editBtn.onclick = function (e) {
    e.stopPropagation();
    state.shownMnemonics.delete(id);
    state.editingMnemonics.add(id);
    saveShownMnemonics();
    updateMnemonicPanel(id, cardEl);
  };

  const delBtn = document.createElement("button");
  delBtn.className = "mnemonic-btn-icon delete";
  delBtn.title = "Löschen";
  delBtn.innerHTML = ICON_TRASH;
  delBtn.onclick = function (e) {
    e.stopPropagation();
    deleteMnemonic(id, cardEl);
  };

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  panel.appendChild(textEl);
  panel.appendChild(actions);
  return panel;
}

function buildMnemonicEditor(id, cardEl) {
  const panel = document.createElement("div");
  panel.className = "mnemonic-panel open";
  const existing = state.mnemonics[id] || "";

  const ta = document.createElement("textarea");
  ta.className = "mnemonic-textarea";
  ta.placeholder = "Eselsbrücke / Denkhilfe…";
  ta.value = existing;
  ta.onclick = function (e) { e.stopPropagation(); };
  panel.appendChild(ta);

  const actions = document.createElement("div");
  actions.className = "mnemonic-panel-actions";

  const genBtn = document.createElement("button");
  genBtn.className = "mnemonic-btn-small mnemonic-generate-btn";
  genBtn.title = "Eselsbrücke mit Claude generieren";
  genBtn.innerHTML = '<span class="gen-icon">✨</span><span>Vorschlag</span>';
  genBtn.onclick = function (e) { e.stopPropagation(); generateMnemonicViaAPI(id, ta, genBtn); };
  actions.appendChild(genBtn);

  if (existing) {
    const delBtn = document.createElement("button");
    delBtn.className = "mnemonic-btn-small";
    delBtn.textContent = "Löschen";
    delBtn.onclick = function (e) { e.stopPropagation(); deleteMnemonic(id, cardEl); };
    actions.appendChild(delBtn);
  }

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mnemonic-btn-small";
  cancelBtn.textContent = "Abbrechen";
  cancelBtn.onclick = function (e) {
    e.stopPropagation();
    state.editingMnemonics.delete(id);
    if (existing) state.shownMnemonics.add(id);
    saveShownMnemonics();
    updateMnemonicPanel(id, cardEl);
  };
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement("button");
  saveBtn.className = "mnemonic-btn-small primary";
  saveBtn.textContent = "Speichern";
  saveBtn.onclick = function (e) {
    e.stopPropagation();
    const v = ta.value.trim();
    if (v) {
      state.mnemonics[id] = v;
      saveJSON("hl_mnemonics", state.mnemonics);
      state.editingMnemonics.delete(id);
      state.shownMnemonics.add(id);
      saveShownMnemonics();
      updateMnemonicPanel(id, cardEl);
      showToast("Eselsbrücke gespeichert.");
    } else if (existing) {
      deleteMnemonic(id, cardEl);
    } else {
      state.editingMnemonics.delete(id);
      updateMnemonicPanel(id, cardEl);
    }
  };
  actions.appendChild(saveBtn);

  panel.appendChild(actions);
  setTimeout(function () { ta.focus(); }, 50);
  return panel;
}

function deleteMnemonic(id, cardEl) {
  if (!confirm("Eselsbrücke wirklich löschen?")) return;
  delete state.mnemonics[id];
  saveJSON("hl_mnemonics", state.mnemonics);
  state.shownMnemonics.delete(id);
  state.editingMnemonics.delete(id);
  saveShownMnemonics();
  updateMnemonicPanel(id, cardEl);
  showToast("Eselsbrücke gelöscht.");
}

// ===== Mnemonic generation via Anthropic API =====
async function generateMnemonicViaAPI(id, ta, btn) {
  if (!state.apiKey) {
    showToast("Bitte Anthropic API Key im Seitenmenü eingeben.", 4000);
    return;
  }
  const s = getSentenceById(id);
  if (!s) return;
  if (!s.es) { showToast("Satz hat noch keine Übersetzung."); return; }

  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add("loading");
  btn.innerHTML = '<span class="gen-icon">✨</span><span>Generiere…</span>';

  const systemPrompt =
    "Du erstellst kurze, einprägsame Eselsbrücken auf Deutsch für spanische Vokabeln (Guatemala-Spanisch).\n" +
    "Wähle EIN Wort aus dem spanischen Satz, das vermutlich am schwersten zu merken ist (klanglich ungewohnt, selten oder nicht aus dem Lateinischen ableitbar). Vermeide triviale Wörter wie está, en, los, se, le, un, poco, siempre, todavía, ¿puedes…?\n" +
    "Mach dafür eine prägnante Eselsbrücke auf Deutsch. Nutze Klangähnlichkeiten zum Deutschen oder einem bekannten Wort, kombiniert mit einem lebendigen, leicht absurden Bild — das bleibt am besten hängen.\n" +
    "Antworte AUSSCHLIESSLICH mit der Eselsbrücke selbst — kurz (1–3 Sätze), ohne Einleitung, ohne Anführungszeichen, ohne Markdown-Formatierung (KEINE Sternchen).\n" +
    "Format: wort (deutsche Bedeutung) — kurze Eselsbrücke.";

  const userPrompt = "DE: " + s.de + "\nES: " + s.es;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": state.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!response.ok) {
      let errMsg = "API Fehler: " + response.status;
      try { const ej = await response.json(); if (ej.error && ej.error.message) errMsg += " — " + ej.error.message; } catch (e) {}
      showToast(errMsg, 5000);
      return;
    }
    const data = await response.json();
    const text = ((data.content && data.content[0] && data.content[0].text) || "").trim();
    if (!text) { showToast("Leere Antwort von der API."); return; }
    ta.value = text;
    ta.focus();
    // Move cursor to end so user sees the full suggestion
    try { ta.setSelectionRange(text.length, text.length); } catch (e) {}
  } catch (e) {
    showToast("Netzwerkfehler: " + e.message, 5000);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.innerHTML = originalHTML;
  }
}

// ===== Selection / playback =====
function highlightCurrent() {
  document.querySelectorAll(".card").forEach(function (c) { c.classList.remove("playing"); });
  const cur = currentSentence();
  if (!cur) return;
  const el = document.querySelector('.card[data-id="' + cur.id + '"]');
  if (el) el.classList.add("playing");
}
function currentSentence() {
  if (state.filteredIds.length === 0) return null;
  return getSentenceById(state.filteredIds[state.currentIdx]);
}
function updatePlayer() {
  const s = currentSentence();
  if (!s) {
    playerNumEl.textContent = "—";
    playerEsEl.textContent = "Keine Auswahl";
    playerDeEl.textContent = "—";
    return;
  }
  playerNumEl.textContent = "#" + s.id;
  playerEsEl.textContent = s.es || "(Übersetzung ausstehend)";
  playerDeEl.textContent = s.de;
  highlightCurrent();
}
function selectCardOnly(id) {
  let idx = state.filteredIds.indexOf(id);
  if (idx === -1) {
    // Self-heal: card not in filteredIds → re-run applyFilter and try again
    console.warn("[selectCardOnly] id " + id + " not in filteredIds (len=" + state.filteredIds.length + ") — re-running applyFilter");
    applyFilter();
    idx = state.filteredIds.indexOf(id);
    if (idx === -1) return;
  }
  state.currentIdx = idx;
  state.repeatCount = 0;
  updatePlayer();
}
function jumpToAndPlay(id) {
  const idx = state.filteredIds.indexOf(id);
  if (idx === -1) return;
  state.currentIdx = idx;
  state.repeatCount = 0;
  updatePlayer();
  play();
}
function revealCard(id) {
  const wasRevealed = state.revealed.has(id);
  state.revealed.add(id);
  const idx = state.filteredIds.indexOf(id);
  if (idx !== -1) state.currentIdx = idx;
  const card = document.querySelector('.card[data-id="' + id + '"]');
  if (card) card.classList.add("revealed");
  // B1 Reveal-Cue: nur beim ersten Aufdecken dieser Karte in der Session.
  if (!wasRevealed) maybeShowRevealCue(card, id, false);
  updatePlayer();
  // Stats: nur das erste Reveal pro Karte pro Session zählen
  if (!wasRevealed) incrementStat("reveals");
}
function revealCurrent() {
  if (state.filteredIds.length === 0) return;
  revealCard(state.filteredIds[state.currentIdx]);
}
function play() {
  const s = currentSentence();
  if (!s) return;
  const src = audioSrcFor(s);
  if (!src) {
    if (state.autoPlay && state.mode !== "recall") next();
    else showToast("Kein Audio für diesen Satz.");
    return;
  }
  // Android-MediaSession-Flicker-Fix: playbackState VOR dem src-Wechsel auf
  // "playing" setzen, sonst sieht Android das audioEl kurz als pausiert/leer
  // und schließt die Status-Bar-Notification, die kurz danach durch den
  // nächsten play()-Call neu aufgeht. Das Ergebnis ist Flackern zwischen
  // Uhr und Player-Chip in der Status-Bar.
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
  }
  audioEl.src = src;
  audioEl.playbackRate = state.speed;
  audioEl.play().then(function () {
    state.isPlaying = true;
    playIcon.style.display = "none";
    pauseIcon.style.display = "block";
    highlightCurrent();
    // PWA: update lockscreen/Bluetooth metadata so the OS shows the
    // current sentence and reacts to media-key presses.
    if (typeof updateMediaSessionMetadata === "function") updateMediaSessionMetadata(s);
    incrementStat("plays");
    // Den nächsten Satz schon mal in den Cache holen, damit der src-Wechsel
    // beim ended-Event quasi instant ist (verkürzt die Lücke, in der Android
    // den Player ausblenden könnte).
    if (typeof preloadNextSentenceAudio === "function") preloadNextSentenceAudio();
  }).catch(function (err) { console.error("Play failed", err); });
}
function pause() {
  audioEl.pause();
  state.isPlaying = false;
  playIcon.style.display = "block";
  pauseIcon.style.display = "none";
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = "paused"; } catch (e) {}
  }
}
function next() {
  if (state.filteredIds.length === 0) return;
  state.currentIdx = (state.currentIdx + 1) % state.filteredIds.length;
  state.repeatCount = 0;
  updatePlayer();
  if (state.mode !== "recall" && state.isPlaying && state.autoPlay) play();
  else if (state.mode !== "recall" && state.isPlaying && !state.autoPlay) pause();
}
function prev() {
  if (state.filteredIds.length === 0) return;
  state.currentIdx = (state.currentIdx - 1 + state.filteredIds.length) % state.filteredIds.length;
  state.repeatCount = 0;
  updatePlayer();
  if (state.mode !== "recall" && state.isPlaying && state.autoPlay) play();
  else if (state.mode !== "recall" && state.isPlaying && !state.autoPlay) pause();
}
audioEl.addEventListener("ended", function () {
  if (state.mode === "car") return;   // Car Mode hat einen eigenen Handler
  if (state.mode === "intro") return; // Intro Mode hat eigenen Auto-Advance-Handler
  // Saetze-Page preview: ignore main-player auto-advance.
  if (state._saetzePreviewActive) { state._saetzePreviewActive = false; return; }
  state.repeatCount++;
  // Wenn gleich der nächste Satz folgt (Repeat oder Autoplay): MediaSession
  // synchron auf "playing" halten, damit Android die Notification während
  // des src-Wechsels nicht für den Bruchteil einer Sekunde abräumt.
  const willContinue =
    state.repeatCount < state.repeat ||
    (state.mode !== "recall" && state.autoPlay);
  if (willContinue && "mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
  }
  if (state.repeatCount < state.repeat) { play(); }
  else {
    state.repeatCount = 0;
    if (state.mode === "recall" || !state.autoPlay) {
      state.isPlaying = false;
      playIcon.style.display = "block";
      pauseIcon.style.display = "none";
      // Session läuft hier wirklich aus → MediaSession sauber auf "paused"
      // setzen (Notification bleibt sichtbar mit Play-Button), nicht
      // implizit auf "none" fallen lassen.
      if ("mediaSession" in navigator) {
        try { navigator.mediaSession.playbackState = "paused"; } catch (e) {}
      }
    } else next();
  }
});

function updateIntroModeBtn() {
  if (!introBtn) return;
  const n = introPoolCount();
  if (n === 0) {
    introBtn.disabled = true;
    introBtn.title = "Keine Karten in Einführung — schiebe eine Kategorie rein (Sidebar) oder importiere neue.";
    if (introCountBadge) introCountBadge.style.display = "none";
  } else {
    introBtn.disabled = false;
    introBtn.title = n + " Karte(n) in Einführung";
    if (introCountBadge) {
      introCountBadge.style.display = "inline-flex";
      introCountBadge.textContent = String(n);
    }
  }
  // Mirror to sidebar section badge (may not exist yet on first call during boot)
  const sectionBadge = document.getElementById("intro-section-count");
  if (sectionBadge) sectionBadge.textContent = n > 0 ? String(n) : "";
  // Mirror to new sidebar nav-link badge (Praxis-Sektion)
  const sideBadge = document.getElementById("side-intro-count");
  if (sideBadge) sideBadge.textContent = n > 0 ? String(n) : "";
}

function updateRecallModeBtn() {
  const n = dueCount();
  // Old (hidden) recall-mode-btn badge — kept for backward compat
  if (recallCountBadge) {
    if (n === 0) recallCountBadge.style.display = "none";
    else { recallCountBadge.style.display = "inline-flex"; recallCountBadge.textContent = String(n); }
  }
  // New sidebar Fokus-Session badge — primärer Recall-Pfad seit Sidebar-Restructure
  const sideFocusBadge = document.getElementById("side-focus-count");
  if (sideFocusBadge) {
    sideFocusBadge.textContent = n > 0 ? String(n) : "";
  }
}

function updateProgress() {
  const total = allSentences().length;
  let learned = 0;
  for (const id in state.ratings) if (state.ratings[id] === "learned") learned++;
  progressText.textContent = learned + " von " + total + " gemeistert";
  const pct = total ? Math.round((learned / total) * 100) : 0;
  progressPercent.textContent = pct + "%";
  progressFill.style.width = pct + "%";
  // Intro mode button reflects pool size; keep it in sync with state changes
  updateIntroModeBtn();
  // Recall mode button reflects heute-fällig count (SRS Phase A)
  updateRecallModeBtn();

  // Stat tiles (top of page).
  const statMastered = document.getElementById("stat-mastered");
  if (statMastered) statMastered.textContent = learned + " / " + total;
  // Engagement-Layer: aktuellen Streak ins Stat-Tile (vorher Placeholder).
  const statStreak = document.getElementById("stat-streak");
  if (statStreak) {
    const streak = computeStreak();
    statStreak.textContent = streak === 0 ? "— Tage" : (streak + (streak === 1 ? " Tag" : " Tage"));
  }
  // Engagement-Layer: Dashboard-Elemente (Warum, Hero, Kette, Aspirational).
  if (typeof renderEngagement === "function") renderEngagement();
  // Motivations-Sprint: App-Icon-Badge mit heute-fällig-Zahl aktuell halten.
  updateAppBadge();
}

// =====================================================================
// ENGAGEMENT-LAYER (Mai 2026) — G1 Warum-Anker, D1 Hero-Listen,
// F1 Streak-Kette, E3 Aspirational Bucket.
// Siehe ENGAGEMENT_KONZEPT.md für die Begründung pro Feature.
// =====================================================================

// ---- G1: Dein Warum ----------------------------------------------------
function renderWhyAnchor() {
  const wrap = document.getElementById("why-anchor");
  if (!wrap) return;
  const empty = document.getElementById("why-anchor-empty");
  const quote = document.getElementById("why-anchor-quote");
  const text = document.getElementById("why-anchor-text");
  if (!empty || !quote || !text) return;
  if (state.whyText && state.whyText.trim()) {
    empty.style.display = "none";
    quote.style.display = "flex";
    text.textContent = state.whyText.trim();
  } else {
    empty.style.display = "flex";
    quote.style.display = "none";
  }
}
function setWhyText(value) {
  state.whyText = (value || "").trim();
  localStorage.setItem("hl_why_text", state.whyText);
  queuePushProfile();
  renderWhyAnchor();
}

// ---- D1: One-Tap-Start Hero -------------------------------------------
function timeOfDayHeroLabel() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "Morgens hören";
  if (h >= 11 && h < 14) return "Mittagspause";
  if (h >= 14 && h < 18) return "Nachmittag hören";
  if (h >= 18 && h < 23) return "Abend hören";
  return "Heute hören";
}
const QUICK_LISTEN_DURATION_MS = 5 * 60 * 1000; // 5 Minuten
let _quickListenStopTimer = null;

function renderHeroButton() {
  const btn = document.getElementById("hero-listen-btn");
  if (!btn) return;
  const label = document.getElementById("hero-listen-label");
  const sub = document.getElementById("hero-listen-sub");
  if (label) label.textContent = timeOfDayHeroLabel();
  // Wenn Car-Modus nicht eligible-Sätze hat → Button deaktivieren mit hint.
  // Defensiv: `car` ist ein const der erst später im Script initialisiert wird —
  // bei den ersten renderEngagement-Aufrufen (vor Car-Mode-Init) wirft das eine
  // ReferenceError. Wir fangen sie weg und behandeln als "ready".
  let eligibleCount = 1;
  try {
    if (typeof carEligibleSentences === "function") {
      eligibleCount = carEligibleSentences().length;
    }
  } catch (e) { /* car-const noch nicht initialisiert — first-render-OK */ }
  if (eligibleCount === 0) {
    btn.disabled = true;
    if (sub) sub.textContent = "Erst Audio generieren — Shadow Mode braucht Audio-Karten.";
  } else {
    btn.disabled = false;
    if (sub) sub.textContent = "5 Minuten Shadowing — direkt los, ohne Setup.";
  }
}
// durationMs optional (Default 5 Min). Der Rescue-Banner (F2) ruft mit 60s.
function startQuickListenSession(durationMs) {
  if (typeof setCarModeActive !== "function" || typeof startCarSession !== "function") return;
  const ms = (typeof durationMs === "number" && durationMs > 0) ? durationMs : QUICK_LISTEN_DURATION_MS;
  const eligible = carEligibleSentences();
  if (!eligible.length) {
    showToast("Keine Audio-Karten in deinem Shadow-Mode-Filter. Setup öffnen?", 4000);
    setCarModeActive();
    return;
  }
  // Shadow-Mode-Body-Class setzen + direkt in die Session springen (überspringt Setup).
  setCarModeActive();
  startCarSession();
  // Auto-Stop. Bestehender Timer wird abgeräumt, falls man's nochmal drückt.
  if (_quickListenStopTimer) clearTimeout(_quickListenStopTimer);
  _quickListenStopTimer = setTimeout(function () {
    _quickListenStopTimer = null;
    if (typeof car !== "undefined" && car.active) {
      const sessionData = collectCarSessionData();
      exitCarSession();
      document.body.classList.remove("car");
      document.body.classList.remove("car-driving");
      document.body.classList.remove("car-night");
      // Zurück in Listen-Modus, damit User wieder auf dem Dashboard landet.
      const lb = document.getElementById("listen-mode-btn");
      if (lb) lb.click();
      // Motivations-Sprint Juni 2026: Postkarte statt Toast — der Win-Moment.
      showSessionPostcard(sessionData);
    }
  }, ms);
}

// ---- F1: Streak-Kette --------------------------------------------------
function renderStreakChain() {
  const dots = document.getElementById("streak-chain-dots");
  const hint = document.getElementById("streak-chain-hint");
  if (!dots) return;
  dots.innerHTML = "";
  const today = new Date();
  const todayKey = dateKeyFromDate(today);
  let todayActive = false;
  let activeDays = 0;
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dateKeyFromDate(d);
    const day = state.stats.daily && state.stats.daily[key];
    const active = day && (day.plays >= 1 || day.reveals >= 1 || day.rated >= 1 || (day.scene_runs || 0) >= 1);
    const isToday = key === todayKey;
    if (isToday) todayActive = !!active;
    if (active) activeDays++;
    const dot = document.createElement("span");
    dot.className = "streak-dot" + (active ? " active" : "") + (isToday ? " today" : "");
    // Format date for tooltip
    const opts = { weekday: "short", day: "2-digit", month: "short" };
    const label = d.toLocaleDateString("de-DE", opts);
    dot.title = label + (active ? " · aktiv" : " · keine Aktivität");
    dots.appendChild(dot);
  }
  if (hint) {
    if (todayActive) {
      hint.textContent = activeDays + " / 14 Tage aktiv";
      hint.style.color = "var(--learned)";
    } else {
      hint.textContent = "Heute noch keine Aktivität";
      hint.style.color = "var(--warning)";
    }
  }
}

// ---- E3: Aspirational Bucket ------------------------------------------
function aspirationalCardIds() {
  // Karten, die der User aktuell mit 2 Sternen ("Okay") bewertet hat —
  // also fast aber noch nicht sicher. Sortiert nach last_reviewed_at desc,
  // max 5. Filter aus archived/pending/non-active raus.
  const candidates = allSentences().filter(function (s) {
    if (s.archived) return false;
    if (s.pending) return false;
    if (typeof stageOf === "function" && stageOf(s.id) !== "active") return false;
    return state.ratings[s.id] === 2;
  });
  candidates.sort(function (a, b) {
    const ar = (state.cardState[a.id] && state.cardState[a.id].last_reviewed_at) || "0000-00-00";
    const br = (state.cardState[b.id] && state.cardState[b.id].last_reviewed_at) || "0000-00-00";
    return br.localeCompare(ar);
  });
  return candidates.slice(0, 5).map(function (s) { return s.id; });
}
function renderAspirational() {
  const card = document.getElementById("aspirational-card");
  if (!card) return;
  const ids = aspirationalCardIds();
  if (ids.length === 0) {
    card.style.display = "none";
    return;
  }
  card.style.display = "flex";
  const countEl = document.getElementById("aspirational-count");
  const previewEl = document.getElementById("aspirational-preview");
  if (countEl) countEl.textContent = ids.length;
  if (previewEl) {
    const s = getSentenceById(ids[0]);
    previewEl.textContent = s ? (s.es || s.de || "—") : "—";
  }
}

// ---- "Heute üben"-Aktionsblock (Dashboard) -----------------------------
// Drei Action-Cards (Recall · Einführung · Szenen) als direkter Einstieg in
// die jeweiligen Übe-Modi. Counter werden aus den existierenden Helpern
// (recallQueue/dueCount, introPoolCount, state.scenes) bezogen — keine neue
// State-Logik, nur eine Render-Funktion.
function renderTodayActions() {
  // ----- Recall -----
  const recallSubEl = document.getElementById("today-action-recall-sub");
  const recallCountEl = document.getElementById("today-action-recall-count");
  const recallCard = document.getElementById("today-action-recall");
  if (recallCard) {
    // Heute fällig vs. überfällig — sauber getrennt, damit der User sieht ob
    // er "auf Kurs" ist oder Liegengebliebenes nachholt.
    const todayDate = (typeof isoToday === "function") ? isoToday() : new Date().toISOString().slice(0, 10);
    let overdue = 0, dueToday = 0;
    for (const s of allSentences()) {
      if (s.archived || s.pending) continue;
      if (typeof stageOf === "function" && stageOf(s.id) !== "active") continue;
      const cs = state.cardState && state.cardState[s.id];
      if (!cs || !cs.due_at) continue;
      if (cs.due_at < todayDate) overdue++;
      else if (cs.due_at === todayDate) dueToday++;
    }
    const total = overdue + dueToday;
    if (recallSubEl) {
      if (total === 0) {
        recallSubEl.textContent = "heute nichts fällig · Smart-Fallback wartet";
      } else if (overdue > 0 && dueToday > 0) {
        recallSubEl.textContent = overdue + " überfällig · " + dueToday + " heute fällig";
      } else if (overdue > 0) {
        recallSubEl.textContent = overdue + " überfällig — jetzt nachholen";
      } else {
        recallSubEl.textContent = dueToday + " heute fällig laut SRS";
      }
    }
    if (recallCountEl) {
      if (total > 0) {
        recallCountEl.textContent = total;
        recallCountEl.style.display = "";
      } else {
        recallCountEl.style.display = "none";
      }
    }
    // Card nicht disablen wenn 0 fällig — Smart-Fallback in recallQueue() gibt
    // dem User trotzdem etwas zum Üben (siehe CLAUDE.md SRS Phase A).
    recallCard.disabled = false;
  }

  // ----- Einführung -----
  const introSubEl = document.getElementById("today-action-intro-sub");
  const introCountEl = document.getElementById("today-action-intro-count");
  const introCard = document.getElementById("today-action-intro");
  if (introCard) {
    let backlog = 0, inIntro = 0;
    for (const s of allSentences()) {
      if (s.archived || s.pending || !s.es) continue;
      if (typeof stageOf !== "function") continue;
      const st = stageOf(s.id);
      if (st === "backlog") backlog++;
      else if (st === "intro") inIntro++;
    }
    const total = backlog + inIntro;
    if (introSubEl) {
      if (total === 0) {
        introSubEl.textContent = "keine Karten in Einführung";
      } else if (backlog > 0 && inIntro > 0) {
        introSubEl.textContent = inIntro + " im Pool · " + backlog + " warten";
      } else if (inIntro > 0) {
        introSubEl.textContent = inIntro + " im Pool · weitermachen";
      } else {
        introSubEl.textContent = backlog + " Karten warten im Backlog";
      }
    }
    if (introCountEl) {
      if (total > 0) {
        introCountEl.textContent = total;
        introCountEl.style.display = "";
      } else {
        introCountEl.style.display = "none";
      }
    }
    // Disablen wenn nichts da — sonst klickt der User ins Leere.
    introCard.disabled = total === 0;
  }

  // ----- Karten-Browser-Meta (Akkordeon-Summary) -----
  // Kleine Orientierung "X Sätze · davon Y aktiv", damit der User beim Blick
  // auf das eingeklappte Akkordeon weiß, was dahinter liegt.
  const browseMetaEl = document.getElementById("cards-browser-meta");
  if (browseMetaEl) {
    let total = 0, active = 0;
    for (const s of allSentences()) {
      if (s.archived || s.pending) continue;
      total++;
      if (typeof stageOf === "function" && stageOf(s.id) === "active") active++;
    }
    browseMetaEl.textContent = total + " Sätze · " + active + " aktiv";
  }

  // ----- Szenen -----
  const scenesSubEl = document.getElementById("today-action-scenes-sub");
  const scenesCountEl = document.getElementById("today-action-scenes-count");
  const scenesCard = document.getElementById("today-action-scenes");
  if (scenesCard) {
    const scenes = (state.scenes || []);
    if (scenes.length === 0) {
      // Hide komplett — Szenen sind ein Opt-in-Feature, leer nur visueller Lärm.
      scenesCard.style.display = "none";
    } else {
      scenesCard.style.display = "";
      const active = scenes.filter(function (sc) {
        return sc.status === "draft" || sc.status === "active";
      });
      const today = (typeof isoToday === "function") ? isoToday() : new Date().toISOString().slice(0, 10);
      const runsToday = (state.stats && state.stats.daily && state.stats.daily[today] && state.stats.daily[today].scene_runs) || 0;
      if (scenesSubEl) {
        if (active.length === 0) {
          scenesSubEl.textContent = "alle Szenen beherrscht · Übersicht öffnen";
        } else if (runsToday > 0) {
          scenesSubEl.textContent = active.length + " aktiv · heute " + runsToday + "× geübt";
        } else {
          scenesSubEl.textContent = active.length + " aktiv · noch nicht geübt heute";
        }
      }
      if (scenesCountEl) {
        if (active.length > 0) {
          scenesCountEl.textContent = active.length;
          scenesCountEl.style.display = "";
        } else {
          scenesCountEl.style.display = "none";
        }
      }
    }
  }
}

// ---- Tagesziel (V1) — geführtes Tagespensum ---------------------------
// Drei Pflichtaufgaben pro Tag (Reihenfolge = Lern-Funnel: Einführung →
// Shadowing → Active Recall). Die Häkchen sind ABGELEITET, nicht klickbar:
// done folgt direkt aus den Tages-Countern (state.stats.daily[heute]) bzw. bei
// Active Recall aus dueCount(). Ziele liegen in DAILY_GOAL_CONFIG.
// "Neue Sätze" wurde Juni 2026 als Pflichtaufgabe entfernt (User-Entscheidung);
// der Counter new_sentences wird weiterhin in addUserSentence() gezählt.
const DAILY_GOAL_CONFIG = {
  shadowingTarget: 60, // ~10 Min Shadowing (1 Rep = 1× anhören + nachsprechen)
  introRuns: 1,        // 1 kompletter Einführungs-Batch (5 Sätze, 5× durchgespielt)
};

function dailyGoalStatsToday() {
  const today = (typeof isoToday === "function") ? isoToday() : new Date().toISOString().slice(0, 10);
  return (state.stats && state.stats.daily && state.stats.daily[today]) || {};
}

function computeDailyGoal() {
  const d = dailyGoalStatsToday();
  const shadow = d.shadow_reps || 0;
  const introRuns = d.intro_runs || 0;
  const due = (typeof dueCount === "function") ? dueCount() : 0;
  const tasks = [
    {
      key: "intro",
      done: introRuns >= DAILY_GOAL_CONFIG.introRuns,
      progress: introRuns,
      target: DAILY_GOAL_CONFIG.introRuns,
      sub: introRuns >= DAILY_GOAL_CONFIG.introRuns
        ? "Einführung gemacht"
        : "1 Einführung (5 Sätze, 5×)",
    },
    {
      key: "shadow",
      done: shadow >= DAILY_GOAL_CONFIG.shadowingTarget,
      progress: shadow,
      target: DAILY_GOAL_CONFIG.shadowingTarget,
      sub: Math.min(shadow, DAILY_GOAL_CONFIG.shadowingTarget) + " / " +
           DAILY_GOAL_CONFIG.shadowingTarget + " Reps (~10 Min)",
    },
    {
      key: "recall",
      done: due === 0,
      progress: due === 0 ? 1 : 0,
      target: 1,
      sub: due === 0
        ? "Alle fälligen Karten erledigt"
        : (due + (due === 1 ? " Karte noch fällig" : " Karten noch fällig")),
    },
  ];
  const doneCount = tasks.filter(function (t) { return t.done; }).length;
  return { tasks: tasks, doneCount: doneCount, total: tasks.length, allDone: doneCount === tasks.length };
}

function renderDailyGoal() {
  const wrap = document.getElementById("daily-goal");
  if (!wrap) return;
  const g = computeDailyGoal();
  const countEl = document.getElementById("daily-goal-count");
  if (countEl) countEl.textContent = g.doneCount + " / " + g.total;
  const fill = document.getElementById("daily-goal-bar-fill");
  if (fill) fill.style.width = Math.round((g.doneCount / g.total) * 100) + "%";
  wrap.classList.toggle("all-done", g.allDone);
  for (const t of g.tasks) {
    const row = document.getElementById("dg-" + t.key);
    if (row) row.classList.toggle("done", t.done);
    const sub = document.getElementById("dg-" + t.key + "-sub");
    if (sub) sub.textContent = t.sub;
    const mini = document.getElementById("dg-" + t.key + "-fill");
    if (mini) {
      const pct = t.target > 0 ? Math.min(100, Math.round((t.progress / t.target) * 100)) : (t.done ? 100 : 0);
      mini.style.width = pct + "%";
    }
  }
  maybeCelebrateDailyGoal(g);
}

// ---- Tagesziel-Celebration (Motivations-Sprint Juni 2026) ---------------
// Full-Screen-Moment beim Übergang 2/3 → 3/3 — der wichtigste Win-Moment des
// Tages, exakt 1× pro Tag (localStorage-Guard hl_dg_celebrated = ISO-Datum).
// WICHTIG: gefeiert wird nur der ÜBERGANG, nie der Zustand — beim App-Start
// mit bereits erfülltem Ziel feuert nichts (der Tag wird dann still als
// gefeiert markiert). Läuft gerade eine Übung (car/focus/intro/scene-
// practice), wird die Celebration zurückgehalten und erst bei Rückkehr aufs
// Dashboard gezeigt (Flag _dgCelebrationPending; renderDailyGoal läuft dort
// via updateProgress → renderEngagement sowieso erneut). Der Audio-Sting ist
// per Default an, abschaltbar in Settings (hl_sound_stings, local-only —
// bewusst nicht gesynct, Sound-Präferenz ist Geräte-Sache wie Lautstärke).
const DG_CELEBRATED_KEY = "hl_dg_celebrated";
const SOUND_STINGS_KEY = "hl_sound_stings";
let _dgPrevDoneCount = null;
let _dgCelebrationPending = false;

function soundStingsEnabled() {
  return localStorage.getItem(SOUND_STINGS_KEY) !== "0"; // Default: an
}

// Kurzer Dur-Dreiklang (C5–E5–G5) via WebAudio — kein Audio-File, kein
// Repo-Asset. Läuft immer in einem User-Gesture-Kontext (das 3. Häkchen
// entsteht nur durch aktive Bedienung), Autoplay-Policy ist also kein Thema.
let _stingCtx = null;
function playGoalSting() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!_stingCtx) _stingCtx = new AC();
    if (_stingCtx.state === "suspended") _stingCtx.resume();
    const notes = [523.25, 659.25, 783.99];
    notes.forEach(function (freq, i) {
      const osc = _stingCtx.createOscillator();
      const gain = _stingCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = _stingCtx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(gain);
      gain.connect(_stingCtx.destination);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  } catch (e) { /* Sound ist Bonus — niemals deswegen crashen */ }
}

function dgSessionRunning() {
  return ["car", "focus", "intro", "scene-practice"].some(function (c) {
    return document.body.classList.contains(c);
  });
}

function maybeCelebrateDailyGoal(g) {
  const today = (typeof isoToday === "function") ? isoToday() : new Date().toISOString().slice(0, 10);
  const already = localStorage.getItem(DG_CELEBRATED_KEY) === today;
  if (_dgPrevDoneCount === null) {
    // Erster Render nach App-Start: nur Zustand merken, nichts nachfeiern.
    if (g.allDone && !already) localStorage.setItem(DG_CELEBRATED_KEY, today);
    _dgPrevDoneCount = g.doneCount;
    return;
  }
  const crossed = g.allDone && _dgPrevDoneCount < g.total && !already;
  _dgPrevDoneCount = g.doneCount;
  if (crossed) _dgCelebrationPending = true;
  if (_dgCelebrationPending && !dgSessionRunning()) showDailyGoalCelebration();
}

function showDailyGoalCelebration() {
  const el = document.getElementById("dg-celebration");
  if (!el) return;
  _dgCelebrationPending = false;
  const today = (typeof isoToday === "function") ? isoToday() : new Date().toISOString().slice(0, 10);
  localStorage.setItem(DG_CELEBRATED_KEY, today); // erst beim ANZEIGEN markieren (Defer-sicher)
  const lineEl = document.getElementById("dg-celebration-line");
  if (lineEl) {
    const streak = (typeof computeStreak === "function") ? computeStreak() : 0;
    lineEl.textContent = streak > 1
      ? ("Tag " + streak + " deiner Serie — komplett.")
      : "Alle drei Aufgaben erledigt.";
  }
  el.style.display = "flex";
  if (soundStingsEnabled()) playGoalSting();
}

(function wireDailyGoalCelebration() {
  const closeBtn = document.getElementById("dg-celebration-close-btn");
  if (closeBtn) closeBtn.onclick = function () {
    const el = document.getElementById("dg-celebration");
    if (el) el.style.display = "none";
  };
  const toggle = document.getElementById("sound-stings-toggle");
  if (toggle) {
    toggle.classList.toggle("on", soundStingsEnabled());
    toggle.onclick = function () {
      const next = !soundStingsEnabled();
      localStorage.setItem(SOUND_STINGS_KEY, next ? "1" : "0");
      toggle.classList.toggle("on", next);
      if (next) playGoalSting(); // direktes Hör-Feedback beim Einschalten
    };
  }
})();

// ---- F2: Abend-Rescue-Banner (Motivations-Sprint Juni 2026) -------------
// Ab 18 Uhr lokal, wenn heute noch KEINE Aktivität gezählt wurde: dezenter
// dunkler Banner überm Tagesziel — „1 Minute reicht". Fordernd, aber ohne
// Push und ohne Schuldgefühl-Rhetorik. Verschwindet mit der ersten Aktivität
// (renderEngagement läuft via incrementStat-Hook).
function todayHasActivity() {
  const d = (state.stats && state.stats.daily && state.stats.daily[isoToday()]) || null;
  if (!d) return false;
  for (const k in d) { if ((Number(d[k]) || 0) > 0) return true; }
  return false;
}
function renderRescueBanner() {
  const el = document.getElementById("rescue-banner");
  if (!el) return;
  const show = new Date().getHours() >= 18 && !todayHasActivity();
  el.style.display = show ? "flex" : "none";
}

// ---- Master-Render -----------------------------------------------------
function renderEngagement() {
  renderWhyAnchor();
  renderHeroButton();
  renderStreakChain();
  renderAspirational();
  renderTodayActions();
  renderDailyGoal();
  renderRescueBanner();
}

// ---- Wiring -----------------------------------------------------------
// Defer via rAF, damit alle später definierten Funktionen (openSettingsPage,
// setCarModeActive, startCarSession, exitCarSession, carEligibleSentences,
// buildRatingFilter, applyFilter) zum Zeitpunkt des Wirings bereits existieren.
function wireEngagement() {
  // G1: Warum-Anker — Edit/Empty öffnen Settings-Page und fokussieren die Textarea.
  function openWhyEditor() {
    if (typeof openSettingsPage === "function") openSettingsPage();
    // 80ms: Settings-Page muss erst im DOM sichtbar werden, sonst greift focus() ins Leere.
    setTimeout(function () {
      const ta = document.getElementById("why-text-input");
      if (ta) { ta.value = state.whyText || ""; ta.focus(); ta.select(); }
    }, 80);
  }
  const emptyEl = document.getElementById("why-anchor-empty");
  const editBtnEl = document.getElementById("why-anchor-edit");
  if (emptyEl) emptyEl.onclick = openWhyEditor;
  if (editBtnEl) editBtnEl.onclick = openWhyEditor;

  // Sicherstellen, dass die Settings-Sidebar-Link den Warum-Textarea ebenfalls
  // sauber befüllt — gleicher Mechanismus über setTimeout.
  const settingsLink = document.getElementById("side-settings-link");
  if (settingsLink) {
    const _origClick = settingsLink.onclick;
    settingsLink.onclick = function (e) {
      if (_origClick) _origClick.call(this, e);
      setTimeout(function () {
        const ta = document.getElementById("why-text-input");
        if (ta) ta.value = state.whyText || "";
      }, 60);
    };
  }

  // Settings-Page: Save/Clear "Mein Warum"
  const whyInput = document.getElementById("why-text-input");
  const saveWhyBtn = document.getElementById("save-why-btn");
  const clearWhyBtn = document.getElementById("clear-why-btn");
  if (whyInput) whyInput.value = state.whyText || "";
  if (saveWhyBtn) saveWhyBtn.onclick = function () {
    if (!whyInput) return;
    const v = whyInput.value.trim();
    setWhyText(v);
    showToast(v ? "Dein Warum ist gespeichert." : "Warum-Text gelöscht.");
  };
  if (clearWhyBtn) clearWhyBtn.onclick = function () {
    if (!whyInput) return;
    whyInput.value = "";
    setWhyText("");
    showToast("Warum-Text gelöscht.");
  };

  // D1: Hero-Listen-Button → 5-Min-Quick-Start.
  const heroBtn = document.getElementById("hero-listen-btn");
  if (heroBtn) heroBtn.onclick = function () { startQuickListenSession(); };

  // F2: Rescue-Banner → 1-Minuten-Quick-Start (niedrigste Hürde).
  const rescueBtn = document.getElementById("rescue-listen-btn");
  if (rescueBtn) rescueBtn.onclick = function () { startQuickListenSession(60 * 1000); };
  // Re-Check alle 5 Min: damit der Banner auch auftaucht, wenn die App
  // einfach offen liegt und 18 Uhr währenddessen vorbeizieht.
  setInterval(renderRescueBanner, 5 * 60 * 1000);

  // E3: Aspirational-Card → 2-Sterne-Karten als Listen-Filter laden.
  const aspBtn = document.getElementById("aspirational-card");
  if (aspBtn) aspBtn.onclick = function () {
    const ids = aspirationalCardIds();
    if (!ids.length) return;
    // Filter setzen: nur 2★, ins Listen-Mode springen.
    state.activeRatings = new Set(["2"]);
    if (typeof buildRatingFilter === "function") buildRatingFilter();
    const lb = document.getElementById("listen-mode-btn");
    if (lb && state.mode !== "listen") lb.click();
    if (typeof applyFilter === "function") applyFilter();
    // Aspirational scrollt zu den Karten — also Akkordeon aufmachen, damit
    // die gefilterten Karten überhaupt sichtbar sind.
    if (typeof openCardsBrowser === "function") openCardsBrowser();
    const cardsEl = document.getElementById("cards");
    if (cardsEl && cardsEl.scrollIntoView) cardsEl.scrollIntoView({ behavior: "smooth", block: "start" });
    showToast(ids.length + " Sätze auf 2★ gefiltert — leg los.", 3000);
  };

  // "Heute üben": drei Action-Cards → Recall / Einführung / Szenen.
  // Logik gespiegelt aus den (gleich entfernten) Stats-CTAs — wir starten den
  // jeweiligen Modus direkt ohne Setup-Zwischenstation.
  const todayRecallBtn = document.getElementById("today-action-recall");
  if (todayRecallBtn) todayRecallBtn.onclick = function () {
    // Fokus-Session konfigurieren auf "alle Stufen, alle Kategorien, alle
    // Karten, zufällig" — focusEligibleSentences() filtert via recallQueue()
    // dann auf heute-fällige + Smart Fallback.
    if (typeof focus !== "undefined") {
      focus.cats = new Set();
      focus.ratings = new Set();
      focus.count = "all";
      focus.order = "random";
      if (typeof buildFocusCatPicker === "function") buildFocusCatPicker();
      if (typeof buildFocusRatingPicker === "function") buildFocusRatingPicker();
      if (typeof focusCountPickerEl !== "undefined" && focusCountPickerEl) {
        focusCountPickerEl.querySelectorAll(".focus-count-chip").forEach(function (b) {
          b.classList.toggle("active", b.dataset.count === "all");
        });
      }
      if (typeof focusOrderPickerEl !== "undefined" && focusOrderPickerEl) {
        focusOrderPickerEl.querySelectorAll(".focus-order-chip").forEach(function (b) {
          b.classList.toggle("active", b.dataset.order === "random");
        });
      }
    }
    if (typeof setFocusModeActive === "function") setFocusModeActive();
    else { const fb = document.getElementById("focus-mode-btn"); if (fb) fb.click(); }
    if (typeof startFocusSession === "function") startFocusSession();
  };
  const todayIntroBtn = document.getElementById("today-action-intro");
  if (todayIntroBtn) todayIntroBtn.onclick = function () {
    if (todayIntroBtn.disabled) return;
    const ib = document.getElementById("intro-mode-btn");
    if (ib && !ib.disabled) ib.click();
  };
  const todayScenesBtn = document.getElementById("today-action-scenes");
  if (todayScenesBtn) todayScenesBtn.onclick = function () {
    if (typeof openScenesPage === "function") openScenesPage();
  };

  // Tagesziel-Reihen: Klick startet den passenden Modus. Recall + Einführung
  // delegieren an die schon verdrahteten "Heute üben"-Cards (gleiche Logik),
  // Shadowing öffnet den Shadow-Mode-Setup.
  const dgRecall = document.getElementById("dg-recall");
  if (dgRecall) dgRecall.onclick = function () {
    const c = document.getElementById("today-action-recall");
    if (c) c.click();
  };
  const dgShadow = document.getElementById("dg-shadow");
  if (dgShadow) dgShadow.onclick = function () {
    if (typeof setCarModeActive === "function") setCarModeActive();
  };
  const dgIntro = document.getElementById("dg-intro");
  if (dgIntro) dgIntro.onclick = function () {
    const ib = document.getElementById("intro-mode-btn");
    if (ib && !ib.disabled) ib.click();
    else showToast("Keine Karten in Einführung. Schiebe eine Kategorie rein oder importiere neue Sätze.", 4000);
  };

  // ===== "Karten durchstöbern"-Akkordeon: Boot-State + Persistenz =====
  // Default zu im Listen-Modus; localStorage merkt sich die letzte Wahl.
  // Recall-Mode öffnet das Akkordeon programmatisch (siehe weiter unten,
  // wo recallBtn.onclick erweitert wird) — diese Programmatik schreibt
  // nicht zurück in localStorage, damit der User-Default erhalten bleibt.
  const cardsBrowserEl = document.getElementById("cards-browser");
  if (cardsBrowserEl) {
    const saved = localStorage.getItem("hl_browse_open");
    cardsBrowserEl.open = saved === "1";
    // Flag um programmatische open/close-Aufrufe von User-Klicks zu trennen.
    let _suppressBrowsePersist = false;
    cardsBrowserEl.addEventListener("toggle", function () {
      if (_suppressBrowsePersist) return;
      localStorage.setItem("hl_browse_open", cardsBrowserEl.open ? "1" : "0");
    });
    // Expose Helper, damit andere Click-Handler (Recall, Aspirational, Stats-
    // CTA) das Akkordeon kontrolliert öffnen können ohne User-Default zu
    // überschreiben.
    window.openCardsBrowser = function () {
      if (!cardsBrowserEl.open) {
        _suppressBrowsePersist = true;
        cardsBrowserEl.open = true;
        // Das toggle-Event ist ein "queued task" — feuert nach dem aktuellen
        // Call-Stack. setTimeout(0) reiht die Flag-Rücksetzung in dieselbe
        // Queue ein, garantiert FIFO nach dem Toggle-Event. Sonst würde der
        // User-Default versehentlich überschrieben.
        setTimeout(function () { _suppressBrowsePersist = false; }, 0);
      }
    };
  }

  // Initial-Render
  try { renderEngagement(); } catch (e) { console.warn("[engagement] initial render failed", e); }
}
// Defer via setTimeout(0) — alle Top-Level-Defs (inkl. des späten `car`-const)
// sind dann bereits ausgewertet. Bugfix Juni 2026: vorher doppeltes
// requestAnimationFrame — rAF feuert in versteckten/Hintergrund-Tabs NICHT,
// d.h. Hero-Button, Tagesziel & Co. blieben unverdrahtet, bis der Tab
// sichtbar wurde. setTimeout(0) läuft nach den Top-Level-Statements und
// auch im Hintergrund zuverlässig.
setTimeout(wireEngagement, 0);

// ===== Controls =====
document.getElementById("play-btn").onclick = function () {
  if (state.isPlaying) pause();
  else if (state.mode === "recall") {
    const s = currentSentence();
    if (s) {
      state.revealed.add(s.id);
      const card = document.querySelector('.card[data-id="' + s.id + '"]');
      if (card) card.classList.add("revealed");
      play();
    }
  } else play();
};
document.getElementById("prev-btn").onclick = prev;
document.getElementById("next-btn").onclick = next;

translateToggle.onclick = function () {
  if (state.mode === "recall") return;
  state.showTranslation = !state.showTranslation;
  translateToggle.classList.toggle("on", state.showTranslation);
  document.querySelectorAll(".de").forEach(function (el) { el.classList.toggle("hidden", !state.showTranslation); });
};

// Auto-play toggle
function updateAutoplayUI() {
  autoplayToggle.classList.toggle("on", state.autoPlay);
}
autoplayToggle.onclick = function () {
  state.autoPlay = !state.autoPlay;
  saveJSON("hl_autoplay", state.autoPlay);
  updateAutoplayUI();
  showToast(state.autoPlay ? "Auto-Play an — Audio läuft durch." : "Auto-Play aus — nur Klick weiterführt.");
};

searchBtn.onclick = function () {
  searchInput.classList.toggle("visible");
  if (searchInput.classList.contains("visible")) searchInput.focus();
};
searchInput.oninput = function (e) {
  const v = e.target.value;
  // Defeat browser autofill: ignore values that look like an email (typical autofill bait)
  if (v && v.includes("@") && v.includes(".") && !/\s/.test(v)) {
    console.warn("[search] Ignoring email-like autofill value:", v);
    e.target.value = "";
    state.search = "";
    applyFilter();
    if (typeof renderSaetzePage === "function") renderSaetzePage();
    return;
  }
  state.search = v;
  applyFilter();
  // The Meine-Sätze page also honors state.search now — re-render it so the
  // topbar query filters that list too. No-op if the page DOM isn't there.
  if (typeof renderSaetzePage === "function") renderSaetzePage();
};
speedBtn.onclick = function () {
  const i = state.speeds.indexOf(state.speed);
  state.speed = state.speeds[(i + 1) % state.speeds.length];
  speedBtn.textContent = state.speed.toFixed(2).replace(/\.?0+$/, "") + "×";
  audioEl.playbackRate = state.speed;
};
repeatBtn.onclick = function () {
  const i = state.repeats.indexOf(state.repeat);
  state.repeat = state.repeats[(i + 1) % state.repeats.length];
  repeatBtn.textContent = "Rep " + state.repeat + "×";
};
listenBtn.onclick = function () {
  state.mode = "listen";
  document.body.classList.remove("recall");
  listenBtn.classList.remove("secondary"); listenBtn.classList.add("primary");
  recallBtn.classList.remove("primary"); recallBtn.classList.add("secondary");
  state.showTranslation = true;
  translateToggle.classList.add("on");
  document.querySelectorAll(".de").forEach(function (el) { el.classList.remove("hidden"); });
  modeHint.textContent = "Spanisch zuerst lesen/hören, Deutsch als Hilfe darunter.";
  // Restore normal filter (kein SRS-Queue mehr)
  applyFilter();
};
recallBtn.onclick = function () {
  state.mode = "recall";
  document.body.classList.add("recall");
  recallBtn.classList.remove("secondary"); recallBtn.classList.add("primary");
  listenBtn.classList.remove("primary"); listenBtn.classList.add("secondary");
  state.revealed.clear();
  // SRS-Queue laden statt der normalen Karten-Liste
  applyFilter();
  // Karten-Akkordeon programmatisch öffnen — sonst sind die Recall-Karten im
  // eingeklappten Dashboard-Browser nicht sichtbar. openCardsBrowser persistiert
  // den User-Default NICHT (siehe wireEngagement), nur das Akkordeon aktuell auf.
  if (typeof openCardsBrowser === "function") openCardsBrowser();
  const n = dueCount();
  if (n === 0) {
    modeHint.textContent = "Keine Karten heute fällig — wir zeigen die nächst-fälligen (Smart Fallback). Tab zum Aufdecken.";
  } else {
    modeHint.textContent = n + " Karte" + (n === 1 ? "" : "n") + " heute fällig. Tab zum Aufdecken — Audio startet nicht automatisch.";
  }
};
document.addEventListener("keydown", function (e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Tab" && state.mode === "recall") { e.preventDefault(); revealCurrent(); }
  else if (e.code === "Space") {
    e.preventDefault();
    if (state.isPlaying) pause();
    else if (state.mode === "recall") {
      const s = currentSentence();
      if (s) { state.revealed.add(s.id); const c = document.querySelector('.card[data-id="' + s.id + '"]'); if (c) c.classList.add("revealed"); play(); }
    } else play();
  } else if (e.code === "ArrowRight") { e.preventDefault(); next(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); prev(); }
  else if (e.code === "KeyT" && state.mode === "listen") translateToggle.click();
  else if (e.code === "Escape") closeSidePanel();
});

// =====================================================================
// MEINE SÄTZE — eigene Seite (Phase 0 Redesign, ersetzt die alte Sidebar-
// Sektion). Bedient sich aus state.userSentences und filtert nach
// state.saetzeFilter ∈ { "translated" | "pending" | "archived" }.
// =====================================================================

function getSaetzeForFilter(filter) {
  if (filter === "archived") {
    return state.userSentences.filter(function (s) { return s.archived; });
  }
  if (filter === "pending") {
    return state.userSentences.filter(function (s) { return !s.archived && s.pending; });
  }
  if (filter === "no_audio") {
    // Übersetzt (also ES vorhanden, nicht pending, nicht archiviert) und KEIN Audio.
    return state.userSentences.filter(function (s) {
      return !s.archived && !s.pending && s.es && !hasAudio(s);
    });
  }
  // "translated" (default): non-archived and non-pending (Übersetzung vorhanden).
  return state.userSentences.filter(function (s) { return !s.archived && !s.pending; });
}

// Mode-driven empty-state copy.
const SAETZE_EMPTY_COPY = {
  translated: "Noch keine übersetzten Sätze. Füge welche über „Neuer Satz“ hinzu.",
  pending: "Keine ausstehenden Übersetzungen. Alles ist übersetzt.",
  no_audio: "Alle übersetzten Sätze haben bereits Audio. 🎉",
  archived: "Archiv ist leer.",
};

function renderSaetzePage() {
  // No-op if the page DOM isn't there (defensive — pre-init or test scenarios).
  if (!saetzeListEl) return;
  saetzeListEl.innerHTML = "";

  const filter = state.saetzeFilter || "translated";
  const rawList = getSaetzeForFilter(filter);

  // Honor the topbar search input on this page too — same DE+ES substring match
  // as applyFilter() uses for the main card list. Empty query → no filtering.
  const q = (state.search || "").trim().toLowerCase();
  const list = q
    ? rawList.filter(function (s) {
        return (s.de && s.de.toLowerCase().includes(q))
          || (s.es && s.es.toLowerCase().includes(q));
      })
    : rawList;

  // Translate-all banner: nur im Pending-Filter UND wenn pending-Sätze da sind.
  const banner = document.getElementById("saetze-translate-banner");
  const bannerBtn = document.getElementById("saetze-translate-btn");
  const bannerLabel = document.getElementById("saetze-translate-btn-label");
  const bannerSub = document.getElementById("saetze-translate-banner-sub");
  const pendingCount = state.userSentences.filter(function (s) { return !s.archived && s.pending; }).length;
  if (banner) {
    if (filter === "pending" && pendingCount > 0) {
      banner.style.display = "flex";
      if (bannerLabel) bannerLabel.textContent = "Alle übersetzen (" + pendingCount + ")";
      if (bannerSub) {
        if (state.apiKey) bannerSub.textContent = "Claude übersetzt alle " + pendingCount + " Sätze in einem Schwung.";
        else bannerSub.textContent = "Anthropic API Key fehlt — setze ihn in Einstellungen.";
      }
      if (bannerBtn) bannerBtn.disabled = !state.apiKey;
    } else {
      banner.style.display = "none";
    }
  }

  // Manual-Copy-Paste-Block: nur im Pending-Filter UND wenn pending-Sätze da sind.
  // Alternative zum API-Call (auch ohne Anthropic-Key nutzbar).
  const manualBlock = document.getElementById("saetze-manual-block");
  if (manualBlock) {
    manualBlock.style.display = (filter === "pending" && pendingCount > 0) ? "block" : "none";
  }

  // Audio-Bulk-Banner: nur im Ohne-Audio-Filter UND wenn Kandidaten da sind.
  const audioBanner = document.getElementById("saetze-audio-banner");
  const audioBtn = document.getElementById("saetze-audio-btn");
  const audioBtnLabel = document.getElementById("saetze-audio-btn-label");
  const audioBannerSub = document.getElementById("saetze-audio-banner-sub");
  if (audioBanner) {
    const noAudioCount = state.userSentences.filter(function (s) {
      return !s.archived && !s.pending && s.es && !hasAudio(s);
    }).length;
    if (filter === "no_audio" && noAudioCount > 0) {
      audioBanner.style.display = "flex";
      if (audioBtnLabel) audioBtnLabel.textContent = "Alle Audios generieren (" + noAudioCount + ")";
      if (audioBannerSub) {
        if (state.elKey) audioBannerSub.textContent = "ElevenLabs erzeugt Audio für alle " + noAudioCount + " Sätze nacheinander.";
        else audioBannerSub.textContent = "ElevenLabs API Key fehlt — setze ihn in Einstellungen.";
      }
      if (audioBtn) audioBtn.disabled = !state.elKey;
    } else {
      audioBanner.style.display = "none";
    }
  }

  // Update filter-tab active state every render (handles deep-link / external state-set).
  if (saetzeFilterEl) {
    const tabs = saetzeFilterEl.querySelectorAll(".saetze-filter-tab");
    for (const t of tabs) {
      if (t.getAttribute("data-saetze-filter") === filter) t.classList.add("active");
      else t.classList.remove("active");
    }
  }

  if (list.length === 0) {
    if (saetzeEmptyEl) saetzeEmptyEl.style.display = "block";
    if (saetzeEmptyTextEl) {
      // If the list is empty specifically because of an active search query,
      // say so — otherwise the user sees "Keine übersetzten Sätze." even though
      // they have plenty of sentences that just don't match the query.
      if (q && rawList.length > 0) {
        saetzeEmptyTextEl.textContent = "Keine Treffer für „" + state.search.trim() + "“.";
      } else {
        saetzeEmptyTextEl.textContent = SAETZE_EMPTY_COPY[filter] || SAETZE_EMPTY_COPY.translated;
      }
    }
    if (saetzeFooterInfoEl) saetzeFooterInfoEl.textContent = "";
    return;
  }
  if (saetzeEmptyEl) saetzeEmptyEl.style.display = "none";

  // Sort (newest / oldest / random)
  let sorted = list.slice();
  if (state.usSort === "newest") sorted.sort(function (a, b) { return b.id - a.id; });
  else if (state.usSort === "oldest") sorted.sort(function (a, b) { return a.id - b.id; });
  else {
    for (let i = sorted.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = sorted[i]; sorted[i] = sorted[j]; sorted[j] = tmp;
    }
  }

  for (const s of sorted) {
    saetzeListEl.appendChild(renderSaetzeCard(s));
  }

  // Footer info — small running count, no menu-level counter.
  if (saetzeFooterInfoEl) {
    const totalUser = state.userSentences.length;
    saetzeFooterInfoEl.textContent = list.length + " von " + totalUser + " Sätzen";
  }
}

function renderSaetzeCard(s) {
  const card = document.createElement("article");
  card.className = "saetze-card" + (s.pending ? " pending" : "") + (s.archived ? " archived" : "");
  card.setAttribute("data-id", String(s.id));

  // === Main column (meta + text) ===
  const main = document.createElement("div");
  main.className = "saetze-card-main";

  const meta = document.createElement("div");
  meta.className = "saetze-card-meta";

  const idEl = document.createElement("span");
  idEl.className = "saetze-card-id";
  idEl.textContent = "#" + s.id;
  meta.appendChild(idEl);

  const statusEl = document.createElement("span");
  statusEl.className = "saetze-status";
  if (s.archived) {
    statusEl.classList.add("archived");
    statusEl.textContent = "Archiviert";
  } else if (s.pending) {
    statusEl.classList.add("pending");
    statusEl.textContent = "Ausstehend";
  } else if (hasAudio(s)) {
    statusEl.classList.add("has-audio");
    statusEl.textContent = "Audio";
  } else {
    statusEl.classList.add("no-audio");
    statusEl.textContent = "Kein Audio";
  }
  meta.appendChild(statusEl);

  if (Array.isArray(s.cats) && s.cats.length > 0) {
    const catsEl = document.createElement("span");
    catsEl.className = "saetze-card-cats";
    catsEl.textContent = s.cats.join(" · ");
    meta.appendChild(catsEl);
  }

  main.appendChild(meta);

  const isEditing = state.saetzeEditingId === s.id;

  // ES on top (primary content) — falls back to a hint if pending.
  // In edit mode, replace the <p> with a textarea pre-filled with the current ES.
  if (isEditing) {
    const ta = document.createElement("textarea");
    ta.className = "saetze-edit-textarea";
    ta.value = s.es || "";
    ta.rows = 2;
    ta.setAttribute("aria-label", "Spanischer Text bearbeiten");
    // Keyboard shortcuts: Cmd/Ctrl+Enter = save, Esc = cancel
    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        saveEditSaetze(s.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEditSaetze();
      }
    });
    main.appendChild(ta);
  } else {
    const esEl = document.createElement("p");
    esEl.className = "saetze-card-es";
    if (s.es) {
      esEl.textContent = s.es;
    } else {
      esEl.textContent = "— wird übersetzt —";
    }
    main.appendChild(esEl);
  }

  const deEl = document.createElement("p");
  deEl.className = "saetze-card-de";
  deEl.textContent = s.de;
  main.appendChild(deEl);

  card.appendChild(main);

  // === Actions column ===
  const actions = document.createElement("div");
  actions.className = "saetze-card-actions";

  if (isEditing) {
    // Reduced action set while editing — Speichern / Abbrechen.
    const saveBtn = document.createElement("button");
    saveBtn.className = "saetze-action-btn accent";
    saveBtn.title = "Speichern (Cmd/Ctrl + Enter)";
    saveBtn.setAttribute("aria-label", "Speichern");
    saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">check</span>';
    saveBtn.onclick = function () { saveEditSaetze(s.id); };
    actions.appendChild(saveBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "saetze-action-btn";
    cancelBtn.title = "Abbrechen (Esc)";
    cancelBtn.setAttribute("aria-label", "Abbrechen");
    cancelBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">close</span>';
    cancelBtn.onclick = function () { cancelEditSaetze(); };
    actions.appendChild(cancelBtn);

    card.appendChild(actions);
    return card;
  }

  if (s.archived) {
    // Restore + permanent delete
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "saetze-action-btn accent";
    restoreBtn.title = "Wiederherstellen";
    restoreBtn.setAttribute("aria-label", "Wiederherstellen");
    restoreBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">restore</span>';
    restoreBtn.onclick = function () { restoreUserSentence(s.id); };
    actions.appendChild(restoreBtn);

    const delPermBtn = document.createElement("button");
    delPermBtn.className = "saetze-action-btn danger";
    delPermBtn.title = "Endgültig löschen";
    delPermBtn.setAttribute("aria-label", "Endgültig löschen");
    delPermBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">delete_forever</span>';
    delPermBtn.onclick = function () { permanentDeleteUserSentence(s.id); };
    actions.appendChild(delPermBtn);
  } else if (s.pending) {
    // Pending: only a delete button (translation happens via main "Übersetzen" flow).
    const delBtn = document.createElement("button");
    delBtn.className = "saetze-action-btn danger";
    delBtn.title = "Löschen";
    delBtn.setAttribute("aria-label", "Löschen");
    delBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">delete</span>';
    delBtn.onclick = function () { archiveOrDelete(s.id); };
    actions.appendChild(delBtn);
  } else {
    // Translated (non-archived): edit / play / regen-or-gen audio / archive
    const editBtn = document.createElement("button");
    editBtn.className = "saetze-action-btn";
    editBtn.title = "Spanisch bearbeiten";
    editBtn.setAttribute("aria-label", "Spanisch bearbeiten");
    editBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">edit</span>';
    editBtn.onclick = function () { startEditSaetze(s.id); };
    actions.appendChild(editBtn);

    if (hasAudio(s)) {
      const playBtn = document.createElement("button");
      playBtn.className = "saetze-action-btn";
      playBtn.title = "Abspielen";
      playBtn.setAttribute("aria-label", "Abspielen");
      playBtn.innerHTML = '<span class="material-symbols-outlined fill" style="font-size:18px;">play_arrow</span>';
      playBtn.onclick = function () { playSaetzeAudio(s); };
      actions.appendChild(playBtn);

      const regenBtn = document.createElement("button");
      regenBtn.className = "saetze-action-btn";
      regenBtn.title = "Audio neu generieren";
      regenBtn.setAttribute("aria-label", "Audio neu generieren");
      regenBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">refresh</span>';
      regenBtn.onclick = function () { regenerateAudioForSaetze(s.id, regenBtn); };
      actions.appendChild(regenBtn);
    } else {
      const genBtn = document.createElement("button");
      genBtn.className = "saetze-action-pill";
      genBtn.title = "Audio generieren";
      genBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">volume_up</span> Audio';
      genBtn.onclick = function () { regenerateAudioForSaetze(s.id, genBtn); };
      actions.appendChild(genBtn);
    }

    const archBtn = document.createElement("button");
    archBtn.className = "saetze-action-btn danger";
    archBtn.title = "Ins Archiv verschieben";
    archBtn.setAttribute("aria-label", "Ins Archiv verschieben");
    archBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">archive</span>';
    archBtn.onclick = function () { archiveOrDelete(s.id); };
    actions.appendChild(archBtn);
  }

  card.appendChild(actions);
  return card;
}

// Plays audio for a single Meine-Sätze card. Does NOT touch the main player
// state (no current-sentence change, no autoplay queue) — pure preview.
// state._saetzePreviewActive prevents the global "ended" handler from
// auto-advancing the main player after the preview clip finishes.
function playSaetzeAudio(s) {
  if (!audioEl) return;
  const src = audioSrcFor(s);
  if (!src) { showToast("Kein Audio für diesen Satz."); return; }
  try {
    state._saetzePreviewActive = true;
    audioEl.src = src;
    audioEl.playbackRate = 1.0;
    audioEl.play().catch(function (err) {
      state._saetzePreviewActive = false;
      console.error("Saetze play failed", err);
    });
  } catch (e) {
    state._saetzePreviewActive = false;
    console.error(e);
  }
}

// Regenerates (or first-time generates) audio for a user-sentence on the
// Meine-Sätze page. Shows a temporary spinner state on the button.
async function regenerateAudioForSaetze(id, btn) {
  if (!btn) return;
  const originalHTML = btn.innerHTML;
  const originalDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined saetze-spin" style="font-size:18px;">refresh</span>';
  try {
    const ok = await generateAudioFor(id);
    if (ok) {
      showToast("Audio generiert.");
      renderSaetzePage();
      renderCards();
      updateGenerateAllAudioBtn();
    } else {
      btn.innerHTML = originalHTML;
      btn.disabled = originalDisabled;
    }
  } catch (e) {
    showToast("Audio-Fehler: " + e.message, 4000);
    btn.innerHTML = originalHTML;
    btn.disabled = originalDisabled;
  }
}

// ===== Edit ES text on a Meine-Sätze card =====
// One-card-at-a-time editing via state.saetzeEditingId. The DE side and
// categories stay read-only — per user decision (Mai 2026), the main use case
// is correcting the Spanish phrasing when the user's wife suggests a Guatemala-
// specific variant. If ES actually changes AND an audio exists, we prompt for
// regeneration (the old audio still says the old text).
function startEditSaetze(id) {
  state.saetzeEditingId = id;
  renderSaetzePage();
  // Focus textarea and put caret at the end so the user can start typing
  // immediately. Wrapped in rAF so the DOM is mounted first.
  requestAnimationFrame(function () {
    const ta = document.querySelector('.saetze-card[data-id="' + id + '"] .saetze-edit-textarea');
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      try { ta.setSelectionRange(len, len); } catch (e) {}
    }
  });
}

function cancelEditSaetze() {
  state.saetzeEditingId = null;
  renderSaetzePage();
}

async function saveEditSaetze(id) {
  const card = document.querySelector('.saetze-card[data-id="' + id + '"]');
  if (!card) return;
  const ta = card.querySelector(".saetze-edit-textarea");
  if (!ta) return;
  const newEs = ta.value.trim();
  if (!newEs) {
    showToast("ES darf nicht leer sein.");
    return;
  }
  const s = state.userSentences.find(function (x) { return x.id === id; });
  if (!s) return;
  const oldEs = s.es || "";
  const changed = newEs !== oldEs;

  s.es = newEs;
  saveJSON("hl_user_sentences", state.userSentences);  // triggers queuePushSentences()
  state.saetzeEditingId = null;
  renderSaetzePage();
  renderCards();  // main list also shows ES, keep it in sync
  showToast(changed ? "Gespeichert." : "Keine Änderung.");

  // Audio regen prompt: only when ES actually changed AND an audio already exists.
  // No audio yet → user will hit the regular "Audio" button on their own.
  if (changed && hasAudio(s)) {
    const yes = confirm(
      "ES-Text wurde geändert.\n\n" +
      "Alt: " + oldEs.slice(0, 120) + "\n" +
      "Neu: " + newEs.slice(0, 120) + "\n\n" +
      "Audio jetzt neu generieren?"
    );
    if (yes) {
      showToast("Audio wird generiert …", 60000);
      try {
        const ok = await generateAudioFor(id);
        if (ok) {
          renderSaetzePage();
          renderCards();
          if (typeof updateGenerateAllAudioBtn === "function") updateGenerateAllAudioBtn();
          showToast("Audio neu generiert.");
        } else {
          showToast("Audio konnte nicht generiert werden.", 4000);
        }
      } catch (e) {
        showToast("Audio-Fehler: " + e.message, 4000);
      }
    }
  }
}

// Filter-tab + sort handlers
if (saetzeFilterEl) {
  saetzeFilterEl.addEventListener("click", function (e) {
    const tab = e.target.closest(".saetze-filter-tab");
    if (!tab) return;
    const f = tab.getAttribute("data-saetze-filter");
    if (!f) return;
    state.saetzeFilter = f;
    state.saetzeEditingId = null;  // discard pending edit when switching filter
    renderSaetzePage();
  });
}
if (saetzeSortEl) {
  saetzeSortEl.onchange = function () {
    state.usSort = saetzeSortEl.value;
    localStorage.setItem("hl_us_sort", state.usSort);
    queuePushProfile();
    state.saetzeEditingId = null;  // discard pending edit when re-sorting
    renderSaetzePage();
  };
}

// Page open/close — same body-class pattern as the New-Sentence page.
let _modeBeforeSaetze = null;
function openSaetzePage() {
  // Remember current mode to restore on close
  _modeBeforeSaetze = document.body.classList.contains("focus")
    ? "focus"
    : (document.body.classList.contains("recall") ? "recall" : "listen");
  document.body.classList.remove("focus");
  document.body.classList.remove("recall");
  document.body.classList.remove("new-sentence");  // mutual exclusion
  document.body.classList.remove("stats");
  document.body.classList.remove("scenes");
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  document.body.classList.add("saetze");
  closeSidePanel();
  renderSaetzePage();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function closeSaetzePage() {
  state.saetzeEditingId = null;  // exit edit mode when leaving the page
  document.body.classList.remove("saetze");
  if (_modeBeforeSaetze === "focus" && typeof setFocusModeActive === "function") {
    setFocusModeActive();
  } else if (_modeBeforeSaetze === "recall") {
    document.body.classList.add("recall");
  }
  _modeBeforeSaetze = null;
}
if (sideSaetzeLink) sideSaetzeLink.onclick = function () { openSaetzePage(); };
if (saetzeBackBtn) saetzeBackBtn.onclick = function () { closeSaetzePage(); };

// Translate-all-Banner-Button auf der Saetze-Page (Pending-Filter)
const saetzeTranslateBtn = document.getElementById("saetze-translate-btn");
if (saetzeTranslateBtn) {
  saetzeTranslateBtn.onclick = function () {
    // Reuse die existierende Translate-Pipeline aus der alten Sidebar-Sektion
    if (typeof translateViaAPI === "function") translateViaAPI();
    else if (translateApiBtn) translateApiBtn.click();
  };
}

// Bulk-Audio-Banner-Button auf der Saetze-Page (Ohne-Audio-Filter)
const saetzeAudioBtn = document.getElementById("saetze-audio-btn");
if (saetzeAudioBtn) {
  saetzeAudioBtn.onclick = function () {
    // Reuse die existierende Generate-All-Pipeline
    if (typeof generateAllPendingAudios === "function") generateAllPendingAudios();
    else if (generateAllAudioBtn) generateAllAudioBtn.click();
  };
}

// Copy-Paste-Manual-Block auf der Saetze-Page (Pending-Filter):
// Prompt kopieren + Antwort einfügen + Anwenden. Reuse von
// buildTranslationPrompt() und parseAndApplyTranslations() aus dem alten
// Sidebar-Manual-Block.
const saetzeCopyPromptBtn = document.getElementById("saetze-copy-prompt-btn");
const saetzePasteTranslationsEl = document.getElementById("saetze-paste-translations");
const saetzeApplyTranslationsBtn = document.getElementById("saetze-apply-translations-btn");
if (saetzeCopyPromptBtn) {
  saetzeCopyPromptBtn.onclick = function () {
    const text = buildTranslationPrompt();
    if (!text) { showToast("Keine ausstehenden Übersetzungen."); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        const n = pendingSentences().length;
        showToast(n + " Sätze in Zwischenablage.");
      }).catch(function () {
        if (saetzePasteTranslationsEl) {
          saetzePasteTranslationsEl.value = text;
          saetzePasteTranslationsEl.select();
        }
        showToast("Bitte manuell kopieren (Ctrl+C).", 4000);
      });
    } else {
      if (saetzePasteTranslationsEl) {
        saetzePasteTranslationsEl.value = text;
        saetzePasteTranslationsEl.select();
      }
      showToast("Bitte manuell kopieren (Ctrl+C).", 4000);
    }
  };
}
if (saetzeApplyTranslationsBtn) {
  saetzeApplyTranslationsBtn.onclick = function () {
    if (!saetzePasteTranslationsEl) return;
    const text = saetzePasteTranslationsEl.value;
    if (!text.trim()) { showToast("Nichts zum Anwenden."); return; }
    parseAndApplyTranslations(text);
    saetzePasteTranslationsEl.value = "";
  };
}

// Back-compat shim: anything in this file that still calls the old function
// goes through the new one (call-sites are renamed below in the same diff).
function buildUserSentencesList() { renderSaetzePage(); }

// =====================================================================
// STATISTIKEN — eigene Page (Basis-Phase)
// =====================================================================
// Lebt parallel zur Meine-Sätze-Page als body.stats-View. Aggregate kommen
// aus state.stats (daily counters + all_time). Streak wird live berechnet.

const sideStatsLink = document.getElementById("side-stats-link");
const statsPage = document.getElementById("stats-page");
const statsBackBtn = document.getElementById("stats-back-btn");
const statsStreakValueEl = document.getElementById("stats-streak-value");
const statsPlaysTodayEl = document.getElementById("stats-plays-today");
const statsLearnedEl = document.getElementById("stats-learned");
const statsHeatmapEl = document.getElementById("stats-heatmap");
const statsLegendScaleEl = document.getElementById("stats-legend-scale");
const statsInselnGridEl = document.getElementById("stats-inseln-grid");
// Note: Heute-fällig + Einführungs-Pool + Szenen-Praxis-CTAs sind aufs Dashboard
// gewandert (Mai 2026, "Heute üben"-Block in index.html + renderTodayActions()).
// Die zugehörigen const-Refs / Render-Blöcke wurden entfernt.

// 5-stufige Heatmap-Skala (heller → dunkler). Erst surface-low, dann
// drei Blau-Stufen, dann --primary (slate). Mirrored im Legend-Marker.
const HEATMAP_COLORS = [
  "var(--surface-low)",        // 0
  "#b5d4f4",                   // 1
  "#85b7eb",                   // 2
  "#378add",                   // 3
  "var(--primary)",            // 4 (höchste Stufe)
];

function heatmapBucket(plays) {
  // 0 Plays = 0, 1-9 = 1, 10-29 = 2, 30-69 = 3, 70+ = 4
  if (!plays || plays < 1) return 0;
  if (plays < 10) return 1;
  if (plays < 30) return 2;
  if (plays < 70) return 3;
  return 4;
}

function dateKeyOffset(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dateKeyFromDate(d);
}

function renderStatsPage() {
  if (!statsPage) return;

  // === Streak-Bar ===
  if (statsStreakValueEl) statsStreakValueEl.textContent = computeStreak();
  const today = isoToday();
  const todayStats = (state.stats.daily && state.stats.daily[today]) || { plays: 0, reveals: 0, rated: 0 };
  if (statsPlaysTodayEl) statsPlaysTodayEl.textContent = todayStats.plays || 0;
  let learned = 0;
  for (const id in state.ratings) if (state.ratings[id] === "learned") learned++;
  if (statsLearnedEl) {
    const total = allSentences().filter(function (s) { return !s.archived && stageOf(s.id) === "active"; }).length;
    statsLearnedEl.textContent = learned + " / " + total;
  }

  // === Heatmap (30 Tage) ===
  if (statsHeatmapEl) {
    statsHeatmapEl.innerHTML = "";
    for (let i = 29; i >= 0; i--) {
      const date = dateKeyOffset(i);
      const day = (state.stats.daily && state.stats.daily[date]) || null;
      const plays = day ? (day.plays || 0) : 0;
      const bucket = heatmapBucket(plays);
      const cell = document.createElement("div");
      cell.className = "stats-heatmap-cell" + (i === 0 ? " today" : "");
      cell.style.background = HEATMAP_COLORS[bucket];
      cell.title = date + " — " + plays + " Play" + (plays === 1 ? "" : "s");
      statsHeatmapEl.appendChild(cell);
    }
  }
  if (statsLegendScaleEl) {
    statsLegendScaleEl.innerHTML = "";
    for (let i = 0; i < 5; i++) {
      const sw = document.createElement("span");
      sw.style.background = HEATMAP_COLORS[i];
      statsLegendScaleEl.appendChild(sw);
    }
  }

  // === Insel-Grid (Kategorien sortiert nach % gelernt) ===
  if (statsInselnGridEl) {
    statsInselnGridEl.innerHTML = "";
    const cats = (DATA && DATA.categories) || [];
    const rows = [];
    for (const cat of cats) {
      let total = 0, catLearned = 0;
      for (const s of allSentences()) {
        if (s.archived || s.pending) continue;
        if (!s.cats || !s.cats.includes(cat.key)) continue;
        total++;
        if (state.ratings[s.id] === "learned") catLearned++;
      }
      if (total === 0) continue;
      rows.push({ cat: cat, total: total, learned: catLearned, pct: catLearned / total });
    }
    rows.sort(function (a, b) { return b.pct - a.pct; });

    for (const row of rows) {
      const pct = Math.round(row.pct * 100);
      const card = document.createElement("div");
      card.className = "stats-insel";
      // Farbe der Progress-Fill nach Reifegrad
      let fillColor = "var(--warning)";
      if (pct >= 60) fillColor = "var(--learned)";
      else if (pct >= 30) fillColor = "var(--primary)";

      card.innerHTML =
        '<div class="stats-insel-header">' +
          '<span style="font-size:20px;">' + (row.cat.icon || "📚") + "</span>" +
          '<span class="stats-insel-name"></span>' +
        "</div>" +
        '<div class="stats-insel-progress"><div class="stats-insel-progress-fill" style="width:' + pct + '%; background:' + fillColor + ';"></div></div>' +
        '<div class="stats-insel-meta">' +
          '<span>' + row.learned + " / " + row.total + " gelernt</span>" +
          '<span class="stats-insel-tag">' + pct + '%</span>' +
        "</div>";
      const nameEl = card.querySelector(".stats-insel-name");
      if (nameEl) nameEl.textContent = row.cat.label || row.cat.key;
      statsInselnGridEl.appendChild(card);
    }

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--secondary); font-size: 13px;";
      empty.textContent = "Noch keine Kategorien aktiv.";
      statsInselnGridEl.appendChild(empty);
    }
  }

  // Heute-fällig + Einführungs-Pool + Szenen-Praxis-Render sind aufs Dashboard
  // gewandert — siehe renderTodayActions() (in renderEngagement). Hier ist
  // bewusst nichts mehr; Stats ist seither pure Rückschau.
}

// CTA-Click-Handler für Heute-fällig / Einführung / Szenen sind ebenfalls auf
// das Dashboard umgezogen (Today-Action-Cards in wireEngagement). Stats hat
// keine Start-Buttons mehr.

// Page open/close — gleiches Pattern wie Saetze
let _modeBeforeStats = null;
function openStatsPage() {
  _modeBeforeStats = document.body.classList.contains("focus")
    ? "focus"
    : (document.body.classList.contains("recall") ? "recall" : "listen");
  document.body.classList.remove("focus");
  document.body.classList.remove("recall");
  document.body.classList.remove("new-sentence");
  document.body.classList.remove("saetze");
  document.body.classList.remove("scenes");
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  document.body.classList.add("stats");
  closeSidePanel();
  renderStatsPage();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function closeStatsPage() {
  document.body.classList.remove("stats");
  if (_modeBeforeStats === "focus" && typeof setFocusModeActive === "function") {
    setFocusModeActive();
  } else if (_modeBeforeStats === "recall") {
    document.body.classList.add("recall");
  }
  _modeBeforeStats = null;
}
if (sideStatsLink) sideStatsLink.onclick = function () { openStatsPage(); };
if (statsBackBtn) statsBackBtn.onclick = function () { closeStatsPage(); };

// =====================================================================
// EINSTELLUNGEN-PAGE (Sidebar-Restructure Mai 2026)
// =====================================================================
const sideSettingsLink = document.getElementById("side-settings-link");
const settingsPage = document.getElementById("settings-page");
const settingsBackBtn = document.getElementById("settings-back-btn");

let _modeBeforeSettings = null;
function openSettingsPage() {
  _modeBeforeSettings = document.body.classList.contains("focus")
    ? "focus"
    : (document.body.classList.contains("recall") ? "recall" : "listen");
  document.body.classList.remove("focus");
  document.body.classList.remove("recall");
  document.body.classList.remove("new-sentence");
  document.body.classList.remove("saetze");
  document.body.classList.remove("stats");
  document.body.classList.remove("scenes");
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  document.body.classList.add("settings");
  closeSidePanel();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function closeSettingsPage() {
  document.body.classList.remove("settings");
  if (_modeBeforeSettings === "focus" && typeof setFocusModeActive === "function") {
    setFocusModeActive();
  } else if (_modeBeforeSettings === "recall") {
    document.body.classList.add("recall");
  }
  _modeBeforeSettings = null;
}
if (sideSettingsLink) sideSettingsLink.onclick = function () { openSettingsPage(); };
if (settingsBackBtn) settingsBackBtn.onclick = function () { closeSettingsPage(); };

// ===== Backup-Export (Juni 2026) =====
// Sichert alle Lerndaten als JSON-Datei aufs Gerät. Reine Versicherung gegen
// Sync-/Cloud-Fehler. Audios sind NICHT enthalten (Storage/Repo). API-Keys
// sind bewusst NICHT enthalten (sollen das Gerät nie verlassen).
function exportBackup() {
  const payload = {
    format: "linguistflow-backup",
    version: 1,
    exported_at: new Date().toISOString(),
    app_version: APP_VERSION,
    userSentences: state.userSentences,
    scenes: state.scenes,
    ratings: state.ratings,
    mnemonics: state.mnemonics,
    shownMnemonics: [...state.shownMnemonics],
    introCounts: state.introCounts,
    cardState: state.cardState,
    stats: state.stats,
    whyText: state.whyText,
    settings: {
      autoplay: state.autoPlay,
      main_sort: state.mainSort,
      us_sort: state.usSort,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "linguistflow-backup-" + isoToday() + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  showToast("Backup heruntergeladen.");
}
const exportBackupBtn = document.getElementById("export-backup-btn");
if (exportBackupBtn) exportBackupBtn.onclick = exportBackup;

// =====================================================================
// SZENEN-PAGE (v1 — Phase 3) + Import-Modal (v1 — Phase 2)
// =====================================================================
// Eine eigene Page (body.scenes) zeigt die Liste aller Szenen mit Filter/Sort
// und einem prominenten "+ Szene importieren"-Knopf. Klick auf eine Szenen-Card
// öffnet (v1) noch keine Detail-Page — kommt in Phase 4 — sondern nur einen
// Toast als Stub.
//
// Das Import-Modal ist ein native <dialog>. TSV-Parsing erkennt sowohl rohen
// 3-Spalten-TSV (rolle\tDE\tES) als auch den optionalen "=== AUSWERTUNG ==="-
// Header aus KONVERSATIONS_PROMPT.md.

const sideScenesLink = document.getElementById("side-scenes-link");
const sideScenesCountBadge = document.getElementById("side-scenes-count");
const scenesPage = document.getElementById("scenes-page");
const scenesBackBtn = document.getElementById("scenes-back-btn");
const scenesListEl = document.getElementById("scenes-list");
const scenesEmptyEl = document.getElementById("scenes-empty");
const scenesFilterEl = document.getElementById("scenes-filter");
const scenesSortEl = document.getElementById("scenes-sort");
const scenesImportCtaEl = document.getElementById("scenes-import-cta");
const scenesImportCtaEmptyEl = document.getElementById("scenes-import-cta-empty");
const scenesHeaderSubEl = document.getElementById("scenes-header-sub");

let _modeBeforeScenes = null;
function openScenesPage() {
  _modeBeforeScenes = document.body.classList.contains("focus")
    ? "focus"
    : (document.body.classList.contains("recall") ? "recall" : "listen");
  document.body.classList.remove("focus");
  document.body.classList.remove("recall");
  document.body.classList.remove("new-sentence");
  document.body.classList.remove("saetze");
  document.body.classList.remove("stats");
  document.body.classList.remove("settings");
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  document.body.classList.add("scenes");
  closeSidePanel();
  if (scenesSortEl) scenesSortEl.value = state.scenesSort;
  renderScenesPage();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function closeScenesPage() {
  document.body.classList.remove("scenes");
  if (_modeBeforeScenes === "focus" && typeof setFocusModeActive === "function") {
    setFocusModeActive();
  } else if (_modeBeforeScenes === "recall") {
    document.body.classList.add("recall");
  }
  _modeBeforeScenes = null;
}
if (sideScenesLink) sideScenesLink.onclick = function () { openScenesPage(); };
if (scenesBackBtn) scenesBackBtn.onclick = function () { closeScenesPage(); };

// ===== Dashboard-Sidebar-Link =====
// Dashboard ist der Default-State (kein body-Mode-Klasse). Der Link bringt
// den User aus jedem beliebigen Page/Modus zurück auf die Main-View. Jede
// Page hat ihre eigene close*-Funktion; Modes (focus/car/intro/scene-practice)
// haben exit*-/end*-Funktionen. Wir rufen sie nacheinander auf, damit
// Session-State sauber abgeräumt wird (Timer, audioEl pausieren, etc.).
const sideDashboardLink = document.getElementById("side-dashboard-link");
function goToDashboard() {
  // Scene-Practice ZUERST behandeln (Bugfix Juni 2026): Vorher wurde
  // scenePracticeCloseBtn.click() gerufen und dessen confirm()-Ergebnis
  // ignoriert — bei „Abbrechen" verschwand das Overlay trotzdem (Belt-and-
  // suspenders unten räumte die Klasse weg), aber die Session blieb intern
  // aktiv (Space-Handler scharf, Run nicht sauber beendet). Jetzt: confirm
  // hier prüfen und bei Ablehnung den Dashboard-Wechsel KOMPLETT abbrechen.
  if (document.body.classList.contains("scene-practice")) {
    const sp = state.scenePractice;
    if (sp.active && sp.index < sp.queue.length) {
      if (!confirm("Session abbrechen? Kein Run-Counter wird hochgezählt.")) return;
    }
    if (typeof endScenePractice === "function") endScenePractice(false);
  }

  // Pages schließen (jede close-Funktion ist no-op wenn ihre body-Klasse fehlt,
  // aber wir checken trotzdem damit wir keine ungewollten Side-Effekte triggern)
  if (document.body.classList.contains("scene-detail") && typeof closeSceneDetailPage === "function") closeSceneDetailPage();
  if (document.body.classList.contains("scenes") && typeof closeScenesPage === "function") closeScenesPage();
  if (document.body.classList.contains("saetze") && typeof closeSaetzePage === "function") closeSaetzePage();
  if (document.body.classList.contains("stats") && typeof closeStatsPage === "function") closeStatsPage();
  if (document.body.classList.contains("settings") && typeof closeSettingsPage === "function") closeSettingsPage();
  if (document.body.classList.contains("new-sentence") && typeof closeNewSentencePage === "function") closeNewSentencePage();

  // Sessions/Modes beenden (jede exit-/end-Funktion macht Cleanup intern;
  // scene-practice wurde oben bereits mit confirm behandelt)
  if (document.body.classList.contains("car") && typeof exitCarSession === "function") exitCarSession();
  if (document.body.classList.contains("focus") && typeof endFocusSession === "function") endFocusSession("dashboard");
  if (document.body.classList.contains("intro") && typeof endIntroSession === "function") endIntroSession();

  // Belt-and-suspenders: residuale Body-Klassen entfernen, falls eine
  // close-/exit-Funktion was übersieht (z.B. car-driving / car-night).
  ["recall", "focus", "car", "intro", "scene-practice", "scene-import", "car-driving", "car-night"].forEach(function (c) {
    document.body.classList.remove(c);
  });

  // Listen-Modus aktivieren (= Dashboard-Default). listenBtn.onclick setzt
  // state.mode, blendet Recall-Translation ein und ruft applyFilter().
  const lb = document.getElementById("listen-mode-btn");
  if (lb) lb.click();

  // Sidebar-Drawer auf Mobile schließen.
  if (typeof closeSidePanel === "function") closeSidePanel();

  // An den Anfang scrollen — sonst landet der User mitten in der Karten-Liste.
  window.scrollTo({ top: 0, behavior: "instant" });
}
if (sideDashboardLink) sideDashboardLink.onclick = function () { goToDashboard(); };

// Sidebar-Badge: Anzahl aktiver Szenen
function updateScenesBadge() {
  if (!sideScenesCountBadge) return;
  const n = state.scenes.filter(function (sc) { return sc.status === "active"; }).length;
  if (n > 0) {
    sideScenesCountBadge.textContent = n;
    sideScenesCountBadge.style.display = "";
  } else {
    sideScenesCountBadge.textContent = "";
    sideScenesCountBadge.style.display = "none";
  }
}

// ----- Filter-Tabs + Sort -----
function setScenesFilter(value) {
  state.scenesFilter = value;
  localStorage.setItem("hl_scenes_filter", value);
  if (scenesFilterEl) {
    const tabs = scenesFilterEl.querySelectorAll(".scenes-filter-tab");
    tabs.forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-scenes-filter") === value);
    });
  }
  renderScenesPage();
}
if (scenesFilterEl) {
  scenesFilterEl.addEventListener("click", function (e) {
    const btn = e.target.closest(".scenes-filter-tab");
    if (!btn) return;
    const value = btn.getAttribute("data-scenes-filter");
    if (value) setScenesFilter(value);
  });
}
if (scenesSortEl) {
  scenesSortEl.onchange = function () {
    state.scenesSort = scenesSortEl.value;
    localStorage.setItem("hl_scenes_sort", state.scenesSort);
    renderScenesPage();
  };
}

function _scenesFilterCounts() {
  const counts = { all: 0, draft: 0, active: 0, mastered: 0, archived: 0 };
  for (const sc of state.scenes) {
    counts.all++;
    if (counts.hasOwnProperty(sc.status)) counts[sc.status]++;
  }
  return counts;
}

function renderScenesPage() {
  if (!scenesListEl) return;
  // Restore active filter tab from state
  if (scenesFilterEl) {
    scenesFilterEl.querySelectorAll(".scenes-filter-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-scenes-filter") === state.scenesFilter);
    });
    // Update count badges in tabs
    const counts = _scenesFilterCounts();
    scenesFilterEl.querySelectorAll("[data-count-for]").forEach(function (el) {
      const k = el.getAttribute("data-count-for");
      if (counts.hasOwnProperty(k)) el.textContent = counts[k];
    });
  }

  // Filter
  let list = state.scenes.slice();
  if (state.scenesFilter !== "all") {
    list = list.filter(function (sc) { return sc.status === state.scenesFilter; });
  }

  // Sort
  const sortBy = state.scenesSort || "last_practiced";
  list.sort(function (a, b) {
    if (sortBy === "title") {
      return (a.title || "").localeCompare(b.title || "");
    }
    if (sortBy === "sentence_count") {
      const ca = state.userSentences.filter(function (s) { return s.scene_id === a.id; }).length;
      const cb = state.userSentences.filter(function (s) { return s.scene_id === b.id; }).length;
      return cb - ca;
    }
    if (sortBy === "created") {
      return (b.created_at || "").localeCompare(a.created_at || "");
    }
    // default: last_practiced — Szenen die nie geübt wurden, ans Ende
    const la = a.last_practiced_at || "";
    const lb = b.last_practiced_at || "";
    if (!la && !lb) return (b.created_at || "").localeCompare(a.created_at || "");
    if (!la) return 1;
    if (!lb) return -1;
    return lb.localeCompare(la);
  });

  // Header-Sub aktualisieren
  if (scenesHeaderSubEl) {
    const counts = _scenesFilterCounts();
    if (counts.all === 0) {
      scenesHeaderSubEl.textContent = "Dialog-Szenen aus Konversationen.";
    } else {
      scenesHeaderSubEl.textContent = counts.active + " aktiv · " + counts.draft + " draft · " +
        counts.mastered + " gemeistert · " + counts.archived + " archiviert";
    }
  }

  // Render
  scenesListEl.innerHTML = "";
  if (list.length === 0) {
    scenesListEl.style.display = "none";
    if (scenesEmptyEl) {
      const counts = _scenesFilterCounts();
      scenesEmptyEl.style.display = counts.all === 0 ? "" : "";
      // Wenn es Szenen gibt aber der aktuelle Filter leer ist, anderen Text zeigen
      if (counts.all > 0) {
        scenesEmptyEl.querySelector("h3").textContent = "Keine Szenen in diesem Filter";
        scenesEmptyEl.querySelector("p").textContent = "Wechsle den Filter oder importiere eine neue Szene.";
      } else {
        scenesEmptyEl.querySelector("h3").textContent = "Noch keine Szenen";
        scenesEmptyEl.querySelector("p").textContent = "Starte eine Konversation in Cowork oder claude.ai, paste den TSV-Output hier rein und lege deine erste Szene an.";
      }
    }
    return;
  }
  scenesListEl.style.display = "";
  if (scenesEmptyEl) scenesEmptyEl.style.display = "none";

  for (const sc of list) {
    scenesListEl.appendChild(renderSceneCard(sc));
  }
  updateScenesBadge();
}

function renderSceneCard(sc) {
  const stats = sceneStats(sc);
  const card = document.createElement("div");
  card.className = "scene-card " + (sc.status || "draft");

  // Icon
  const iconWrap = document.createElement("div");
  iconWrap.className = "scene-card-icon";
  iconWrap.innerHTML = '<span class="material-symbols-outlined">forum</span>';
  card.appendChild(iconWrap);

  // Body
  const body = document.createElement("div");
  body.className = "scene-card-body";
  const title = document.createElement("h3");
  title.className = "scene-card-title";
  title.textContent = sc.title || "(Ohne Titel)";
  body.appendChild(title);
  if (sc.setting) {
    const setting = document.createElement("p");
    setting.className = "scene-card-setting";
    setting.textContent = sc.setting;
    body.appendChild(setting);
  }
  const meta = document.createElement("div");
  meta.className = "scene-card-meta";
  const parts = [];
  parts.push(stats.sentenceCount + " Sätze");
  parts.push(stats.runs + " Runs");
  if (stats.lastPracticedAgo) parts.push("zuletzt " + stats.lastPracticedAgo);
  meta.innerHTML = parts.join('<span class="dot">·</span>');
  body.appendChild(meta);
  // Progress-Bar
  const progress = document.createElement("div");
  progress.className = "scene-card-progress";
  const fill = document.createElement("div");
  fill.className = "scene-card-progress-fill";
  fill.style.width = Math.round(stats.avgProgress * 100) + "%";
  progress.appendChild(fill);
  body.appendChild(progress);
  card.appendChild(body);

  // Right: Status-Pill
  const right = document.createElement("div");
  right.className = "scene-card-right";
  const pill = document.createElement("span");
  pill.className = "scene-status-pill " + (sc.status || "draft");
  const STATUS_LABELS = { draft: "Draft", active: "Aktiv", mastered: "Beherrscht", archived: "Archiv" };
  pill.textContent = STATUS_LABELS[sc.status] || sc.status || "Draft";
  right.appendChild(pill);
  card.appendChild(right);

  // Klick → v1-Stub-Toast (Detail-Page kommt in Phase 4)
  card.onclick = function () {
    showToast("Szenen-Detail-Page kommt in der nächsten Phase. Aktuell: „" + sc.title + "“ mit " + stats.sentenceCount + " Sätzen.", 4000);
  };

  return card;
}

// ============================================================
//   SZENEN-IMPORT-PAGE (Phase 2, Refactor von Modal zu Page)
// ============================================================
// Eigene Vollbild-Page (body.scene-import). Vorher war das ein <dialog>,
// aber bei vielen Sätzen + Footer wurde der Submit-Button unten abgeschnitten
// und die Sätze-Liste hatte nur winzigen internen Scroll. Page-Layout löst
// beides: ganze Page scrollt mit Browser-Scrollbar, Submit-Knopf oben rechts
// IMMER sichtbar.
const sceneImportPageEl = document.getElementById("scene-import-page");
const sceneImportBackBtn = document.getElementById("scene-import-back-btn");
const sceneImportSubmitTopBtn = document.getElementById("scene-import-submit-top");
const sceneImportSubmitTopLabel = document.getElementById("scene-import-submit-top-label");
const sceneImportCancelBtn = document.getElementById("scene-import-cancel");
const sceneImportSubmitBtn = document.getElementById("scene-import-submit");
const sceneImportTitleEl = document.getElementById("scene-import-title");
const sceneImportSettingEl = document.getElementById("scene-import-setting");
const sceneImportRolesEl = document.getElementById("scene-import-roles");
const sceneImportRoleInputEl = document.getElementById("scene-import-role-input");
const sceneImportRoleAddBtn = document.getElementById("scene-import-role-add-btn");
const sceneImportTsvEl = document.getElementById("scene-import-tsv");
const sceneImportParseBtn = document.getElementById("scene-import-parse-btn");
const sceneImportParseStatusEl = document.getElementById("scene-import-parse-status");
const sceneImportSentencesEl = document.getElementById("scene-import-sentences");
const sceneImportCountHintEl = document.getElementById("scene-import-count-hint");
const sceneImportAudioEl = document.getElementById("scene-import-audio");
const sceneImportFlatEl = document.getElementById("scene-import-flat");

// State des Imports — lebt nur für die Page-Session
const _sceneImport = {
  roles: [],         // ["self", "maria"]
  parsedRows: [],    // [{ role, de, es, status, error? }]
};

let _modeBeforeSceneImport = null;
function openSceneImportPage() {
  if (!sceneImportPageEl) return;
  _modeBeforeSceneImport = document.body.classList.contains("scenes") ? "scenes" : "listen";
  // Reset State
  _sceneImport.roles = ["self"];
  _sceneImport.parsedRows = [];
  if (sceneImportTitleEl) sceneImportTitleEl.value = "";
  if (sceneImportSettingEl) sceneImportSettingEl.value = "";
  if (sceneImportTsvEl) sceneImportTsvEl.value = "";
  if (sceneImportAudioEl) sceneImportAudioEl.checked = false;
  if (sceneImportFlatEl) sceneImportFlatEl.checked = false;
  if (sceneImportParseStatusEl) sceneImportParseStatusEl.textContent = "Noch kein TSV-Inhalt geparsed.";
  renderImportRoles();
  renderImportSentences();
  updateImportSubmitState();
  // Page-Klassen swap
  document.body.classList.remove("focus");
  document.body.classList.remove("recall");
  document.body.classList.remove("new-sentence");
  document.body.classList.remove("saetze");
  document.body.classList.remove("stats");
  document.body.classList.remove("settings");
  document.body.classList.remove("scenes");
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  document.body.classList.add("scene-import");
  closeSidePanel();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function closeSceneImportPage() {
  document.body.classList.remove("scene-import");
  if (_modeBeforeSceneImport === "scenes") {
    document.body.classList.add("scenes");
    renderScenesPage();
  }
  _modeBeforeSceneImport = null;
}
// Legacy-Alias damit alte JS-Pfade weiter funktionieren (siehe submit-Handler)
function closeSceneImportDialog() { closeSceneImportPage(); }
function openSceneImportDialog() { openSceneImportPage(); }

if (scenesImportCtaEl) scenesImportCtaEl.onclick = openSceneImportPage;
if (scenesImportCtaEmptyEl) scenesImportCtaEmptyEl.onclick = openSceneImportPage;
if (sceneImportBackBtn) sceneImportBackBtn.onclick = function () {
  // Wenn schon was getippt wurde: nachfragen
  const dirty = (sceneImportTitleEl && sceneImportTitleEl.value.trim()) ||
    (sceneImportTsvEl && sceneImportTsvEl.value.trim());
  if (dirty && !confirm("Eingaben verwerfen und zurück?")) return;
  closeSceneImportPage();
};
if (sceneImportCancelBtn) sceneImportCancelBtn.onclick = function () {
  const dirty = (sceneImportTitleEl && sceneImportTitleEl.value.trim()) ||
    (sceneImportTsvEl && sceneImportTsvEl.value.trim());
  if (dirty && !confirm("Eingaben verwerfen und zurück?")) return;
  closeSceneImportPage();
};

// ----- Rollen-Verwaltung -----
function renderImportRoles() {
  if (!sceneImportRolesEl) return;
  sceneImportRolesEl.innerHTML = "";
  for (const role of _sceneImport.roles) {
    const pill = document.createElement("span");
    pill.className = "scene-import-role-pill";
    const txt = document.createElement("span");
    txt.textContent = role;
    pill.appendChild(txt);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Rolle entfernen";
    remove.textContent = "×";
    remove.onclick = function () {
      _sceneImport.roles = _sceneImport.roles.filter(function (r) { return r !== role; });
      renderImportRoles();
      renderImportSentences();
    };
    pill.appendChild(remove);
    sceneImportRolesEl.appendChild(pill);
  }
}
function addImportRole(name) {
  const norm = (name || "").trim().toLowerCase();
  if (!norm) return;
  if (_sceneImport.roles.indexOf(norm) >= 0) return;
  _sceneImport.roles.push(norm);
  renderImportRoles();
  renderImportSentences();
}
if (sceneImportRoleAddBtn) sceneImportRoleAddBtn.onclick = function () {
  const val = sceneImportRoleInputEl ? sceneImportRoleInputEl.value : "";
  addImportRole(val);
  if (sceneImportRoleInputEl) sceneImportRoleInputEl.value = "";
};
if (sceneImportRoleInputEl) sceneImportRoleInputEl.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    addImportRole(sceneImportRoleInputEl.value);
    sceneImportRoleInputEl.value = "";
  }
});

// ----- TSV-Parser -----
// Akzeptiert:
//   - Code-Block-Backticks (```) am Anfang/Ende werden gestrippt
//   - Optionaler Auswertungs-Header (=== AUSWERTUNG ===, [SZENE], Titel:, Setting:, Rollen:)
//     wird erkannt und die Header-Felder im Modal werden vorbefüllt
//   - Jede Daten-Zeile: rolle<TAB>DE<TAB>ES
//     Toleriert auch 2+ Spaces als Trenner und "|" als Pipe-Trenner
//   - Leerzeilen / Kommentar-Zeilen (#…) werden übersprungen
// Output: { headerTitle, headerSetting, headerRoles, rows: [{role, de, es, error?}] }
function parseSceneTSV(text) {
  if (!text) return { rows: [] };
  // Strippen
  let s = String(text);
  s = s.replace(/^```[a-z]*\n/i, "").replace(/\n```\s*$/, "");
  const lines = s.split(/\r?\n/);
  const result = { rows: [] };
  let inHeader = false;
  let sceneBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    // Header-Marker erkennen
    if (/^={2,}\s*AUSWERTUNG\s*={2,}$/i.test(line)) { inHeader = true; continue; }
    if (/^\[SZENE\]$/i.test(line)) { inHeader = true; sceneBlock = true; continue; }
    if (/^\[SAETZE\]$/i.test(line) || /^\[SÄTZE\]$/i.test(line)) { sceneBlock = false; continue; }
    if (line.startsWith("#")) continue;

    if (inHeader && sceneBlock) {
      // Key: Value Zeilen
      const m = line.match(/^(Titel|Setting|Rollen|Participants)\s*:\s*(.+)$/i);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === "titel") result.headerTitle = val;
        else if (key === "setting") result.headerSetting = val;
        else if (key === "rollen" || key === "participants") {
          result.headerRoles = val.split(/[,;]/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
        }
        continue;
      }
      // Trennlinie zwischen Header und Sätzen
      if (/^---+$/.test(line)) { sceneBlock = false; continue; }
    }

    // Daten-Zeile: erst Tab, dann 2+-Spaces, dann Pipe als Trenner
    let parts;
    if (line.indexOf("\t") >= 0) {
      parts = line.split(/\t+/);
    } else if (/\|\s*/.test(line) && line.split(/\s*\|\s*/).length >= 3) {
      parts = line.split(/\s*\|\s*/);
    } else if (/ {2,}/.test(line)) {
      parts = line.split(/ {2,}/);
    } else {
      // Vielleicht ein Header-Hinweis im Mini-Format — als Fehler-Row
      result.rows.push({ role: "self", de: line, es: "", error: "Konnte Zeile nicht parsen (kein Tab/Pipe/2+Spaces als Trenner)" });
      continue;
    }
    parts = parts.map(function (p) { return p.trim(); });
    let role = "self", de = "", es = "";
    if (parts.length >= 3) {
      role = parts[0].toLowerCase() || "self";
      de = parts[1] || "";
      es = parts[2] || "";
    } else if (parts.length === 2) {
      // Annahme: DE, ES (keine Rolle)
      de = parts[0] || "";
      es = parts[1] || "";
    } else {
      result.rows.push({ role: "self", de: line, es: "", error: "Nur ein Feld — nicht genug für eine Karte" });
      continue;
    }
    if (!de && !es) continue;
    result.rows.push({ role: role, de: de, es: es });
  }
  return result;
}

function _parseAndPopulate() {
  const text = sceneImportTsvEl ? sceneImportTsvEl.value : "";
  const parsed = parseSceneTSV(text);

  // Header-Felder befüllen, falls geparsed und Felder leer
  if (parsed.headerTitle && sceneImportTitleEl && !sceneImportTitleEl.value.trim()) {
    sceneImportTitleEl.value = parsed.headerTitle;
  }
  if (parsed.headerSetting && sceneImportSettingEl && !sceneImportSettingEl.value.trim()) {
    sceneImportSettingEl.value = parsed.headerSetting;
  }
  if (parsed.headerRoles && parsed.headerRoles.length > 0) {
    for (const r of parsed.headerRoles) addImportRole(r);
  }
  // Status: bisher unbekannte Rollen in der TSV automatisch hinzufügen
  for (const row of parsed.rows) {
    if (row.role && _sceneImport.roles.indexOf(row.role) < 0) {
      _sceneImport.roles.push(row.role);
    }
  }
  renderImportRoles();

  // Rows ins State, jede default-status "card_and_scene"
  _sceneImport.parsedRows = parsed.rows.map(function (r) {
    return {
      role: r.role || "self",
      de: r.de,
      es: r.es,
      status: r.error ? "skip" : "card_and_scene",
      error: r.error || null,
    };
  });

  const validCount = _sceneImport.parsedRows.filter(function (r) { return !r.error; }).length;
  const errCount = _sceneImport.parsedRows.length - validCount;
  if (sceneImportParseStatusEl) {
    if (_sceneImport.parsedRows.length === 0) {
      sceneImportParseStatusEl.textContent = "Keine parsbare Zeile gefunden.";
    } else {
      sceneImportParseStatusEl.textContent = validCount + " Zeilen erkannt"
        + (errCount > 0 ? " · " + errCount + " mit Fehler" : "");
    }
  }
  renderImportSentences();
  updateImportSubmitState();
}
if (sceneImportParseBtn) sceneImportParseBtn.onclick = _parseAndPopulate;
// Auto-Parse on paste
if (sceneImportTsvEl) sceneImportTsvEl.addEventListener("paste", function () {
  // Kurz warten bis paste applied ist
  setTimeout(_parseAndPopulate, 30);
});

// ----- Sätze-Liste rendern -----
function renderImportSentences() {
  if (!sceneImportSentencesEl) return;
  sceneImportSentencesEl.innerHTML = "";
  if (_sceneImport.parsedRows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "scene-import-empty";
    empty.textContent = "Vorschau erscheint hier, sobald TSV eingefügt ist.";
    sceneImportSentencesEl.appendChild(empty);
    if (sceneImportCountHintEl) sceneImportCountHintEl.textContent = "— ausgewählt";
    return;
  }
  // Roles ggf. um "self" ergänzen falls leer
  if (_sceneImport.roles.length === 0) {
    _sceneImport.roles.push("self");
    renderImportRoles();
  }
  _sceneImport.parsedRows.forEach(function (row, idx) {
    sceneImportSentencesEl.appendChild(renderImportRow(row, idx));
  });
  const selected = _sceneImport.parsedRows.filter(function (r) {
    return r.status !== "skip" && !r.error;
  }).length;
  if (sceneImportCountHintEl) {
    sceneImportCountHintEl.textContent = selected + " von " + _sceneImport.parsedRows.length + " ausgewählt";
  }
}

function renderImportRow(row, idx) {
  const el = document.createElement("div");
  el.className = "scene-import-row";
  if (row.status === "skip") el.classList.add("skip");
  if (row.error) el.classList.add("error");

  // Status-Toggle: card_and_scene | scene_only | skip
  const status = document.createElement("div");
  status.className = "scene-import-row-status";
  const opts = [
    { key: "card_and_scene", label: "Karte+Szene", title: "Als Karte (mit Audio & SRS) und Teil der Szene" },
    { key: "scene_only", label: "Nur Szene", title: "Nur in der Szene sichtbar, NICHT in den normalen Üben-Pools (z.B. other-Linien)" },
    { key: "skip", label: "Weglassen", title: "Diese Zeile gar nicht importieren" },
  ];
  for (const opt of opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.label;
    b.title = opt.title;
    if (row.status === opt.key) b.classList.add("active");
    b.onclick = function () {
      _sceneImport.parsedRows[idx].status = opt.key;
      renderImportSentences();
      updateImportSubmitState();
    };
    status.appendChild(b);
  }
  el.appendChild(status);

  // Rolle-Dropdown
  const roleWrap = document.createElement("div");
  roleWrap.className = "scene-import-row-role";
  const sel = document.createElement("select");
  for (const role of _sceneImport.roles) {
    const opt = document.createElement("option");
    opt.value = role;
    opt.textContent = role;
    if (role === row.role) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = function () { _sceneImport.parsedRows[idx].role = sel.value; };
  roleWrap.appendChild(sel);
  el.appendChild(roleWrap);

  // Text (DE+ES editierbar)
  const text = document.createElement("div");
  text.className = "scene-import-row-text";
  const deInput = document.createElement("input");
  deInput.type = "text";
  deInput.className = "de";
  deInput.value = row.de || "";
  deInput.placeholder = "Deutsch";
  deInput.oninput = function () { _sceneImport.parsedRows[idx].de = deInput.value; };
  text.appendChild(deInput);
  const esInput = document.createElement("input");
  esInput.type = "text";
  esInput.className = "es";
  esInput.value = row.es || "";
  esInput.placeholder = "Español";
  esInput.oninput = function () { _sceneImport.parsedRows[idx].es = esInput.value; };
  text.appendChild(esInput);
  if (row.error) {
    const err = document.createElement("div");
    err.className = "scene-import-row-error-msg";
    err.textContent = row.error;
    text.appendChild(err);
  }
  el.appendChild(text);

  return el;
}

function updateImportSubmitState() {
  if (!sceneImportSubmitBtn) return;
  const title = sceneImportTitleEl ? sceneImportTitleEl.value.trim() : "";
  const selected = _sceneImport.parsedRows.filter(function (r) {
    return r.status !== "skip" && !r.error && r.de.trim();
  });
  const flat = sceneImportFlatEl && sceneImportFlatEl.checked;
  // Im flachen Modus brauchen wir keinen Title
  const titleOk = flat || title.length > 0;
  const ok = selected.length > 0 && titleOk;
  const label = ok
    ? (flat ? "Sätze importieren (" + selected.length + ")" : "Szene anlegen (" + selected.length + " Sätze)")
    : "Szene anlegen";
  // Bottom-Submit (Footer)
  sceneImportSubmitBtn.disabled = !ok;
  sceneImportSubmitBtn.textContent = label;
  // Top-Submit im Header — kompakter Label aber gleiche Logik
  if (sceneImportSubmitTopBtn) {
    sceneImportSubmitTopBtn.disabled = !ok;
    if (sceneImportSubmitTopLabel) {
      sceneImportSubmitTopLabel.textContent = ok
        ? (flat ? "Importieren (" + selected.length + ")" : "Anlegen (" + selected.length + ")")
        : "Szene anlegen";
    }
  }
}
if (sceneImportTitleEl) sceneImportTitleEl.addEventListener("input", updateImportSubmitState);
if (sceneImportFlatEl) sceneImportFlatEl.addEventListener("change", updateImportSubmitState);
// Top-Submit klickt den Bottom-Submit durch, damit nur ein Handler existiert
if (sceneImportSubmitTopBtn) sceneImportSubmitTopBtn.onclick = function () {
  if (sceneImportSubmitBtn && !sceneImportSubmitBtn.disabled) sceneImportSubmitBtn.click();
};

// ----- Submit -----
if (sceneImportSubmitBtn) sceneImportSubmitBtn.onclick = function () {
  const title = sceneImportTitleEl ? sceneImportTitleEl.value.trim() : "";
  const setting = sceneImportSettingEl ? sceneImportSettingEl.value.trim() : "";
  const participants = _sceneImport.roles.slice();
  const flat = sceneImportFlatEl && sceneImportFlatEl.checked;
  const audio = sceneImportAudioEl && sceneImportAudioEl.checked;

  const usable = _sceneImport.parsedRows.filter(function (r) {
    return r.status !== "skip" && !r.error && r.de.trim();
  });
  if (usable.length === 0) {
    showToast("Keine Sätze zum Importieren.");
    return;
  }
  if (!flat && !title) {
    showToast("Bitte einen Titel angeben (oder „Flach importieren“ aktivieren).");
    if (sceneImportTitleEl) sceneImportTitleEl.focus();
    return;
  }

  let sceneId = null;
  if (!flat) {
    sceneId = addScene({
      title: title,
      setting: setting,
      participants: participants,
      status: "draft",
      source: "conversation",
    });
  }

  const newIds = [];
  const newIdsWithEs = [];
  let orderCounter = 1;
  for (const r of usable) {
    // scene_only-Rows bekommen die Rolle "other", damit sie automatisch
    // aus den normalen SRS-Pools rausfallen (siehe isPracticeable)
    let role = r.role || "self";
    if (r.status === "scene_only" && role === "self") {
      role = "other"; // Default für "Nur Szene"
    }
    const id = addUserSentence({
      de: r.de.trim(),
      es: r.es.trim(),
      cats: [],
      scene_id: sceneId,
      scene_order: sceneId ? orderCounter++ : null,
      scene_role: sceneId ? role : null,
    });
    if (id) {
      newIds.push(id);
      if (r.es && r.es.trim()) newIdsWithEs.push(id);
    }
  }

  // UI-Update
  buildUserSentencesList();
  updatePendingBadge();
  updateProgress();
  if (typeof buildIntroCatSelect === "function") buildIntroCatSelect();
  if (typeof updateIntroModeBtn === "function") updateIntroModeBtn();
  if (typeof updateRecallModeBtn === "function") updateRecallModeBtn();
  renderScenesPage();

  if (flat) {
    showToast(newIds.length + " Sätze importiert.");
  } else {
    showToast("Szene „" + title + "“ angelegt mit " + newIds.length + " Sätzen.");
  }
  closeSceneImportDialog();

  // Audio im Hintergrund erzeugen falls Checkbox aktiv
  if (audio && newIdsWithEs.length > 0 && state.elKey) {
    generateBulkAudios(newIdsWithEs);
  } else if (audio && newIdsWithEs.length > 0 && !state.elKey) {
    showToast("ElevenLabs Key fehlt — Audios nicht generiert.", 4000);
  }
};

// ESC auf der Page → zurück zur Szenen-Liste (mit dirty-Check via Back-Btn)
document.addEventListener("keydown", function (e) {
  if (!document.body.classList.contains("scene-import")) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (sceneImportBackBtn) sceneImportBackBtn.click();
  }
});

// =====================================================================
// SZENEN-DETAIL-PAGE (Phase 4)
// =====================================================================
// Eine Szene als Chat-Bubble-Layout. self-Bubbles rechts mit teal-Akzent
// + Stars + SRS-Status-Pill, other-Bubbles links neutral ohne Rating.
// Edit-Modus erlaubt Titel/Setting/Sätze + scene_role-Toggle, KEIN Reorder
// in v1.

const scenesDetailPage = document.getElementById("scene-detail-page");
const sceneDetailBackBtn = document.getElementById("scene-detail-back-btn");
const sceneDetailTitleEl = document.getElementById("scene-detail-title");
const sceneDetailSettingEl = document.getElementById("scene-detail-setting");
const sceneDetailParticipantsEl = document.getElementById("scene-detail-participants");
const sceneDetailBubblesEl = document.getElementById("scene-detail-bubbles");
const sceneDetailFooterEl = document.getElementById("scene-detail-footer");
const sceneDetailPracticeBtn = document.getElementById("scene-detail-practice-btn");
const sceneDetailExtendBtn = document.getElementById("scene-detail-extend-btn");
const sceneDetailMenuBtn = document.getElementById("scene-detail-menu-btn");
const sceneDetailMenuEl = document.getElementById("scene-detail-menu");
const sceneDetailEditBtn = document.getElementById("scene-detail-edit-btn");
const sceneDetailArchiveBtn = document.getElementById("scene-detail-archive-btn");
const sceneDetailArchiveLabel = document.getElementById("scene-detail-archive-label");
const sceneDetailDeleteBtn = document.getElementById("scene-detail-delete-btn");
const sceneDetailEditBannerEl = document.getElementById("scene-detail-edit-banner");
const sceneDetailEditCancelBtn = document.getElementById("scene-detail-edit-cancel");
const sceneDetailEditSaveBtn = document.getElementById("scene-detail-edit-save");

// Welche Szene aktuell offen ist + ob Edit-Modus aktiv
state.openSceneId = null;
state.sceneEditing = false;
// Pending Edits: { title, setting, sentences: {[id]: {de, es, scene_role}} }
state.sceneEditBuffer = null;
let _modeBeforeSceneDetail = null;

function openSceneDetailPage(sceneId) {
  const sc = getSceneById(sceneId);
  if (!sc) {
    showToast("Szene nicht gefunden.");
    return;
  }
  _modeBeforeSceneDetail = document.body.classList.contains("scenes") ? "scenes" : "listen";
  state.openSceneId = sceneId;
  state.sceneEditing = false;
  state.sceneEditBuffer = null;
  document.body.classList.remove("focus");
  document.body.classList.remove("recall");
  document.body.classList.remove("new-sentence");
  document.body.classList.remove("saetze");
  document.body.classList.remove("stats");
  document.body.classList.remove("settings");
  document.body.classList.remove("scenes");
  document.body.classList.remove("editing");
  document.body.classList.add("scene-detail");
  closeSidePanel();
  if (sceneDetailMenuEl) sceneDetailMenuEl.classList.remove("open");
  renderSceneDetailPage();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function closeSceneDetailPage() {
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("editing");
  state.openSceneId = null;
  state.sceneEditing = false;
  state.sceneEditBuffer = null;
  if (sceneDetailMenuEl) sceneDetailMenuEl.classList.remove("open");
  if (_modeBeforeSceneDetail === "scenes") {
    // Zurück zur Szenen-Liste
    document.body.classList.add("scenes");
    renderScenesPage();
  }
  _modeBeforeSceneDetail = null;
}
if (sceneDetailBackBtn) sceneDetailBackBtn.onclick = function () {
  if (state.sceneEditing) {
    if (!confirm("Bearbeitung verwerfen?")) return;
  }
  closeSceneDetailPage();
};

// SRS-Status-Pill-Text + Klasse für eine self-Karte
function sceneSrsPillFor(id) {
  const r = getRating(id);
  if (r === "learned") return { text: "Gelernt", cls: "learned" };
  const cs = state.cardState[id];
  if (!cs || !cs.due_at) {
    if (!r) return { text: "Neu", cls: "fresh" };
    return { text: "Nicht terminiert", cls: "fresh" };
  }
  const today = isoToday();
  if (cs.due_at <= today) return { text: "Heute fällig", cls: "due" };
  if (cs.due_at === isoAddDays(today, 1)) return { text: "Morgen fällig", cls: "" };
  // In N Tagen
  const t = new Date(today + "T00:00:00").getTime();
  const dt = new Date(cs.due_at + "T00:00:00").getTime();
  const days = Math.max(0, Math.round((dt - t) / (1000 * 60 * 60 * 24)));
  return { text: "in " + days + " Tagen", cls: "" };
}

// Sterne-SVG-Render für die Bubble-Meta (3 Sterne + optional Gehirn)
function sceneStarsHtml(id) {
  const r = getRating(id);
  if (r === "learned") {
    return '<span class="scene-bubble-stars" title="Gelernt"><svg class="filled learned" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg></span>';
  }
  const filled = (typeof r === "number" || typeof r === "string") ? parseInt(r) : 0;
  let html = '<span class="scene-bubble-stars">';
  for (let i = 1; i <= 3; i++) {
    const cls = (i <= filled) ? ' class="filled"' : "";
    html += '<svg' + cls + ' viewBox="0 0 24 24" fill="' + (i <= filled ? "currentColor" : "none") + '" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
  }
  html += '</span>';
  return html;
}

function renderSceneDetailPage() {
  if (!state.openSceneId) return;
  const sc = getSceneById(state.openSceneId);
  if (!sc) { closeSceneDetailPage(); return; }

  // Edit-Buffer initialisieren, falls noch nicht gesetzt
  if (state.sceneEditing && !state.sceneEditBuffer) {
    const sentences = state.userSentences.filter(function (s) { return s.scene_id === sc.id; });
    state.sceneEditBuffer = {
      title: sc.title || "",
      setting: sc.setting || "",
      sentences: {},
    };
    for (const s of sentences) {
      state.sceneEditBuffer.sentences[s.id] = {
        de: s.de || "",
        es: s.es || "",
        scene_role: s.scene_role || "self",
      };
    }
  }

  // Header
  if (sceneDetailTitleEl) {
    if (state.sceneEditing) {
      sceneDetailTitleEl.innerHTML = "";
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.sceneEditBuffer.title;
      input.placeholder = "Szenen-Titel";
      input.oninput = function () { state.sceneEditBuffer.title = input.value; };
      sceneDetailTitleEl.appendChild(input);
    } else {
      sceneDetailTitleEl.textContent = sc.title || "(Ohne Titel)";
    }
  }
  if (sceneDetailSettingEl) {
    if (state.sceneEditing) {
      sceneDetailSettingEl.innerHTML = "";
      const ta = document.createElement("textarea");
      ta.value = state.sceneEditBuffer.setting;
      ta.placeholder = "Setting (1–2 Zeilen Kontext)";
      ta.rows = 2;
      ta.oninput = function () { state.sceneEditBuffer.setting = ta.value; };
      sceneDetailSettingEl.appendChild(ta);
    } else {
      sceneDetailSettingEl.textContent = sc.setting || "";
    }
  }
  if (sceneDetailParticipantsEl) {
    sceneDetailParticipantsEl.innerHTML = "";
    for (const p of (sc.participants || [])) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = p;
      sceneDetailParticipantsEl.appendChild(pill);
    }
  }

  // Archive-Label dynamisch
  if (sceneDetailArchiveLabel) {
    sceneDetailArchiveLabel.textContent = sc.status === "archived" ? "Wiederherstellen" : "Archivieren";
  }

  // Edit-Banner
  if (sceneDetailEditBannerEl) {
    sceneDetailEditBannerEl.style.display = state.sceneEditing ? "flex" : "none";
  }
  document.body.classList.toggle("editing", !!state.sceneEditing);

  // Bubbles
  if (sceneDetailBubblesEl) {
    sceneDetailBubblesEl.innerHTML = "";
    const sentences = state.userSentences
      .filter(function (s) { return s.scene_id === sc.id; })
      .sort(function (a, b) { return (a.scene_order || 0) - (b.scene_order || 0); });
    if (sentences.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "text-align:center; color:var(--outline); padding:30px 12px; font-style:italic;";
      empty.textContent = "Diese Szene hat noch keine Sätze.";
      sceneDetailBubblesEl.appendChild(empty);
    } else {
      for (const s of sentences) {
        sceneDetailBubblesEl.appendChild(renderSceneBubble(s));
      }
    }
  }

  // Footer
  if (sceneDetailFooterEl) {
    const stats = sceneStats(sc);
    const parts = [];
    parts.push(stats.sentenceCount + " Sätze");
    parts.push(stats.runs + " Runs");
    if (stats.lastPracticedAgo) parts.push("zuletzt " + stats.lastPracticedAgo);
    const STATUS_LABELS = { draft: "Draft", active: "Aktiv", mastered: "Beherrscht", archived: "Archiv" };
    parts.push('Status: <span class="status-pill">' + (STATUS_LABELS[sc.status] || sc.status) + '</span>');
    sceneDetailFooterEl.innerHTML = parts.join('<span class="dot">·</span>');
  }

  // Practice-Button: disabled wenn keine Sätze oder editing
  if (sceneDetailPracticeBtn) {
    const stats = sceneStats(sc);
    sceneDetailPracticeBtn.disabled = state.sceneEditing || stats.sentenceCount === 0;
  }
}

function renderSceneBubble(s) {
  const isOther = (s.scene_role === "other");
  const editing = !!state.sceneEditing;
  const bubble = document.createElement("div");
  bubble.className = "scene-bubble " + (isOther ? "other" : "self");

  // Rolle-Tag (nur für other oder editing-Mode für jede Bubble)
  if (isOther || editing) {
    const role = document.createElement("div");
    role.className = "scene-bubble-role";
    role.textContent = s.scene_role || "self";
    bubble.appendChild(role);
  }

  const body = document.createElement("div");
  body.className = "scene-bubble-body";

  if (editing) {
    const buf = state.sceneEditBuffer.sentences[s.id];
    const editRow = document.createElement("div");
    editRow.className = "scene-bubble-edit-row";
    const esInput = document.createElement("input");
    esInput.className = "es";
    esInput.type = "text";
    esInput.value = buf.es;
    esInput.placeholder = "Español";
    esInput.oninput = function () { buf.es = esInput.value; };
    editRow.appendChild(esInput);
    const deInput = document.createElement("input");
    deInput.className = "de";
    deInput.type = "text";
    deInput.value = buf.de;
    deInput.placeholder = "Deutsch";
    deInput.oninput = function () { buf.de = deInput.value; };
    editRow.appendChild(deInput);
    // Rolle-Toggle
    const toggle = document.createElement("div");
    toggle.className = "scene-bubble-role-toggle";
    const selfBtn = document.createElement("button");
    selfBtn.type = "button";
    selfBtn.textContent = "self";
    selfBtn.className = (buf.scene_role !== "other") ? "active" : "";
    const otherBtn = document.createElement("button");
    otherBtn.type = "button";
    otherBtn.textContent = "other";
    otherBtn.className = (buf.scene_role === "other") ? "active" : "";
    selfBtn.onclick = function () {
      buf.scene_role = "self";
      selfBtn.classList.add("active");
      otherBtn.classList.remove("active");
    };
    otherBtn.onclick = function () {
      buf.scene_role = "other";
      otherBtn.classList.add("active");
      selfBtn.classList.remove("active");
    };
    toggle.appendChild(selfBtn);
    toggle.appendChild(otherBtn);
    editRow.appendChild(toggle);
    // Papierkorb — nur im Edit-Modus, löscht die Karte dauerhaft aus der Szene
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "scene-bubble-delete";
    delBtn.title = "Karte aus Szene löschen";
    delBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">delete</span>';
    delBtn.onclick = function () { deleteSceneSentence(s.id); };
    editRow.appendChild(delBtn);
    body.appendChild(editRow);
  } else {
    // ES + DE
    const es = document.createElement("p");
    es.className = "es" + (s.pending ? " pending" : "");
    es.textContent = s.pending ? "(Übersetzung ausstehend)" : (s.es || "—");
    body.appendChild(es);
    if (s.de) {
      const de = document.createElement("p");
      de.className = "de";
      de.textContent = s.de;
      body.appendChild(de);
    }

    // Meta-Zeile (Speaker + Stars + SRS-Pill für self)
    const meta = document.createElement("div");
    meta.className = "scene-bubble-meta";
    // Speaker
    const speaker = document.createElement("button");
    speaker.className = "scene-bubble-speaker";
    speaker.title = "Abspielen";
    const audioReady = hasAudio(s);
    if (!audioReady) {
      speaker.classList.add("loading");
      speaker.title = s.pending ? "Übersetzung fehlt" : "Audio wird erzeugt …";
      speaker.disabled = true;
      speaker.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">hourglass_top</span>';
    } else {
      speaker.innerHTML = '<span class="material-symbols-outlined fill" style="font-size:16px;">volume_up</span>';
      speaker.onclick = function () { playSaetzeAudio(s); };
    }
    meta.appendChild(speaker);

    if (!isOther) {
      // Bugfix Juni 2026: insertAdjacentHTML statt `innerHTML +=`. Letzteres
      // serialisiert + re-parst ALLE bestehenden Kinder — dabei gehen
      // onclick-PROPERTIES verloren (der Speaker-Button oben war dadurch
      // tot). insertAdjacentHTML hängt nur das neue Fragment an.
      meta.insertAdjacentHTML("beforeend", sceneStarsHtml(s.id));
      // SRS-Pill
      const srs = sceneSrsPillFor(s.id);
      if (srs.text) {
        const pill = document.createElement("span");
        pill.className = "scene-bubble-srs " + (srs.cls || "");
        pill.textContent = srs.text;
        meta.appendChild(pill);
      }
    }
    // Teilen-Button — nur wenn die Karte aus mehreren Sätzen besteht.
    if (sceneSentenceIsSplittable(s)) {
      const splitBtn = document.createElement("button");
      splitBtn.type = "button";
      splitBtn.className = "scene-bubble-split";
      splitBtn.title = "In einzelne Sätze aufteilen";
      splitBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px;">call_split</span><span class="scene-bubble-split-label">Teilen</span>';
      splitBtn.onclick = function () { splitSceneSentence(s.id); };
      meta.appendChild(splitBtn);
    }
    body.appendChild(meta);
  }

  bubble.appendChild(body);
  return bubble;
}

// ----- Edit-Modus Toggle -----
function enterSceneEditMode() {
  if (!state.openSceneId) return;
  state.sceneEditing = true;
  state.sceneEditBuffer = null; // wird in renderSceneDetailPage initialisiert
  if (sceneDetailMenuEl) sceneDetailMenuEl.classList.remove("open");
  renderSceneDetailPage();
}
function cancelSceneEdit() {
  state.sceneEditing = false;
  state.sceneEditBuffer = null;
  renderSceneDetailPage();
}
function saveSceneEdit() {
  if (!state.openSceneId || !state.sceneEditBuffer) return;
  const buf = state.sceneEditBuffer;
  // Szene aktualisieren
  updateScene(state.openSceneId, {
    title: buf.title.trim() || "(Ohne Titel)",
    setting: buf.setting.trim(),
  });
  // Sätze aktualisieren
  let touched = 0;
  for (const idStr in buf.sentences) {
    const id = parseInt(idStr);
    const s = getSentenceById(id);
    if (!s) continue;
    const edit = buf.sentences[idStr];
    const newDe = (edit.de || "").trim();
    const newEs = (edit.es || "").trim();
    const newRole = edit.scene_role || "self";
    const changed = s.de !== newDe || s.es !== newEs || s.scene_role !== newRole;
    if (changed) {
      s.de = newDe;
      s.es = newEs;
      s.pending = newEs ? false : true;
      // Wenn self → other gewechselt: aus den SRS-Pools rausnehmen, sonst stage anpassen
      const prevRole = s.scene_role;
      s.scene_role = newRole;
      if (prevRole !== "other" && newRole === "other") {
        // setzt intro_count auf 5 (active=neutral, nicht im SRS)
        setIntroCount(id, 5);
      } else if (prevRole === "other" && newRole !== "other") {
        // wieder in den Einführungs-Backlog
        setIntroCount(id, 0);
      }
      touched++;
    }
  }
  if (touched > 0) saveJSON("hl_user_sentences", state.userSentences);
  state.sceneEditing = false;
  state.sceneEditBuffer = null;
  showToast("Änderungen gespeichert (" + touched + " Sätze).");
  renderSceneDetailPage();
}

// ----- Satz teilen: lange Mehrsatz-Karte in atomare Einzelsatz-Karten zerlegen -----
// Shadowing + Recall brauchen kurze, in einem Atemzug nachsprechbare Einheiten.
// Wir trennen NUR an Satzgrenzen (. ! ?), nie am Komma. Reihenfolge bleibt via
// scene_order erhalten (mehrere Karten gleicher Rolle hintereinander), der Dialog
// liest sich identisch.
// splitIntoSentences() lebt seit Juni 2026 in core.js (testbar).

function sceneSentenceIsSplittable(s) {
  if (!s || !s.scene_id) return false;
  return splitIntoSentences(s.es || s.de || "").length > 1;
}

function splitSceneSentence(id) {
  const s = getSentenceById(id);
  if (!s || !s.scene_id) return;
  const esParts = splitIntoSentences(s.es || "");
  const deParts = splitIntoSentences(s.de || "");
  const n = Math.max(esParts.length, deParts.length);
  if (n < 2) { showToast("Nichts zu teilen — das ist nur ein Satz."); return; }
  if (!confirm(
    "Diesen Satz in " + n + " einzelne Karten aufteilen?\n\n" +
    "Die neuen Karten landen in der Einführung und brauchen neues Audio."
  )) return;

  const mismatch = esParts.length !== deParts.length;
  function partAt(arr, i) { return arr[i] != null ? arr[i] : ""; }

  const sceneId = s.scene_id;
  const baseOrder = (typeof s.scene_order === "number") ? s.scene_order : 0;

  // 1) Originalkarte auf den ERSTEN Teil kürzen
  s.es = partAt(esParts, 0);
  s.de = partAt(deParts, 0) || s.de; // DE nie versehentlich leeren
  s.pending = s.es ? false : true;
  // Audio passt nicht mehr zum gekürzten Text → VOLLSTÄNDIG invalidieren.
  // Bugfix Juni 2026: audio_path="" allein reichte nicht — audioSrcFor()
  // fiel auf den IDB-Cache (userAudioUrls) zurück, die gekürzte Karte
  // spielte weiter das alte Mehrsatz-Audio und hasAudio() blieb true,
  // wodurch der „Audio generieren"-Button gar nicht erst erschien.
  const oldAudioPath = s.audio_path || "";
  s.audio_path = "";
  s.audio = "";
  deleteAudioFromIDB(s.id);
  if (oldAudioPath && currentUser) {
    sb.storage.from("audios").remove([oldAudioPath]).then(function (res) {
      if (res && res.error) console.warn("Storage delete failed for", oldAudioPath, res.error);
    }).catch(function (e) { console.warn("Storage delete error:", e); });
  }

  // 2) Restliche Teile als neue Karten anlegen, direkt nach dem Original
  for (let i = 1; i < n; i++) {
    const de = partAt(deParts, i);
    const es = partAt(esParts, i);
    addUserSentence({
      de: de || "(Deutsch ergänzen)",
      es: es,
      cats: s.cats,
      scene_id: sceneId,
      scene_role: s.scene_role || "self",
      scene_order: baseOrder + i * 0.001, // sortiert direkt nach dem Original; gleich renummeriert
    });
  }

  // 3) scene_order der ganzen Szene sauber als Integer durchnummerieren
  const all = state.userSentences
    .filter(function (x) { return x.scene_id === sceneId; })
    .sort(function (a, b) {
      return (a.scene_order || 0) - (b.scene_order || 0) || a.id - b.id;
    });
  all.forEach(function (x, i) { x.scene_order = i; });

  saveJSON("hl_user_sentences", state.userSentences); // triggert Cloud-Push

  if (mismatch) {
    showToast("Geteilt — DE und ES hatten unterschiedlich viele Sätze. Bitte Deutsch auf den neuen Karten prüfen.", 5000);
  } else {
    showToast("In " + n + " Karten geteilt.");
  }
  renderSceneDetailPage();
  if (typeof updateProgress === "function") updateProgress();
}

// ----- Karte aus Szene löschen (nur im Edit-Modus erreichbar) -----
// Dauerhaft, weil archivierte Karten weiterhin als Bubble in der Szene
// sichtbar bleiben — zum Aufräumen schlechter Karten ist „weg" gewünscht.
// Reuse von permanentDeleteUserSentence (räumt Ratings/Audio/Badges auf).
function deleteSceneSentence(id) {
  const s = getSentenceById(id);
  if (!s || !s.scene_id) return;
  const preview = (s.es || s.de || "").slice(0, 50);
  if (!confirm("Diese Karte dauerhaft aus der Szene löschen?\n\n„" + preview + "…“")) return;
  const sceneId = s.scene_id;
  permanentDeleteUserSentence(id, true); // silent=true → eigener kurzer Toast
  // Aus dem Edit-Buffer entfernen, damit saveSceneEdit sie nicht mehr anfasst
  if (state.sceneEditBuffer && state.sceneEditBuffer.sentences) {
    delete state.sceneEditBuffer.sentences[id];
  }
  // scene_order der verbleibenden Karten sauber als Integer neu durchnummerieren
  const all = state.userSentences
    .filter(function (x) { return x.scene_id === sceneId; })
    .sort(function (a, b) {
      return (a.scene_order || 0) - (b.scene_order || 0) || a.id - b.id;
    });
  all.forEach(function (x, i) { x.scene_order = i; });
  saveJSON("hl_user_sentences", state.userSentences); // persistiert scene_order + triggert Push
  renderSceneDetailPage();
}

if (sceneDetailEditBtn) sceneDetailEditBtn.onclick = enterSceneEditMode;
if (sceneDetailEditCancelBtn) sceneDetailEditCancelBtn.onclick = function () {
  if (!confirm("Bearbeitung verwerfen?")) return;
  cancelSceneEdit();
};
if (sceneDetailEditSaveBtn) sceneDetailEditSaveBtn.onclick = saveSceneEdit;

// ----- Menü-Toggle (Klick außerhalb schließt) -----
if (sceneDetailMenuBtn) sceneDetailMenuBtn.onclick = function (e) {
  e.stopPropagation();
  if (sceneDetailMenuEl) sceneDetailMenuEl.classList.toggle("open");
};
document.addEventListener("click", function (e) {
  if (!sceneDetailMenuEl) return;
  if (!sceneDetailMenuEl.contains(e.target) && e.target !== sceneDetailMenuBtn && !sceneDetailMenuBtn.contains(e.target)) {
    sceneDetailMenuEl.classList.remove("open");
  }
});

// ----- Archivieren / Wiederherstellen -----
if (sceneDetailArchiveBtn) sceneDetailArchiveBtn.onclick = function () {
  const sc = getSceneById(state.openSceneId);
  if (!sc) return;
  if (sc.status === "archived") {
    updateScene(sc.id, { status: "active" });
    showToast("Szene wiederhergestellt.");
  } else {
    updateScene(sc.id, { status: "archived" });
    showToast("Szene archiviert.");
  }
  if (sceneDetailMenuEl) sceneDetailMenuEl.classList.remove("open");
  renderSceneDetailPage();
  updateScenesBadge();
};

// ----- Endgültig löschen -----
if (sceneDetailDeleteBtn) sceneDetailDeleteBtn.onclick = function () {
  const sc = getSceneById(state.openSceneId);
  if (!sc) return;
  const stats = sceneStats(sc);
  const msg = "Szene „" + sc.title + "“ endgültig löschen?\n\n" +
    stats.sentenceCount + " Sätze verlieren nur die Szenen-Bindung — die Karten selbst bleiben in „Meine Sätze“.";
  if (!confirm(msg)) return;
  deleteScene(sc.id);
  showToast("Szene gelöscht.");
  closeSceneDetailPage();
};

// ----- Üben-Button (öffnet Practice-Mode) -----
if (sceneDetailPracticeBtn) sceneDetailPracticeBtn.onclick = function () {
  if (!state.openSceneId) return;
  startScenePractice(state.openSceneId);
};

// =====================================================================
// SZENEN-CARD-CLICK in der Liste → Detail-Page öffnen
// =====================================================================
// Override des Stub-Toasts aus Phase 3 — Klick auf Card öffnet jetzt Detail.
// Die existierende renderSceneCard-Funktion in der Scenes-Liste wird hier
// nicht modifiziert (wir wollen die Logik gekapselt halten); stattdessen
// ersetzen wir den onclick-Handler direkt nach dem Re-Render.
// Wir hooken in renderScenesPage via einer Wrapping-Strategie: nach jedem
// Append der Cards re-binden wir die onclick-Handler.
const _originalRenderScenesPage = renderScenesPage;
renderScenesPage = function () {
  _originalRenderScenesPage();
  // Re-bind Klick-Handler auf alle Scene-Cards (statt Stub-Toast → Detail)
  if (scenesListEl) {
    const cards = scenesListEl.querySelectorAll(".scene-card");
    cards.forEach(function (card, idx) {
      // Wir brauchen die scene-ID aus der gefilterten/sortierten Liste, aber
      // _originalRenderScenesPage rendert sie nicht direkt als data-attr.
      // Einfacher Workaround: in renderSceneCard die ID via data-attr setzen.
      const sid = card.getAttribute("data-scene-id");
      if (sid) {
        const sceneId = parseInt(sid, 10);
        card.onclick = function () { openSceneDetailPage(sceneId); };
      }
    });
  }
};
// Patch renderSceneCard: data-scene-id setzen
const _originalRenderSceneCard = renderSceneCard;
renderSceneCard = function (sc) {
  const card = _originalRenderSceneCard(sc);
  card.setAttribute("data-scene-id", sc.id);
  // onclick wird von renderScenesPage (s.o.) gesetzt — den Stub-Toast überschreiben
  card.onclick = function () { openSceneDetailPage(sc.id); };
  return card;
};

// =====================================================================
// SZENEN-ÜBEN-MODUS (Phase 5)
// =====================================================================
// Vollbild-Overlay, läuft sequenziell durch alle Sätze einer Szene.
// self-Karten: DE → Reveal → ES + Audio + SRS-Pill → Weiter
// other-Karten: DE + ES direkt sichtbar, Audio spielt sofort, Weiter
// Am Ende: practice_count++, last_practiced_at=now, intro_count++ für self.
// Status-Übergänge: draft → active (erster Run), → mastered (>=10 runs +
// alle self auf learned).

const scenePracticeOverlay = document.getElementById("scene-practice-overlay");
const scenePracticeCloseBtn = document.getElementById("scene-practice-close-btn");
const scenePracticeTitleEl = document.getElementById("scene-practice-title");
const scenePracticeCounterEl = document.getElementById("scene-practice-counter");
const scenePracticeProgressFillEl = document.getElementById("scene-practice-progress-fill");
const scenePracticeCardViewEl = document.getElementById("scene-practice-card-view");
const scenePracticeSummaryViewEl = document.getElementById("scene-practice-summary-view");
const scenePracticePrevEl = document.getElementById("scene-practice-prev");
const scenePracticeSettingEl = document.getElementById("scene-practice-setting");
const scenePracticeRoleTagEl = document.getElementById("scene-practice-role-tag");
const scenePracticeDeEl = document.getElementById("scene-practice-de");
const scenePracticeRevealBtn = document.getElementById("scene-practice-reveal-btn");
const scenePracticeEsSideEl = document.getElementById("scene-practice-es-side");
const scenePracticeEsEl = document.getElementById("scene-practice-es");
const scenePracticePlayBtn = document.getElementById("scene-practice-play-btn");
const scenePracticeAgainBtn = document.getElementById("scene-practice-again-btn");
const scenePracticeSrsPillEl = document.getElementById("scene-practice-srs-pill");
const scenePracticeNextBtn = document.getElementById("scene-practice-next-btn");
const scenePracticeSummaryTitleEl = document.getElementById("scene-practice-summary-title");
const scenePracticeSummarySubEl = document.getElementById("scene-practice-summary-sub");
const scenePracticeSummaryStatsEl = document.getElementById("scene-practice-summary-stats");
const scenePracticeSummaryAgainBtn = document.getElementById("scene-practice-summary-again");
const scenePracticeSummaryDoneBtn = document.getElementById("scene-practice-summary-done");

// Session-State
state.scenePractice = {
  active: false,
  sceneId: null,
  queue: [],         // Array<sentenceId> in scene_order
  index: 0,
  revealed: false,
};

function startScenePractice(sceneId) {
  const sc = getSceneById(sceneId);
  if (!sc) return;
  const sentences = state.userSentences
    .filter(function (s) { return s.scene_id === sceneId && !s.archived; })
    .sort(function (a, b) { return (a.scene_order || 0) - (b.scene_order || 0); });
  if (sentences.length === 0) {
    showToast("Diese Szene hat keine Sätze zum Üben.");
    return;
  }
  state.scenePractice = {
    active: true,
    sceneId: sceneId,
    queue: sentences.map(function (s) { return s.id; }),
    index: 0,
    revealed: false,
  };
  document.body.classList.add("scene-practice");
  if (scenePracticeSummaryViewEl) scenePracticeSummaryViewEl.style.display = "none";
  if (scenePracticeCardViewEl) scenePracticeCardViewEl.style.display = "flex";
  if (scenePracticeTitleEl) scenePracticeTitleEl.textContent = sc.title || "(Ohne Titel)";
  showScenePracticeCard();
}

function endScenePractice(advance) {
  state.scenePractice.active = false;
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  // Audio stoppen
  try { if (audioEl) { audioEl.pause(); audioEl.src = ""; } } catch (e) {}
  if (advance) renderSceneDetailPage();
}

function showScenePracticeCard() {
  const sp = state.scenePractice;
  if (!sp.active) return;
  if (sp.index >= sp.queue.length) {
    showScenePracticeSummary();
    return;
  }
  const id = sp.queue[sp.index];
  const s = getSentenceById(id);
  if (!s) {
    sp.index++;
    showScenePracticeCard();
    return;
  }
  sp.revealed = false;
  const isOther = (s.scene_role === "other");

  // Header-Counter + Progress
  if (scenePracticeCounterEl) {
    scenePracticeCounterEl.textContent = "Satz " + (sp.index + 1) + " von " + sp.queue.length;
  }
  if (scenePracticeProgressFillEl) {
    scenePracticeProgressFillEl.style.width = (((sp.index) / sp.queue.length) * 100) + "%";
  }

  // Vorherige Karte als Kontext-Hinweis (dezent darüber)
  if (scenePracticePrevEl) {
    if (sp.index > 0) {
      const prevId = sp.queue[sp.index - 1];
      const prev = getSentenceById(prevId);
      if (prev) {
        scenePracticePrevEl.innerHTML = '<span class="prev-role">' + (prev.scene_role || "self") + ':</span> ' +
          '<span class="prev-es">' + escapeHtml(prev.es || "—") + '</span><br>' +
          '<span class="prev-de">' + escapeHtml(prev.de || "") + '</span>';
        scenePracticePrevEl.style.display = "";
      } else {
        scenePracticePrevEl.style.display = "none";
      }
    } else {
      scenePracticePrevEl.style.display = "none";
    }
  }

  // Setting nur auf erster Karte zeigen
  if (scenePracticeSettingEl) {
    const sc = getSceneById(sp.sceneId);
    if (sp.index === 0 && sc && sc.setting) {
      scenePracticeSettingEl.textContent = sc.setting;
      scenePracticeSettingEl.style.display = "";
    } else {
      scenePracticeSettingEl.style.display = "none";
    }
  }

  // Rollen-Tag
  if (scenePracticeRoleTagEl) {
    scenePracticeRoleTagEl.textContent = s.scene_role || "self";
    scenePracticeRoleTagEl.classList.toggle("other", isOther);
  }

  // DE
  if (scenePracticeDeEl) scenePracticeDeEl.textContent = s.de || "—";

  // ES + Reveal/Next-Buttons
  if (isOther) {
    // Other-Karten: ES sofort sichtbar, kein Reveal, Audio auto?
    // Hard UX Rule: KEIN auto-play bei Reveal. Aber other-Karten haben keinen
    // Reveal-Step — sie sind direkt offen. Auto-play wäre hier OK, aber
    // wir bleiben konservativ und lassen den User klicken.
    if (scenePracticeRevealBtn) scenePracticeRevealBtn.style.display = "none";
    if (scenePracticeEsSideEl) scenePracticeEsSideEl.style.display = "";
    if (scenePracticeEsEl) scenePracticeEsEl.textContent = s.es || "—";
    if (scenePracticeSrsPillEl) {
      // other-Karten haben keinen SRS-Status
      scenePracticeSrsPillEl.textContent = "";
      scenePracticeSrsPillEl.className = "scene-practice-srs-pill";
    }
    if (scenePracticeNextBtn) scenePracticeNextBtn.style.display = "";
    sp.revealed = true;
  } else {
    // self-Karten: Reveal-Step
    if (scenePracticeRevealBtn) scenePracticeRevealBtn.style.display = "";
    if (scenePracticeEsSideEl) scenePracticeEsSideEl.style.display = "none";
    if (scenePracticeNextBtn) scenePracticeNextBtn.style.display = "none";
    // ES vorbereiten (wird beim Reveal sichtbar)
    if (scenePracticeEsEl) scenePracticeEsEl.textContent = s.es || "—";
    const srs = sceneSrsPillFor(id);
    if (scenePracticeSrsPillEl) {
      scenePracticeSrsPillEl.textContent = srs.text;
      scenePracticeSrsPillEl.className = "scene-practice-srs-pill " + (srs.cls || "");
    }
  }
}

function revealScenePracticeCard() {
  const sp = state.scenePractice;
  if (!sp.active || sp.revealed) return;
  sp.revealed = true;
  if (scenePracticeRevealBtn) scenePracticeRevealBtn.style.display = "none";
  if (scenePracticeEsSideEl) scenePracticeEsSideEl.style.display = "";
  if (scenePracticeNextBtn) scenePracticeNextBtn.style.display = "";
  // Reveal-Stats analog dem normalen Recall
  if (typeof incrementStat === "function") {
    try {
      const id = sp.queue[sp.index];
      if (!state.revealed.has(id)) {
        state.revealed.add(id);
        incrementStat("reveals");
      }
    } catch (e) { /* nicht-kritisch */ }
  }
}

function playScenePracticeAudio() {
  const sp = state.scenePractice;
  if (!sp.active) return;
  const id = sp.queue[sp.index];
  const s = getSentenceById(id);
  if (!s) return;
  if (!hasAudio(s)) {
    showToast("Kein Audio für diesen Satz.", 2500);
    return;
  }
  playSaetzeAudio(s);
  if (typeof incrementStat === "function") {
    try { incrementStat("plays"); } catch (e) {}
  }
}

function nextScenePracticeCard() {
  const sp = state.scenePractice;
  if (!sp.active) return;
  sp.index++;
  showScenePracticeCard();
}

function showScenePracticeSummary() {
  const sp = state.scenePractice;
  if (!sp.active) return;
  const sc = getSceneById(sp.sceneId);
  if (!sc) { endScenePractice(true); return; }

  // 1) practice_count + last_practiced_at hochzählen
  const newCount = (sc.practice_count || 0) + 1;
  const patch = {
    practice_count: newCount,
    last_practiced_at: new Date().toISOString(),
  };
  // Status-Übergang: draft → active beim ersten Run
  if (sc.status === "draft") patch.status = "active";
  // mastered-Check: >=10 Runs UND alle self-Sätze auf learned
  if (newCount >= 10 && sc.status !== "mastered") {
    const selfSentences = state.userSentences.filter(function (s) {
      return s.scene_id === sc.id && s.scene_role !== "other" && !s.archived;
    });
    const allLearned = selfSentences.length > 0 && selfSentences.every(function (s) {
      return getRating(s.id) === "learned";
    });
    if (allLearned) patch.status = "mastered";
  }
  // Bugfix Juni 2026: Status VOR updateScene sichern — updateScene mutiert
  // `sc` per Object.assign, danach ist sc.status bereits der neue Wert und
  // der „jetzt aktiv"-Vergleich unten war immer false.
  const prevStatus = sc.status;
  updateScene(sc.id, patch);

  // Stats-Counter "scene_runs" für heute inkrementieren — die Stats-Page
  // zeigt das als "heute geübt" an. Wir benutzen incrementStat nicht, weil
  // das eine "non-plays"-Aktivität ist die den Streak zählen darf (also
  // wie "rated" behandelt).
  try {
    const today = isoToday();
    ensureStatsDay(today);
    const day = state.stats.daily[today];
    if (typeof day.scene_runs !== "number") day.scene_runs = 0;
    day.scene_runs += 1;
    const cur = computeStreak();
    if (cur > (state.stats.all_time.longest_streak || 0)) {
      state.stats.all_time.longest_streak = cur;
    }
    saveJSON("hl_stats", state.stats);
  } catch (e) { console.warn("[scenes] stats counter failed:", e); }

  // 2) intro_count++ für alle self-Karten der Szene (NICHT other)
  const selfIds = sp.queue.filter(function (id) {
    const s = getSentenceById(id);
    return s && s.scene_role !== "other";
  });
  let graduated = 0;
  let advanced = 0;
  for (const id of selfIds) {
    const before = getIntroCount(id);
    const after = Math.min(before + 1, 5);
    setIntroCount(id, after);
    if (before < 5 && after >= 5) graduated++;
    else if (after > before) advanced++;
  }

  // 3) Summary-Screen anzeigen
  if (scenePracticeCardViewEl) scenePracticeCardViewEl.style.display = "none";
  if (scenePracticeSummaryViewEl) scenePracticeSummaryViewEl.style.display = "flex";
  if (scenePracticeProgressFillEl) scenePracticeProgressFillEl.style.width = "100%";

  if (scenePracticeSummaryTitleEl) {
    scenePracticeSummaryTitleEl.textContent = "Run " + newCount + " abgeschlossen";
  }
  if (scenePracticeSummarySubEl) {
    let sub = "";
    if (graduated > 0) sub = graduated + " Karte(n) sind jetzt im aktiven Pool.";
    else if (advanced > 0) sub = advanced + " Karte(n) sind eine Einführungs-Stufe weiter.";
    else sub = "Schön — du hast die Szene durchgespielt.";
    // Vergleich gegen prevStatus (Bugfix Juni 2026, siehe oben)
    if (patch.status === "active" && prevStatus === "draft") sub += " Status: jetzt aktiv.";
    if (patch.status === "mastered" && prevStatus !== "mastered") sub += " Szene als beherrscht markiert!";
    scenePracticeSummarySubEl.textContent = sub;
  }
  if (scenePracticeSummaryStatsEl) {
    scenePracticeSummaryStatsEl.innerHTML =
      '<div class="scene-practice-summary-stat"><div class="num">' + newCount + '</div><div class="lbl">Runs</div></div>' +
      '<div class="scene-practice-summary-stat"><div class="num">' + sp.queue.length + '</div><div class="lbl">Sätze</div></div>' +
      '<div class="scene-practice-summary-stat"><div class="num">' + graduated + '</div><div class="lbl">graduiert</div></div>';
  }
  updateScenesBadge();
}

// Buttons
if (scenePracticeCloseBtn) scenePracticeCloseBtn.onclick = function () {
  // Vor Summary: confirm
  const sp = state.scenePractice;
  if (sp.active && sp.index < sp.queue.length) {
    if (!confirm("Session abbrechen? Kein Run-Counter wird hochgezählt.")) return;
  }
  endScenePractice(true);
};
if (scenePracticeRevealBtn) scenePracticeRevealBtn.onclick = revealScenePracticeCard;
if (scenePracticePlayBtn) scenePracticePlayBtn.onclick = playScenePracticeAudio;
if (scenePracticeAgainBtn) scenePracticeAgainBtn.onclick = playScenePracticeAudio;
if (scenePracticeNextBtn) scenePracticeNextBtn.onclick = nextScenePracticeCard;
if (scenePracticeSummaryAgainBtn) scenePracticeSummaryAgainBtn.onclick = function () {
  if (!state.scenePractice.sceneId) return;
  startScenePractice(state.scenePractice.sceneId);
};
if (scenePracticeSummaryDoneBtn) scenePracticeSummaryDoneBtn.onclick = function () {
  endScenePractice(true);
};

// Leertaste = Reveal oder Next
document.addEventListener("keydown", function (e) {
  if (!document.body.classList.contains("scene-practice")) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    const sp = state.scenePractice;
    if (!sp.active) return;
    if (!sp.revealed) revealScenePracticeCard();
    else nextScenePracticeCard();
  } else if (e.key === "Escape") {
    if (state.scenePractice.active) {
      e.preventDefault();
      scenePracticeCloseBtn && scenePracticeCloseBtn.click();
    }
  }
});

// =====================================================================
// PRAXIS-MODI in der Sidebar (Sidebar-Restructure Mai 2026)
// =====================================================================
// Die alten Mode-Buttons leben weiter im DOM (versteckt via CSS), weil ihre
// onclick-Handler durch Wrapper-Funktionen ergänzt werden (intro, focus, car).
// Die Sidebar-Links rufen sie programmatisch via .click() auf — damit alle
// Wrapper sauber durchlaufen, kein duplizierter Cleanup-Code nötig.

const sideIntroLink = document.getElementById("side-intro-link");
const sideCarLink = document.getElementById("side-car-link");
const sideFocusLink = document.getElementById("side-focus-link");
const sideIntroCountBadge = document.getElementById("side-intro-count");
const sideFocusCountBadge = document.getElementById("side-focus-count");

function _closeAllPageOverlays() {
  // Wenn der User aus Saetze/Stats/Settings/New-Sentence in einen Praxis-Modus
  // wechselt, müssen die Page-Klassen weg.
  document.body.classList.remove("saetze");
  document.body.classList.remove("stats");
  document.body.classList.remove("settings");
  document.body.classList.remove("scenes");
  document.body.classList.remove("scene-detail");
  document.body.classList.remove("scene-practice");
  document.body.classList.remove("scene-import");
  document.body.classList.remove("new-sentence");
}

if (sideIntroLink) {
  sideIntroLink.onclick = function () {
    closeSidePanel();
    _closeAllPageOverlays();
    if (introBtn && !introBtn.disabled) introBtn.click();
  };
}
if (sideCarLink) {
  sideCarLink.onclick = function () {
    closeSidePanel();
    _closeAllPageOverlays();
    if (carBtn) carBtn.click();
  };
}
if (sideFocusLink) {
  sideFocusLink.onclick = function () {
    closeSidePanel();
    _closeAllPageOverlays();
    if (focusBtn) focusBtn.click();
  };
}


// Main sort handler
mainSortEl.onchange = function () {
  state.mainSort = mainSortEl.value;
  localStorage.setItem("hl_main_sort", state.mainSort);
  queuePushProfile();
  applyFilter();
};

// ===== Auth =====
function setSyncStatus(state) {
  const el = document.getElementById("sync-indicator");
  if (!el) return;
  el.classList.remove("syncing", "synced", "error");
  if (state) el.classList.add(state);
}

async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session && session.user) {
    currentUser = session.user;
    await onLogin();
  } else {
    showLoginScreen();
  }
  sb.auth.onAuthStateChange(async function (event, session) {
    if (event === "SIGNED_OUT" || !session) {
      currentUser = null;
      document.body.classList.remove("authenticated");
      showLoginScreen();
    } else if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session.user && !currentUser) {
      currentUser = session.user;
      await onLogin();
    }
  });
}

function showLoginScreen() {
  document.body.classList.remove("authenticated");
  const err = document.getElementById("login-error");
  if (err) err.textContent = "";
}

async function onLogin() {
  document.body.classList.add("authenticated");
  // Topbar user menu: email + avatar initial
  const emailText = document.getElementById("user-menu-email-text");
  if (emailText && currentUser && currentUser.email) emailText.textContent = currentUser.email;
  const avatarInitial = document.getElementById("user-avatar-initial");
  if (avatarInitial && currentUser && currentUser.email) {
    avatarInitial.textContent = currentUser.email.charAt(0).toUpperCase();
  }
  // Legacy: side-user-info kept hidden in DOM; populate for back-compat.
  const sideUserInfo = document.getElementById("side-user-info");
  if (sideUserInfo) {
    sideUserInfo.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = currentUser.email + " ";
    const link = document.createElement("span");
    link.className = "logout-link";
    link.textContent = "(Abmelden)";
    link.onclick = signOut;
    sideUserInfo.appendChild(span);
    sideUserInfo.appendChild(link);
  }
  setSyncStatus("syncing");
  try {
    // Bugfix Juni 2026: Lokale Daten VOR dem Pull snapshotten. Vorher las
    // maybeMigrate() aus localStorage — das war zu dem Zeitpunkt aber schon
    // vom Pull mit dem (ggf. leeren) Cloud-Stand überschrieben, d.h. der
    // „lokale Daten in die Cloud heben"-Pfad konnte nie greifen.
    const localSnapshot = {
      ratings: loadJSON("hl_ratings", {}),
      mnemonics: loadJSON("hl_mnemonics", {}),
      sentences: loadJSON("hl_user_sentences", []),
      shownMnemonics: loadJSON("hl_shown_mnemonics", []),
    };
    await pullCloudData();
    await maybeMigrate(localSnapshot);
    await migrateIDBToStorage();
    setSyncStatus("synced");
    showToast("Eingeloggt als " + currentUser.email);
  } catch (e) {
    console.error("Login data pull failed:", e);
    setSyncStatus("error");
    showToast("Cloud-Fehler: " + e.message, 5000);
  }
  // Re-render with cloud data
  buildRatingFilter();
  applyFilter();
  updatePlayer();
  updateProgress();
  updateAutoplayUI();
  buildUserSentencesList();
  updatePendingBadge();
  // Reslice intro pool to max INTRO_POOL_SIZE after cloud data has loaded
  // (overrides the local-only reslicing that ran at init before login).
  try {
    if (typeof maybeReslicePool === "function") maybeReslicePool();
  } catch (e) { console.error("[pullCloudData] maybeReslicePool failed:", e); }
  // Refresh the Einführung dropdown now that user_sentences + intro_counts are loaded
  if (typeof buildIntroCatSelect === "function") buildIntroCatSelect();
  if (typeof updateIntroModeBtn === "function") updateIntroModeBtn();
  // Szenen-Badge aktualisieren nach Pull
  if (typeof updateScenesBadge === "function") updateScenesBadge();
  if (mainSortEl) mainSortEl.value = state.mainSort;
  if (saetzeSortEl) saetzeSortEl.value = state.usSort;
  // Defeat any browser autofill that may have polluted the search box
  state.search = "";
  if (searchInput) searchInput.value = "";
}

async function signOut() {
  await sb.auth.signOut();
  showToast("Abgemeldet.");
}

// Login form handler
document.getElementById("login-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("login-submit");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Anmelden...";
  console.info("[login] signInWithPassword starting…");
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    console.info("[login] signInWithPassword OK, awaiting onAuthStateChange…");
    // onAuthStateChange handles the rest. Aber als Sicherheits-Fallback: wenn das
    // onAuthStateChange-Callback aus irgendwelchen Gründen nicht feuert (iOS PWA
    // Quirks, beobachtet), starten wir onLogin direkt — currentUser ist schon
    // gesetzt via sb.auth.getSession() im nächsten Tick, sonst greifen wir auf
    // data.user zurück.
    setTimeout(function () {
      if (!document.body.classList.contains("authenticated")) {
        console.warn("[login] onAuthStateChange did not fire within 2s — kicking onLogin manually");
        if (!currentUser && data && data.user) currentUser = data.user;
        if (currentUser && typeof onLogin === "function") onLogin();
      }
    }, 2000);
  } catch (err) {
    console.error("[login] failed:", err);
    errEl.textContent = "Login fehlgeschlagen: " + err.message;
    btn.disabled = false;
    btn.textContent = "Anmelden";
  }
});

// ===== Cloud sync =====
// ===== Profil-Merge (Juni 2026) =====
// Kombiniert die Karten-Daten eines Cloud-Profils mit dem lokalen State,
// statt eine Seite blind zu überschreiben. Wird von pullCloudData (Login)
// UND pushProfile (vor jedem Schreiben) benutzt. Damit kann weder ein
// veralteter lokaler Stand die Cloud platttrampeln (Last-Write-Wins) noch
// ein Pull lokale Offline-Änderungen vernichten.
//
// Merge-Regeln pro Datentyp:
// - cardState + ratings: pro Karte gewinnt der neuere last_reviewed_at
//   (Gleichstand/unklar → Cloud). ratings folgen der cardState-Entscheidung,
//   weil beide immer zusammen via scheduleNext() geschrieben werden.
// - introCounts: explizite Einträge gewinnen über fehlende (fehlend = 5 =
//   graduiert); sind beide explizit, gewinnt der höhere Fortschritt. Edge:
//   eine offline graduierte Karte kann einmal extra in der Einführung
//   auftauchen — harmlos.
// - mnemonics: Vereinigungsmenge; bei Konflikt gewinnt Cloud (es gibt keine
//   Timestamps, und Eselsbrücken werden praktisch nur am PC editiert).
// - shownMnemonics: Vereinigungsmenge.
// - stats: pro Tag, pro Metrik Max() (Mai-2026-Verhalten, hierher verschoben).
//
// Bewusste Schwäche: ein explizites LÖSCHEN (z.B. Rating entfernen) auf
// Gerät A kann durch den Merge mit Gerät B wieder auftauchen. Seltener Fall —
// Wiederauferstehung ist das deutlich kleinere Übel als Datenverlust.
function mergeCardData(profile) {
  if (!profile) return;
  const s = profile.settings || {};

  // --- cardState + ratings (Autorität: last_reviewed_at pro Karte) ---
  // Reine Merge-Logik lebt in core.js (mergeCardStateAndRatings) und ist
  // dort durch tests.html abgedeckt. Hier nur State-Anwendung.
  const cloudCardState = (s.card_state && typeof s.card_state === "object") ? s.card_state : {};
  const merged = mergeCardStateAndRatings(
    state.cardState, state.ratings, cloudCardState, profile.ratings
  );
  state.cardState = merged.cardState;
  state.ratings = merged.ratings;

  // --- introCounts ---
  const cloudIntro = (s.intro_counts && typeof s.intro_counts === "object") ? s.intro_counts : {};
  state.introCounts = mergeIntroCounts(state.introCounts, cloudIntro);

  // --- mnemonics + shownMnemonics ---
  state.mnemonics = Object.assign({}, state.mnemonics || {}, profile.mnemonics || {});
  (profile.shown_mnemonics || []).forEach(function (id) { state.shownMnemonics.add(id); });

  // --- stats (per-Tag Max-Merge, Verhalten unverändert seit Mai 2026) ---
  if (s.stats && typeof s.stats === "object") {
    state.stats = mergeStats(state.stats, s.stats);
  }
}

// Spiegelt die Karten-Daten nach einem Merge in den localStorage-Cache.
// Direkt via setItem (NICHT saveJSON), damit kein neuer Push gequeued wird.
function mirrorCardDataToLocalStorage() {
  localStorage.setItem("hl_ratings", JSON.stringify(state.ratings));
  localStorage.setItem("hl_mnemonics", JSON.stringify(state.mnemonics));
  localStorage.setItem("hl_shown_mnemonics", JSON.stringify([...state.shownMnemonics]));
  localStorage.setItem("hl_intro_counts", JSON.stringify(state.introCounts));
  localStorage.setItem("hl_card_state", JSON.stringify(state.cardState));
  localStorage.setItem("hl_stats", JSON.stringify(state.stats));
}

async function pullCloudData() {
  if (!currentUser) return;
  _suppressSync = true;
  try {
    // Profile (single row)
    const { data: profile, error: pErr } = await sb
      .from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
    if (pErr) throw pErr;
    if (profile) {
      const s = profile.settings || {};
      // Skalare Settings: Cloud autoritativ, lokal als Cache.
      if (typeof s.autoplay === "boolean") state.autoPlay = s.autoplay;
      if (s.main_sort) state.mainSort = s.main_sort;
      if (s.us_sort) state.usSort = s.us_sort;
      // Engagement-Layer: Dein Warum (G1) — cloud autoritativ, lokal als Cache.
      if (typeof s.why_text === "string") state.whyText = s.why_text;
      // Karten-Daten (ratings/cardState/introCounts/mnemonics/stats):
      // MERGE statt Überschreiben (Juni 2026). Vorher vernichtete der Pull
      // alle lokal aufgelaufenen Offline-Änderungen (Ratings, SRS-Termine,
      // Intro-Fortschritt) — nur stats waren gemerged. Details: mergeCardData.
      mergeCardData(profile);
      // SRS Phase A: one-shot migration of existing ratings into card_state.
      // Idempotent via settings.srs_phase_a_migrated flag — runs only on first
      // login after deploying Phase A. Distributes due_at across the next 1/3/7/30
      // days based on the existing rating so the user doesn't get a wall of due
      // cards on day one.
      if (!s.srs_phase_a_migrated) {
        let migrated = 0;
        for (const id in state.ratings) {
          if (state.cardState[id]) continue; // already has SRS state — keep it
          const r = state.ratings[id];
          if (typeof SRS_INTERVALS[r] !== "number") continue;
          const days = SRS_INTERVALS[r];
          const today = isoToday();
          state.cardState[id] = {
            interval_days: days,
            due_at: isoAddDays(today, days),
            last_reviewed_at: today,
          };
          migrated++;
        }
        if (migrated > 0) console.info("[SRS] migrated " + migrated + " rated cards into card_state");
        // Mark as done so this never runs again, even if cardState is later cleared
        state._srsPhaseAMigrated = true;
      }
      // Mirror to localStorage (cache for offline / next reload)
      mirrorCardDataToLocalStorage();
      localStorage.setItem("hl_autoplay", JSON.stringify(state.autoPlay));
      localStorage.setItem("hl_main_sort", state.mainSort);
      localStorage.setItem("hl_us_sort", state.usSort);
      localStorage.setItem("hl_why_text", state.whyText);
    }
    // User sentences
    const { data: sentences, error: sErr } = await sb
      .from("user_sentences").select("*").eq("user_id", currentUser.id).order("id");
    if (sErr) throw sErr;
    state.userSentences = (sentences || []).map(function (r) {
      return {
        id: r.id, de: r.de, es: r.es || "",
        cats: r.cats || [], pending: r.pending !== false,
        archived: !!r.archived, audio_path: r.audio_path || "",
        // Szenen v1 — optional, leer wenn nicht migriert oder keine Szene
        scene_id: r.scene_id || null,
        scene_order: typeof r.scene_order === "number" ? r.scene_order : null,
        scene_role: r.scene_role || null,
        audio: "" // local field, not stored in cloud
      };
    });
    localStorage.setItem("hl_user_sentences", JSON.stringify(state.userSentences));

    // ID-Hochwasser-Marke anheben (Juni 2026) — siehe nextUserId(): IDs
    // dürfen nie wiederverwendet werden, auch nicht nach Löschungen.
    let maxCloudId = 0;
    for (const s2 of state.userSentences) if (s2.id > maxCloudId) maxCloudId = s2.id;
    const hwm = Number(localStorage.getItem("hl_max_id_ever")) || 0;
    if (maxCloudId > hwm) localStorage.setItem("hl_max_id_ever", String(maxCloudId));

    // Scenes — eigene Tabelle. Wir tolerieren ein Fehlen der Tabelle, damit
    // die App auch vor Ausführung der Migration sauber bootet.
    try {
      const { data: scenes, error: scErr } = await sb
        .from("scenes").select("*").eq("user_id", currentUser.id).order("id");
      if (scErr) throw scErr;
      state.scenes = (scenes || []).map(function (r) {
        return {
          id: r.id,
          title: r.title || "",
          setting: r.setting || "",
          participants: r.participants || [],
          status: r.status || "draft",
          practice_count: r.practice_count || 0,
          last_practiced_at: r.last_practiced_at || null,
          source: r.source || "conversation",
          created_at: r.created_at || null,
        };
      });
      localStorage.setItem("hl_scenes", JSON.stringify(state.scenes));
      // Szenen-ID-Hochwasser-Marke anheben (analog Sätze).
      let maxSceneId = 0;
      for (const sc2 of state.scenes) if (sc2.id > maxSceneId) maxSceneId = sc2.id;
      const scHwm = Number(localStorage.getItem("hl_max_scene_id_ever")) || 0;
      if (maxSceneId > scHwm) localStorage.setItem("hl_max_scene_id_ever", String(maxSceneId));
    } catch (scErr) {
      // Wenn die `scenes`-Tabelle noch nicht existiert (Migration nicht
      // ausgeführt), loggen wir eine Hinweis-Warnung statt zu crashen.
      // Der Rest der App funktioniert dann normal.
      console.warn("[scenes] Pull fehlgeschlagen — vermutlich Migration noch nicht ausgeführt:", scErr.message);
      state.scenes = [];
    }
  } finally {
    _suppressSync = false;
  }
  // Nach dem Merge kann der lokale Stand neuer sein als die Cloud (z.B.
  // offline geratete Karten, deren Push fehlschlug). Einmal zurückpushen,
  // damit beide Seiten konvergieren. pushProfile merged selbst nochmal
  // (merge-before-write), das ist also idempotent und sicher.
  queuePushProfile();
}

let pushProfileTimer = null;
function queuePushProfile() {
  if (!currentUser || _suppressSync) return;
  if (pushProfileTimer) clearTimeout(pushProfileTimer);
  setSyncStatus("syncing");
  pushProfileTimer = setTimeout(pushProfile, 1500);
}
async function pushProfile() {
  pushProfileTimer = null;
  if (!currentUser) return;
  try {
    // Merge-before-write (Juni 2026): aktuellen Cloud-Stand holen und in den
    // lokalen State mergen, BEVOR wir schreiben. Vorher war der Push ein
    // Last-Write-Wins übers gesamte Profil-Blob — ein Gerät mit veraltetem
    // Stand überschrieb damit sämtliche zwischenzeitlichen Änderungen des
    // anderen Geräts. Best effort: scheitert der Lese-Versuch, pushen wir
    // trotzdem (besser ein riskanter Push als gar keiner — der nächste
    // Pull merged wieder). Skalare Settings (autoplay, sorts, why_text)
    // werden bewusst NICHT zurückgemerged: die gerade getätigte lokale
    // Änderung ist hier ja oft der Auslöser des Pushes.
    try {
      const { data: cloudProfile } = await sb.from("profiles")
        .select("ratings, mnemonics, shown_mnemonics, settings")
        .eq("id", currentUser.id).maybeSingle();
      if (cloudProfile) {
        mergeCardData(cloudProfile);
        mirrorCardDataToLocalStorage();
      }
    } catch (mergeErr) {
      console.warn("pushProfile: merge-before-write übersprungen:", mergeErr);
    }
    const { error } = await sb.from("profiles").upsert({
      id: currentUser.id,
      ratings: state.ratings,
      mnemonics: state.mnemonics,
      shown_mnemonics: [...state.shownMnemonics],
      settings: {
        autoplay: state.autoPlay,
        main_sort: state.mainSort,
        us_sort: state.usSort,
        intro_counts: state.introCounts,
        card_state: state.cardState,
        stats: state.stats,
        // Engagement-Layer: Dein Warum (G1)
        why_text: state.whyText,
        // Set on first login post-Phase-A, prevents the migration block in
        // pullCloudData from re-running on subsequent logins.
        srs_phase_a_migrated: true,
      },
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    setSyncStatus("synced");
  } catch (e) {
    console.error("pushProfile error:", e);
    setSyncStatus("error");
    showToast("Sync-Fehler (Profile): " + e.message, 4000);
  }
}

let pushSentencesTimer = null;
function queuePushSentences() {
  if (!currentUser || _suppressSync) return;
  if (pushSentencesTimer) clearTimeout(pushSentencesTimer);
  setSyncStatus("syncing");
  pushSentencesTimer = setTimeout(pushUserSentences, 1500);
}
async function pushUserSentences() {
  pushSentencesTimer = null;
  if (!currentUser) return;
  try {
    // Cloud-Delete via Tombstones (Juni 2026): Es werden NUR IDs gelöscht,
    // die auf DIESEM Gerät explizit gelöscht wurden (hl_deleted_ids).
    // Vorher: Diff-Delete (alles in der Cloud, was lokal fehlt) — das hat
    // bei veraltetem lokalen Stand die neuen Sätze des anderen Geräts
    // mitgelöscht. Sätze, die nur in der Cloud existieren, bleiben jetzt
    // unangetastet und kommen beim nächsten Login-Pull lokal an.
    const tombstones = loadJSON("hl_deleted_ids", []);
    if (tombstones.length) {
      const { error: dErr } = await sb.from("user_sentences").delete()
        .eq("user_id", currentUser.id).in("id", tombstones);
      if (dErr) throw dErr;
      // Erst nach erfolgreichem Delete aufräumen — schlägt er fehl,
      // bleiben die Tombstones liegen und der nächste Push versucht's erneut.
      clearTombstones("hl_deleted_ids", tombstones);
    }
    // Upsert all local rows.
    // Wenn die Szenen-Migration noch nicht gelaufen ist, fehlen die scene_*
    // Spalten in der DB → wir versuchen zuerst mit den neuen Spalten und
    // fallen auf die alte Form zurück, wenn Postgres meckert. Cache das
    // Ergebnis pro Session, damit nicht jeder Push doppelt feuert.
    if (state.userSentences.length) {
      const includeScene = !window._scenesColumnsMissing;
      const rows = state.userSentences.map(function (s) {
        const row = {
          id: s.id, user_id: currentUser.id, de: s.de, es: s.es || "",
          cats: s.cats || [], pending: s.pending !== false,
          archived: !!s.archived, audio_path: s.audio_path || "",
        };
        if (includeScene) {
          row.scene_id = s.scene_id || null;
          row.scene_order = typeof s.scene_order === "number" ? s.scene_order : null;
          row.scene_role = s.scene_role || null;
        }
        return row;
      });
      const { error: uErr } = await sb.from("user_sentences").upsert(rows);
      if (uErr) {
        // Wenn die scene_*-Spalten fehlen, ein Mal still retryen ohne sie.
        // Bugfix Juni 2026: Vorher matchte auch das nackte Wort "column" —
        // damit setzte JEDER Fehler mit "column" im Text (z.B. Constraint
        // auf einer ganz anderen Spalte) das Session-Flag, und alle weiteren
        // Pushes ließen die scene_*-Felder weg → Szenen-Zuordnung konnte in
        // der Cloud verloren gehen. Jetzt: nur Postgres-Code 42703
        // (undefined_column) bzw. explizite scene_*-Spaltennamen.
        const msg = (uErr.message || "").toLowerCase();
        const isMissingSceneColumn =
          uErr.code === "42703" ||
          msg.indexOf("scene_id") >= 0 || msg.indexOf("scene_order") >= 0 || msg.indexOf("scene_role") >= 0;
        if (includeScene && isMissingSceneColumn) {
          console.warn("[scenes] user_sentences.scene_* fehlen — fallback push ohne Szenen-Felder. Migration ausführen für volle Funktion.");
          window._scenesColumnsMissing = true;
          const legacyRows = state.userSentences.map(function (s) {
            return {
              id: s.id, user_id: currentUser.id, de: s.de, es: s.es || "",
              cats: s.cats || [], pending: s.pending !== false,
              archived: !!s.archived, audio_path: s.audio_path || "",
            };
          });
          const { error: uErr2 } = await sb.from("user_sentences").upsert(legacyRows);
          if (uErr2) throw uErr2;
        } else {
          throw uErr;
        }
      }
    }
    setSyncStatus("synced");
  } catch (e) {
    console.error("pushUserSentences error:", e);
    setSyncStatus("error");
    showToast("Sync-Fehler (Sätze): " + e.message, 4000);
  }
}

// ===== Szenen-Sync (Diff + Upsert + Delete, analog pushUserSentences) =====
let pushScenesTimer = null;
function queuePushScenes() {
  if (!currentUser || _suppressSync) return;
  if (pushScenesTimer) clearTimeout(pushScenesTimer);
  setSyncStatus("syncing");
  pushScenesTimer = setTimeout(pushScenes, 1500);
}
async function pushScenes() {
  pushScenesTimer = null;
  if (!currentUser) return;
  try {
    // 1) Lokal gelöschte Szenen aus Cloud entfernen — via Tombstones
    //    (Juni 2026, analog pushUserSentences: kein Diff-Delete mehr).
    const tombstones = loadJSON("hl_deleted_scene_ids", []);
    if (tombstones.length) {
      const { error: dErr } = await sb.from("scenes").delete()
        .eq("user_id", currentUser.id).in("id", tombstones);
      if (dErr) throw dErr;
      clearTombstones("hl_deleted_scene_ids", tombstones);
    }
    // 2) Lokale Rows upserten
    if (state.scenes.length) {
      const rows = state.scenes.map(function (sc) {
        return {
          id: sc.id,
          user_id: currentUser.id,
          title: sc.title || "",
          setting: sc.setting || "",
          participants: sc.participants || [],
          status: sc.status || "draft",
          practice_count: sc.practice_count || 0,
          last_practiced_at: sc.last_practiced_at || null,
          source: sc.source || "conversation",
        };
      });
      const { error: uErr } = await sb.from("scenes").upsert(rows);
      if (uErr) throw uErr;
    }
    setSyncStatus("synced");
  } catch (e) {
    console.error("pushScenes error:", e);
    setSyncStatus("error");
    // Wenn die Tabelle noch nicht existiert (Migration nicht ausgeführt), klingt das
    // nach einem normalen Fehler — wir loggen nur und zeigen einen sanften Toast.
    if (e.message && /relation "scenes" does not exist|scenes/i.test(e.message)) {
      showToast("Szenen-Tabelle fehlt — Migration ausführen (siehe migrations/scenes_v1.sql)", 5000);
    } else {
      showToast("Sync-Fehler (Szenen): " + e.message, 4000);
    }
  }
}

// One-time migration on first login if cloud is empty but local has data
// `snapshot` = lokale Daten, VOR pullCloudData gesichert (Bugfix Juni 2026 —
// localStorage ist nach dem Pull bereits mit dem Cloud-Stand überschrieben).
async function maybeMigrate(snapshot) {
  if (!currentUser || !snapshot) return;
  const { data: profile } = await sb.from("profiles")
    .select("ratings, mnemonics").eq("id", currentUser.id).maybeSingle();
  const { count: sCount } = await sb.from("user_sentences")
    .select("*", { count: "exact", head: true }).eq("user_id", currentUser.id);
  const cloudHasData = (sCount && sCount > 0) || (profile && (
    Object.keys(profile.ratings || {}).length > 0 ||
    Object.keys(profile.mnemonics || {}).length > 0
  ));
  if (cloudHasData) return;
  const lsRatings = snapshot.ratings || {};
  const lsMnemonics = snapshot.mnemonics || {};
  const lsSentences = snapshot.sentences || [];
  const hasLocal = lsSentences.length > 0 ||
    Object.keys(lsRatings).length > 0 ||
    Object.keys(lsMnemonics).length > 0;
  if (!hasLocal) return;
  const summary = lsSentences.length + " Sätze, " +
    Object.keys(lsRatings).length + " Ratings, " +
    Object.keys(lsMnemonics).length + " Mnemonics";
  if (!confirm("Lokale Daten gefunden:\n" + summary + "\n\nIn die Cloud übertragen, damit alle Geräte synchron bleiben?")) return;
  state.ratings = lsRatings;
  state.mnemonics = lsMnemonics;
  state.userSentences = lsSentences;
  state.shownMnemonics = new Set(snapshot.shownMnemonics || []);
  _suppressSync = false;
  await pushProfile();
  await pushUserSentences();
  showToast("Migration abgeschlossen — " + summary, 3500);
}

// One-time migration: upload all user-generated audios from IDB to Supabase Storage.
// Per-device guard via localStorage so each device migrates its own IDB once.
// Idempotent across devices because `upsert: true` overwrites identical content.
async function migrateIDBToStorage() {
  if (!currentUser) return;
  const flagKey = "hl_audio_migrated_" + currentUser.id;
  if (localStorage.getItem(flagKey) === "true") {
    console.log("[migrate] flag already set — skipping");
    return;
  }

  // Ensure IDB is fully open before reading
  if (_audioDbReady) { try { await _audioDbReady; } catch (e) {} }

  const blobs = await getAllAudiosFromIDB();
  // Only user sentences (originals 1-84 stay as repo files, never go to Storage)
  const userBlobs = blobs.filter(function (b) { return isUserSentence(b.id); });
  console.log("[migrate] IDB user-audios found:", userBlobs.length);
  if (userBlobs.length === 0) {
    // Nothing on this device to migrate. Mark done so we don't retry every login.
    localStorage.setItem(flagKey, "true");
    return;
  }

  setSyncStatus("syncing");
  let uploaded = 0, skipped = 0, failed = 0;
  for (const { id, blob } of userBlobs) {
    const s = getSentenceById(id);
    if (!s) { skipped++; continue; }       // sentence was deleted elsewhere
    if (s.audio_path) { skipped++; continue; } // already migrated (by another device or earlier run)

    const path = currentUser.id + "/sentence_" + id + ".mp3";
    try {
      const { error: upErr } = await sb.storage.from("audios")
        .upload(path, blob, { upsert: true, contentType: "audio/mpeg" });
      if (upErr) throw upErr;
      const { error: dbErr } = await sb.from("user_sentences")
        .update({ audio_path: path }).eq("id", id).eq("user_id", currentUser.id);
      if (dbErr) throw dbErr;
      s.audio_path = path;
      uploaded++;
    } catch (e) {
      console.warn("Migration: failed for sentence", id, e);
      failed++;
    }
  }

  console.log("[migrate] result — uploaded:", uploaded, "skipped:", skipped, "failed:", failed);

  // Persist updated audio_paths to localStorage cache
  localStorage.setItem("hl_user_sentences", JSON.stringify(state.userSentences));

  // Set the flag only if no failures — partial failures will retry on next login
  if (failed === 0) {
    localStorage.setItem(flagKey, "true");
  }

  setSyncStatus(failed === 0 ? "synced" : "error");

  // Always show feedback when migration actually inspected blobs
  let msg;
  if (uploaded === 0 && failed === 0) {
    msg = "Audio-Cloud ist aktuell (" + skipped + " bereits synchron)";
  } else {
    msg = "Audio-Migration: " + uploaded + " in Cloud"
      + (skipped ? ", " + skipped + " übersprungen" : "")
      + (failed ? ", " + failed + " fehlgeschlagen" : "");
  }
  showToast(msg, 4000);

  // Re-render so UI reflects new audio availability
  if (typeof renderCards === "function") renderCards();
  if (typeof buildUserSentencesList === "function") buildUserSentencesList();
  if (typeof updateGenerateAllAudioBtn === "function") updateGenerateAllAudioBtn();
}

// ===== Init =====
// Migrationen defensiv wrappen — wenn eine wegen unerwarteter Daten-Form
// crashen würde, soll der Rest der Init (vor allem Auth/Login!) trotzdem
// durchlaufen. Login-blockierende Init-Fehler sind das schlimmste UX-Problem.
try {
  // SRS Phase A: rebuild card_state from existing ratings if it's empty
  // (offline / pre-cloud-pull case). Idempotent.
  maybeMigrateCardStateLocal();
} catch (e) { console.error("[init] maybeMigrateCardStateLocal failed:", e); }

try {
  // Einführungs-Pool auf 5 zurückslicen falls aus alter Logik mehr drin sind.
  if (typeof maybeReslicePool === "function") maybeReslicePool();
} catch (e) { console.error("[init] maybeReslicePool failed:", e); }

buildCatFilter();
buildNsCatPickers();
renderNsRecent();
updateNsMultiCount();
buildRatingFilter();
if (typeof updateScenesBadge === "function") updateScenesBadge();
if (saetzeSortEl) saetzeSortEl.value = state.usSort;
mainSortEl.value = state.mainSort;
applyFilter();
updatePlayer();
updateProgress();
updateApiKeyUI();
updateElKeyUI();
updatePendingBadge();
updateAutoplayUI();
buildUserSentencesList();
_audioDbReady = initAudioDB().then(function () {
  renderCards();
  buildUserSentencesList();
  updateGenerateAllAudioBtn();
});

// =====================================================================
// PWA · Service Worker registration
// =====================================================================
// Seit Juni 2026 liefert der SW den App-Code network-first aus — neue
// Deploys sind damit automatisch beim nächsten Laden live. Der SW cached
// nur noch Audios (Bandbreite/Egress) und hält die Shell als Fallback
// für kurze Netz-Aussetzer vor.
if ("serviceWorker" in navigator) {
  // Update-Fix (Juni 2026): Wenn eine neue SW-Version übernimmt
  // (controllerchange nach skipWaiting), einmal neu laden, damit sofort
  // der frische Code läuft — statt erst beim übernächsten Besuch.
  // Guards: (a) kein Reload beim allerersten SW-Install (hadController),
  // (b) max. einmal (refreshing), (c) NICHT mitten in einer Übung oder
  // laufendem Audio — dann reicht der nächste natürliche Reload.
  const hadController = !!navigator.serviceWorker.controller;
  let _swRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController || _swRefreshing) return;
    const busy = document.body.classList.contains("car")
      || document.body.classList.contains("focus")
      || document.body.classList.contains("intro")
      || document.body.classList.contains("scene-practice")
      || (typeof audioEl !== "undefined" && audioEl && !audioEl.paused);
    if (busy) {
      console.info("[SW] Neue Version aktiv — Reload beim nächsten Besuch (Session läuft).");
      return;
    }
    _swRefreshing = true;
    location.reload();
  });
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      // When a new SW is found, ping it to skip waiting so the user gets the
      // update immediately rather than after closing all tabs.
      reg.addEventListener("updatefound", function () {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", function () {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            newWorker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    }).catch(function (err) {
      console.warn("[SW] registration failed:", err);
    });
  });
}

// =====================================================================
// PWA · Media Session API — Lockscreen / Bluetooth controls
// =====================================================================
// Lets the OS show the current sentence on the lockscreen and respond to
// headphone / Bluetooth play/pause/skip buttons. Setup is one-time; metadata
// is refreshed on every play() via updateMediaSessionMetadata().
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler("play", function () {
      // Car-Mode hat eigene Buffer/Logik — niemals den globalen Player anfassen.
      if (typeof car !== "undefined" && car && car.active) {
        carResume();
        return;
      }
      // Resume if we have an existing track, otherwise start the current one
      if (audioEl && audioEl.src && audioEl.paused) {
        audioEl.play().then(function () {
          state.isPlaying = true;
          if (playIcon) playIcon.style.display = "none";
          if (pauseIcon) pauseIcon.style.display = "block";
        }).catch(function (e) { console.warn("[MS] resume failed:", e); });
      } else {
        play();
      }
    });
    navigator.mediaSession.setActionHandler("pause", function () {
      if (typeof car !== "undefined" && car && car.active) { carPause(); return; }
      pause();
    });
    navigator.mediaSession.setActionHandler("nexttrack", function () {
      if (typeof car !== "undefined" && car && car.active) { carSkipNext(); return; }
      next();
    });
    navigator.mediaSession.setActionHandler("previoustrack", function () {
      if (typeof car !== "undefined" && car && car.active) { carSkipPrev(); return; }
      prev();
    });
    // Explicitly disable seek (sentence-by-sentence, no scrubbing inside a clip)
    try { navigator.mediaSession.setActionHandler("seekto", null); } catch (e) {}
    try { navigator.mediaSession.setActionHandler("seekbackward", null); } catch (e) {}
    try { navigator.mediaSession.setActionHandler("seekforward", null); } catch (e) {}
  } catch (e) {
    console.warn("[MS] setup failed:", e);
  }
}
function updateMediaSessionMetadata(s) {
  if (!("mediaSession" in navigator) || !s) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.es || s.de || "LinguistFlow",
      artist: s.de || "",
      album: "LinguistFlow · Spanisch (Guatemala)",
      artwork: [
        { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
    navigator.mediaSession.playbackState = "playing";
  } catch (e) { /* MediaMetadata not supported — ignore */ }
}
setupMediaSession();

// =====================================================================
// FOKUS-SESSION (third mode: Anki-style single card practice)
// =====================================================================

// Local state (not persisted — sessions are ephemeral)
const focus = {
  // Setup config
  cats: new Set(),           // empty = all
  // Default: LEER = alle Stufen (Bugfix Juni 2026). Vorher ["unrated","1","2"]
  // — damit erschienen fällige 3★- und learned-Karten über den Sidebar-Link
  // NIE (die SRS-Queue wurde zusätzlich rating-gefiltert und 30-Tage-Karten
  // verhungerten). Die Today-Action-Card setzte deshalb schon explizit ein
  // leeres Set — jetzt sind beide Pfade konsistent. Rating-Filter bleibt als
  // explizites Opt-in im Setup wählbar.
  ratings: new Set(),
  count: 20,                 // 10 / 20 / 50 / "all"
  order: "random",           // "random" | "hardest" | "oldest"
  // Session
  active: false,
  queue: [],                 // array of sentence IDs
  idx: 0,
  revealed: false,
  startedAt: 0,
  // Per-session results (for summary)
  results: { 1: 0, 2: 0, 3: 0, learned: 0 },
};

// DOM refs
const focusBtn = document.getElementById("focus-mode-btn");
const focusSessionEl = document.getElementById("focus-session");
const focusSetupEl = document.getElementById("focus-setup");
const focusCardViewEl = document.getElementById("focus-card-view");
const focusSummaryEl = document.getElementById("focus-summary");
const focusCatPickerEl = document.getElementById("focus-cat-picker");
const focusRatingPickerEl = document.getElementById("focus-rating-picker");
const focusCountPickerEl = document.getElementById("focus-count-picker");
const focusOrderPickerEl = document.getElementById("focus-order-picker");
const focusSetupSummaryEl = document.getElementById("focus-setup-summary");
const focusStartBtn = document.getElementById("focus-start-btn");
const focusCloseBtn = document.getElementById("focus-close-btn");
const focusProgressCountEl = document.getElementById("focus-progress-count");
const focusProgressFillEl = document.getElementById("focus-progress-fill");
const focusCardEl = document.getElementById("focus-card");
const focusCardNumEl = document.getElementById("focus-card-num");
const focusDeEl = document.getElementById("focus-de");
const focusEsEl = document.getElementById("focus-es");
const focusSideEsEl = document.getElementById("focus-side-es");
const focusRevealBtn = document.getElementById("focus-reveal-btn");
const focusPlayBtn = document.getElementById("focus-play-btn");
const focusMnemonicAreaEl = document.getElementById("focus-mnemonic-area");
const focusRatingsEl = document.getElementById("focus-ratings");
const focusSummaryStatsEl = document.getElementById("focus-summary-stats");
const focusSummaryBackBtn = document.getElementById("focus-summary-back");
const focusSummaryRestartBtn = document.getElementById("focus-summary-restart");

// ----- Setup view: build pickers -----
function buildFocusCatPicker() {
  focusCatPickerEl.innerHTML = "";
  for (const cat of DATA.categories) {
    const chip = document.createElement("button");
    chip.className = "focus-cat-chip" + (focus.cats.has(cat.key) ? " active" : "");
    chip.textContent = cat.label;
    chip.onclick = function () {
      if (focus.cats.has(cat.key)) focus.cats.delete(cat.key);
      else focus.cats.add(cat.key);
      chip.classList.toggle("active");
      updateFocusSetupSummary();
    };
    focusCatPickerEl.appendChild(chip);
  }
}

function buildFocusRatingPicker() {
  focusRatingPickerEl.innerHTML = "";
  const items = [
    { key: "unrated", label: "Unrated", icon: '<span class="chip-stars"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg></span>' },
    { key: "1", label: "Schwierig", icon: '<span class="chip-stars"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg></span>' },
    { key: "2", label: "Okay", icon: '<span class="chip-stars"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg></span>' },
    { key: "3", label: "Easy", icon: '<span class="chip-stars"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg></span>' },
    { key: "learned", label: "Gelernt", icon: '<span class="chip-brain"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg></span>' },
  ];
  for (const it of items) {
    const chip = document.createElement("button");
    chip.className = "focus-rating-chip" + (focus.ratings.has(it.key) ? " active" : "");
    chip.innerHTML = it.icon + '<span>' + it.label + '</span>';
    chip.onclick = function () {
      if (focus.ratings.has(it.key)) focus.ratings.delete(it.key);
      else focus.ratings.add(it.key);
      chip.classList.toggle("active");
      updateFocusSetupSummary();
    };
    focusRatingPickerEl.appendChild(chip);
  }
}

function wireFocusCountPicker() {
  focusCountPickerEl.querySelectorAll(".focus-count-chip").forEach(function (btn) {
    btn.onclick = function () {
      focusCountPickerEl.querySelectorAll(".focus-count-chip").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      const v = btn.dataset.count;
      focus.count = v === "all" ? "all" : parseInt(v, 10);
      updateFocusSetupSummary();
    };
  });
}

function wireFocusOrderPicker() {
  focusOrderPickerEl.querySelectorAll(".focus-order-chip").forEach(function (btn) {
    btn.onclick = function () {
      focusOrderPickerEl.querySelectorAll(".focus-order-chip").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      focus.order = btn.dataset.order;
    };
  });
}

// Filter sentences according to the setup config (no count/order yet — that's done at start)
function focusEligibleSentences() {
  // SRS Phase A: Fokus-Modus ist die Single-Card-Variante von Active Recall.
  // Basis-Queue kommt aus recallQueue() (heute-fällig + Smart Fallback),
  // dann Cat-Filter und Rating-Filter (optional, falls User die explizit setzt).
  const dueIds = new Set(recallQueue(5));
  return allSentences().filter(function (s) {
    if (!isPracticeable(s)) return false;  // archiviert, pending, oder Szenen-other-Linie
    if (stageOf(s.id) !== "active") return false;
    if (!dueIds.has(s.id)) return false;  // <-- die wichtige Zeile: nur SRS-Queue
    if (focus.cats.size > 0 && !s.cats.some(function (c) { return focus.cats.has(c); })) return false;
    if (focus.ratings.size > 0) {
      let match = false;
      for (const key of focus.ratings) {
        if (ratingMatches(s.id, key)) { match = true; break; }
      }
      if (!match) return false;
    }
    return true;
  });
}

function updateFocusSetupSummary() {
  const eligible = focusEligibleSentences();
  const willPlay = focus.count === "all" ? eligible.length : Math.min(focus.count, eligible.length);
  focusSetupSummaryEl.textContent = eligible.length === 0
    ? "Keine Karten in dieser Auswahl"
    : (willPlay + " von " + eligible.length + " Karten");
  focusStartBtn.disabled = eligible.length === 0;
}

// ----- Session lifecycle -----
function startFocusSession() {
  const eligible = focusEligibleSentences();
  if (eligible.length === 0) return;

  // Order
  let ordered = eligible.slice();
  if (focus.order === "random") {
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = ordered[i]; ordered[i] = ordered[j]; ordered[j] = tmp;
    }
  } else if (focus.order === "hardest") {
    // 1-star < unrated < 2-star < 3-star < learned (hardest first)
    const score = function (s) {
      const r = getRating(s.id);
      if (r === 1) return 0;
      if (r === null) return 1;
      if (r === 2) return 2;
      if (r === 3) return 3;
      if (r === "learned") return 4;
      return 5;
    };
    ordered.sort(function (a, b) { return score(a) - score(b); });
  } else if (focus.order === "oldest") {
    ordered.sort(function (a, b) { return a.id - b.id; });
  }

  // Count cap
  if (focus.count !== "all") ordered = ordered.slice(0, focus.count);

  focus.queue = ordered.map(function (s) { return s.id; });
  focus.idx = 0;
  focus.revealed = false;
  focus.active = true;
  focus.startedAt = Date.now();
  focus.results = { 1: 0, 2: 0, 3: 0, learned: 0 };

  focusSetupEl.style.display = "none";
  focusSummaryEl.style.display = "none";
  focusCardViewEl.style.display = "flex";
  window.scrollTo(0, 0);
  renderFocusCard();
}

function endFocusSession(reason) {
  focus.active = false;
  if (reason === "completed") {
    focusCardViewEl.style.display = "none";
    focusSummaryEl.style.display = "block";
    renderFocusSummary();
  } else {
    // aborted → back to setup
    focusCardViewEl.style.display = "none";
    focusSummaryEl.style.display = "none";
    focusSetupEl.style.display = "block";
    updateFocusSetupSummary();
  }
}

// ----- Render active card -----
function renderFocusCard() {
  const id = focus.queue[focus.idx];
  const s = getSentenceById(id);
  if (!s) { endFocusSession("aborted"); return; }

  // Progress
  focusProgressCountEl.textContent = (focus.idx + 1) + " / " + focus.queue.length;
  const pct = Math.round((focus.idx / focus.queue.length) * 100);
  focusProgressFillEl.style.width = pct + "%";

  focusCardNumEl.textContent = "#" + s.id;
  focusDeEl.textContent = s.de;
  focusEsEl.textContent = s.es || "(keine Übersetzung)";

  // Reset reveal state
  focus.revealed = false;
  focusRevealBtn.style.display = "inline-flex";
  focusSideEsEl.style.display = "none";
  focusRatingsEl.style.display = "none";
  focusMnemonicAreaEl.style.display = "none";
  focusMnemonicAreaEl.innerHTML = "";
  // B1 Reveal-Cue der vorherigen Karte abräumen (Focus-Card wird recycled).
  const fc = document.getElementById("focus-card");
  if (fc) {
    const oldCue = fc.querySelector(".focus-reveal-cue");
    if (oldCue) oldCue.remove();
  }

  // Play button enable/disable based on audio availability
  focusPlayBtn.disabled = !hasAudio(s);
}

function revealFocusCard() {
  if (focus.revealed) return;
  focus.revealed = true;
  focusRevealBtn.style.display = "none";
  focusSideEsEl.style.display = "flex";
  focusRatingsEl.style.display = "grid";
  // B1 Reveal-Cue: Glow + Label wenn die Karte 21+ Tage weg war.
  maybeShowRevealCue(document.getElementById("focus-card"), focus.queue[focus.idx], true);
  renderFocusMnemonic();
  // Autoplay nach Reveal — der Reveal-Klick ist die User-Geste,
  // also läuft das in der gleichen Chain und die Autoplay-Policy ist happy.
  playFocusAudio();
}

function renderFocusMnemonic() {
  const id = focus.queue[focus.idx];
  focusMnemonicAreaEl.innerHTML = "";
  focusMnemonicAreaEl.style.display = "block";

  if (state.editingMnemonics.has(id)) {
    // Editor
    const editor = document.createElement("div");
    editor.className = "focus-mnemonic-editor";
    const ta = document.createElement("textarea");
    ta.placeholder = "Eselsbrücke / Denkhilfe…";
    ta.value = state.mnemonics[id] || "";
    editor.appendChild(ta);
    const actions = document.createElement("div");
    actions.className = "focus-mnemonic-editor-actions";
    const genBtn = document.createElement("button");
    genBtn.className = "mnemonic-generate-btn";
    genBtn.title = "Eselsbrücke mit Claude generieren";
    genBtn.innerHTML = '<span class="gen-icon">✨</span><span>Vorschlag</span>';
    genBtn.onclick = function () { generateMnemonicViaAPI(id, ta, genBtn); };
    actions.appendChild(genBtn);
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.onclick = function () {
      state.editingMnemonics.delete(id);
      renderFocusMnemonic();
    };
    const saveBtn = document.createElement("button");
    saveBtn.className = "primary";
    saveBtn.textContent = "Speichern";
    saveBtn.onclick = function () {
      const v = ta.value.trim();
      if (v) {
        state.mnemonics[id] = v;
        saveJSON("hl_mnemonics", state.mnemonics);
        state.shownMnemonics.add(id);
        saveShownMnemonics();
        showToast("Eselsbrücke gespeichert.");
      } else if (state.mnemonics[id]) {
        delete state.mnemonics[id];
        saveJSON("hl_mnemonics", state.mnemonics);
        state.shownMnemonics.delete(id);
        saveShownMnemonics();
      }
      state.editingMnemonics.delete(id);
      renderFocusMnemonic();
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    editor.appendChild(actions);
    focusMnemonicAreaEl.appendChild(editor);
    setTimeout(function () { ta.focus(); }, 50);
  } else if (state.mnemonics[id]) {
    // Display existing
    const disp = document.createElement("div");
    disp.className = "focus-mnemonic-display";
    const text = document.createElement("div");
    text.className = "focus-mnemonic-text";
    text.textContent = state.mnemonics[id];
    disp.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "focus-mnemonic-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "focus-mnemonic-icon-btn";
    editBtn.title = "Bearbeiten";
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    editBtn.onclick = function () {
      state.editingMnemonics.add(id);
      renderFocusMnemonic();
    };
    const delBtn = document.createElement("button");
    delBtn.className = "focus-mnemonic-icon-btn";
    delBtn.title = "Löschen";
    delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
    delBtn.onclick = function () {
      if (!confirm("Eselsbrücke wirklich löschen?")) return;
      delete state.mnemonics[id];
      saveJSON("hl_mnemonics", state.mnemonics);
      state.shownMnemonics.delete(id);
      saveShownMnemonics();
      renderFocusMnemonic();
      showToast("Eselsbrücke gelöscht.");
    };
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    disp.appendChild(actions);
    focusMnemonicAreaEl.appendChild(disp);
  } else {
    // Add button
    const addBtn = document.createElement("button");
    addBtn.className = "focus-mnemonic-add-btn";
    addBtn.innerHTML = '<span style="font-size:14px;">💡</span><span>Eselsbrücke hinzufügen</span>';
    addBtn.onclick = function () {
      state.editingMnemonics.add(id);
      renderFocusMnemonic();
    };
    focusMnemonicAreaEl.appendChild(addBtn);
  }
}

function playFocusAudio() {
  const id = focus.queue[focus.idx];
  const s = getSentenceById(id);
  if (!s) return;
  const src = audioSrcFor(s);
  if (!src) { showToast("Kein Audio für diesen Satz."); return; }
  // Android-Flicker-Fix (gleiche Logik wie in play()): MediaSession-Status
  // synchron vor dem src-Wechsel auf "playing".
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
  }
  audioEl.src = src;
  audioEl.playbackRate = state.speed;
  audioEl.play().then(function () {
    incrementStat("plays");
    if (typeof updateMediaSessionMetadata === "function") updateMediaSessionMetadata(s);
  }).catch(function (err) { console.error("Focus play failed", err); });
}

function rateFocusAndAdvance(rateKey) {
  if (!focus.revealed) return;          // must reveal before rating
  const id = focus.queue[focus.idx];
  const value = rateKey === "learned" ? "learned" : parseInt(rateKey, 10);
  setRating(id, value);
  focus.results[rateKey] = (focus.results[rateKey] || 0) + 1;

  // Also re-render the main card list so list view stays in sync (cheap)
  // (Don't render now if we're in focus mode — but data is already saved)

  // Advance
  focus.idx++;
  if (focus.idx >= focus.queue.length) {
    endFocusSession("completed");
  } else {
    renderFocusCard();
  }
}

// ----- Summary -----
function renderFocusSummary() {
  const total = focus.queue.length;
  const elapsed = Math.round((Date.now() - focus.startedAt) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? mins + "m " + secs + "s" : secs + "s";

  focusSummaryStatsEl.innerHTML = "";
  const stats = [
    { label: "Karten", value: total },
    { label: "Gelernt", value: focus.results.learned || 0 },
    { label: "Schwierig", value: focus.results[1] || 0 },
    { label: "Dauer", value: timeStr },
  ];
  for (const st of stats) {
    const card = document.createElement("div");
    card.className = "focus-summary-stat";
    card.innerHTML = '<div class="focus-summary-stat-value">' + st.value + '</div>' +
                     '<div class="focus-summary-stat-label">' + st.label + '</div>';
    focusSummaryStatsEl.appendChild(card);
  }
}

// ----- Wiring -----
function setFocusModeActive() {
  state.mode = "focus";
  document.body.classList.add("focus");
  window.scrollTo(0, 0);
  document.body.classList.remove("recall");
  listenBtn.classList.remove("primary"); listenBtn.classList.add("secondary");
  recallBtn.classList.remove("primary"); recallBtn.classList.add("secondary");
  focusBtn.classList.remove("secondary"); focusBtn.classList.add("primary");
  modeHint.textContent = "Anki-Stil: eine Karte nach der anderen, mit Eselsbrücken.";
  // Show setup if no active session
  if (focus.active) {
    focusSetupEl.style.display = "none";
    focusSummaryEl.style.display = "none";
    focusCardViewEl.style.display = "flex";
  } else {
    focusSetupEl.style.display = "block";
    focusCardViewEl.style.display = "none";
    focusSummaryEl.style.display = "none";
    updateFocusSetupSummary();
  }
}

focusBtn.onclick = setFocusModeActive;

// When switching to listen or recall, deactivate focus body class
const _origListenBtnOnclick = listenBtn.onclick;
listenBtn.onclick = function () {
  document.body.classList.remove("focus");
  focusBtn.classList.remove("primary"); focusBtn.classList.add("secondary");
  _origListenBtnOnclick.call(this);
};
const _origRecallBtnOnclick = recallBtn.onclick;
recallBtn.onclick = function () {
  document.body.classList.remove("focus");
  focusBtn.classList.remove("primary"); focusBtn.classList.add("secondary");
  _origRecallBtnOnclick.call(this);
};

focusStartBtn.onclick = startFocusSession;
focusCloseBtn.onclick = function () {
  if (focus.idx > 0 && focus.idx < focus.queue.length) {
    if (!confirm("Session abbrechen? Bereits bewertete Karten bleiben gespeichert.")) return;
  }
  endFocusSession("aborted");
};
focusSummaryBackBtn.onclick = function () { endFocusSession("aborted"); };
focusSummaryRestartBtn.onclick = function () {
  focusSummaryEl.style.display = "none";
  focusSetupEl.style.display = "block";
  updateFocusSetupSummary();
};

focusRevealBtn.onclick = revealFocusCard;
focusPlayBtn.onclick = playFocusAudio;

// Whole-card click reveals (but ignore clicks on buttons inside)
focusCardEl.addEventListener("click", function (e) {
  if (focus.revealed) return;
  // Only reveal if click was on the card itself, not on a button/textarea
  if (e.target.closest("button") || e.target.closest("textarea")) return;
  revealFocusCard();
});

// Wire rating buttons
focusRatingsEl.querySelectorAll(".focus-rating-btn").forEach(function (btn) {
  btn.onclick = function () { rateFocusAndAdvance(btn.dataset.rate); };
});

// Keyboard shortcuts in focus mode
document.addEventListener("keydown", function (e) {
  if (state.mode !== "focus" || !focus.active) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!focus.revealed) revealFocusCard();
    else playFocusAudio();
  } else if (e.code === "Digit1" && focus.revealed) { e.preventDefault(); rateFocusAndAdvance("1"); }
  else if (e.code === "Digit2" && focus.revealed) { e.preventDefault(); rateFocusAndAdvance("2"); }
  else if (e.code === "Digit3" && focus.revealed) { e.preventDefault(); rateFocusAndAdvance("3"); }
  else if (e.code === "Digit4" && focus.revealed) { e.preventDefault(); rateFocusAndAdvance("learned"); }
  else if (e.code === "Escape") {
    e.preventDefault();
    focusCloseBtn.click();
  }
});

// Init the focus setup UI
buildFocusCatPicker();
buildFocusRatingPicker();
wireFocusCountPicker();
wireFocusOrderPicker();
updateFocusSetupSummary();


// ============================================================
// AUTO-MODUS (Car Mode) — Shadowing fürs Auto
// ============================================================
const car = {
  // Setup config (persisted in localStorage)
  cats: new Set(loadJSON("hl_car_cats", [])),
  ratings: new Set(loadJSON("hl_car_ratings", ["unrated", "1", "2", "3"])),
  repeats: loadJSON("hl_car_repeats", 3),
  shadowPause: loadJSON("hl_car_shadow", 2.5),    // seconds of silence after each playback (shadowing gap)
  sentencePause: loadJSON("hl_car_gap", 2.5),     // seconds between sentences
  // Reihenfolge: "random" (default) | "newest" | "oldest". Ersetzt das alte
  // shuffle-Boolean (Mai 2026). "newest" sortiert User-Sätze nach created_at
  // DESC und hängt die 84 Originale dahinter (ID ASC); "oldest" dreht das um.
  // Loop-Verhalten: bei "random" wird bei jedem neuen Durchgang neu gemischt;
  // bei "newest"/"oldest" bleibt die Reihenfolge stabil (so kommt das "neu
  // zuerst" auch im 2./3./… Durchgang wieder).
  sort: loadJSON("hl_car_sort", loadJSON("hl_car_shuffle", true) ? "random" : "oldest"),
  loop: loadJSON("hl_car_loop", true),
  night: loadJSON("hl_car_night", false),
  // Session state (runtime only)
  active: false,
  queue: [],
  idx: 0,
  repCount: 0,
  paused: false,
  pendingTimer: null,
  wakeLock: null,
  // Background-Audio-Fix (Mai 2026, double-buffered): zwei HTMLAudioElement-
  // Instanzen, die sich abwechseln. Während Buf A den aktuellen Satz spielt,
  // lädt Buf B den nächsten Satz schon vor (src + load()). Auf `ended` wechseln
  // wir auf B und spielen — KEIN src-Reset auf dem aktiven Element zur Play-Zeit
  // nötig. Das ist der einzige zuverlässige Weg, um Android Chrome dazu zu
  // bringen, im Hintergrund (Bildschirm gesperrt) mehr als 1–2 Sätze
  // hintereinander zu spielen.
  //   _buffers     = [audioEl, audioElB]  — wird lazy in ensureCarBuffers() befüllt
  //   _activeBuf   = 0 | 1                — Index in _buffers für aktuellen Player
  //   _preloadedId = ID, die im OTHER-Buf vorgeladen ist (null = nichts vorgeladen)
  //   _lastSrcId   = ID, die zuletzt gespielt wurde (für Shadow-Repeat-Detection)
  _buffers: null,
  _activeBuf: 0,
  _preloadedId: null,
  _lastSrcId: null,
};

// Zweites Audio-Element für Double-Buffering. Wird lazy beim ersten
// startCarSession() angelegt und in den DOM gehängt. Hidden, denselben
// preload="auto"-Mode wie das Haupt-Element.
let audioElB = null;
function ensureCarBuffers() {
  if (car._buffers) return;
  audioElB = document.createElement("audio");
  audioElB.preload = "auto";
  audioElB.style.display = "none";
  document.body.appendChild(audioElB);
  audioElB.addEventListener("ended", function () {
    if (!car.active || car.paused) return;
    // Nur reagieren, wenn dieses Element gerade der AKTIVE Car-Buf ist.
    if (!car._buffers || car._buffers[car._activeBuf] !== audioElB) return;
    carAdvance(false);
  });
  car._buffers = [audioEl, audioElB];
}
// Silent-Keepalive (Mai 2026, v16): drittes Audio-Element, das stille Loop
// während der gesamten Car-Session abspielt. Hält die Audio-Session und den
// „audible tab"-Status bei Android Chrome durchgehend aktiv — so kann die
// Lücke zwischen Sätzen Chrome nicht dazu bringen, den Audio-Slot freizugeben.
let audioElSilent = null;
let _silentBlobUrl = null;
function ensureSilentBlob() {
  if (_silentBlobUrl) return _silentBlobUrl;
  // 1-Sekunde silent WAV erzeugen — bei v16 stand das auf 8kHz mono, was Android
  // dazu gebracht hat, die Audio-Session auf Voice-Channel zu legen (downsampled
  // alle anderen Streams auf 8kHz → Sätze klangen gedämpft/unscharf). Ab v18
  // 44.1kHz mono — matched typische MP3-Sample-Rates und zwingt Android auf den
  // Media-Channel. 1 sec * 44100 * 2 Bytes = ~88KB Blob, akzeptabel.
  const sampleRate = 44100;
  const numSamples = sampleRate;     // 1 second
  const dataLength = numSamples * 2; // 16-bit
  const buf = new ArrayBuffer(44 + dataLength);
  const dv = new DataView(buf);
  // RIFF header
  dv.setUint8(0, 0x52); dv.setUint8(1, 0x49); dv.setUint8(2, 0x46); dv.setUint8(3, 0x46);  // "RIFF"
  dv.setUint32(4, 36 + dataLength, true);
  dv.setUint8(8, 0x57); dv.setUint8(9, 0x41); dv.setUint8(10, 0x56); dv.setUint8(11, 0x45); // "WAVE"
  // fmt subchunk
  dv.setUint8(12, 0x66); dv.setUint8(13, 0x6d); dv.setUint8(14, 0x74); dv.setUint8(15, 0x20); // "fmt "
  dv.setUint32(16, 16, true);          // PCM chunk size
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true);           // block align
  dv.setUint16(34, 16, true);          // bits per sample
  // data subchunk
  dv.setUint8(36, 0x64); dv.setUint8(37, 0x61); dv.setUint8(38, 0x74); dv.setUint8(39, 0x61); // "data"
  dv.setUint32(40, dataLength, true);
  // Samples sind alle 0 (Silent), ArrayBuffer ist zero-initialized → keine Writes nötig
  const blob = new Blob([buf], { type: "audio/wav" });
  _silentBlobUrl = URL.createObjectURL(blob);
  return _silentBlobUrl;
}
function startSilentKeepalive() {
  if (audioElSilent && !audioElSilent.paused) return;
  if (!audioElSilent) {
    audioElSilent = document.createElement("audio");
    audioElSilent.loop = true;
    audioElSilent.preload = "auto";
    audioElSilent.style.display = "none";
    audioElSilent.src = ensureSilentBlob();
    audioElSilent.volume = 0.0001;  // Praktisch unhörbar
    document.body.appendChild(audioElSilent);
  }
  const p = audioElSilent.play();
  if (p && typeof p.then === "function") {
    p.catch(function (err) { console.warn("silentKeepalive failed:", err); });
  }
}
function stopSilentKeepalive() {
  if (!audioElSilent) return;
  try { audioElSilent.pause(); } catch (e) {}
}

function carActiveBuf() {
  return car._buffers ? car._buffers[car._activeBuf] : audioEl;
}
function carOtherBuf() {
  return car._buffers ? car._buffers[1 - car._activeBuf] : null;
}
// Preload des NÄCHSTEN Plays in den OTHER-Buf. Setzt src + ruft load() auf,
// damit der Browser die Datei schon dekodiert, während der aktuelle Satz noch
// läuft. Beim nächsten playCarCurrent() können wir dann einfach swap+play().
function preloadOtherBuf() {
  if (!car._buffers || !car.active) return;
  // Welche ID kommt als nächstes?
  //   - repCount+1 < repeats  → noch ein Shadow-Repeat desselben Satzes
  //   - sonst                  → nächste Karte (mit Loop/Shuffle handled in carAdvance)
  let nextId;
  if (car.repCount + 1 < car.repeats) {
    nextId = car.queue[car.idx];
  } else {
    const nextIdx = car.idx + 1 >= car.queue.length
      ? (car.loop ? 0 : -1)
      : car.idx + 1;
    if (nextIdx < 0) return;  // Session endet — nichts zu preloaden
    nextId = car.queue[nextIdx];
  }
  const nextS = getSentenceById(nextId);
  if (!nextS) return;
  const nextSrc = audioSrcFor(nextS);
  if (!nextSrc) return;
  const otherBuf = carOtherBuf();
  if (!otherBuf) return;
  // Bereits vorgeladen für diese ID? Skip.
  if (car._preloadedId === nextId && otherBuf.src && otherBuf.readyState >= 2) return;
  try {
    otherBuf.src = nextSrc;
    otherBuf.load();
    car._preloadedId = nextId;
  } catch (e) { /* ignore */ }
}

// One-time migration: bump 3.0/1.5 -> 0.5/1.0 if user is still on old defaults
if (!localStorage.getItem("hl_car_defaults_v2")) {
  if (car.shadowPause === 3.0) { car.shadowPause = 0.5; localStorage.setItem("hl_car_shadow", "0.5"); }
  if (car.sentencePause === 1.5) { car.sentencePause = 1.0; localStorage.setItem("hl_car_gap", "1.0"); }
  localStorage.setItem("hl_car_defaults_v2", "1");
}

// One-time migration (Juni 2026): neue Standard-Pausen 2.5s/2.5s. Nur Installs,
// die noch auf den alten Defaults (0.5/1.0) sitzen, werden angehoben — manuell
// gesetzte Werte bleiben unangetastet.
if (!localStorage.getItem("hl_car_defaults_v3")) {
  if (car.shadowPause === 0.5) { car.shadowPause = 2.5; localStorage.setItem("hl_car_shadow", "2.5"); }
  if (car.sentencePause === 1.0) { car.sentencePause = 2.5; localStorage.setItem("hl_car_gap", "2.5"); }
  localStorage.setItem("hl_car_defaults_v3", "1");
}

function saveCarConfig() {
  saveJSON("hl_car_cats", Array.from(car.cats));
  saveJSON("hl_car_ratings", Array.from(car.ratings));
  saveJSON("hl_car_repeats", car.repeats);
  saveJSON("hl_car_shadow", car.shadowPause);
  saveJSON("hl_car_gap", car.sentencePause);
  saveJSON("hl_car_sort", car.sort);
  saveJSON("hl_car_loop", car.loop);
  saveJSON("hl_car_night", car.night);
}

// DOM refs
const carBtn = document.getElementById("car-mode-btn");
const carSessionEl = document.getElementById("car-session");
const carSetupEl = document.getElementById("car-setup");
const carActiveEl = document.getElementById("car-active");
const carCatPickerEl = document.getElementById("car-cat-picker");
const carRatingPickerEl = document.getElementById("car-rating-picker");
const carRepeatsPickerEl = document.getElementById("car-repeats-picker");
const carRepeatsValueEl = document.getElementById("car-repeats-value");
const carShadowSliderEl = document.getElementById("car-shadow-slider");
const carShadowValueEl = document.getElementById("car-shadow-value");
const carGapSliderEl = document.getElementById("car-gap-slider");
const carGapValueEl = document.getElementById("car-gap-value");
const carSortPickerEl = document.getElementById("car-sort-picker");
const carSortHintEl = document.getElementById("car-sort-hint");
const carLoopToggleEl = document.getElementById("car-loop-toggle");
const carNightToggleEl = document.getElementById("car-night-toggle");
const carSetupSummaryEl = document.getElementById("car-setup-summary");
const carStartBtn = document.getElementById("car-start-btn");
const carCloseBtn = document.getElementById("car-close-btn");
const carSettingsBtn = document.getElementById("car-settings-btn");
const carCounterEl = document.getElementById("car-counter");
const carProgressFillEl = document.getElementById("car-progress-fill");
const carStageEl = document.getElementById("car-stage");
const carEsEl = document.getElementById("car-es");
const carDeEl = document.getElementById("car-de");
const carCatsEl = document.getElementById("car-cats");
const carStatusEl = document.getElementById("car-status");
const carPrevBtn = document.getElementById("car-prev-btn");
const carNextBtn = document.getElementById("car-next-btn");
const carPlayBtn = document.getElementById("car-play-btn");
const carPlayIcon = document.getElementById("car-play-icon");
const carPauseIcon = document.getElementById("car-pause-icon");

// ---- Build pickers ----
function buildCarCatPicker() {
  carCatPickerEl.innerHTML = "";
  for (const cat of DATA.categories) {
    const chip = document.createElement("button");
    chip.className = "car-cat-chip" + (car.cats.has(cat.key) ? " active" : "");
    chip.textContent = cat.label;
    chip.onclick = function () {
      if (car.cats.has(cat.key)) car.cats.delete(cat.key);
      else car.cats.add(cat.key);
      chip.classList.toggle("active");
      saveCarConfig();
      updateCarSetupSummary();
    };
    carCatPickerEl.appendChild(chip);
  }
}

function buildCarRatingPicker() {
  carRatingPickerEl.innerHTML = "";
  const starSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
  const brainSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg>';
  const emptyStar = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';
  const items = [
    { key: "unrated", label: "Unrated", icon: '<span class="chip-stars">' + emptyStar + '</span>' },
    { key: "1", label: "Schwierig", icon: '<span class="chip-stars">' + starSvg + '</span>' },
    { key: "2", label: "Okay", icon: '<span class="chip-stars">' + starSvg + starSvg + '</span>' },
    { key: "3", label: "Easy", icon: '<span class="chip-stars">' + starSvg + starSvg + starSvg + '</span>' },
    { key: "learned", label: "Gelernt", icon: '<span class="chip-brain">' + brainSvg + '</span>' },
  ];
  for (const it of items) {
    const chip = document.createElement("button");
    chip.className = "car-rating-chip" + (car.ratings.has(it.key) ? " active" : "");
    chip.innerHTML = it.icon + '<span>' + it.label + '</span>';
    chip.onclick = function () {
      if (car.ratings.has(it.key)) car.ratings.delete(it.key);
      else car.ratings.add(it.key);
      chip.classList.toggle("active");
      saveCarConfig();
      updateCarSetupSummary();
    };
    carRatingPickerEl.appendChild(chip);
  }
}

// ---- Wire setup controls ----
function wireCarSetup() {
  // Repeats segmented control
  carRepeatsPickerEl.querySelectorAll(".car-repeats-chip").forEach(function (btn) {
    const val = parseInt(btn.dataset.rep, 10);
    btn.classList.toggle("active", val === car.repeats);
    btn.onclick = function () {
      carRepeatsPickerEl.querySelectorAll(".car-repeats-chip").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      car.repeats = val;
      carRepeatsValueEl.textContent = car.repeats + "×";
      saveCarConfig();
    };
  });
  carRepeatsValueEl.textContent = car.repeats + "×";

  // Sliders
  carShadowSliderEl.value = String(car.shadowPause);
  carShadowValueEl.textContent = car.shadowPause.toFixed(1) + " s";
  carShadowSliderEl.oninput = function () {
    car.shadowPause = parseFloat(carShadowSliderEl.value);
    carShadowValueEl.textContent = car.shadowPause.toFixed(1) + " s";
    saveCarConfig();
  };
  carGapSliderEl.value = String(car.sentencePause);
  carGapValueEl.textContent = car.sentencePause.toFixed(1) + " s";
  carGapSliderEl.oninput = function () {
    car.sentencePause = parseFloat(carGapSliderEl.value);
    carGapValueEl.textContent = car.sentencePause.toFixed(1) + " s";
    saveCarConfig();
  };

  // Reihenfolge-Picker
  function renderCarSortPicker() {
    if (!carSortPickerEl) return;
    const chips = carSortPickerEl.querySelectorAll(".car-sort-chip");
    chips.forEach(function (chip) {
      chip.classList.toggle("active", chip.getAttribute("data-sort") === car.sort);
    });
    if (carSortHintEl) {
      const hints = {
        random: "Bei jedem Durchgang neu mischen.",
        newest: "Deine zuletzt hinzugefügten Sätze zuerst — Originale am Ende. Reihenfolge bleibt über Durchgänge stabil.",
        oldest: "Originale zuerst, deine eigenen Sätze chronologisch danach. Reihenfolge bleibt über Durchgänge stabil.",
      };
      carSortHintEl.textContent = hints[car.sort] || hints.random;
    }
  }
  renderCarSortPicker();
  if (carSortPickerEl) {
    carSortPickerEl.querySelectorAll(".car-sort-chip").forEach(function (chip) {
      chip.onclick = function () {
        const v = chip.getAttribute("data-sort");
        if (!v || v === car.sort) return;
        car.sort = v;
        renderCarSortPicker();
        saveCarConfig();
      };
    });
  }
  carLoopToggleEl.classList.toggle("on", car.loop);
  carLoopToggleEl.onclick = function () {
    car.loop = !car.loop;
    carLoopToggleEl.classList.toggle("on", car.loop);
    saveCarConfig();
  };
  carNightToggleEl.classList.toggle("on", car.night);
  carNightToggleEl.onclick = function () {
    car.night = !car.night;
    carNightToggleEl.classList.toggle("on", car.night);
    if (car.active) document.body.classList.toggle("car-night", car.night);
    saveCarConfig();
  };
}

function carEligibleSentences() {
  return allSentences().filter(function (s) {
    if (s.archived) return false;
    if (s.pending) return false;
    if (!s.es) return false;
    if (!hasAudio(s)) return false;
    if (stageOf(s.id) !== "active") return false;  // intro/backlog excluded
    if (car.cats.size > 0 && !s.cats.some(function (c) { return car.cats.has(c); })) return false;
    if (car.ratings.size > 0) {
      let match = false;
      for (const key of car.ratings) {
        if (ratingMatches(s.id, key)) { match = true; break; }
      }
      if (!match) return false;
    }
    return true;
  });
}

// Sort-Helper für Car-Queue. sortKey ∈ {"random", "newest", "oldest"}.
// - "random":  Fisher-Yates Shuffle.
// - "newest":  User-Sätze (ID ≥ 85) zuerst, sortiert nach created_at DESC,
//              fallback ID DESC. Originale (ID 1..84) danach in ID ASC.
//              Begründung: Originale haben kein created_at und sind das
//              "Fundament" — User-Sätze sind alles, was später dazukam.
// - "oldest":  Spiegelbild von "newest" — Originale ID ASC zuerst, User-Sätze
//              nach created_at ASC, fallback ID ASC danach.
// Liefert eine neue Array, mutiert das Input nicht.
// carSortEligible() lebt seit Juni 2026 in core.js (testbar).

function updateCarSetupSummary() {
  const eligible = carEligibleSentences();
  carSetupSummaryEl.textContent = eligible.length === 0
    ? "Keine Karten mit Audio in dieser Auswahl"
    : (eligible.length + " Karten mit Audio bereit");
  carStartBtn.disabled = eligible.length === 0;
}

// ---- Wake Lock ----
async function requestCarWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    car.wakeLock = await navigator.wakeLock.request("screen");
    car.wakeLock.addEventListener("release", function () { car.wakeLock = null; });
  } catch (e) {
    console.warn("Wake Lock request failed:", e);
  }
}
async function releaseCarWakeLock() {
  if (!car.wakeLock) return;
  try { await car.wakeLock.release(); } catch (e) { /* ignore */ }
  car.wakeLock = null;
}
document.addEventListener("visibilitychange", function () {
  if (car.active && !document.hidden && !car.wakeLock) requestCarWakeLock();
});

// ---- Session lifecycle ----
function startCarSession() {
  const eligible = carEligibleSentences();
  if (eligible.length === 0) return;

  const ordered = carSortEligible(eligible, car.sort);
  car.queue = ordered.map(function (s) { return s.id; });
  car.idx = 0;
  car.repCount = 0;
  car.paused = false;
  car.active = true;
  // Session-Tracking für die End-of-Session-Postkarte (B2, Juni 2026)
  car._sessionStart = Date.now();
  car._sessionReps = 0;

  carSetupEl.style.display = "none";
  carActiveEl.style.display = "flex";
  // Version-Badge im Topbar setzen — damit Maurizio auf dem Handy sehen
  // kann ob die neueste Build-Version live ist.
  const verEl = document.getElementById("car-version-badge");
  if (verEl) verEl.textContent = APP_VERSION;
  document.body.classList.add("car-driving");
  if (car.night) document.body.classList.add("car-night");
  window.scrollTo(0, 0);

  requestCarWakeLock();
  renderCarCard();

  // Silent-Keepalive (v16): stille Loop starten, damit Chrome den Audio-
  // Slot zwischen Sätzen nicht freigibt. Im User-Gesture (Start-Button-
  // Klick) damit Autoplay-Permission gewährt wird.
  startSilentKeepalive();

  // Background-Audio-Fix (Mai 2026): audioElB im User-Gesture priming. Ohne
  // diesen Schritt verweigert Android Chrome dem zweiten Audio-Element die
  // Autoplay-Permission, weil es nie einen direkt User-initiierten play()-
  // Aufruf gesehen hat. Beim ersten Swap im Hintergrund (auf audioElB)
  // würde play() sonst still failen. Stumm und kurz reicht, um die
  // Permission zu vergeben.
  ensureCarBuffers();
  if (audioElB) {
    const firstS = getSentenceById(car.queue[0]);
    const firstSrc = firstS ? audioSrcFor(firstS) : null;
    if (firstSrc) {
      try {
        audioElB.muted = true;
        audioElB.src = firstSrc;
        // Mark als vorgeladen, damit Pfad (1) in playCarCurrent für den
        // ersten Karten-Wechsel direkt swap-ready ist.
        car._preloadedId = car.queue[0];
        const primePromise = audioElB.play();
        if (primePromise && typeof primePromise.then === "function") {
          primePromise.then(function () {
            try { audioElB.pause(); } catch (e) {}
            try { audioElB.currentTime = 0; } catch (e) {}
            audioElB.muted = false;
          }).catch(function () {
            audioElB.muted = false;
          });
        }
      } catch (e) {
        audioElB.muted = false;
      }
    }
  }

  playCarCurrent();
}

function exitCarSession() {
  car.active = false;
  car.paused = false;
  car._lastSrcId = null;
  car._preloadedId = null;
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  // Bugfix Juni 2026: Quick-Listen-Timer (Hero-Button, 5-Min-Auto-Stop) hier
  // IMMER abräumen. Vorher überlebte er ein manuelles Session-Ende und
  // beendete dann eine später gestartete REGULÄRE Shadow-Session nach 5 Min.
  if (typeof _quickListenStopTimer !== "undefined" && _quickListenStopTimer) {
    clearTimeout(_quickListenStopTimer);
    _quickListenStopTimer = null;
  }
  // Double-Buffer: beide Audio-Elemente pausieren beim Exit.
  try { audioEl.pause(); } catch (e) { /* ignore */ }
  if (audioElB) { try { audioElB.pause(); } catch (e) { /* ignore */ } }
  stopSilentKeepalive();
  releaseCarWakeLock();
  carActiveEl.style.display = "none";
  carSetupEl.style.display = "block";
  document.body.classList.remove("car-driving");
  document.body.classList.remove("car-night");
  updateCarSetupSummary();
}

function renderCarCard() {
  const id = car.queue[car.idx];
  const s = getSentenceById(id);
  if (!s) { exitCarSession(); return; }
  carEsEl.textContent = s.es || "—";
  carDeEl.textContent = s.de || "";
  carCatsEl.innerHTML = "";
  (s.cats || []).forEach(function (catKey) {
    const cat = DATA.categories.find(function (c) { return c.key === catKey; });
    if (cat) {
      const tag = document.createElement("span");
      tag.className = "car-cat-tag";
      tag.textContent = cat.label;
      carCatsEl.appendChild(tag);
    }
  });
  carCounterEl.textContent = "KARTE " + (car.idx + 1) + " / " + car.queue.length + " · WDH " + (car.repCount + 1) + " / " + car.repeats;
  const pct = ((car.idx * car.repeats + car.repCount) / (car.queue.length * car.repeats)) * 100;
  carProgressFillEl.style.width = pct + "%";
  carStatusEl.textContent = "";
}

function playCarCurrent() {
  if (!car.active || car.paused) return;
  ensureCarBuffers();
  const id = car.queue[car.idx];
  const s = getSentenceById(id);
  if (!s) { exitCarSession(); return; }
  const src = audioSrcFor(s);
  if (!src) {
    carStatusEl.textContent = "Kein Audio — überspringe…";
    car.repCount = car.repeats - 1;
    carAdvance(true);
    return;
  }
  // Android-Flicker-Fix: playbackState VOR src-Wechsel auf "playing", damit
  // die Lücke zwischen ended → setTimeout → play() nicht zum Schließen der
  // Status-Bar-Notification führt.
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
  }

  // Double-Buffered Audio (Mai 2026): drei Pfade, je nachdem ob der nächste
  // Buf bereits die richtige Karte vorgeladen hat.
  //   (1) OTHER-Buf hat die ID vorgeladen → swap zu OTHER, einfach play()
  //       (KEIN src-Reset — das ist der Background-friendly Fall).
  //   (2) ACTIVE-Buf hat den gleichen Satz noch geladen (Shadow-Repeat oder
  //       Fallback nach failed preload) → currentTime=0 auf ACTIVE, play().
  //   (3) Fallback: ACTIVE-Buf src neu setzen und play() (initial play oder
  //       nach Skip/Resume — hier sind wir typisch noch im Foreground).
  const otherBuf = carOtherBuf();
  const activeBuf = carActiveBuf();
  const otherHasIt = car._preloadedId === id && otherBuf && otherBuf.src && otherBuf.readyState >= 2;
  let bufToPlay;
  if (otherHasIt) {
    // Pfad (1): swap
    try { activeBuf.pause(); } catch (e) { /* ignore */ }
    car._activeBuf = 1 - car._activeBuf;
    bufToPlay = carActiveBuf();
    try { bufToPlay.currentTime = 0; } catch (e) { /* ignore */ }
    car._preloadedId = null;
  } else if (car._lastSrcId === id && activeBuf.src) {
    // Pfad (2): Shadow-Repeat ohne Preload-Hit — rewind und play
    bufToPlay = activeBuf;
    try { bufToPlay.currentTime = 0; } catch (e) { /* ignore */ }
  } else {
    // Pfad (3): Fallback — vollständiger src-Reset
    bufToPlay = activeBuf;
    bufToPlay.src = src;
  }
  car._lastSrcId = id;
  bufToPlay.playbackRate = 1.0;
  bufToPlay.play().then(function () {
    carPauseIcon.style.display = "block";
    carPlayIcon.style.display = "none";
    carStatusEl.textContent = "Spielt ab";
    // PWA: refresh Lockscreen-Metadata für jeden neuen Satz, sonst verschwindet
    // der Media-Session-Player nach dem ersten Clip (Android sieht die Session
    // sonst als stale an).
    if (typeof updateMediaSessionMetadata === "function") updateMediaSessionMetadata(s);
    // Background-Audio-Fix: setPositionState() verankert die MediaSession bei
    // Android, sonst stuft Chrome die Session im Hintergrund als "stale" ein.
    if ("mediaSession" in navigator && typeof navigator.mediaSession.setPositionState === "function") {
      const dur = bufToPlay.duration;
      if (dur && isFinite(dur) && dur > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: bufToPlay.playbackRate || 1.0,
            position: 0,
          });
        } catch (e) { /* invalid state — ignore */ }
      }
    }
    incrementStat("plays");
    // Tagesziel V1: jeder Shadow-Play = 1 Rep (1× anhören + nachsprechen).
    // playCarCurrent läuft ausschließlich im Shadow Mode, daher zählt jeder
    // erfolgreiche Play hier genau eine Wiederholung fürs Tagespensum.
    incrementStat("shadow_reps");
    // Session-Counter für die End-of-Session-Postkarte (B2, Juni 2026).
    car._sessionReps = (car._sessionReps || 0) + 1;
    // Double-Buffer: jetzt den NÄCHSTEN Play in den OTHER-Buf vorladen, damit
    // der Swap beim nächsten ended() ohne src-Reset auskommt.
    preloadOtherBuf();
    // SW-Cache-Warmup für die übernächste Karte (eine vor der nächsten).
    if (typeof preloadNextCarAudio === "function") preloadNextCarAudio();
  }).catch(function (err) {
    console.error("Car play failed", err);
    carStatusEl.textContent = "Audio-Fehler";
    car.repCount = car.repeats - 1;
    carAdvance(true);
  });
}

function carPause() {
  if (!car.active) return;
  car.paused = true;
  // Double-Buffer: nur den AKTIVEN Buf pausieren. Der andere ist vorgeladen
  // aber nicht abgespielt — kein pause() nötig.
  try { carActiveBuf().pause(); } catch (e) { /* ignore */ }
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  carPauseIcon.style.display = "none";
  carPlayIcon.style.display = "block";
  carStatusEl.textContent = "Pausiert";
}

function carResume() {
  if (!car.active) return;
  car.paused = false;
  const buf = carActiveBuf();
  if (buf.src && buf.paused && buf.currentTime > 0 && buf.currentTime < (buf.duration || Infinity)) {
    buf.play().then(function () {
      carPauseIcon.style.display = "block";
      carPlayIcon.style.display = "none";
      carStatusEl.textContent = "Spielt ab";
    }).catch(function () { playCarCurrent(); });
  } else {
    playCarCurrent();
  }
}

function carAdvance(skipPause) {
  if (!car.active) return;
  car.repCount++;

  // Android-Flicker-Fix: Solange wir zwischen Sätzen sind (Shadow-Pause oder
  // Sentence-Pause), audioEl ist gerade ended → Android würde die Media-
  // Notification implizit schließen. Wir setzen playbackState explizit auf
  // "paused" (statt "none"), damit die Notification mit Play-Icon stehen
  // bleibt. Der nächste playCarCurrent() schaltet dann wieder auf "playing".
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = "paused"; } catch (e) {}
  }

  // PWA-Background-Pausen-Fix (Juni 2026): Früher haben wir im Hintergrund
  // (document.hidden) die Pause komplett übersprungen und synchron
  // weitergemacht — weil Android/iOS setTimeout in versteckten Tabs drosseln,
  // SOBALD kein Audio läuft. Folge: bei gesperrtem Screen kamen die Sätze ohne
  // Shadow-/Satz-Pause am Stück. Seit dem Silent-Keepalive (v16/v18) läuft
  // während der GANZEN Session durchgehend ein stilles Audio-Element — der Tab
  // bleibt also „audible" und die Timer werden NICHT mehr gedrosselt, auch in
  // der Pause zwischen zwei Sätzen (da spielt nur das Keepalive). Deshalb
  // dürfen wir die Pause jetzt auch im Hintergrund regulär via setTimeout
  // einhalten. NICHT wieder auf den synchronen Skip zurückbauen, solange das
  // Silent-Keepalive existiert — sonst sind die Pausen im Hintergrund wieder weg.
  const proceedNext = function () {
    if (car.active && !car.paused) {
      renderCarCard();
      playCarCurrent();
    }
  };
  const schedule = function (delayMs) {
    if (delayMs <= 0) {
      car.pendingTimer = null;
      proceedNext();
      return;
    }
    car.pendingTimer = setTimeout(function () {
      car.pendingTimer = null;
      proceedNext();
    }, delayMs);
  };

  if (car.repCount < car.repeats) {
    carStatusEl.textContent = "Shadow-Pause…";
    schedule(skipPause ? 0 : car.shadowPause * 1000);
  } else {
    car.repCount = 0;
    car.idx++;
    if (car.idx >= car.queue.length) {
      if (car.loop) {
        // Bei "random": Queue neu mischen, damit jeder Durchgang anders ist.
        // Bei "newest"/"oldest": Reihenfolge bleibt stabil — der User hat sich
        // bewusst dafür entschieden, Neue/Alte zuerst zu hören, also reproduzieren
        // wir dieselbe Reihenfolge in jedem Durchgang.
        if (car.sort === "random" || (car.sort !== "newest" && car.sort !== "oldest")) {
          for (let i = car.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = car.queue[i]; car.queue[i] = car.queue[j]; car.queue[j] = tmp;
          }
        }
        car.idx = 0;
      } else {
        carStatusEl.textContent = "Fertig — gut gemacht!";
        car.pendingTimer = setTimeout(function () {
          car.pendingTimer = null;
          exitCarSession();
        }, 2000);
        return;
      }
    }
    carStatusEl.textContent = "Nächste Karte…";
    schedule(skipPause ? 0 : car.sentencePause * 1000);
  }
}

function carSkipNext() {
  if (!car.active) return;
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  // Double-Buffer: aktiven Buf pausieren (nicht zwangsweise audioEl).
  try { carActiveBuf().pause(); } catch (e) { /* ignore */ }
  car.repCount = car.repeats - 1;
  carAdvance(true);
}

function carSkipPrev() {
  if (!car.active) return;
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  try { carActiveBuf().pause(); } catch (e) { /* ignore */ }
  car.repCount = 0;
  car.idx = (car.idx - 1 + car.queue.length) % car.queue.length;
  // Skip-Prev springt zu einer anderen ID → preload für OTHER-Buf ist ungültig.
  car._preloadedId = null;
  renderCarCard();
  if (!car.paused) playCarCurrent();
}

audioEl.addEventListener("ended", function () {
  if (!car.active || car.paused) return;
  // Double-Buffer: nur reagieren, wenn audioEl der AKTIVE Car-Buf ist.
  // (audioElB hat seinen eigenen ended-Handler in ensureCarBuffers().)
  if (car._buffers && car._buffers[car._activeBuf] !== audioEl) return;
  carAdvance(false);
});

carStartBtn.onclick = startCarSession;
// ===== End-of-Session-Postkarte (B2+E1 · Motivations-Sprint Juni 2026) =====
// Kein Konfetti, kein Toast — drei Zahlen für den Stolz (Minuten, Reps,
// Serie) und ein „Morgen"-Hint als Open Loop. Erscheint nach beendeten
// Shadow-Sessions (Beenden-Knopf + Quick-Listen-Auto-Stop), NICHT bei
// goToDashboard oder Settings-Wechsel (dort will der User woanders hin).
function collectCarSessionData() {
  const mins = car._sessionStart
    ? Math.max(1, Math.round((Date.now() - car._sessionStart) / 60000))
    : 0;
  return { minutes: mins, reps: car._sessionReps || 0 };
}
function showSessionPostcard(data) {
  // Leere Session (0 Reps) → nichts feiern, nichts zeigen.
  if (!data || !data.reps) return;
  const el = document.getElementById("session-postcard");
  if (!el) return;
  const statsEl = document.getElementById("postcard-stats");
  if (statsEl) {
    statsEl.innerHTML = "";
    const items = [
      { num: data.minutes, lbl: data.minutes === 1 ? "Minute" : "Minuten" },
      { num: data.reps, lbl: "Reps" },
    ];
    for (const it of items) {
      const d = document.createElement("div");
      d.className = "postcard-stat";
      const n = document.createElement("div");
      n.className = "num";
      n.textContent = it.num;
      const l = document.createElement("div");
      l.className = "lbl";
      l.textContent = it.lbl;
      d.appendChild(n); d.appendChild(l);
      statsEl.appendChild(d);
    }
  }
  const streakEl = document.getElementById("postcard-streak");
  if (streakEl) {
    const streak = (typeof computeStreak === "function") ? computeStreak() : 0;
    streakEl.textContent = streak > 1
      ? ("Serie: " + streak + " Tage — heute gesichert ✓")
      : "Heute gezählt ✓";
  }
  const tomorrowEl = document.getElementById("postcard-tomorrow");
  if (tomorrowEl) {
    const n = (typeof dueCountTomorrow === "function") ? dueCountTomorrow() : 0;
    tomorrowEl.textContent = n > 0
      ? ("Morgen warten " + n + " Karte" + (n === 1 ? "" : "n") + " im Recall auf dich.")
      : "Morgen ist dein Recall frei — einfach nur hören.";
  }
  el.style.display = "flex";
}
function hideSessionPostcard() {
  const el = document.getElementById("session-postcard");
  if (el) el.style.display = "none";
}
(function wireSessionPostcard() {
  const closeBtn = document.getElementById("postcard-close-btn");
  const contBtn = document.getElementById("postcard-continue-btn");
  if (closeBtn) closeBtn.onclick = hideSessionPostcard;
  if (contBtn) contBtn.onclick = function () {
    hideSessionPostcard();
    // Direkt wieder rein — ohne Setup-Zwischenschritt (User-Geste vorhanden).
    if (typeof setCarModeActive === "function" && typeof startCarSession === "function") {
      setCarModeActive();
      startCarSession();
    }
  };
})();

carCloseBtn.onclick = function () {
  if (car.idx > 0) {
    if (!confirm("Shadow Mode beenden?")) return;
  }
  const sessionData = collectCarSessionData();
  exitCarSession();
  showSessionPostcard(sessionData);
};
carSettingsBtn.onclick = function () {
  exitCarSession();
  showToast("Einstellungen anpassen und neu starten.", 3000);
};
carPrevBtn.onclick = function (e) { e.stopPropagation(); carSkipPrev(); };
carNextBtn.onclick = function (e) { e.stopPropagation(); carSkipNext(); };
carPlayBtn.onclick = function (e) {
  e.stopPropagation();
  if (car.paused) carResume();
  else carPause();
};
carStageEl.addEventListener("click", function () {
  if (!car.active) return;
  if (car.paused) carResume();
  else carPause();
});

function setCarModeActive() {
  state.mode = "car";
  document.body.classList.add("car");
  window.scrollTo(0, 0);
  document.body.classList.remove("recall");
  document.body.classList.remove("focus");
  listenBtn.classList.remove("primary"); listenBtn.classList.add("secondary");
  recallBtn.classList.remove("primary"); recallBtn.classList.add("secondary");
  focusBtn.classList.remove("primary"); focusBtn.classList.add("secondary");
  carBtn.classList.remove("secondary"); carBtn.classList.add("primary");
  if (modeHint) modeHint.textContent = "Shadow Mode: konfiguriere die Session und drücke Start.";

  if (car.active) {
    carSetupEl.style.display = "none";
    carActiveEl.style.display = "flex";
    if (car.night) document.body.classList.add("car-night");
  } else {
    carSetupEl.style.display = "block";
    carActiveEl.style.display = "none";
    updateCarSetupSummary();
  }
}

carBtn.onclick = setCarModeActive;

const _origListenForCar = listenBtn.onclick;
listenBtn.onclick = function () {
  if (car.active) exitCarSession();
  document.body.classList.remove("car");
  document.body.classList.remove("car-night");
  document.body.classList.remove("car-driving");
  carBtn.classList.remove("primary"); carBtn.classList.add("secondary");
  _origListenForCar.call(this);
};
const _origRecallForCar = recallBtn.onclick;
recallBtn.onclick = function () {
  if (car.active) exitCarSession();
  document.body.classList.remove("car");
  document.body.classList.remove("car-night");
  document.body.classList.remove("car-driving");
  carBtn.classList.remove("primary"); carBtn.classList.add("secondary");
  _origRecallForCar.call(this);
};
const _origFocusForCar = focusBtn.onclick;
focusBtn.onclick = function () {
  if (car.active) exitCarSession();
  document.body.classList.remove("car");
  document.body.classList.remove("car-night");
  document.body.classList.remove("car-driving");
  carBtn.classList.remove("primary"); carBtn.classList.add("secondary");
  _origFocusForCar.call(this);
};

buildCarCatPicker();
buildCarRatingPicker();
wireCarSetup();
updateCarSetupSummary();

// =====================================================================
// EINFÜHRUNGS-MODUS (Phase 3) — Glossika-style 5× exposure for new cards
// =====================================================================

const intro = {
  active: false,
  queue: [],            // array of sentence IDs in this session
  idx: 0,
  startedAt: 0,
  // session stats for the summary screen
  graduated: 0,         // intro_count reached 5+
  advanced: 0,          // intro_count incremented but still <5
  again: 0,             // "Nochmal" clicks
};

// DOM refs for intro session
const introSessionEl = document.getElementById("intro-session");
const introCardViewEl = document.getElementById("intro-card-view");
const introSummaryEl = document.getElementById("intro-summary");
const introProgressTextEl = document.getElementById("intro-progress-text");
const introProgressPoolEl = document.getElementById("intro-progress-pool");
const introProgressFillEl = document.getElementById("intro-progress-fill");
const introCardNumEl = document.getElementById("intro-card-num");
const introDotsEl = document.getElementById("intro-dots");
const introDeEl = document.getElementById("intro-de");
const introEsEl = document.getElementById("intro-es");
const introPlayBtn = document.getElementById("intro-play-btn");
const introAudioHintEl = document.getElementById("intro-audio-hint");
const introAgainBtn = document.getElementById("intro-again-btn");
const introGotBtn = document.getElementById("intro-got-btn");
const introSummaryTextEl = document.getElementById("intro-summary-text");
const introSummaryStatsEl = document.getElementById("intro-summary-stats");
const introSummaryDoneBtn = document.getElementById("intro-summary-done");
const introSummaryMoreBtn = document.getElementById("intro-summary-more");

// Glossika-Style Einführungs-Pool: max INTRO_POOL_SIZE Karten gleichzeitig
// aktiv. Sind alle 5 graduiert (intro_count → 5), kommen automatisch beim
// nächsten Session-Start 5 frische aus dem Backlog rein. Schafft eine
// gestaffelte Einführung statt einer überfordernden Mass-Promotion.
const INTRO_POOL_SIZE = 5;

// Glossika-Style Expositions-Anzahl: jede Karte pro Session INTRO_REPS-mal,
// in runden-weise shuffleter Reihenfolge. 5 Karten × 5 Wiederholungen = 25
// Plays pro Session. Der User klickt nach jeder Karte manuell „Verstanden"
// (zählt intro_count hoch) oder „Nochmal" (replayed Audio). Audio der
// nächsten Karte spielt automatisch ab — siehe `intro.idx > 0`-Check in
// showIntroCard. Issue-Quelle: User-Feedback Mai 2026 ("jetzt wird jede der
// 5 Karte nur einmal angezeigt", später "Auto-Advance fühlt sich falsch an").
const INTRO_REPS = 5;

function buildIntroQueue() {
  const introStage = [];
  const backlog = [];
  for (const s of allSentences()) {
    if (s.archived || s.pending || !s.es) continue;
    const stage = stageOf(s.id);
    if (stage === "intro") introStage.push(s.id);
    else if (stage === "backlog") backlog.push(s.id);
  }

  // Priorisiere die reifsten intro-stage Karten (intro_count desc) — die sind
  // näher an Graduierung und sollten zuerst durch.
  introStage.sort(function (a, b) {
    return getIntroCount(b) - getIntroCount(a);
  });

  // Take up to POOL_SIZE intro-stage cards
  let pool = introStage.slice(0, INTRO_POOL_SIZE);

  // Wenn Pool zu klein, mit Backlog auffüllen
  if (pool.length < INTRO_POOL_SIZE) {
    // Shuffle backlog für Zufalls-Auswahl
    for (let i = backlog.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = backlog[i]; backlog[i] = backlog[j]; backlog[j] = t;
    }
    const need = INTRO_POOL_SIZE - pool.length;
    const newcomers = backlog.slice(0, need);
    for (const id of newcomers) setIntroCount(id, 1);
    pool = pool.concat(newcomers);
  }

  // Glossika-Style: jede Karte INTRO_REPS-mal, runden-weise shuffled.
  // Statt einem Pool von N Karten à 1 Anzeige → N Karten × INTRO_REPS Anzeigen
  // (typisch 5×5 = 25). Auto-Advance auf Audio-Ende loopt passiv durch, der
  // User klickt nur bei Bedarf. Pool-Erhalt: in jeder Runde wird die gleiche
  // Pool-Karten-Liste frisch geshuffled — Cards sehen sich aus → kein Block
  // gleicher Karten hintereinander, aber jede Karte kommt garantiert REPS-mal.
  const queue = [];
  for (let r = 0; r < INTRO_REPS; r++) {
    const round = pool.slice();
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = round[i]; round[i] = round[j]; round[j] = t;
    }
    // Vermeide direkte Doppelung an Rundengrenzen (sonst kommt z.B. Karte A
    // als letzte einer Runde und als erste der nächsten direkt nochmal).
    if (r > 0 && queue.length > 0 && round.length > 1 && round[0] === queue[queue.length - 1]) {
      const t = round[0]; round[0] = round[1]; round[1] = t;
    }
    for (const id of round) queue.push(id);
  }
  return queue;
}

// Einmalige Migration: wenn der User aus der alten unbegrenzten Logik mehr als
// INTRO_POOL_SIZE Karten in intro-stage hat, schiebe die unreifsten zurück zu
// backlog. Idempotent — läuft jedes Mal, ist aber no-op sobald Pool stabil ist.
function maybeReslicePool() {
  const introStageIds = [];
  for (const s of allSentences()) {
    if (s.archived || s.pending || !s.es) continue;
    if (stageOf(s.id) === "intro") introStageIds.push(s.id);
  }
  if (introStageIds.length <= INTRO_POOL_SIZE) return;
  // Sort by intro_count desc — keep top POOL_SIZE, demote the rest
  introStageIds.sort(function (a, b) {
    return getIntroCount(b) - getIntroCount(a);
  });
  const toDemote = introStageIds.slice(INTRO_POOL_SIZE);
  for (const id of toDemote) setIntroCount(id, 0);
  console.info("[intro] resliced pool: " + toDemote.length + " Karten zurück in Backlog (Pool-Size " + INTRO_POOL_SIZE + ")");
}

function startIntroSession() {
  const queue = buildIntroQueue();
  if (queue.length === 0) {
    showToast("Keine Karten in Einführung. Schiebe eine Kategorie rein oder importiere neue Sätze.", 4000);
    setListenModeFromIntro();
    return;
  }
  intro.queue = queue;
  intro.idx = 0;
  intro.active = true;
  intro.startedAt = Date.now();
  intro.graduated = 0;
  intro.advanced = 0;
  intro.again = 0;
  introSummaryEl.style.display = "none";
  introCardViewEl.style.display = "block";
  showIntroCard();
}

function showIntroCard() {
  if (intro.idx >= intro.queue.length) { endIntroSession(); return; }
  const id = intro.queue[intro.idx];
  const s = getSentenceById(id);
  if (!s) { intro.idx++; showIntroCard(); return; }
  const count = getIntroCount(id);
  // Progress header — "Wiederholung X / Y" weil bei Glossika 5 Karten × 5 Reps = 25
  introProgressTextEl.textContent = "Wiederholung " + (intro.idx + 1) + " / " + intro.queue.length;
  const remaining = introPoolCount();
  introProgressPoolEl.textContent = remaining + " in Einführung";
  const pct = ((intro.idx) / intro.queue.length) * 100;
  introProgressFillEl.style.width = pct + "%";
  // Card content
  introCardNumEl.textContent = "#" + id;
  introDeEl.textContent = s.de;
  introEsEl.textContent = s.es;
  // Dots
  const dots = introDotsEl.querySelectorAll(".intro-dot");
  for (let i = 0; i < dots.length; i++) {
    dots[i].classList.toggle("filled", i < count);
  }
  // Audio
  const src = audioSrcFor(s);
  if (src) {
    introPlayBtn.disabled = false;
    introAudioHintEl.style.display = "none";
    audioEl.src = src;
    audioEl.playbackRate = state.speed || 1.0;
    // Auto-Play nur ab der ZWEITEN Karte. Bei der ersten Karte (intro.idx === 0)
    // wartet die App auf den manuellen Play-Klick — sonst startet Audio direkt
    // beim Sidebar-Klick, was du nicht willst (und macht die Browser-Autoplay-
    // Policy unhappy). Ab Karte 2 ist die User-Geste vom Verstanden/Nochmal-Klick
    // direkt in der Chain → autoplay läuft sauber.
    if (intro.idx > 0) {
      audioEl.play().catch(function (err) {
        console.warn("Intro autoplay blocked:", err);
      });
    }
  } else {
    introPlayBtn.disabled = true;
    introAudioHintEl.style.display = "block";
  }
}

introPlayBtn.onclick = function () {
  const id = intro.queue[intro.idx];
  const s = getSentenceById(id);
  if (!s) return;
  const src = audioSrcFor(s);
  if (!src) return;
  audioEl.src = src;
  audioEl.playbackRate = state.speed || 1.0;
  audioEl.play().catch(function (err) { console.warn("Intro play failed:", err); });
};

// Intro-Mode: KEIN Auto-Advance auf Audio-Ende. Nach dem Audio bleibt die
// Karte stehen, der User klickt manuell „Verstanden" (oder „Nochmal"), um
// weiterzukommen. Die nächste Karte spielt dann automatisch ab (siehe
// `intro.idx > 0` in showIntroCard). User-Entscheidung Mai 2026: Auto-Advance
// fühlte sich wie ein Zwangsdurchlauf an — bewusste Bestätigung pro Karte
// passt besser zur "Sanfte Einführung"-Idee.
//
// Der globale audio-ended-Listener returnt früh für state.mode === "intro",
// also tut hier explizit nichts zu hooken — wir lassen audio einfach enden.

introAgainBtn.onclick = function () {
  if (!intro.active) return;
  // "Nochmal": Audio einmal neu abspielen, KEIN Advance.
  // Karte kommt sowieso noch INTRO_REPS-mal in der Queue dran (Glossika-Stil).
  const id = intro.queue[intro.idx];
  const s = getSentenceById(id);
  if (!s) return;
  intro.again++;
  const src = audioSrcFor(s);
  if (!src) return;
  audioEl.src = src;
  audioEl.playbackRate = state.speed || 1.0;
  audioEl.play().catch(function (err) { console.warn("Intro replay failed:", err); });
};

introGotBtn.onclick = function () {
  if (!intro.active) return;
  const id = intro.queue[intro.idx];
  const before = getIntroCount(id);
  const after = Math.min(before + 1, 5);
  setIntroCount(id, after);
  // graduated zählt nur den Übergang <5 → 5 (einmalig pro Karte).
  // Spätere "Verstanden"-Klicks an einer schon graduierten Karte ändern nichts.
  if (before < 5 && after >= 5) intro.graduated++;
  else if (after > before) intro.advanced++;
  intro.idx++;
  showIntroCard();
};

function endIntroSession() {
  intro.active = false;
  introCardViewEl.style.display = "none";
  introSummaryEl.style.display = "flex";
  // Bei Glossika-Stil ist intro.idx = Anzahl tatsächlich gesehener Wiederholungen
  // (jedes Advance, ob manuell oder per Auto-Advance, zählt eins hoch).
  // intro.queue.length ist die geplante Session-Größe (typ. 25 = 5 × 5).
  const totalReps = intro.idx;
  const target = intro.queue.length;
  // Tagesziel V1: ein komplett durchgespielter Batch (alle geplanten
  // Wiederholungen gesehen) zählt als 1 Einführung fürs Tagespensum.
  if (target > 0 && totalReps >= target) {
    incrementStat("intro_runs");
  }
  introSummaryTextEl.textContent = totalReps >= target
    ? "Du hast " + totalReps + " Wiederholungen geschafft."
    : "Du hast " + totalReps + " von " + target + " Wiederholungen gemacht.";
  introSummaryStatsEl.innerHTML =
    '<div class="intro-summary-stat"><div class="intro-summary-stat-num">' + intro.graduated + '</div><div class="intro-summary-stat-label">graduiert</div></div>' +
    '<div class="intro-summary-stat"><div class="intro-summary-stat-num">' + totalReps + '</div><div class="intro-summary-stat-label">Wdh.</div></div>' +
    '<div class="intro-summary-stat"><div class="intro-summary-stat-num">' + intro.again + '</div><div class="intro-summary-stat-label">nochmal</div></div>';
  // Show "5 more from backlog" only if there's still backlog
  const stillBacklog = allSentences().some(function (s) {
    return !s.archived && !s.pending && s.es && stageOf(s.id) === "backlog";
  });
  introSummaryMoreBtn.style.display = stillBacklog ? "inline-flex" : "none";
  updateIntroModeBtn();
}

introSummaryDoneBtn.onclick = function () {
  introSummaryEl.style.display = "none";
  setListenModeFromIntro();
};
introSummaryMoreBtn.onclick = function () {
  startIntroSession();
};

function setIntroModeActive() {
  state.mode = "intro";
  document.body.classList.add("intro");
  window.scrollTo(0, 0);
  document.body.classList.remove("recall");
  document.body.classList.remove("focus");
  document.body.classList.remove("car");
  document.body.classList.remove("car-night");
  document.body.classList.remove("car-driving");
  listenBtn.classList.remove("primary"); listenBtn.classList.add("secondary");
  recallBtn.classList.remove("primary"); recallBtn.classList.add("secondary");
  focusBtn.classList.remove("primary"); focusBtn.classList.add("secondary");
  carBtn.classList.remove("primary"); carBtn.classList.add("secondary");
  introBtn.classList.remove("secondary"); introBtn.classList.add("primary");
  modeHint.textContent = "Sanfte Einführung: Karten 5× sehen, bevor sie in Listen/Recall kommen.";
  startIntroSession();
}

function setListenModeFromIntro() {
  // Reset mode chrome back to listen
  document.body.classList.remove("intro");
  introBtn.classList.remove("primary"); introBtn.classList.add("secondary");
  // Delegate to the existing listen button click handler
  listenBtn.click();
}

introBtn.onclick = setIntroModeActive;

// Wrap other mode buttons so that switching out of intro cleans up correctly
const _origListenForIntro = listenBtn.onclick;
listenBtn.onclick = function () {
  if (intro.active) intro.active = false;
  document.body.classList.remove("intro");
  introBtn.classList.remove("primary"); introBtn.classList.add("secondary");
  _origListenForIntro.call(this);
};
const _origRecallForIntro = recallBtn.onclick;
recallBtn.onclick = function () {
  if (intro.active) intro.active = false;
  document.body.classList.remove("intro");
  introBtn.classList.remove("primary"); introBtn.classList.add("secondary");
  _origRecallForIntro.call(this);
};
const _origFocusForIntro = focusBtn.onclick;
focusBtn.onclick = function () {
  if (intro.active) intro.active = false;
  document.body.classList.remove("intro");
  introBtn.classList.remove("primary"); introBtn.classList.add("secondary");
  _origFocusForIntro.call(this);
};
const _origCarForIntro = carBtn.onclick;
carBtn.onclick = function () {
  if (intro.active) intro.active = false;
  document.body.classList.remove("intro");
  introBtn.classList.remove("primary"); introBtn.classList.add("secondary");
  _origCarForIntro.call(this);
};

// Keyboard shortcuts inside intro session: V = Verstanden, N = Nochmal, Space = Play
// (Intro keydown handler — runs only when intro session is active.)
document.addEventListener("keydown", function (e) {
  if (state.mode !== "intro" || !intro.active) return;
  // Skip if user is typing in an input
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.key === "v" || e.key === "V") { e.preventDefault(); introGotBtn.click(); }
  else if (e.key === "n" || e.key === "N") { e.preventDefault(); introAgainBtn.click(); }
  else if (e.key === " ") { e.preventDefault(); introPlayBtn.click(); }
});

// Initial sync of the button enabled state and counter
updateIntroModeBtn();

// ----- Sidebar section: send a category back to Einführung -----
const introCatSelectEl = document.getElementById("intro-cat-select");
const introSendCatBtn = document.getElementById("intro-send-cat-btn");
const introSendCatText = document.getElementById("intro-send-cat-text");
const introSectionCountEl = document.getElementById("intro-section-count");

function buildIntroCatSelect() {
  if (!introCatSelectEl) return;
  // Preserve current selection
  const current = introCatSelectEl.value;
  introCatSelectEl.innerHTML = '<option value="">Kategorie wählen…</option>';
  for (const cat of DATA.categories) {
    // Show how many of this cat are currently active (eligible to be reset)
    let eligible = 0;
    for (const s of allSentences()) {
      if (s.archived || s.pending || !s.es) continue;
      if (!s.cats || !s.cats.includes(cat.key)) continue;
      if (stageOf(s.id) === "active") eligible++;
    }
    if (eligible === 0) continue;       // skip cats with no active cards
    const opt = document.createElement("option");
    opt.value = cat.key;
    opt.textContent = cat.label + " (" + eligible + ")";
    introCatSelectEl.appendChild(opt);
  }
  // Restore selection if still valid
  if (current) {
    const stillValid = Array.from(introCatSelectEl.options).some(function (o) { return o.value === current; });
    introCatSelectEl.value = stillValid ? current : "";
  }
  updateIntroSendCatBtn();
}

function updateIntroSendCatBtn() {
  if (!introSendCatBtn) return;
  introSendCatBtn.disabled = !introCatSelectEl.value;
}

if (introCatSelectEl) introCatSelectEl.onchange = updateIntroSendCatBtn;

if (introSendCatBtn) introSendCatBtn.onclick = function () {
  const catKey = introCatSelectEl.value;
  if (!catKey) return;
  const catDef = DATA.categories.find(function (c) { return c.key === catKey; });
  const label = catDef ? catDef.label : catKey;
  // Find all eligible cards
  const ids = [];
  let withoutAudio = 0;
  for (const s of allSentences()) {
    if (s.archived || s.pending || !s.es) continue;
    if (!s.cats || !s.cats.includes(catKey)) continue;
    if (stageOf(s.id) !== "active") continue;   // skip already in intro
    ids.push(s.id);
    if (!hasAudio(s)) withoutAudio++;
  }
  if (ids.length === 0) {
    showToast("Keine aktiven Karten in „" + label + "“.", 3000);
    return;
  }
  let msg = ids.length + " Karte(n) der Kategorie „" + label + "“ in Einführung schieben?";
  if (withoutAudio > 0) msg += "\n\nHinweis: " + withoutAudio + " davon haben noch kein Audio — werden ohne Auto-Play angezeigt.";
  if (!confirm(msg)) return;
  for (const id of ids) setIntroCount(id, 0);
  showToast(ids.length + " Karten in Einführung verschoben.", 3000);
  applyFilter();
  renderCards();
  updateProgress();        // also updates intro mode button
  buildIntroCatSelect();   // refresh counts
}

// Initial render of the dropdown (badge is updated via updateIntroModeBtn below)
buildIntroCatSelect();

// Auth comes last so all DOM handlers are wired up first
initAuth();
