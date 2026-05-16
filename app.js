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
  mode: "listen",
  repeatCount: 0,
  revealed: new Set(),
  userSentences: loadJSON("hl_user_sentences", []),
  newSentenceCats: new Set(),
  apiKey: localStorage.getItem("hl_api_key") || "",
  elKey: localStorage.getItem("hl_el_key") || "",
  elVoice: localStorage.getItem("hl_el_voice") || "21m00Tcm4TlvDq8ikWAM",
  usSort: localStorage.getItem("hl_us_sort") || "newest",
  usTab: "active",
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

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
  if (!currentUser || _suppressSync) return;
  if (key === "hl_user_sentences") queuePushSentences();
  else if (key === "hl_ratings" || key === "hl_mnemonics" ||
           key === "hl_shown_mnemonics" || key === "hl_autoplay") queuePushProfile();
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
const modeHint = document.getElementById("mode-hint");
const hamburgerBtn = document.getElementById("hamburger-btn");
const sidePanel = document.getElementById("side-panel");
const sideOverlay = document.getElementById("side-overlay");
const closeSidePanelBtn = document.getElementById("close-side-panel");
const newDeInput = document.getElementById("new-de-input");
const newCatPickerEl = document.getElementById("new-cat-picker");
const addSentenceBtn = document.getElementById("add-sentence-btn");
const copyPromptBtn = document.getElementById("copy-prompt-btn");
const pasteTranslationsEl = document.getElementById("paste-translations");
const applyTranslationsBtn = document.getElementById("apply-translations-btn");
const pendingCountEl = document.getElementById("pending-count");
const toastEl = document.getElementById("toast");
const userSentencesListEl = document.getElementById("user-sentences-list");
const mySentencesCountEl = document.getElementById("my-sentences-count");
const elKeyInput = document.getElementById("el-key-input");
const elVoiceInput = document.getElementById("el-voice-input");
const elKeyStatus = document.getElementById("el-key-status");
const saveElBtn = document.getElementById("save-el-btn");
const clearElBtn = document.getElementById("clear-el-btn");
const generateAllAudioBtn = document.getElementById("generate-all-audio-btn");
const generateAllAudioText = document.getElementById("generate-all-audio-text");
const usSortEl = document.getElementById("us-sort");
const usTabActive = document.getElementById("us-tab-active");
const usTabArchived = document.getElementById("us-tab-archived");
const usCountActive = document.getElementById("us-count-active");
const usCountArchived = document.getElementById("us-count-archived");
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
    await saveAudioToIDB(id, blob);
    return true;
  } catch (e) {
    showToast("Audio-Fehler: " + e.message, 5000);
    console.error(e);
    return false;
  }
}

async function generateAllPendingAudios() {
  const candidates = state.userSentences.filter(function (s) {
    return !s.archived && s.es && !s.pending && !userAudioUrls[s.id];
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
    return !s.archived && s.es && !s.pending && !userAudioUrls[s.id];
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

function buildNewCatPicker() {
  newCatPickerEl.innerHTML = "";
  for (const cat of DATA.categories) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "new-cat-chip" + (state.newSentenceCats.has(cat.key) ? " active" : "");
    chip.textContent = cat.label;
    chip.onclick = function () {
      if (state.newSentenceCats.has(cat.key)) state.newSentenceCats.delete(cat.key);
      else state.newSentenceCats.add(cat.key);
      buildNewCatPicker();
    };
    newCatPickerEl.appendChild(chip);
  }
}

addSentenceBtn.onclick = function () {
  const de = newDeInput.value.trim();
  if (!de) { showToast("Bitte einen deutschen Satz eingeben."); return; }
  const id = nextUserId();
  state.userSentences.push({
    id: id, de: de, es: "", cats: [...state.newSentenceCats], audio: "", pending: true,
  });
  saveJSON("hl_user_sentences", state.userSentences);
  newDeInput.value = "";
  state.newSentenceCats.clear();
  buildNewCatPicker();
  applyFilter();
  updatePendingBadge();
  updateProgress();
  buildUserSentencesList();
  showToast("Satz #" + id + " hinzugefügt.");
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
  const _hasAudio = !!s.audio || !!userAudioUrls[id];
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
  const src = userAudioUrls[s.id] || s.audio;
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
  }).catch(function (err) { console.error("Play failed", err); });
}
function pause() {
  audioEl.pause();
  state.isPlaying = false;
  playIcon.style.display = "block";
  pauseIcon.style.display = "none";
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

function updateProgress() {
  const total = allSentences().length;
  let learned = 0;
  for (const id in state.ratings) if (state.ratings[id] === "learned") learned++;
  progressText.textContent = learned + " von " + total + " gemeistert";
  const pct = total ? Math.round((learned / total) * 100) : 0;
  progressPercent.textContent = pct + "%";
  progressFill.style.width = pct + "%";
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
searchInput.oninput = function (e) { state.search = e.target.value; applyFilter(); };
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

// ===== "Meine Sätze" overview (sidebar list of user-added sentences) =====
function buildUserSentencesList() {
  userSentencesListEl.innerHTML = "";
  const allActive = state.userSentences.filter(function (s) { return !s.archived; });
  const allArchived = state.userSentences.filter(function (s) { return s.archived; });
  usCountActive.textContent = allActive.length;
  usCountArchived.textContent = allArchived.length;
  const total = state.userSentences.length;
  mySentencesCountEl.textContent = total > 0 ? total : "";

  const list = state.usTab === "archived" ? allArchived : allActive;
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "user-sentence-empty";
    empty.textContent = state.usTab === "archived" ? "Archiv ist leer." : "Noch keine eigenen Sätze.";
    userSentencesListEl.appendChild(empty);
    return;
  }

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
    const row = document.createElement("div");
    row.className = "user-sentence-row" + (s.pending ? " pending" : "") + (s.archived ? " archived" : "");

    const idEl = document.createElement("span");
    idEl.className = "us-id";
    idEl.textContent = "#" + s.id;
    row.appendChild(idEl);

    const textEl = document.createElement("div");
    textEl.className = "us-text";
    textEl.textContent = s.de;
    textEl.title = s.de + (s.es ? " — " + s.es : "");
    row.appendChild(textEl);

    const statusEl = document.createElement("span");
    statusEl.className = "us-status";
    statusEl.textContent = s.archived ? "archiviert" : (s.pending ? "ausstehend" : (userAudioUrls[s.id] ? "✓ audio" : "übersetzt"));
    row.appendChild(statusEl);

    const actions = document.createElement("div");
    actions.className = "us-actions-group";

    if (s.archived) {
      const restoreBtn = document.createElement("button");
      restoreBtn.className = "us-action-btn restore";
      restoreBtn.title = "Wiederherstellen";
      restoreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
      restoreBtn.onclick = function () { restoreUserSentence(s.id); };
      actions.appendChild(restoreBtn);

      const delPermBtn = document.createElement("button");
      delPermBtn.className = "us-action-btn del-perm";
      delPermBtn.title = "Endgültig löschen";
      delPermBtn.innerHTML = ICON_TRASH;
      delPermBtn.onclick = function () { permanentDeleteUserSentence(s.id); };
      actions.appendChild(delPermBtn);
    } else {
      const delBtn = document.createElement("button");
      delBtn.className = "us-action-btn";
      delBtn.title = s.pending ? "Löschen" : "Ins Archiv verschieben";
      delBtn.innerHTML = ICON_TRASH;
      delBtn.onclick = function () { archiveOrDelete(s.id); };
      actions.appendChild(delBtn);
    }

    row.appendChild(actions);
    userSentencesListEl.appendChild(row);
  }
}

usTabActive.onclick = function () {
  state.usTab = "active";
  usTabActive.classList.add("active");
  usTabArchived.classList.remove("active");
  buildUserSentencesList();
};
usTabArchived.onclick = function () {
  state.usTab = "archived";
  usTabArchived.classList.add("active");
  usTabActive.classList.remove("active");
  buildUserSentencesList();
};
usSortEl.onchange = function () {
  state.usSort = usSortEl.value;
  localStorage.setItem("hl_us_sort", state.usSort);
  queuePushProfile();
  buildUserSentencesList();
};


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
  if (mainSortEl) mainSortEl.value = state.mainSort;
  if (usSortEl) usSortEl.value = state.usSort;
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
      // Mirror to localStorage (cache for offline / next reload)
      localStorage.setItem("hl_ratings", JSON.stringify(state.ratings));
      localStorage.setItem("hl_mnemonics", JSON.stringify(state.mnemonics));
      localStorage.setItem("hl_shown_mnemonics", JSON.stringify([...state.shownMnemonics]));
      localStorage.setItem("hl_autoplay", JSON.stringify(state.autoPlay));
      localStorage.setItem("hl_main_sort", state.mainSort);
      localStorage.setItem("hl_us_sort", state.usSort);
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
  // Push: state already in memory from earlier init; ensure it matches localStorage
  state.ratings = lsRatings;
  state.mnemonics = lsMnemonics;
  state.userSentences = lsSentences;
  state.shownMnemonics = new Set(JSON.parse(localStorage.getItem("hl_shown_mnemonics") || "[]"));
  // Force push
  _suppressSync = false;
  await pushProfile();
  await pushUserSentences();
  showToast("Migration abgeschlossen — " + summary, 3500);
}

// ===== Init =====
buildCatFilter();
buildNewCatPicker();
buildRatingFilter();
usSortEl.value = state.usSort;
mainSortEl.value = state.mainSort;
applyFilter();
updatePlayer();
updateProgress();
updateApiKeyUI();
updateElKeyUI();
updatePendingBadge();
updateAutoplayUI();
buildUserSentencesList();
initAudioDB().then(function () {
  renderCards();
  buildUserSentencesList();
  updateGenerateAllAudioBtn();
});

// Auth comes last so all DOM handlers are wired up first
initAuth();
