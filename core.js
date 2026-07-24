/* 语卡 core — pure logic shared by the app and the test suite.
 * NO DOM / IndexedDB / browser globals here. Everything is deterministic
 * (except newState()/schedule() which take a clock via the `nowFn` argument
 * so tests can control time). This module is loaded as a plain <script> in the
 * browser (attaches to window.YukaCore) and via require() in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  root.YukaCore = api;                                                        // browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;

  // ---------- tone-mark utilities ----------
  const TONE_MARKS = { '\u0304': 1, '\u0301': 2, '\u030c': 3, '\u0300': 4 };
  const TONE_NAMES = { 1: 'ˉ high', 2: 'ˊ rising', 3: 'ˇ dip', 4: 'ˋ fall', 5: '· neutral' };

  function stripToneMarks(s) {
    return (s || '').normalize('NFD').replace(/[\u0304\u0301\u030c\u0300]/g, '').normalize('NFC');
  }

  // ---------- SM-2 scheduler (per mastery dimension) ----------
  // state: { ease, interval(days), reps, due(ts), lapses }
  function newState(nowFn) {
    const t = (nowFn || Date.now)();
    return { ease: 2.5, interval: 0, reps: 0, due: t, lapses: 0 };
  }

  // grade: 0 again, 1 hard, 2 good, 3 easy
  function schedule(s, grade, nowFn) {
    const t = (nowFn || Date.now)();
    s = Object.assign({}, s);
    if (grade === 0) {
      s.reps = 0; s.interval = 0; s.lapses = (s.lapses || 0) + 1;
      s.ease = Math.max(1.3, s.ease - 0.2);
      s.due = t + 60 * 1000; // 1 min: resurface this session
      return s;
    }
    const q = grade === 1 ? 3 : grade === 2 ? 4 : 5;
    s.ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    s.reps = (s.reps || 0) + 1;
    if (s.reps === 1) s.interval = grade === 1 ? 1 : grade === 3 ? 4 : 1;
    else if (s.reps === 2) s.interval = grade === 1 ? 3 : 6;
    else s.interval = Math.round(s.interval * s.ease * (grade === 1 ? 0.7 : grade === 3 ? 1.3 : 1));
    s.interval = Math.max(1, s.interval);
    s.due = t + s.interval * DAY;
    return s;
  }

  // ---------- mastery predicates ----------
  const isMastered = (s) => !!(s && s.reps >= 3 && s.interval >= 7);
  // In progress: at least one successful rep and not currently due (resting).
  const isProgressed = (s, nowFn) => !!(s && s.reps >= 1 && s.due > (nowFn || Date.now)());
  const cardHasTones = (c) => Array.isArray(c.tones) && c.tones.some(t => t >= 1 && t <= 4);

  function stateForMode(c, mode) {
    if (mode === 'en2zh') return c.enZhState;
    if (mode === 'tone') return c.toneState;
    return c.zhEnState;
  }
  function modesFor(c) {
    const m = ['zh2en', 'en2zh'];
    if (cardHasTones(c)) m.push('tone');
    return m;
  }
  function fullyMastered(c) {
    return modesFor(c).every(mode => isMastered(stateForMode(c, mode)));
  }
  // per-mode progress count for a set of cards
  function modeMastery(cards, mode, nowFn) {
    let done = 0, mastered = 0, applicable = 0;
    for (const c of cards) {
      if (mode === 'tone' && !cardHasTones(c)) continue;
      applicable++;
      const s = stateForMode(c, mode);
      if (isProgressed(s, nowFn) || isMastered(s)) done++;
      if (isMastered(s)) mastered++;
    }
    return { done, mastered, applicable };
  }

  // Mode-aware deck stats: counts each card once PER applicable mode
  // (zh2en, en2zh, and tone only when the card has tones). So a 30-card deck
  // where every mode is outstanding totals 90 review-items; clearing one whole
  // mode drops due by 30. Matches the (card,mode) unit used by Review-Everything.
  function deckStatsModes(cards, nowFn) {
    let total = 0, due = 0, mastered = 0;
    for (const c of cards) {
      for (const mode of modesFor(c)) {
        total++;
        const s = stateForMode(c, mode);
        if (s.due <= (nowFn ? nowFn() : Date.now())) due++;
        if (isMastered(s)) mastered++;
      }
    }
    return { total, due, mastered };
  }

  // ---------- pinyin -> tones / syllables (greedy segmentation) ----------
  const _INITIALS = ['b','p','m','f','d','t','n','l','g','k','h','j','q','x','zh','ch','sh','r','z','c','s','y','w',''];
  const _FINALS = ['a','o','e','ai','ei','ao','ou','an','en','ang','eng','ong','er','i','ia','ie','iao','iu','ian','in','iang','ing','iong','u','ua','uo','uai','ui','uan','un','uang','ueng','v','ve','van','vn'];
  const _SYL = (() => { const s = new Set(); for (const i of _INITIALS) for (const f of _FINALS) s.add(i + f); ['er','r','n','ng','hm','hng','m'].forEach(x => s.add(x)); return s; })();

  function _stripTones(tok) { let o = ''; for (const ch of tok.normalize('NFD')) { if (TONE_MARKS[ch]) continue; if (/\p{Mn}/u.test(ch)) continue; o += ch; } return o; }
  function _tonePositions(tok) { let idx = -1; const pos = {}; for (const ch of tok.normalize('NFD')) { if (TONE_MARKS[ch]) pos[idx] = TONE_MARKS[ch]; else if (/\p{Mn}/u.test(ch)) {} else idx++; } return pos; }
  function _segment(tok) {
    const base = _stripTones(tok).toLowerCase().replace(/ü/g, 'v');
    const segs = []; let i = 0; const n = base.length;
    while (i < n) {
      let matched = null;
      for (let L = Math.min(6, n - i); L >= 1; L--) { if (_SYL.has(base.slice(i, i + L))) { matched = base.slice(i, i + L); break; } }
      if (!matched) matched = base[i];
      segs.push([i, i + matched.length]); i += matched.length;
    }
    return segs;
  }
  function _tokenTones(tok) { const pos = _tonePositions(tok); return _segment(tok).map(([a, b]) => { for (let k = a; k < b; k++) if (pos[k]) return pos[k]; return 5; }); }
  function _tokenSyllables(tok) {
    const dec = tok.normalize('NFD'); const orig = []; const baseToOrig = [];
    for (const ch of dec) { if (TONE_MARKS[ch] || /\p{Mn}/u.test(ch)) { if (orig.length) orig[orig.length - 1] += ch; continue; } orig.push(ch); baseToOrig.push(orig.length - 1); }
    return _segment(tok).map(([a, b]) => {
      const oa = a < baseToOrig.length ? baseToOrig[a] : 0;
      const ob = (b - 1) < baseToOrig.length ? baseToOrig[b - 1] : orig.length - 1;
      return orig.slice(oa, ob + 1).join('').normalize('NFC');
    });
  }
  function _cleanPinyin(p) {
    p = (p || '').trim();
    p = p.replace(/\([^)]*\)/g, ' ');                  // remove (male)/(female)
    p = p.replace(/[^\w\u00c0-\u024f\s'üÜ]/g, ' ');    // keep letters/diacritics/space
    return p.replace(/\s+/g, ' ').trim();
  }
  function deriveTones(pinyin) {
    pinyin = _cleanPinyin(pinyin); if (!pinyin) return [];
    const toks = pinyin.includes(' ') ? pinyin.split(/\s+/) : [pinyin];
    const out = []; for (const t of toks) if (t) out.push(..._tokenTones(t)); return out;
  }
  function deriveSyllables(pinyin) {
    pinyin = _cleanPinyin(pinyin); if (!pinyin) return [];
    const toks = pinyin.includes(' ') ? pinyin.split(/\s+/) : [pinyin];
    const out = []; for (const t of toks) if (t) out.push(..._tokenSyllables(t)); return out;
  }

  // ---------- shuffle (Fisher-Yates) ----------
  function shuffle(a, rng) {
    rng = rng || Math.random;
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  return {
    DAY, TONE_MARKS, TONE_NAMES,
    stripToneMarks,
    newState, schedule,
    isMastered, isProgressed, cardHasTones,
    stateForMode, modesFor, fullyMastered, modeMastery, deckStatsModes,
    deriveTones, deriveSyllables,
    shuffle,
  };
});
