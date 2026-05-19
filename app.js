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
  mode: "listen",
  repeatCount: 0,
  revealed: new Set(),
  userSentences: loadJSON("hl_user_sentences", []),
  newSentenceCats: new Set(),
  apiKey: localStorage.getItem("hl_api_key") || "",
  elKey: localStorage.getItem("hl_el_key") || "",
  elVoice: localStorage.getItem("hl_el_voice") || "21m00Tcm4TlvDq8ikWAM",
  // Sort for the Meine-Sätze page (newest/oldest/random).
  // Persisted under legacy key `hl_us_sort` for backward compat.
  usSort: localStorage.getItem("hl_us_sort") || "newest",
  // Filter for the Meine-Sätze page: "translated" | "pending" | "archived"
  saetzeFilter: "translated",
  mainSort: localStorage.getItem("hl_main_sort") || "oldest",
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

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
  if (!currentUser || _suppressSync) return;
  if (key === "hl_user_sentences") queuePushSentences();
  else if (key === "hl_ratings" || key === "hl_mnemonics" ||
           key === "hl_shown_mnemonics" || key === "hl_autoplay" ||
           key === "hl_intro_counts") queuePushProfile();
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
  // Storage minimization: anything >= 5 = "active" = default → drop the key.
  if (value >= 5) delete state.introCounts[id];
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
  return maxId + 1;
}
function isUserSentence(id) { return id > DATA.sentences.length; }

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
  document.body.classList.add("new-sentence");
  if (sideNewSentenceLink) sideNewSentenceLink.classList.add("active");
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
  if (sideNewSentenceLink) sideNewSentenceLink.classList.remove("active");
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

// Background audio queue for bulk imports. Sequential (ElevenLabs rate-limits +
// gentler on the user's quota). Each item already uploads to Storage via
// generateAudioFor. Progress is shown via toast updates.
async function generateBulkAudios(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (!state.elKey) { showToast("ElevenLabs Key fehlt — Audios nicht generiert.", 4000); return; }
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
  generateAllAudioBtn.disabled = true;
  generateAllAudioBtn.classList.add("loading");
  let ok = 0, fail = 0;
  for (let i = 0; i < candidates.length; i++) {
    generateAllAudioText.textContent = "Generiere " + (i + 1) + " / " + candidates.length + " ...";
    const success = await generateAudioFor(candidates[i].id);
    if (success) { ok++; } else { fail++; break; }
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  generateAllAudioBtn.disabled = false;
  generateAllAudioBtn.classList.remove("loading");
  updateGenerateAllAudioBtn();
  renderCards();
  buildUserSentencesList();
  showToast(ok + " Audio(s) generiert" + (fail ? ", " + fail + " fehlgeschlagen" : "") + ".");
}
generateAllAudioBtn.onclick = generateAllPendingAudios;

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
  state.userSentences.push({
    id: id,
    de: de,
    es: es,
    cats: opts.cats ? [...opts.cats] : [],
    audio: "",
    pending: es ? false : true,
  });
  if (opts.mnemonic && opts.mnemonic.trim()) {
    state.mnemonics[id] = opts.mnemonic.trim();
    saveJSON("hl_mnemonics", state.mnemonics);
  }
  // New cards automatically enter the Einführungs-Pool (intro_count = 0 = backlog).
  // Existing cards keep their default of 5 (active) since they have no entry.
  setIntroCount(id, 0);
  saveJSON("hl_user_sentences", state.userSentences);
  return id;
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
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// "Alle ansehen" → close the page and open "Meine Sätze" in the sidebar
if (nsRecentAllBtn) nsRecentAllBtn.onclick = function () {
  closeNewSentencePage();
  openSidePanel();
  const sec = document.getElementById("my-sentences-section");
  if (sec) {
    sec.open = true;
    setTimeout(function () { try { sec.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {} }, 60);
  }
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
  state.shownMnemonics.delete(id);
  state.editingMnemonics.delete(id);
  saveJSON("hl_user_sentences", state.userSentences);
  saveJSON("hl_ratings", state.ratings);
  saveJSON("hl_mnemonics", state.mnemonics);
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
  buildRatingFilter();
  updateProgress();
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
  state.revealed.add(id);
  const idx = state.filteredIds.indexOf(id);
  if (idx !== -1) state.currentIdx = idx;
  const card = document.querySelector('.card[data-id="' + id + '"]');
  if (card) card.classList.add("revealed");
  updatePlayer();
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
  if (state.mode === "car") return; // Car Mode hat einen eigenen Handler
  // Saetze-Page preview: ignore main-player auto-advance.
  if (state._saetzePreviewActive) { state._saetzePreviewActive = false; return; }
  state.repeatCount++;
  if (state.repeatCount < state.repeat) { play(); }
  else {
    state.repeatCount = 0;
    if (state.mode === "recall" || !state.autoPlay) {
      state.isPlaying = false;
      playIcon.style.display = "block";
      pauseIcon.style.display = "none";
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

  // Stat tiles (top of page). Streak is reserved for Phase 5 — placeholder for now.
  const statMastered = document.getElementById("stat-mastered");
  if (statMastered) statMastered.textContent = learned + " / " + total;
  const statStreak = document.getElementById("stat-streak");
  if (statStreak && statStreak.textContent.trim() === "— Tage") {
    // Leave as-is — Phase 5 will populate from real data.
  }
}

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
    return;
  }
  state.search = v;
  applyFilter();
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
};
recallBtn.onclick = function () {
  state.mode = "recall";
  document.body.classList.add("recall");
  recallBtn.classList.remove("secondary"); recallBtn.classList.add("primary");
  listenBtn.classList.remove("primary"); listenBtn.classList.add("secondary");
  state.revealed.clear();
  renderCards();
  modeHint.textContent = "Versuche den Satz auf Spanisch zu bilden — Tab zum Aufdecken. Audio startet nicht automatisch.";
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
  // "translated" (default): non-archived and non-pending (Übersetzung vorhanden).
  return state.userSentences.filter(function (s) { return !s.archived && !s.pending; });
}

// Mode-driven empty-state copy.
const SAETZE_EMPTY_COPY = {
  translated: "Noch keine übersetzten Sätze. Füge welche über „Neuer Satz“ hinzu.",
  pending: "Keine ausstehenden Übersetzungen. Alles ist übersetzt.",
  archived: "Archiv ist leer.",
};

function renderSaetzePage() {
  // No-op if the page DOM isn't there (defensive — pre-init or test scenarios).
  if (!saetzeListEl) return;
  saetzeListEl.innerHTML = "";

  const filter = state.saetzeFilter || "translated";
  const list = getSaetzeForFilter(filter);

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
    if (saetzeEmptyTextEl) saetzeEmptyTextEl.textContent = SAETZE_EMPTY_COPY[filter] || SAETZE_EMPTY_COPY.translated;
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

  // ES on top (primary content) — falls back to a hint if pending.
  const esEl = document.createElement("p");
  esEl.className = "saetze-card-es";
  if (s.es) {
    esEl.textContent = s.es;
  } else {
    esEl.textContent = "— wird übersetzt —";
  }
  main.appendChild(esEl);

  const deEl = document.createElement("p");
  deEl.className = "saetze-card-de";
  deEl.textContent = s.de;
  main.appendChild(deEl);

  card.appendChild(main);

  // === Actions column ===
  const actions = document.createElement("div");
  actions.className = "saetze-card-actions";

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
    // Translated (non-archived): play / regen-or-gen audio / archive
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

// Filter-tab + sort handlers
if (saetzeFilterEl) {
  saetzeFilterEl.addEventListener("click", function (e) {
    const tab = e.target.closest(".saetze-filter-tab");
    if (!tab) return;
    const f = tab.getAttribute("data-saetze-filter");
    if (!f) return;
    state.saetzeFilter = f;
    renderSaetzePage();
  });
}
if (saetzeSortEl) {
  saetzeSortEl.onchange = function () {
    state.usSort = saetzeSortEl.value;
    localStorage.setItem("hl_us_sort", state.usSort);
    queuePushProfile();
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
  document.body.classList.add("saetze");
  if (sideSaetzeLink) sideSaetzeLink.classList.add("active");
  closeSidePanel();
  renderSaetzePage();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function closeSaetzePage() {
  document.body.classList.remove("saetze");
  if (sideSaetzeLink) sideSaetzeLink.classList.remove("active");
  if (_modeBeforeSaetze === "focus" && typeof setFocusModeActive === "function") {
    setFocusModeActive();
  } else if (_modeBeforeSaetze === "recall") {
    document.body.classList.add("recall");
  }
  _modeBeforeSaetze = null;
}
if (sideSaetzeLink) sideSaetzeLink.onclick = function () { openSaetzePage(); };
if (saetzeBackBtn) saetzeBackBtn.onclick = function () { closeSaetzePage(); };

// Back-compat shim: anything in this file that still calls the old function
// goes through the new one (call-sites are renamed below in the same diff).
function buildUserSentencesList() { renderSaetzePage(); }


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
    await pullCloudData();
    await maybeMigrate();
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
  // Refresh the Einführung dropdown now that user_sentences + intro_counts are loaded
  if (typeof buildIntroCatSelect === "function") buildIntroCatSelect();
  if (typeof updateIntroModeBtn === "function") updateIntroModeBtn();
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
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // onAuthStateChange handles the rest
  } catch (err) {
    errEl.textContent = "Login fehlgeschlagen: " + err.message;
    btn.disabled = false;
    btn.textContent = "Anmelden";
  }
});

// ===== Cloud sync =====
async function pullCloudData() {
  if (!currentUser) return;
  _suppressSync = true;
  try {
    // Profile (single row)
    const { data: profile, error: pErr } = await sb
      .from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
    if (pErr) throw pErr;
    if (profile) {
      state.ratings = profile.ratings || {};
      state.mnemonics = profile.mnemonics || {};
      state.shownMnemonics = new Set(profile.shown_mnemonics || []);
      const s = profile.settings || {};
      if (typeof s.autoplay === "boolean") state.autoPlay = s.autoplay;
      if (s.main_sort) state.mainSort = s.main_sort;
      if (s.us_sort) state.usSort = s.us_sort;
      if (s.intro_counts && typeof s.intro_counts === "object") state.introCounts = s.intro_counts;
      // Mirror to localStorage (cache for offline / next reload)
      localStorage.setItem("hl_ratings", JSON.stringify(state.ratings));
      localStorage.setItem("hl_mnemonics", JSON.stringify(state.mnemonics));
      localStorage.setItem("hl_shown_mnemonics", JSON.stringify([...state.shownMnemonics]));
      localStorage.setItem("hl_autoplay", JSON.stringify(state.autoPlay));
      localStorage.setItem("hl_main_sort", state.mainSort);
      localStorage.setItem("hl_us_sort", state.usSort);
      localStorage.setItem("hl_intro_counts", JSON.stringify(state.introCounts));
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
        audio: "" // local field, not stored in cloud
      };
    });
    localStorage.setItem("hl_user_sentences", JSON.stringify(state.userSentences));
  } finally {
    _suppressSync = false;
  }
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
    // Determine what's in cloud
    const { data: cloud, error: cErr } = await sb
      .from("user_sentences").select("id").eq("user_id", currentUser.id);
    if (cErr) throw cErr;
    const cloudIds = new Set((cloud || []).map(function (r) { return r.id; }));
    const localIds = new Set(state.userSentences.map(function (s) { return s.id; }));
    // Delete from cloud what no longer exists locally
    const toDelete = [...cloudIds].filter(function (id) { return !localIds.has(id); });
    if (toDelete.length) {
      const { error: dErr } = await sb.from("user_sentences").delete()
        .eq("user_id", currentUser.id).in("id", toDelete);
      if (dErr) throw dErr;
    }
    // Upsert all local rows
    if (state.userSentences.length) {
      const rows = state.userSentences.map(function (s) {
        return {
          id: s.id, user_id: currentUser.id, de: s.de, es: s.es || "",
          cats: s.cats || [], pending: s.pending !== false,
          archived: !!s.archived, audio_path: s.audio_path || "",
        };
      });
      const { error: uErr } = await sb.from("user_sentences").upsert(rows);
      if (uErr) throw uErr;
    }
    setSyncStatus("synced");
  } catch (e) {
    console.error("pushUserSentences error:", e);
    setSyncStatus("error");
    showToast("Sync-Fehler (Sätze): " + e.message, 4000);
  }
}

// One-time migration on first login if cloud is empty but local has data
async function maybeMigrate() {
  if (!currentUser) return;
  const { data: profile } = await sb.from("profiles")
    .select("ratings, mnemonics").eq("id", currentUser.id).maybeSingle();
  const { count: sCount } = await sb.from("user_sentences")
    .select("*", { count: "exact", head: true }).eq("user_id", currentUser.id);
  const cloudHasData = (sCount && sCount > 0) || (profile && (
    Object.keys(profile.ratings || {}).length > 0 ||
    Object.keys(profile.mnemonics || {}).length > 0
  ));
  if (cloudHasData) return;
  const lsRatings = JSON.parse(localStorage.getItem("hl_ratings") || "{}");
  const lsMnemonics = JSON.parse(localStorage.getItem("hl_mnemonics") || "{}");
  const lsSentences = JSON.parse(localStorage.getItem("hl_user_sentences") || "[]");
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
  state.shownMnemonics = new Set(JSON.parse(localStorage.getItem("hl_shown_mnemonics") || "[]"));
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
buildCatFilter();
buildNsCatPickers();
renderNsRecent();
updateNsMultiCount();
buildRatingFilter();
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
// Cache app shell + audios for offline use. The sw.js file handles all the
// caching strategy details. We bump VERSION inside sw.js whenever app code
// changes meaningfully — the activate handler clears stale caches.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      // When a new SW is found, ping it to skip waiting so the user gets the
      // update on next reload rather than after closing all tabs.
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
    navigator.mediaSession.setActionHandler("pause", function () { pause(); });
    navigator.mediaSession.setActionHandler("nexttrack", function () { next(); });
    navigator.mediaSession.setActionHandler("previoustrack", function () { prev(); });
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
  ratings: new Set(["unrated", "1", "2"]),  // default: practice the unmastered cards
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
  return allSentences().filter(function (s) {
    if (s.archived) return false;
    if (s.pending) return false;          // no point practicing untranslated
    if (stageOf(s.id) !== "active") return false;  // intro/backlog excluded
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

  // Play button enable/disable based on audio availability
  focusPlayBtn.disabled = !hasAudio(s);
}

function revealFocusCard() {
  if (focus.revealed) return;
  focus.revealed = true;
  focusRevealBtn.style.display = "none";
  focusSideEsEl.style.display = "flex";
  focusRatingsEl.style.display = "grid";
  renderFocusMnemonic();
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
  audioEl.src = src;
  audioEl.playbackRate = state.speed;
  audioEl.play().catch(function (err) { console.error("Focus play failed", err); });
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
  shadowPause: loadJSON("hl_car_shadow", 0.5),    // seconds of silence after each playback (shadowing gap)
  sentencePause: loadJSON("hl_car_gap", 1.0),     // seconds between sentences
  shuffle: loadJSON("hl_car_shuffle", true),
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
};

// One-time migration: bump 3.0/1.5 -> 0.5/1.0 if user is still on old defaults
if (!localStorage.getItem("hl_car_defaults_v2")) {
  if (car.shadowPause === 3.0) { car.shadowPause = 0.5; localStorage.setItem("hl_car_shadow", "0.5"); }
  if (car.sentencePause === 1.5) { car.sentencePause = 1.0; localStorage.setItem("hl_car_gap", "1.0"); }
  localStorage.setItem("hl_car_defaults_v2", "1");
}

function saveCarConfig() {
  saveJSON("hl_car_cats", Array.from(car.cats));
  saveJSON("hl_car_ratings", Array.from(car.ratings));
  saveJSON("hl_car_repeats", car.repeats);
  saveJSON("hl_car_shadow", car.shadowPause);
  saveJSON("hl_car_gap", car.sentencePause);
  saveJSON("hl_car_shuffle", car.shuffle);
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
const carShuffleToggleEl = document.getElementById("car-shuffle-toggle");
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

  // Toggles
  carShuffleToggleEl.classList.toggle("on", car.shuffle);
  carShuffleToggleEl.onclick = function () {
    car.shuffle = !car.shuffle;
    carShuffleToggleEl.classList.toggle("on", car.shuffle);
    saveCarConfig();
  };
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

  let ordered = eligible.slice();
  if (car.shuffle) {
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = ordered[i]; ordered[i] = ordered[j]; ordered[j] = tmp;
    }
  }
  car.queue = ordered.map(function (s) { return s.id; });
  car.idx = 0;
  car.repCount = 0;
  car.paused = false;
  car.active = true;

  carSetupEl.style.display = "none";
  carActiveEl.style.display = "flex";
  document.body.classList.add("car-driving");
  if (car.night) document.body.classList.add("car-night");
  window.scrollTo(0, 0);

  requestCarWakeLock();
  renderCarCard();
  playCarCurrent();
}

function exitCarSession() {
  car.active = false;
  car.paused = false;
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  try { audioEl.pause(); } catch (e) { /* ignore */ }
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
  audioEl.src = src;
  audioEl.playbackRate = 1.0;
  audioEl.play().then(function () {
    carPauseIcon.style.display = "block";
    carPlayIcon.style.display = "none";
    carStatusEl.textContent = "Spielt ab";
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
  try { audioEl.pause(); } catch (e) { /* ignore */ }
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  carPauseIcon.style.display = "none";
  carPlayIcon.style.display = "block";
  carStatusEl.textContent = "Pausiert";
}

function carResume() {
  if (!car.active) return;
  car.paused = false;
  if (audioEl.src && audioEl.paused && audioEl.currentTime > 0 && audioEl.currentTime < (audioEl.duration || Infinity)) {
    audioEl.play().then(function () {
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
  if (car.repCount < car.repeats) {
    carStatusEl.textContent = "Shadow-Pause…";
    car.pendingTimer = setTimeout(function () {
      car.pendingTimer = null;
      if (car.active && !car.paused) {
        renderCarCard();
        playCarCurrent();
      }
    }, skipPause ? 0 : car.shadowPause * 1000);
  } else {
    car.repCount = 0;
    car.idx++;
    if (car.idx >= car.queue.length) {
      if (car.loop) {
        if (car.shuffle) {
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
    car.pendingTimer = setTimeout(function () {
      car.pendingTimer = null;
      if (car.active && !car.paused) {
        renderCarCard();
        playCarCurrent();
      }
    }, skipPause ? 0 : car.sentencePause * 1000);
  }
}

function carSkipNext() {
  if (!car.active) return;
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  try { audioEl.pause(); } catch (e) { /* ignore */ }
  car.repCount = car.repeats - 1;
  carAdvance(true);
}

function carSkipPrev() {
  if (!car.active) return;
  if (car.pendingTimer) { clearTimeout(car.pendingTimer); car.pendingTimer = null; }
  try { audioEl.pause(); } catch (e) { /* ignore */ }
  car.repCount = 0;
  car.idx = (car.idx - 1 + car.queue.length) % car.queue.length;
  renderCarCard();
  if (!car.paused) playCarCurrent();
}

audioEl.addEventListener("ended", function () {
  if (!car.active || car.paused) return;
  carAdvance(false);
});

carStartBtn.onclick = startCarSession;
carCloseBtn.onclick = function () {
  if (car.idx > 0) {
    if (!confirm("Auto-Modus beenden?")) return;
  }
  exitCarSession();
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
  if (modeHint) modeHint.textContent = "Auto-Modus: konfiguriere die Session und drücke Start.";

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

// Build the session queue: all "intro" (1-4) cards + up to 5 "backlog" (0) cards.
// Backlog cards get intro_count = 1 on entry (the "free" first showing).
function buildIntroQueue() {
  const introStage = [];
  const backlog = [];
  for (const s of allSentences()) {
    if (s.archived || s.pending || !s.es) continue;
    const stage = stageOf(s.id);
    if (stage === "intro") introStage.push(s.id);
    else if (stage === "backlog") backlog.push(s.id);
  }
  // Shuffle each pool
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  shuffle(introStage);
  shuffle(backlog);
  // Take up to 5 backlog cards, promote them to intro_count = 1
  const newcomers = backlog.slice(0, 5);
  for (const id of newcomers) setIntroCount(id, 1);
  return introStage.concat(newcomers);
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
  // Progress header
  introProgressTextEl.textContent = "Karte " + (intro.idx + 1) + " von " + intro.queue.length;
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
    // Auto-play (user gesture chain: they clicked "Verstanden" or started session)
    audioEl.src = src;
    audioEl.playbackRate = state.speed || 1.0;
    audioEl.play().catch(function (err) {
      console.warn("Intro autoplay blocked:", err);
    });
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

introAgainBtn.onclick = function () {
  if (!intro.active) return;
  // "Nochmal": keep current count, move card to end of queue
  const id = intro.queue[intro.idx];
  intro.queue.push(id);
  intro.again++;
  intro.idx++;
  showIntroCard();
};

introGotBtn.onclick = function () {
  if (!intro.active) return;
  const id = intro.queue[intro.idx];
  const before = getIntroCount(id);
  const after = Math.min(before + 1, 5);
  setIntroCount(id, after);
  if (after >= 5) intro.graduated++;
  else intro.advanced++;
  intro.idx++;
  showIntroCard();
};

function endIntroSession() {
  intro.active = false;
  introCardViewEl.style.display = "none";
  introSummaryEl.style.display = "flex";
  const totalSeen = intro.graduated + intro.advanced + intro.again;
  introSummaryTextEl.textContent = "Du hast " + totalSeen + " Wiederholungen durchgegangen.";
  introSummaryStatsEl.innerHTML =
    '<div class="intro-summary-stat"><div class="intro-summary-stat-num">' + intro.graduated + '</div><div class="intro-summary-stat-label">graduiert</div></div>' +
    '<div class="intro-summary-stat"><div class="intro-summary-stat-num">' + intro.advanced + '</div><div class="intro-summary-stat-label">weiter</div></div>' +
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
