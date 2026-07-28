/* sync.js — GitHub-backed progress backup/restore for 语卡.
 *
 * Progress (per-card SR states) is synced to progress.json in the langlearn
 * repo via the GitHub Contents API. The token is entered ONCE per device and
 * stored in this device's IndexedDB `meta` store — it is NEVER committed to the
 * repo, so GitHub secret-scanning never sees or revokes it.
 *
 * Depends on globals from app.js: DB (IndexedDB helper), YukaCore (optional).
 * Exposes window.YukaSync.
 */
(function () {
  'use strict';

  // --- repo config (public, non-secret) ---
  const OWNER = 'Oseifert';
  const REPO = 'langlearn';
  const BRANCH = 'main';
  const PATH = 'progress.json';
  const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
  const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${PATH}`;

  const META_TOKEN = 'gh_token';
  const META_LASTBACKUP = 'sync_last_backup';
  const META_LASTSHA = 'sync_last_sha';

  const enc = (s) => btoa(unescape(encodeURIComponent(s)));
  const dec = (b64) => decodeURIComponent(escape(atob(b64)));

  let backupTimer = null;
  const listeners = new Set();
  function emit(status) { listeners.forEach((fn) => { try { fn(status); } catch (_) {} }); }

  async function getToken() { return (await DB.getMeta(META_TOKEN)) || ''; }
  async function setToken(t) { await DB.setMeta(META_TOKEN, (t || '').trim()); }
  async function hasToken() { return !!(await getToken()); }

  async function lastBackup() { return await DB.getMeta(META_LASTBACKUP); }

  // Collect all card progress into a compact, portable payload.
  async function collectProgress() {
    const cards = await DB.allCards();
    const out = {};
    for (const c of cards) {
      out[c.id] = {
        zhEnState: c.zhEnState,
        enZhState: c.enZhState,
        toneState: c.toneState,
        updatedAt: c.updatedAt || 0,
      };
    }
    return {
      schema: 'yuka.progress.v1',
      device: (navigator.userAgent || '').slice(0, 60),
      savedAt: Date.now(),
      cards: out,
    };
  }

  // Merge a remote payload into local cards. Newest-per-card-per-mode wins,
  // compared by that card's updatedAt. A missing/older remote never clobbers
  // newer local progress, and vice versa.
  async function mergeIntoLocal(remote) {
    if (!remote || !remote.cards) return { merged: 0 };
    const cards = await DB.allCards();
    const byId = new Map(cards.map((c) => [c.id, c]));
    const toWrite = [];
    for (const [id, r] of Object.entries(remote.cards)) {
      const local = byId.get(id);
      if (!local) continue; // card not present locally (deck not imported) — skip
      const rt = r.updatedAt || 0;
      const lt = local.updatedAt || 0;
      if (rt > lt) {
        if (r.zhEnState) local.zhEnState = r.zhEnState;
        if (r.enZhState) local.enZhState = r.enZhState;
        if (r.toneState) local.toneState = r.toneState;
        local.updatedAt = rt;
        toWrite.push(local);
      }
    }
    if (toWrite.length) await DB.putCards(toWrite);
    return { merged: toWrite.length };
  }

  async function ghGet(token) {
    const res = await fetch(`${API}?ref=${BRANCH}&_=${Date.now()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (res.status === 404) return { exists: false, sha: null, json: null };
    if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
    const data = await res.json();
    let json = null;
    try { json = JSON.parse(dec(data.content.replace(/\n/g, ''))); } catch (_) {}
    return { exists: true, sha: data.sha, json };
  }

  async function ghPut(token, contentObj, sha) {
    const body = {
      message: `progress sync ${new Date().toISOString()}`,
      content: enc(JSON.stringify(contentObj, null, 0)),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    const res = await fetch(API, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content && data.content.sha;
  }

  // Full backup: merge remote first (so we don't lose other-device progress),
  // then push the merged result. Retries once on SHA conflict (409/422).
  async function backupNow() {
    const token = await getToken();
    if (!token) { emit({ state: 'no-token' }); return { ok: false, reason: 'no-token' }; }
    emit({ state: 'backing-up' });
    try {
      let remote = await ghGet(token);
      if (remote.json) await mergeIntoLocal(remote.json);
      const payload = await collectProgress();
      let newSha;
      try {
        newSha = await ghPut(token, payload, remote.sha);
      } catch (e) {
        if (/\b(409|422)\b/.test(String(e))) {
          remote = await ghGet(token);
          if (remote.json) await mergeIntoLocal(remote.json);
          const payload2 = await collectProgress();
          newSha = await ghPut(token, payload2, remote.sha);
        } else throw e;
      }
      const ts = Date.now();
      await DB.setMeta(META_LASTBACKUP, ts);
      if (newSha) await DB.setMeta(META_LASTSHA, newSha);
      emit({ state: 'ok', lastBackup: ts });
      return { ok: true, at: ts };
    } catch (e) {
      emit({ state: 'error', error: String(e) });
      return { ok: false, reason: String(e) };
    }
  }

  // Restore: pull remote and merge into local (newest-per-card wins).
  async function restoreNow() {
    const token = await getToken();
    if (!token) { emit({ state: 'no-token' }); return { ok: false, reason: 'no-token' }; }
    emit({ state: 'restoring' });
    try {
      const remote = await ghGet(token);
      if (!remote.exists || !remote.json) { emit({ state: 'ok' }); return { ok: true, merged: 0, empty: true }; }
      const r = await mergeIntoLocal(remote.json);
      emit({ state: 'ok' });
      return { ok: true, merged: r.merged };
    } catch (e) {
      emit({ state: 'error', error: String(e) });
      return { ok: false, reason: String(e) };
    }
  }

  // Debounced auto-backup — call after each graded card.
  function scheduleBackup(delayMs = 4000) {
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(() => { backupTimer = null; backupNow(); }, delayMs);
  }

  // Validate a token against the repo (used by settings UI).
  async function testToken(token) {
    try {
      const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      return res.ok;
    } catch (_) { return false; }
  }

  window.YukaSync = {
    getToken, setToken, hasToken, lastBackup,
    backupNow, restoreNow, scheduleBackup, testToken,
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _collectProgress: collectProgress, _mergeIntoLocal: mergeIntoLocal,
    REPO_URL: `https://github.com/${OWNER}/${REPO}`,
  };
})();
