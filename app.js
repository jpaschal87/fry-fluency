(() => {
  // ---------- Storage ----------
  const STORE_KEY = "fry_fluency_v1";

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveStore(store) {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  // ---------- Defaults ----------
  const defaultSettings = {
    masteryMode: "accuracy_speed",  // or "accuracy_only"
    speedThreshold: 2.5,            // seconds
    repsToMaster: 5,                // correct reps needed
    autoSpeak: "on",
    speechCheck: "on",
    voiceURI: ""
  };

  function ensureStoreShape(store) {
    store.settings ??= { ...defaultSettings };
    store.progress ??= {}; // per list id
    store.sessions ??= {}; // per list id
    return store;
  }

  // ---------- DOM ----------
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  const listSelect = document.getElementById("listSelect");
  const wordEl = document.getElementById("word");
  const metaEl = document.getElementById("meta");
  const sessionPill = document.getElementById("sessionPill");
  const masteryPill = document.getElementById("masteryPill");

  const hearBtn = document.getElementById("hearBtn");
  const repeatBtn = document.getElementById("repeatBtn");
  const speakBtn = document.getElementById("speakBtn");
  const correctBtn = document.getElementById("correctBtn");
  const missedBtn = document.getElementById("missedBtn");
  const resetListBtn = document.getElementById("resetListBtn");

  // Growth
  const gMastery = document.getElementById("gMastery");
  const gAccuracy = document.getElementById("gAccuracy");
  const gAttempts = document.getElementById("gAttempts");
  const gSessions = document.getElementById("gSessions");
  const watchList = document.getElementById("watchList");
  const exportBtn = document.getElementById("exportBtn");
  const clearAllBtn = document.getElementById("clearAllBtn");
  const exportOut = document.getElementById("exportOut");

  // Settings
  const masteryModeSel = document.getElementById("masteryMode");
  const speedThresholdInp = document.getElementById("speedThreshold");
  const repsToMasterInp = document.getElementById("repsToMaster");
  const autoSpeakSel = document.getElementById("autoSpeak");
  const voiceSelect = document.getElementById("voiceSelect");
  const speechCheckSel = document.getElementById("speechCheck");

  // ---------- Lists ----------
  const lists = (window.FRY_LISTS || []).map(x => ({...x, words: uniqClean(x.words)}));

  function uniqClean(arr) {
    const seen = new Set();
    return (arr || [])
      .map(w => String(w).trim().toLowerCase())
      .filter(w => w && !seen.has(w) && seen.add(w));
  }

  // ---------- Speech (TTS) ----------
  let voices = [];
  function refreshVoices() {
    voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    voiceSelect.innerHTML = "";
    const optAuto = document.createElement("option");
    optAuto.value = "";
    optAuto.textContent = "Default voice";
    voiceSelect.appendChild(optAuto);

    for (const v of voices) {
      const o = document.createElement("option");
      o.value = v.voiceURI;
      o.textContent = `${v.name} (${v.lang})`;
      voiceSelect.appendChild(o);
    }
  }

  function speak(word) {
    if (!window.speechSynthesis) return;
    const store = ensureStoreShape(loadStore());
    const u = new SpeechSynthesisUtterance(word);
    u.rate = 0.9;
    if (store.settings.voiceURI) {
      const v = voices.find(x => x.voiceURI === store.settings.voiceURI);
      if (v) u.voice = v;
    }
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  // ---------- Speech Recognition ----------
  function speechSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function listenOnce() {
    return new Promise((resolve) => {
      if (!speechSupported()) return resolve({ ok: false, text: null, reason: "not_supported" });

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      rec.onresult = (e) => {
        const text = (e.results?.[0]?.[0]?.transcript || "").trim().toLowerCase();
        resolve({ ok: true, text });
      };
      rec.onerror = () => resolve({ ok: false, text: null, reason: "error" });
      rec.onend = () => {}; // no-op
      try { rec.start(); } catch { resolve({ ok: false, text: null, reason: "blocked" }); }
    });
  }

  // ---------- Adaptive Scheduling ----------
  // Each word keeps: seen, correct, incorrect, fastCorrect, lastRT (reaction time), due (timestamp), interval (ms)
  // Algorithm: pick among due items, weighted toward weak items.
  function getListState(store, listId, words) {
    store.progress[listId] ??= {};
    store.sessions[listId] ??= { sessionCount: 0, sessionAttempts: 0 };

    const p = store.progress[listId];
    for (const w of words) {
      p[w] ??= {
        seen: 0,
        correct: 0,
        incorrect: 0,
        fastCorrect: 0,
        lastRT: null,
        interval: 0,
        due: 0
      };
    }
    return p;
  }

  function isMastered(wordRec, settings) {
    if (settings.masteryMode === "accuracy_only") {
      return wordRec.correct >= settings.repsToMaster;
    }
    // accuracy + speed: need repsToMaster "fastCorrect"
    return wordRec.fastCorrect >= settings.repsToMaster;
  }

  function nextIntervalMs(wr, settings, wasCorrect, wasFast) {
    // Simple spaced repetition-ish intervals:
    // Miss => short interval; Correct => grow; Fast correct grows more.
    const base = 10 * 1000; // 10 seconds (in-session)
    const min = 5 * 1000;
    const max = 4 * 60 * 60 * 1000; // 4 hours (still local)

    if (!wasCorrect) return min;

    const boost = wasFast ? 3.0 : 2.0;
    const prev = wr.interval || base;
    const next = Math.min(max, Math.max(base, prev * boost));
    return next;
  }

  function pickNextWord(progress, words, settings) {
    const now = Date.now();
    const dueWords = words.filter(w => (progress[w]?.due || 0) <= now);
    const pool = dueWords.length ? dueWords : words;

    // weight: higher if low correct, high incorrect, not mastered
    const weighted = [];
    for (const w of pool) {
      const r = progress[w];
      const mastered = isMastered(r, settings);
      const attempts = r.seen || 0;
      const missRate = attempts ? (r.incorrect / attempts) : 0.5;
      const masteryPenalty = mastered ? 0.2 : 1.0;

      // Weight formula (tuned to feel "Fluent-style")
      const weight =
        (1 + missRate * 3) *
        (1 + Math.max(0, settings.repsToMaster - (settings.masteryMode === "accuracy_only" ? r.correct : r.fastCorrect)) * 0.4) *
        masteryPenalty;

      weighted.push({ w, weight: Math.max(0.05, weight) });
    }

    // Weighted random pick
    const total = weighted.reduce((s, x) => s + x.weight, 0);
    let roll = Math.random() * total;
    for (const x of weighted) {
      roll -= x.weight;
      if (roll <= 0) return x.w;
    }
    return weighted[weighted.length - 1].w;
  }

  // ---------- Session handling ----------
  const SESSION_SIZE = 20; // counts as a "session" after 20 attempts
  let currentList = lists[0];
  let currentWord = null;
  let wordShownAt = Date.now();

  function setTab(tabId) {
    tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tabId));
    panels.forEach(p => p.classList.toggle("active", p.id === tabId));
    if (tabId === "growth") renderGrowth();
  }

  tabs.forEach(t => t.addEventListener("click", () => setTab(t.dataset.tab)));

  function loadSettingsToUI(store) {
    masteryModeSel.value = store.settings.masteryMode;
    speedThresholdInp.value = store.settings.speedThreshold;
    repsToMasterInp.value = store.settings.repsToMaster;
    autoSpeakSel.value = store.settings.autoSpeak;
    speechCheckSel.value = store.settings.speechCheck;
    voiceSelect.value = store.settings.voiceURI || "";
  }

  function saveSettingsFromUI() {
    const store = ensureStoreShape(loadStore());
    store.settings.masteryMode = masteryModeSel.value;
    store.settings.speedThreshold = clampNum(speedThresholdInp.value, 0.5, 10, 2.5);
    store.settings.repsToMaster = clampInt(repsToMasterInp.value, 2, 20, 5);
    store.settings.autoSpeak = autoSpeakSel.value;
    store.settings.speechCheck = speechCheckSel.value;
    store.settings.voiceURI = voiceSelect.value || "";
    saveStore(store);
    updatePills();
  }

  function clampNum(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }
  function clampInt(val, min, max, fallback) {
    const n = parseInt(val, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // Settings listeners
  [masteryModeSel, speedThresholdInp, repsToMasterInp, autoSpeakSel, voiceSelect, speechCheckSel]
    .forEach(el => el.addEventListener("change", saveSettingsFromUI));

  // ---------- List selector ----------
  function populateListSelect() {
    listSelect.innerHTML = "";
    for (const l of lists) {
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = l.name;
      listSelect.appendChild(o);
    }
  }

  function setCurrentListById(id) {
    currentList = lists.find(x => x.id === id) || lists[0];
    listSelect.value = currentList.id;
    nextWord(true);
    updatePills();
  }

  listSelect.addEventListener("change", () => setCurrentListById(listSelect.value));

  // ---------- Practice flow ----------
  function updatePills() {
    const store = ensureStoreShape(loadStore());
    const settings = store.settings;
    const p = getListState(store, currentList.id, currentList.words);
    const words = currentList.words;

    const masteredCount = words.filter(w => isMastered(p[w], settings)).length;
    const masteryPct = Math.round((masteredCount / words.length) * 100);
    masteryPill.textContent = `Mastered: ${masteryPct}%`;

    const s = store.sessions[currentList.id] || { sessionCount: 0, sessionAttempts: 0 };
    sessionPill.textContent = `Session: ${s.sessionCount}`;
  }

  function nextWord(forceNew = false) {
    const store = ensureStoreShape(loadStore());
    const settings = store.settings;
    const p = getListState(store, currentList.id, currentList.words);

    if (forceNew || !currentWord) {
      currentWord = pickNextWord(p, currentList.words, settings);
    }

    wordEl.textContent = currentWord;
    wordShownAt = Date.now();

    const rec = p[currentWord];
    const attempts = rec.seen || 0;
    const missRate = attempts ? Math.round((rec.incorrect / attempts) * 100) : 0;
    const mastered = isMastered(rec, settings);

    metaEl.textContent =
      `Seen: ${rec.seen} • Correct: ${rec.correct} • Missed: ${rec.incorrect} • Miss%: ${missRate}% • Mastered: ${mastered ? "Yes" : "No"}`;

    saveStore(store);
    updatePills();

    if (settings.autoSpeak === "on") speak(currentWord);
  }

  function recordAttempt({ correct, rtSeconds }) {
    const store = ensureStoreShape(loadStore());
    const settings = store.settings;
    const p = getListState(store, currentList.id, currentList.words);

    const r = p[currentWord];
    r.seen += 1;
    r.lastRT = rtSeconds;

    const wasFast = rtSeconds <= settings.speedThreshold;

    if (correct) {
      r.correct += 1;
      if (settings.masteryMode === "accuracy_only" || wasFast) {
        r.fastCorrect += 1;
      }
    } else {
      r.incorrect += 1;
    }

    r.interval = nextIntervalMs(r, settings, correct, wasFast);
    r.due = Date.now() + r.interval;

    // session counting
    store.sessions[currentList.id] ??= { sessionCount: 0, sessionAttempts: 0 };
    store.sessions[currentList.id].sessionAttempts += 1;
    if (store.sessions[currentList.id].sessionAttempts >= SESSION_SIZE) {
      store.sessions[currentList.id].sessionCount += 1;
      store.sessions[currentList.id].sessionAttempts = 0;
    }

    saveStore(store);
    nextWord(true);
  }

  hearBtn.addEventListener("click", () => speak(currentWord));
  repeatBtn.addEventListener("click", () => nextWord(false));

  correctBtn.addEventListener("click", () => {
    const rt = (Date.now() - wordShownAt) / 1000;
    recordAttempt({ correct: true, rtSeconds: rt });
  });
  missedBtn.addEventListener("click", () => {
    const rt = (Date.now() - wordShownAt) / 1000;
    recordAttempt({ correct: false, rtSeconds: rt });
  });

  function normalizeSpeechText(text) {
    // normalize smart apostrophes, lowercase, remove punctuation except apostrophes
    return (text || "")
      .toLowerCase()
      .replace(/'/g, "'")
      .replace(/[^a-z' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function speechMatchesTarget(transcript, targetWord) {
    const t = normalizeSpeechText(transcript);
    const target = normalizeSpeechText(targetWord);

    if (!t || !target) return false;

    // exact full match
    if (t === target) return true;

    // token match (kids might say "the ... the" or "it's the")
    const tokens = t.split(" ").filter(Boolean);

    // accept if any token equals the target
    if (tokens.includes(target)) return true;

    // accept if last token equals target (common)
    if (tokens.length && tokens[tokens.length - 1] === target) return true;

    return false;
  }

  async function listenOnceDetailed() {
    return new Promise((resolve) => {
      if (!speechSupported()) {
        return resolve({ ok: false, text: null, confidence: null, reason: "not_supported" });
      }

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 3;

      rec.onresult = (e) => {
        const alt = e.results?.[0];
        const transcript = (alt?.[0]?.transcript || "").trim();
        const confidence = typeof alt?.[0]?.confidence === "number" ? alt[0].confidence : null;
        resolve({ ok: true, text: transcript, confidence });
      };

      rec.onerror = () => resolve({ ok: false, text: null, confidence: null, reason: "error" });

      try {
        rec.start();
      } catch {
        resolve({ ok: false, text: null, confidence: null, reason: "blocked" });
      }
    });
  }

  speakBtn.addEventListener("click", async () => {
    const store = ensureStoreShape(loadStore());
    const settings = store.settings;

    // Reaction time from when the word appeared
    const rt = (Date.now() - wordShownAt) / 1000;

    // If speech checking is turned off, just listen (no marking)
    if (settings.speechCheck === "off") {
      await listenOnceDetailed();
      metaEl.textContent = "Heard you (speech check is off). Use ✅/❌ buttons.";
      return;
    }

    const res = await listenOnceDetailed();

    if (!res.ok) {
      metaEl.textContent = "Mic not available. Use ✅/❌ buttons (or allow microphone).";
      return;
    }

    const heard = res.text || "";
    const isCorrect = speechMatchesTarget(heard, currentWord);

    // ✅ IMPROVED: Lowered confidence threshold from 0.55 to 0.4
    // This is much more forgiving for children's voices and speech variations
    const minConfidence = 0.4;
    const confidentEnough = res.confidence == null ? true : res.confidence >= minConfidence;

    if (isCorrect && confidentEnough) {
      // ✅ Auto-mark correct
      metaEl.textContent = `✅ Correct! "${heard}" - Moving to next word...`;
      // Small delay so user sees the confirmation
      setTimeout(() => {
        recordAttempt({ correct: true, rtSeconds: rt });
      }, 800);
      return;
    }

    // Not matched (or low confidence): do NOT auto-mark incorrect.
    // Keep same word so they can try again or you can tap.
    metaEl.textContent =
      `Heard: "${heard}"` +
      (res.confidence != null ? ` (conf: ${(res.confidence * 100).toFixed(0)}%)` : "") +
      ` — Say the word again, or tap ✅/❌.`;
  });

  resetListBtn.addEventListener("click", () => {
    const store = ensureStoreShape(loadStore());
    if (store.progress?.[currentList.id]) delete store.progress[currentList.id];
    if (store.sessions?.[currentList.id]) delete store.sessions[currentList.id];
    saveStore(store);
    nextWord(true);
  });

  // ---------- Growth ----------
  function renderGrowth() {
    const store = ensureStoreShape(loadStore());
    const settings = store.settings;

    const p = getListState(store, currentList.id, currentList.words);
    const words = currentList.words;

    let attempts = 0, correct = 0, mastered = 0;

    const watch = words.map(w => {
      const r = p[w];
      const a = r.seen || 0;
      const missRate = a ? (r.incorrect / a) : 0;
      const slow = r.lastRT ? Math.max(0, r.lastRT - settings.speedThreshold) : 0;
      const score = missRate * 3 + slow; // higher = needs attention
      return { w, score, missRate, lastRT: r.lastRT, seen: a };
    });

    for (const w of words) {
      attempts += p[w].seen;
      correct += p[w].correct;
      if (isMastered(p[w], settings)) mastered += 1;
    }

    const masteryPct = Math.round((mastered / words.length) * 100);
    const accPct = attempts ? Math.round((correct / attempts) * 100) : 0;

    const s = store.sessions[currentList.id] || { sessionCount: 0 };

    gMastery.textContent = `${masteryPct}%`;
    gAccuracy.textContent = `${accPct}%`;
    gAttempts.textContent = `${attempts}`;
    gSessions.textContent = `${s.sessionCount || 0}`;

    watch.sort((a, b) => b.score - a.score);
    const top = watch.slice(0, 12).filter(x => x.seen > 0 || x.score > 0);

    watchList.innerHTML = "";
    if (!top.length) {
      const c = document.createElement("div");
      c.className = "chip";
      c.textContent = "No data yet — start practicing!";
      watchList.appendChild(c);
    } else {
      for (const item of top) {
        const c = document.createElement("div");
        c.className = "chip";
        const rt = item.lastRT ? `${item.lastRT.toFixed(1)}s` : "—";
        const miss = item.seen ? `${Math.round(item.missRate * 100)}% miss` : "new";
        c.textContent = `${item.w} • ${miss} • RT ${rt}`;
        watchList.appendChild(c);
      }
    }
  }

  exportBtn.addEventListener("click", () => {
    const store = ensureStoreShape(loadStore());
    exportOut.hidden = false;
    exportOut.textContent = JSON.stringify(store, null, 2);
  });

  clearAllBtn.addEventListener("click", () => {
    localStorage.removeItem(STORE_KEY);
    exportOut.hidden = true;
    exportOut.textContent = "";
    nextWord(true);
    updatePills();
  });

  // ---------- Init ----------
  function init() {
    if (!lists.length) {
      wordEl.textContent = "Add Fry lists in words.js";
      return;
    }

    populateListSelect();

    let store = ensureStoreShape(loadStore());
    saveStore(store);

    // voices
    refreshVoices();
    if (window.speechSynthesis) {
      speechSynthesis.onvoiceschanged = () => {
        refreshVoices();
        const s = ensureStoreShape(loadStore());
        loadSettingsToUI(s);
      };
    }

    loadSettingsToUI(store);

    setCurrentListById(lists[0].id);

    // If speech recognition not supported, soften message
    if (!speechSupported()) {
      document.getElementById("hint").textContent =
        "This device/browser does not support speech recognition. Use ✅/❌ buttons (audio still works).";
    }
  }

  init();
})();
