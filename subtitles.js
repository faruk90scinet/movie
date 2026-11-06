/* Faruk's Movie Zone — subtitle parsing, VTT output and Bengali auto-translation.
   Works in the browser (window.FMZSubs) and in Node (module.exports). */
(function (root) {
  'use strict';

  const pad = n => String(n).padStart(2, '0');

  function parseTime(s) {
    if (!s) return null;
    const p = s.trim().replace(',', '.').split(':');
    let sec = 0;
    for (const x of p) sec = sec * 60 + parseFloat(x);
    return isNaN(sec) ? null : sec;
  }

  function fmtTime(t) {
    if (!(t > 0)) t = 0;
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
    const s = Math.floor(ms % 60000 / 1000), r = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)}.${String(r).padStart(3, '0')}`;
  }

  function cleanAss(t) {
    return String(t).replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
  }

  function splitN(s, sep, n) {
    const out = [];
    let rest = s;
    for (let i = 0; i < n - 1; i++) {
      const k = rest.indexOf(sep);
      if (k < 0) break;
      out.push(rest.slice(0, k).trim());
      rest = rest.slice(k + 1);
    }
    out.push(rest.trim());
    return out;
  }

  function parseAss(text) {
    const cues = [];
    let fmt = null, inEvents = false;
    for (const line of text.split('\n')) {
      if (/^\s*\[Events\]/i.test(line)) { inEvents = true; continue; }
      if (/^\s*\[/.test(line)) { inEvents = false; continue; }
      if (!inEvents) continue;
      if (/^Format:/i.test(line)) { fmt = line.slice(7).split(',').map(s => s.trim().toLowerCase()); continue; }
      if (/^Dialogue:/i.test(line) && fmt) {
        const parts = splitN(line.slice(9), ',', fmt.length);
        const o = {};
        fmt.forEach((f, i) => { o[f] = parts[i]; });
        const t = cleanAss(o.text || '');
        const start = parseTime(o.start), end = parseTime(o.end);
        if (t && start != null && end != null) cues.push({ start, end, text: t });
      }
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  /** Parse WebVTT, SRT or ASS/SSA text into [{start, end, text}] (seconds). */
  function parse(text) {
    text = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (/^\s*\[Script Info\]/i.test(text) || (/\[Events\]/i.test(text) && /^Dialogue:/im.test(text))) return parseAss(text);
    const cues = [];
    for (const block of text.split(/\n[ \t]*\n/)) {
      const lines = block.split('\n');
      const i = lines.findIndex(l => l.includes('-->'));
      if (i < 0) continue;
      const m = lines[i].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if (!m) continue;
      const start = parseTime(m[1]), end = parseTime(m[2]);
      const t = lines.slice(i + 1).join('\n').trim();
      if (start == null || end == null || !t) continue;
      cues.push({ start, end, text: t });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  /** Build a WebVTT file. `texts` (optional) replaces each cue's text by index. */
  function toVTT(cues, texts) {
    let o = 'WEBVTT\n\n';
    cues.forEach((c, i) => {
      const t = String((texts && texts[i] != null ? texts[i] : c.text) || '').replace(/-->/g, '→').replace(/\n{2,}/g, '\n').trim();
      if (!t) return;
      o += `${fmtTime(c.start)} --> ${fmtTime(Math.max(c.end, c.start + 0.05))}\n${t}\n\n`;
    });
    return o;
  }

  function decodeEntities(s) {
    return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  /** Plain text: no tags at all. */
  function plain(t) {
    return decodeEntities(cleanAss(String(t || '')).replace(/<[^>]*>/g, ''));
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** Safe HTML for the on-screen overlay: keeps only <i>, <b>, <u>. */
  function toHtml(t) {
    let s = cleanAss(String(t || '')).replace(/<(?!\/?(?:i|b|u)>)[^>]*>/gi, '');
    s = decodeEntities(s);
    return esc(s).replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>').replace(/\n/g, '<br>');
  }

  function isBengali(cues) {
    const sample = cues.slice(0, 300).map(c => plain(c.text)).join(' ');
    const bn = (sample.match(/[ঀ-৿]/g) || []).length;
    const letters = (sample.match(/\p{L}/gu) || []).length;
    return letters > 0 && bn / letters > 0.3;
  }

  /* ---------------- Translation (free Google Translate web endpoint) ---------------- */

  const GTX = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function gtx(text, tl, sl) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 20000);
    try {
      const url = `${GTX}&sl=${sl || 'auto'}&tl=${tl}&q=${encodeURIComponent(text)}`;
      const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('Translate HTTP ' + r.status);
      const j = await r.json();
      return (j[0] || []).map(seg => (seg && seg[0]) || '').join('');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const prep = t => plain(t).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const needsTranslation = t => /\p{L}/u.test(t);

  // Keep two-person dialogue ("- Hi\n- Hello") on two lines after translation.
  function restoreDialog(orig, tr) {
    const o = plain(orig);
    if (/^\s*[-–]/.test(o) && /\n\s*[-–]/.test(o)) return tr.replace(/\s+[-–]\s*(?=\S)/g, '\n- ').trim();
    return tr;
  }

  async function translateLines(arr, tl) {
    if (!arr.length) return [];
    const res = await gtx(arr.join('\n'), tl);
    const parts = res.split('\n').map(s => s.trim());
    if (parts.length === arr.length) return parts;
    const out = [];   // line count changed — fall back to one line at a time
    for (const l of arr) out.push((await gtx(l, tl)).trim());
    return out;
  }

  function cacheGet(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function cacheSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return; } catch (e) { /* quota */ }
    try {   // make room: drop other cached translations, then retry once
      Object.keys(localStorage).filter(k => k.startsWith('fmz-tr1:') && k !== key).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* give up silently */ }
  }

  /**
   * Translates subtitle cues in batches. Batches nearest to getTime() go first,
   * so the part you are watching is ready within a few seconds.
   */
  class Translator {
    constructor({ cues, tl = 'bn', cacheKey, getTime, onUpdate, onProgress }) {
      this.cues = cues; this.tl = tl; this.getTime = getTime;
      this.onUpdate = onUpdate; this.onProgress = onProgress;
      this.lines = cues.map(c => prep(c.text));
      this.key = cacheKey ? `fmz-tr1:${tl}:${cacheKey}` : null;
      const cached = this.key && typeof localStorage !== 'undefined' ? cacheGet(this.key) : null;
      this.out = cached && cached.n === cues.length ? cached.t : new Array(cues.length).fill(null);
      this.lines.forEach((l, i) => { if (!needsTranslation(l)) this.out[i] = l; });
      this.batches = [];
      let cur = null;
      this.lines.forEach((l, i) => {
        if (!needsTranslation(l)) return;
        if (!cur || cur.chars + l.length + 1 > 1400 || cur.idx.length >= 45) {
          cur = { idx: [], chars: 0, state: 0, fail: 0, tEnd: 0 };
          this.batches.push(cur);
        }
        cur.idx.push(i); cur.chars += l.length + 1; cur.tEnd = cues[i].end;
      });
      this.batches.forEach(b => { if (b.idx.every(i => this.out[i] != null)) b.state = 2; });
      this.stopped = true; this.active = 0;
    }
    get progress() {
      if (!this.batches.length) return 1;
      return this.batches.filter(b => b.state >= 2).length / this.batches.length;
    }
    get failed() { return this.batches.some(b => b.state === 3); }
    start(workers = 2) {
      this.stopped = false;
      this.onProgress && this.onProgress(this.progress);
      this.done = new Promise(res => { this._resolve = res; });
      const n = Math.min(workers, this.batches.filter(b => b.state === 0).length);
      if (!n) { this._resolve(); return this.done; }
      for (let k = 0; k < n; k++) this._work();
      return this.done;
    }
    stop() { this.stopped = true; this._save(true); }
    _pick() {
      const t = this.getTime ? this.getTime() : -Infinity;
      let first = null;
      for (const b of this.batches) {
        if (b.state !== 0) continue;
        if (!first) first = b;
        if (b.tEnd >= t - 5) return b;
      }
      return first;
    }
    async _work() {
      this.active++;
      while (!this.stopped) {
        const b = this._pick();
        if (!b) break;
        b.state = 1;
        try {
          const res = await translateLines(b.idx.map(i => this.lines[i]), this.tl);
          if (this.stopped) { b.state = 0; break; }
          b.idx.forEach((i, k) => { this.out[i] = restoreDialog(this.cues[i].text, res[k] || this.lines[i]); });
          b.state = 2;
          this._save();
          this.onUpdate && this.onUpdate(b.idx);
          this.onProgress && this.onProgress(this.progress);
        } catch (e) {
          b.fail++;
          b.state = b.fail >= 4 ? 3 : 0;
          if (b.state === 3) this.onProgress && this.onProgress(this.progress);
          await sleep(1500 * b.fail);
        }
      }
      this.active--;
      if (!this.active && this._resolve) { this._save(true); this._resolve(); }
    }
    _save(now) {
      if (!this.key || typeof localStorage === 'undefined') return;
      clearTimeout(this._t);
      const write = () => cacheSet(this.key, { n: this.cues.length, t: this.out });
      if (now) write(); else this._t = setTimeout(write, 2000);
    }
  }

  const api = { parse, toVTT, plain, toHtml, isBengali, fmtTime, Translator, gtx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FMZSubs = api;
})(typeof self !== 'undefined' ? self : this);
