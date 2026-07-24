/* 语卡 — Mandarin Flashcards PWA
 * Offline-first. IndexedDB storage. SM-2 scheduling.
 * Two mastery dimensions per card: meaning + tone.
 */
'use strict';

// Shared pure logic (scheduler, tone derivation, mastery predicates) lives in
// core.js — single source of truth, also imported by the test suite.
const YC = self.YukaCore;

// ---------- tiny helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};
const now = () => Date.now();
const DAY = 86400000;
const fmtDue = (ts) => {
  if (!ts || ts <= now()) return 'due';
  const d = Math.round((ts - now()) / DAY);
  return d <= 0 ? 'due' : d === 1 ? '1d' : d + 'd';
};
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

const TONE_NAMES = YC.TONE_NAMES;
function stripToneMarks(s) { return YC.stripToneMarks(s); }

// ---------- IndexedDB ----------
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('yuka-db', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cards')) {
          const cs = db.createObjectStore('cards', { keyPath: 'id' });
          cs.createIndex('deckId', 'deckId', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      const out = fn(t);
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  return {
    async getAllDecks() { return tx('decks', 'readonly', t => { const o = []; t.objectStore('decks').openCursor().onsuccess = e => { const c = e.target.result; if (c) { o.push(c.value); c.continue(); } }; return o; }); },
    async getDeck(id) { let v; await tx('decks', 'readonly', t => { t.objectStore('decks').get(id).onsuccess = e => (v = e.target.result); }); return v; },
    async putDeck(d) { return tx('decks', 'readwrite', t => t.objectStore('decks').put(d)); },
    async cardsFor(deckId) { const o = []; await tx('cards', 'readonly', t => { const idx = t.objectStore('cards').index('deckId'); idx.openCursor(IDBKeyRange.only(deckId)).onsuccess = e => { const c = e.target.result; if (c) { o.push(c.value); c.continue(); } }; }); return o; },
    async allCards() { const o = []; await tx('cards', 'readonly', t => { t.objectStore('cards').openCursor().onsuccess = e => { const c = e.target.result; if (c) { o.push(c.value); c.continue(); } }; }); return o; },
    async putCards(cards) { return tx('cards', 'readwrite', t => { const s = t.objectStore('cards'); cards.forEach(c => s.put(c)); }); },
    async putCard(c) { return tx('cards', 'readwrite', t => t.objectStore('cards').put(c)); },
    async getMeta(k) { let v; await tx('meta', 'readonly', t => { t.objectStore('meta').get(k).onsuccess = e => (v = e.target.result); }); return v ? v.v : undefined; },
    async setMeta(k, v) { return tx('meta', 'readwrite', t => t.objectStore('meta').put({ k, v })); },
  };
})();

// ---------- SM-2 scheduler (per mastery dimension) ----------
// state: { ease, interval(days), reps, due(ts), lapses }
function newState() { return YC.newState(now); }
// grade: 0 again, 1 hard, 2 good, 3 easy
function schedule(s, grade) { return YC.schedule(s, grade, now); }
const isMastered = (s) => YC.isMastered(s);
const isProgressed = (s) => YC.isProgressed(s, now);
const cardHasTones = (c) => YC.cardHasTones(c);

// ---------- import / seed ----------
function makeCardRecord(raw, deckId) {
  return {
    id: raw.id || ('c_' + Math.random().toString(36).slice(2, 12)),
    deckId,
    front: raw.front || raw.pinyin || raw.meaning || '?',
    pinyin: raw.pinyin || '',
    meaning: raw.meaning || '',
    emoji: raw.emoji || '',
    example: raw.example || '',
    notes: raw.notes || '',
    tones: Array.isArray(raw.tones) ? raw.tones : deriveTones(raw.pinyin || ''),
    syllables: Array.isArray(raw.syllables) && raw.syllables.length ? raw.syllables : deriveSyllables(raw.pinyin || ''),
    zhEnState: newState(),
    enZhState: newState(),
    toneState: newState(),
    createdAt: now(),
  };
}
// derive tones/syllables client-side (for in-app text uploads) — delegates to core.js
function deriveTones(pinyin) { return YC.deriveTones(pinyin); }
function deriveSyllables(pinyin) { return YC.deriveSyllables(pinyin); }

async function ensureSeeded() {
  const decks = await DB.getAllDecks();
  try {
    const res = await fetch('seed.json', { cache: 'no-store' });
    if (res.ok) {
      const seed = await res.json();
      const lastGen = await DB.getMeta('seedGen');
      // Re-import when first run OR seed.json is newer (updates card content like
      // corrected pinyin), merging while preserving per-mode SR progress.
      if (!decks.length || seed.generatedAt !== lastGen) {
        for (const d of seed.decks || []) await importDeck(d, false);
        await DB.setMeta('seedGen', seed.generatedAt || String(now()));
        await DB.setMeta('seeded', true);
      }
    }
  } catch (e) { /* offline: keep whatever is stored */ }
}

// One-time migration of already-stored cards to the 3-mode schema + refreshed tones.
async function migrateCards() {
  const done = await DB.getMeta('migv4');
  const cards = await DB.allCards();
  if (!cards.length) { await DB.setMeta('migv4', true); return; }
  let changed = 0;
  for (const c of cards) {
    let dirty = false;
    if (!c.zhEnState) { c.zhEnState = c.meaningState || newState(); dirty = true; }
    if (!c.enZhState) { c.enZhState = c.meaningState ? { ...c.meaningState } : newState(); dirty = true; }
    if (!c.toneState) { c.toneState = newState(); dirty = true; }
    const nt = deriveTones(c.pinyin || '');
    const ns = deriveSyllables(c.pinyin || '');
    if (JSON.stringify(nt) !== JSON.stringify(c.tones)) { c.tones = nt; dirty = true; }
    if (JSON.stringify(ns) !== JSON.stringify(c.syllables)) { c.syllables = ns; dirty = true; }
    if (dirty) { await DB.putCard(c); changed++; }
  }
  await DB.setMeta('migv4', true);
  if (changed && !done) console.log('migrated', changed, 'cards to v4');
}

async function importDeck(deckRaw, notify = true) {
  const deckId = deckRaw.id || ('d_' + Math.random().toString(36).slice(2, 10));
  const existing = await DB.getDeck(deckId);
  const deck = {
    id: deckId,
    title: deckRaw.title || deckRaw.source || 'Untitled',
    source: deckRaw.source || '',
    summary: deckRaw.summary || '',
    createdAt: deckRaw.createdAt || new Date().toISOString(),
  };
  await DB.putDeck(deck);
  // merge cards: keep SR state for cards that already exist
  const existingCards = existing ? await DB.cardsFor(deckId) : [];
  const byId = new Map(existingCards.map(c => [c.id, c]));
  const recs = (deckRaw.cards || []).map(raw => {
    const rec = makeCardRecord(raw, deckId);
    const prev = byId.get(rec.id);
    if (prev) {
      // migrate: old schema had single meaningState -> seed both directions from it
      rec.zhEnState = prev.zhEnState || prev.meaningState || rec.zhEnState;
      rec.enZhState = prev.enZhState || prev.meaningState || rec.enZhState;
      rec.toneState = prev.toneState || rec.toneState;
    }
    return rec;
  });
  await DB.putCards(recs);
  if (notify) toast(`Imported “${deck.title}” · ${recs.length} cards`);
  return deck;
}

// Parse an uploaded plain-text/markdown homework into cards (best-effort).
// Accepts lines like:  pinyin - meaning   |   pinyin: meaning   |   pinyin, meaning
function parseTextUpload(text, name) {
  const lines = text.split(/\r?\n/);
  const cards = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = line.split(/\s*[-–—:|\t]\s*|\s{2,}/);
    if (m.length >= 2) {
      const pinyin = m[0].trim();
      const meaning = m.slice(1).join(' ').trim();
      if (pinyin && meaning) cards.push({ front: pinyin, pinyin, meaning, tones: deriveTones(pinyin), syllables: deriveSyllables(pinyin) });
    }
  }
  return { title: name.replace(/\.[^.]+$/, ''), source: name, createdAt: new Date().toISOString(), cards };
}

// ---------- mastery helpers (3 modes) ----------
function ensureStates(c) {
  if (!c.zhEnState) c.zhEnState = c.meaningState || newState();
  if (!c.enZhState) c.enZhState = c.meaningState ? { ...c.meaningState } : newState();
  if (!c.toneState) c.toneState = newState();
  return c;
}
function stateForMode(c, mode) { return YC.stateForMode(c, mode); }
// A word is truly mastered only when all applicable modes are mastered.
function modesFor(c) { return YC.modesFor(c); }
function fullyMastered(c) { return YC.fullyMastered(c); }

// ---------- deck stats ----------
function deckStats(cards) {
  let due = 0, mastered = 0;
  for (const c of cards) {
    ensureStates(c);
    const dueNow = modesFor(c).some(mode => stateForMode(c, mode).due <= now());
    if (dueNow) due++;
    if (fullyMastered(c)) mastered++;
  }
  return { total: cards.length, due, mastered };
}
// per-mode progress count for a set of cards (delegates to core.js).
function modeMastery(cards, mode) { return YC.modeMastery(cards, mode, now); }
// how many cards are due RIGHT NOW in a specific mode (matches what a
// single-mode session will actually quiz). Skips cards where the mode does
// not apply (e.g. tone mode on a toneless card) so the count matches the
// drill's own cardHasTones filter.
function modeDue(cards, mode) {
  let n = 0;
  for (const c of cards) {
    ensureStates(c);
    if (mode === 'tone' && !YC.cardHasTones(c)) continue;
    if (stateForMode(c, mode).due <= now()) n++;
  }
  return n;
}

// ---------- Router / views ----------
const app = {
  stack: [],
  async go(view, params) {
    this.stack.push({ view, params });
    await render();
  },
  async back() {
    this.stack.pop();
    if (!this.stack.length) this.stack.push({ view: 'home' });
    await render();
  },
  cur() { return this.stack[this.stack.length - 1] || { view: 'home' }; },
};

async function render() {
  const { view, params } = app.cur();
  const root = $('#view');
  root.innerHTML = '';
  $('#backBtn').hidden = app.stack.length <= 1;
  // ＋ upload button only makes sense on the home screen.
  $('#uploadBtn').hidden = view !== 'home';
  if (view === 'home') return renderHome(root);
  if (view === 'deck') return renderDeck(root, params.deckId);
  if (view === 'practice') return renderPractice(root, params);
  if (view === 'mixed') return renderMixedReview(root, params);
  if (view === 'tones') return renderToneDrill(root, params);
}

// ---- Home: deck list ----
const BUILD = 'v17 · emoji on cards only';

async function renderHome(root) {
  $('#title').textContent = '语卡 Flashcards';
  const decks = await DB.getAllDecks();
  // Most recently uploaded deck first.
  decks.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const all = await DB.allCards();
  const byDeck = new Map();
  for (const c of all) { if (!byDeck.has(c.deckId)) byDeck.set(c.deckId, []); byDeck.get(c.deckId).push(c); }

  if (!decks.length) {
    root.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '📚'),
      el('p', {}, 'No decks yet.'),
      el('p', { class: 'hint' }, 'Tap ＋ to upload homework (.json / .txt / .md), or send it to the tutor bot and re-sync.')));
    return;
  }

  // Review everything card
  const totals = deckStats(all);
  const reviewCard = el('div', { class: 'deck review-all', onclick: () => app.go('mixed', {}) },
    el('h3', {}, '🔁 Review Everything'),
    el('div', { class: 'sub' }, 'All modes mixed — every due item (中→EN, EN→中, tones) across every deck'),
    el('div', { class: 'bar' }, el('i', { style: `width:${totals.total ? Math.round(100 * totals.mastered / totals.total) : 0}%` })),
    el('div', { class: 'stats' },
      el('span', { class: 'pill' }, `${totals.total} cards`),
      el('span', { class: 'pill due' }, `${totals.due} due`),
      el('span', { class: 'pill mastered' }, `${totals.mastered} mastered`)));
  root.append(reviewCard);
  root.append(el('div', { class: 'hint' }, 'Or pick a single upload to focus on:'));

  for (const d of decks) {
    const cards = byDeck.get(d.id) || [];
    const s = deckStats(cards);
    const pct = s.total ? Math.round(100 * s.mastered / s.total) : 0;
    root.append(el('div', { class: 'deck', onclick: () => app.go('deck', { deckId: d.id }) },
      el('h3', {}, d.title),
      el('div', { class: 'sub' }, d.source || ''),
      el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'stats' },
        el('span', { class: 'pill' }, `${s.total} cards`),
        el('span', { class: 'pill due' }, `${s.due} due`),
        el('span', { class: 'pill mastered' }, `${s.mastered} mastered`))));
  }
  root.append(el('div', { class: 'hint', style: 'text-align:center;opacity:.5;margin-top:1.5rem' }, `build ${BUILD}`));
}

// ---- Deck detail ----
async function renderDeck(root, deckId) {
  const deck = await DB.getDeck(deckId);
  const cards = await DB.cardsFor(deckId);
  $('#title').textContent = deck ? deck.title : 'Deck';
  const s = deckStats(cards);
  const toneCards = cards.filter(cardHasTones);

  if (deck.summary) root.append(el('div', { class: 'hint' }, deck.summary));
  root.append(el('div', { class: 'stats', style: 'margin:.4rem 0 0' },
    el('span', { class: 'pill' }, `${s.total} cards`),
    el('span', { class: 'pill due' }, `${s.due} due`),
    el('span', { class: 'pill mastered' }, `${s.mastered} mastered`)));

  const actions = el('div', { class: 'actions' });
  const mZhEn = modeMastery(cards, 'zh2en');
  const mEnZh = modeMastery(cards, 'en2zh');
  const mTone = modeMastery(cards, 'tone');
  // Simple, honest per-mode label: how many are due (what a session quizzes),
  // ✅ when the whole mode is mastered, "caught up" when nothing's due right now.
  const label = (base, mode, m) => {
    if (m.applicable && m.mastered >= m.applicable) return `${base} · ✅ mastered`;
    const d = modeDue(cards, mode);
    return d ? `${base} · ${d} due` : `${base} · caught up`;
  };
  actions.append(el('button', { class: 'btn primary', onclick: () => app.go('practice', { mode: 'deck', deckId, dir: 'zh2en' }) }, label('Practice 中→EN', 'zh2en', mZhEn)));
  actions.append(el('button', { class: 'btn', onclick: () => app.go('practice', { mode: 'deck', deckId, dir: 'en2zh' }) }, label('Practice EN→中', 'en2zh', mEnZh)));
  const toneBtn = el('button', { class: 'btn', onclick: () => app.go('tones', { deckId }) }, mTone.applicable ? label('🎵 Tone drills', 'tone', mTone) : '🎵 Tone drills · n/a');
  if (!toneCards.length) toneBtn.disabled = true;
  actions.append(toneBtn);
  actions.append(el('button', { class: 'btn ghost', onclick: () => app.go('practice', { mode: 'deck', deckId, dir: 'zh2en', cram: true }) }, 'Cram all cards'));
  root.append(actions);
  root.append(el('div', { class: 'hint' }, 'Master a word in all three modes to truly master it — ✅ marks a mode complete.'));

  // card list preview
  root.append(el('div', { class: 'hint' }, 'Cards in this deck:'));
  for (const c of cards) {
    ensureStates(c);
    root.append(el('div', { class: 'deck', style: 'cursor:default;padding:.7rem 1rem' },
      el('div', { style: 'display:flex;justify-content:space-between;gap:1rem;align-items:baseline' },
        el('strong', {}, (fullyMastered(c) ? '✅ ' : '') + c.front),
        el('span', { class: 'sub', style: 'margin:0' }, c.meaning))));
  }
}

// ---- Build a practice queue ----
// Returns { queue, dueCount, aheadUsed } so the UI can tell the difference
// between "reviewing due cards" and "getting ahead (nothing was due)".
async function buildQueue({ mode, deckId, cram, dir }) {
  const smode = dir === 'en2zh' ? 'en2zh' : 'zh2en';
  let cards = mode === 'all' ? await DB.allCards() : await DB.cardsFor(deckId);
  cards.forEach(ensureStates);
  if (cram) return { queue: shuffle(cards), dueCount: cards.length, aheadUsed: false };
  const due = cards.filter(c => stateForMode(c, smode).due <= now());
  // If cards are due in this mode, practice EXACTLY those — never pad the
  // session with not-due cards (that was the "click 2 due, get all 27" bug).
  if (due.length) return { queue: shuffle(due), dueCount: due.length, aheadUsed: false };
  // Nothing due in this mode. Do NOT dump the whole deck. Offer a small
  // "get ahead" batch of the least-solid not-yet-mastered cards, capped low.
  const ahead = cards.filter(c => !isMastered(stateForMode(c, smode)))
    .sort((a, b) => stateForMode(a, smode).ease - stateForMode(b, smode).ease)
    .slice(0, 10);
  return { queue: shuffle(ahead), dueCount: 0, aheadUsed: true };
}
function modeScore(c, mode) { const s = stateForMode(c, mode); return s.reps * s.ease; }
function shuffle(a) { return YC.shuffle(a); }
// Chinese/pinyin front, with a trailing emoji when the word has an obvious
// concrete fit (memory aid). Emoji comes from the seed (build_seed.py).
function frontText(c) { return c.emoji ? `${c.front} ${c.emoji}` : c.front; }

// ---- Practice (meaning flashcards) ----
async function renderPractice(root, params) {
  const dir = params.dir === 'en2zh' ? 'en2zh' : 'zh2en';
  const dirLabel = dir === 'en2zh' ? 'EN→中' : '中→EN';
  $('#title').textContent = (params.mode === 'all' ? 'Review All' : 'Practice') + ' · ' + dirLabel;
  const { queue, aheadUsed } = await buildQueue(params);
  if (!queue.length) { root.append(doneScreen('Nothing to practice 🎉', {})); return; }
  // If nothing was due and we're in "get ahead" mode, tell the user up front so
  // they know these cards weren't actually due yet.
  if (aheadUsed) {
    root.append(el('div', { class: 'hint', style: 'text-align:center;color:var(--accent)' },
      `Nothing due right now — practicing ${queue.length} card${queue.length > 1 ? 's' : ''} to get ahead.`));
  }
  let i = 0, revealed = false, correct = 0, again = 0;

  const stage = el('div', { class: 'stage' });
  root.append(stage);
  draw();

  function draw() {
    if (i >= queue.length) { stage.replaceWith(doneScreen('Session complete!', { Reviewed: queue.length, Good: correct, Again: again })); return; }
    const c = queue[i];
    revealed = false;
    stage.innerHTML = '';
    stage.append(el('div', { class: 'progress-row' },
      el('span', {}, `${i + 1} / ${queue.length}`),
      el('span', {}, `${dirLabel} · next ${fmtDue(stateForMode(c, dir).due)}`)));
    const card = el('div', { class: 'card', onclick: reveal });
    if (dir === 'en2zh') {
      card.append(el('div', { class: 'meaning', style: 'font-size:1.7rem' }, c.meaning));
    } else {
      card.append(el('div', { class: 'front' }, frontText(c)));
    }
    card.append(el('div', { class: 'flip-hint' }, 'tap to reveal'));
    stage.append(card);
  }
  function reveal() {
    if (revealed) return; revealed = true;
    const c = queue[i];
    stage.innerHTML = '';
    stage.append(el('div', { class: 'progress-row' }, el('span', {}, `${i + 1} / ${queue.length}`), el('span', {}, dirLabel)));
    const card = el('div', { class: 'card' });
    if (dir === 'en2zh') {
      card.append(el('div', { class: 'meaning', style: 'font-size:1.35rem' }, c.meaning));
      card.append(el('div', { class: 'divider' }));
      card.append(el('div', { class: 'front' }, frontText(c)));
    } else {
      card.append(el('div', { class: 'front' }, frontText(c)));
      card.append(el('div', { class: 'divider' }));
      card.append(el('div', { class: 'meaning' }, c.meaning));
    }
    if (c.example) card.append(el('div', { class: 'example' }, c.example));
    if (c.notes) card.append(el('div', { class: 'notes' }, c.notes));
    stage.append(card);
    const grade = el('div', { class: 'grade grade2' });
    grade.append(gradeBtn('again', '✗ Didn’t know', '', 0));
    grade.append(gradeBtn('easy', '✓ Knew it', '', 3));
    stage.append(grade);
  }
  function gradeBtn(cls, label, sub, g) {
    return el('button', { class: cls, onclick: () => grade(g) }, el('span', {}, label), sub ? el('small', {}, sub) : null);
  }
  async function grade(g) {
    const c = queue[i];
    if (dir === 'en2zh') c.enZhState = schedule(c.enZhState, g);
    else c.zhEnState = schedule(c.zhEnState, g);
    await DB.putCard(c);
    if (g === 0) { again++; queue.push(c); } else correct++;
    i++; draw();
  }
}

// ---- Tone drill ----
async function renderToneDrill(root, params) {
  $('#title').textContent = 'Tone Drills';
  let cards = params.deckId ? await DB.cardsFor(params.deckId) : await DB.allCards();
  cards.forEach(ensureStates);
  cards = cards.filter(cardHasTones);
  // Consistent with meaning practice: if tone cards are due, drill EXACTLY
  // those. If none are due, do NOT dump the deck — offer a small "get ahead"
  // batch of the least-solid cards, capped low, and flag it for the UI.
  const dueTone = cards.filter(c => stateForMode(c, 'tone').due <= now());
  // If nothing is due, show a "caught up" screen with an opt-in button to
  // practice ahead — don't force a grind. (Unless ?ahead=1 was requested.)
  if (!dueTone.length && !params.ahead) {
    if (!cards.length) { root.append(doneScreen('No tone cards here', {})); return; }
    const wrap = el('div', { class: 'done-screen' },
      el('div', { class: 'big' }, '✅'),
      el('h2', {}, 'All caught up on tones!'),
      el('div', { class: 'hint', style: 'margin:.4rem 0 1rem' }, 'Nothing due right now. New reviews will surface here when they’re due.'),
      el('button', { class: 'btn', onclick: () => app.go('tones', { deckId: params.deckId, ahead: 1 }) }, 'Practice ahead anyway'),
      el('button', { class: 'btn primary', onclick: () => app.back() }, 'Done'));
    root.append(wrap); return;
  }
  let pool;
  if (dueTone.length) {
    pool = dueTone;
  } else {
    cards.sort((a, b) => (a.toneState.reps * a.toneState.ease) - (b.toneState.reps * b.toneState.ease));
    pool = cards.slice(0, 10);
  }
  const queue = shuffle(pool);
  if (!queue.length) { root.append(doneScreen('No tone cards here', {})); return; }
  if (!dueTone.length) {
    root.append(el('div', { class: 'hint', style: 'text-align:center;color:var(--accent)' },
      `Nothing due right now — practicing ${queue.length} tone card${queue.length > 1 ? 's' : ''} to get ahead.`));
  }
  let i = 0, hits = 0, misses = 0;
  const stage = el('div', { class: 'stage' });
  root.append(stage);
  draw();

  function draw() {
    if (i >= queue.length) { stage.replaceWith(doneScreen('Tone drill done! 🎵', { Words: queue.length, Correct: hits, Missed: misses })); return; }
    const c = queue[i];
    const syls = (c.syllables && c.syllables.length ? c.syllables : (c.pinyin.includes(' ') ? c.pinyin.split(/\s+/) : [c.pinyin]));
    const answers = c.tones.slice();
    // toneless display: strip the diacritics so the answer isn't given away
    const bare = syls.map(stripToneMarks);
    const picks = new Array(syls.length).fill(null); // user's tone choice per syllable
    let activeSyl = 0; // which syllable we're currently assigning
    let locked = false;

    function render() {
      stage.innerHTML = '';
      stage.append(el('div', { class: 'progress-row' }, el('span', {}, `${i + 1} / ${queue.length}`), el('span', {}, c.meaning)));
      const wrap = el('div', { class: 'card', style: 'min-height:26vh' });
      // toneless word
      wrap.append(el('div', { class: 'drill-word' }, bare.join('')));
      // per-syllable slots showing chosen tone (or blank), highlight the active one
      wrap.append(el('div', { class: 'syllable-tones' }, ...bare.map((s, k) => {
        const chosen = picks[k];
        const cls = 'syl' + (k === activeSyl && !locked ? ' target' : '');
        const style = k === activeSyl && !locked ? 'outline:2px solid var(--accent)' : '';
        const label = chosen ? `${s}${'₁₂₃₄₅'[chosen-1]||''}` : s;
        const node = el('span', { class: cls, style }, label);
        if (locked) node.classList.add(picks[k] === answers[k] ? 'ok' : 'bad');
        return node;
      })));
      wrap.append(el('div', { class: 'drill-q' }, locked ? '' : `Tone for syllable ${activeSyl + 1} of ${syls.length}: “${bare[activeSyl]}”`));
      stage.append(wrap);
      if (!locked) {
        const choices = el('div', { class: 'tone-choices' });
        for (let t = 1; t <= 5; t++) {
          choices.append(el('button', { 'data-t': t, onclick: () => choose(t) },
            el('span', {}, t === 5 ? '·' : String(t)), el('span', { class: 'lbl' }, TONE_NAMES[t].split(' ')[1] || 'neutral')));
        }
        stage.append(choices);
      }
    }

    function choose(t) {
      picks[activeSyl] = t;
      // advance to next syllable; skip nothing — every syllable needs a tone (neutral=5 valid)
      if (activeSyl < syls.length - 1) { activeSyl++; render(); }
      else finish();
    }

    async function finish() {
      locked = true;
      const allCorrect = picks.every((p, k) => p === answers[k]);
      if (allCorrect) hits++; else misses++;
      c.toneState = schedule(c.toneState, allCorrect ? 2 : 0);
      await DB.putCard(c);
      if (!allCorrect) queue.push(c);
      render();
      // show the correct answer and wait for the user to tap Next so they have
      // time to internalize it (no auto-advance).
      const q = stage.querySelector('.drill-q');
      if (q) q.textContent = allCorrect ? '✓ correct' : 'answer: ' + syls.join(' ');
      const next = el('div', { class: 'grade grade1' },
        el('button', { class: 'easy', onclick: () => { i++; draw(); } },
          el('span', {}, i + 1 >= queue.length ? 'Finish' : 'Next →')));
      stage.append(next);
    }

    render();
  }
}

// ---- Mixed review: every due (card, mode) across ALL decks, interleaved ----
async function renderMixedReview(root, params) {
  $('#title').textContent = 'Review All · mixed';
  const cards = await DB.allCards();
  cards.forEach(ensureStates);
  // Build one queue entry per DUE (card, mode) pair. modesFor() returns the
  // modes applicable to a card (tone only when it has tone data).
  let items = [];
  for (const c of cards) {
    for (const mode of modesFor(c)) {
      if (stateForMode(c, mode).due <= now()) items.push({ c, mode });
    }
  }
  // Nothing due: fall back to the least-solid unmastered items so the user can
  // keep practicing, still mixed across modes. Cap it so it isn't overwhelming.
  if (!items.length) {
    const pool = [];
    for (const c of cards) for (const mode of modesFor(c)) {
      if (!isMastered(stateForMode(c, mode))) pool.push({ c, mode });
    }
    pool.sort((a, b) => (stateForMode(a.c, a.mode).ease) - (stateForMode(b.c, b.mode).ease));
    items = pool.slice(0, 30);
  }
  const queue = shuffle(items);
  if (!queue.length) { root.append(doneScreen('Nothing to review 🎉', {})); return; }

  let i = 0, good = 0, again = 0;
  const stage = el('div', { class: 'stage' });
  root.append(stage);
  draw();

  function advance(wasGood, requeueItem) {
    if (wasGood) good++; else { again++; if (requeueItem) queue.push(requeueItem); }
    i++; draw();
  }

  function draw() {
    if (i >= queue.length) {
      stage.replaceWith(doneScreen('Review complete! 🎊', { Reviewed: queue.length, Good: good, Again: again }));
      return;
    }
    const item = queue[i];
    stage.innerHTML = '';
    if (item.mode === 'tone') drawToneItem(item);
    else drawMeaningItem(item);
  }

  // ---- meaning card (zh2en / en2zh) ----
  function drawMeaningItem(item) {
    const { c, mode } = item;
    const dir = mode; // 'zh2en' | 'en2zh'
    const dirLabel = dir === 'en2zh' ? 'EN→中' : '中→EN';
    let revealed = false;
    render();
    function render() {
      stage.innerHTML = '';
      stage.append(el('div', { class: 'progress-row' },
        el('span', {}, `${i + 1} / ${queue.length}`),
        el('span', {}, `${dirLabel} · next ${fmtDue(stateForMode(c, dir).due)}`)));
      const card = el('div', { class: 'card', onclick: reveal });
      if (!revealed) {
        card.append(dir === 'en2zh'
          ? el('div', { class: 'meaning', style: 'font-size:1.7rem' }, c.meaning)
          : el('div', { class: 'front' }, frontText(c)));
        card.append(el('div', { class: 'flip-hint' }, 'tap to reveal'));
        stage.append(card);
      } else {
        if (dir === 'en2zh') {
          card.append(el('div', { class: 'meaning', style: 'font-size:1.35rem' }, c.meaning));
          card.append(el('div', { class: 'divider' }));
          card.append(el('div', { class: 'front' }, frontText(c)));
        } else {
          card.append(el('div', { class: 'front' }, frontText(c)));
          card.append(el('div', { class: 'divider' }));
          card.append(el('div', { class: 'meaning' }, c.meaning));
        }
        if (c.example) card.append(el('div', { class: 'example' }, c.example));
        if (c.notes) card.append(el('div', { class: 'notes' }, c.notes));
        stage.append(card);
        const grade = el('div', { class: 'grade grade2' });
        grade.append(el('button', { class: 'again', onclick: () => grade0(0) }, el('span', {}, '✗ Didn’t know')));
        grade.append(el('button', { class: 'easy', onclick: () => grade0(3) }, el('span', {}, '✓ Knew it')));
        stage.append(grade);
      }
    }
    function reveal() { if (!revealed) { revealed = true; render(); } }
    async function grade0(g) {
      if (dir === 'en2zh') c.enZhState = schedule(c.enZhState, g);
      else c.zhEnState = schedule(c.zhEnState, g);
      await DB.putCard(c);
      advance(g > 0, g === 0 ? item : null);
    }
  }

  // ---- tone item (reuses the tone-drill interaction) ----
  function drawToneItem(item) {
    const { c } = item;
    const syls = (c.syllables && c.syllables.length ? c.syllables : (c.pinyin.includes(' ') ? c.pinyin.split(/\s+/) : [c.pinyin]));
    const answers = c.tones.slice();
    const bare = syls.map(stripToneMarks);
    const picks = new Array(syls.length).fill(null);
    let activeSyl = 0, locked = false;
    render();
    function render() {
      stage.innerHTML = '';
      stage.append(el('div', { class: 'progress-row' }, el('span', {}, `${i + 1} / ${queue.length}`), el('span', {}, `🎵 ${c.meaning}`)));
      const wrap = el('div', { class: 'card', style: 'min-height:26vh' });
      wrap.append(el('div', { class: 'drill-word' }, bare.join('')));
      wrap.append(el('div', { class: 'syllable-tones' }, ...bare.map((s, k) => {
        const chosen = picks[k];
        const cls = 'syl' + (k === activeSyl && !locked ? ' target' : '');
        const style = k === activeSyl && !locked ? 'outline:2px solid var(--accent)' : '';
        const label = chosen ? `${s}${'₁₂₃₄₅'[chosen-1]||''}` : s;
        const node = el('span', { class: cls, style }, label);
        if (locked) node.classList.add(picks[k] === answers[k] ? 'ok' : 'bad');
        return node;
      })));
      wrap.append(el('div', { class: 'drill-q' }, locked ? '' : `Tone for syllable ${activeSyl + 1} of ${syls.length}: “${bare[activeSyl]}”`));
      stage.append(wrap);
      if (!locked) {
        const choices = el('div', { class: 'tone-choices' });
        for (let t = 1; t <= 5; t++) {
          choices.append(el('button', { 'data-t': t, onclick: () => choose(t) },
            el('span', {}, t === 5 ? '·' : String(t)), el('span', { class: 'lbl' }, TONE_NAMES[t].split(' ')[1] || 'neutral')));
        }
        stage.append(choices);
      }
    }
    function choose(t) {
      picks[activeSyl] = t;
      if (activeSyl < syls.length - 1) { activeSyl++; render(); }
      else finish();
    }
    async function finish() {
      locked = true;
      const allCorrect = picks.every((p, k) => p === answers[k]);
      c.toneState = schedule(c.toneState, allCorrect ? 2 : 0);
      await DB.putCard(c);
      render();
      const q = stage.querySelector('.drill-q');
      if (q) q.textContent = allCorrect ? '✓ correct' : 'answer: ' + syls.join(' ');
      const next = el('div', { class: 'grade grade1' },
        el('button', { class: 'easy', onclick: () => advance(allCorrect, allCorrect ? null : item) },
          el('span', {}, i + 1 >= queue.length ? 'Finish' : 'Next →')));
      stage.append(next);
    }
  }
}

function doneScreen(title, stats) {
  const wrap = el('div', { class: 'done-screen' }, el('div', { class: 'big' }, '✅'), el('h2', {}, title));
  const keys = Object.keys(stats);
  if (keys.length) {
    const grid = el('div', { class: 'stat-grid' });
    for (const k of keys) grid.append(el('div', { class: 'stat-box' }, el('div', { class: 'n' }, String(stats[k])), el('div', { class: 'l' }, k)));
    wrap.append(grid);
  }
  wrap.append(el('button', { class: 'btn primary', onclick: () => app.back() }, 'Done'));
  return wrap;
}

// ---------- upload handling ----------
$('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    try {
      const text = await f.text();
      if (f.name.endsWith('.json')) {
        const data = JSON.parse(text);
        const decks = Array.isArray(data) ? data : data.decks ? data.decks : [data];
        for (const d of decks) await importDeck(d, true);
      } else {
        const deck = parseTextUpload(text, f.name);
        if (!deck.cards.length) { toast(`No cards found in ${f.name}`); continue; }
        await importDeck(deck, true);
      }
    } catch (err) { toast(`Failed: ${f.name}`); console.error(err); }
  }
  if (app.cur().view === 'home' || app.cur().view === 'deck') render();
});

$('#backBtn').addEventListener('click', () => app.back());

// ---------- boot ----------
(async function boot() {
  try { await ensureSeeded(); } catch (e) { console.error(e); }
  try { await migrateCards(); } catch (e) { console.error(e); }
  app.stack = [{ view: 'home' }];
  await render();
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      let refreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshed) return; refreshed = true; location.reload();
      });
      // Activate an already-waiting SW immediately.
      if (reg.waiting) reg.waiting.postMessage('skipWaiting');
      // And any SW that finishes installing after this load.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('skipWaiting');
          }
        });
      });
      reg.update();
    } catch (e) { /* ok offline */ }
  }
})();
