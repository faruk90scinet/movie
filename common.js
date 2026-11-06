/* Faruk's Movie Zone — shared helpers: data, links, saved progress, TV remote navigation */
(function () {
  'use strict';
  const FMZ = window.FMZ = {};

  const ua = navigator.userAgent;
  FMZ.isTV = /SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|HbbTV|Opera TV|VIDAA|PhilipsTV|Large Screen/i.test(ua);
  if (FMZ.isTV) document.documentElement.classList.add('tv');

  FMZ.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  FMZ.loadData = async function () {
    const r = await fetch('movie-data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('movie-data.json: HTTP ' + r.status);
    return r.json();
  };
  FMZ.items = data => Object.keys(data).map(id => Object.assign({ id }, data[id]));
  FMZ.watchUrl = id => 'watch.html?id=' + encodeURIComponent(id);
  FMZ.isLinks = item => item && (item.type === 'links' || Array.isArray(item.links));

  /** Turns a Dropbox share link into a direct stream link. Other links pass through. */
  FMZ.directLink = function (u) {
    if (!u) return '';
    try {
      const x = new URL(u);
      if (/(^|\.)dropbox\.com$/i.test(x.hostname) && !/dropboxusercontent/i.test(x.hostname)) {
        x.hostname = 'dl.dropboxusercontent.com';
        x.searchParams.delete('dl'); x.searchParams.delete('raw');
      }
      return x.toString();
    } catch (e) { return u; }
  };

  /** All subtitle files for an entry: new "subtitles" list plus the older single-link fields. */
  FMZ.subtitleList = function (item) {
    const out = [], seen = new Set();
    const add = (url, label, lang, auto) => {
      url = FMZ.directLink(url);
      if (url && !seen.has(url)) { seen.add(url); out.push({ url, label: label || '', lang: lang || '', auto: auto !== false }); }
    };
    (Array.isArray(item.subtitles) ? item.subtitles : []).forEach(s => {
      if (typeof s === 'string') add(s); else if (s) add(s.url || s.link, s.label, s.lang, s.auto);
    });
    add(item.subtitleBnLink, '', 'bn');
    add(item.subtitleEnLink, 'English', 'en');
    return out;
  };

  FMZ.fmtTime = function (t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };

  /* ---- saved watch position ---- */
  const PKEY = 'fmz-progress';
  const readAll = () => { try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { return {}; } };
  FMZ.getProgress = id => readAll()[id] || null;
  FMZ.setProgress = function (id, t, d) {
    const all = readAll();
    if (!d || t < 15 || t > d - 60) delete all[id]; else all[id] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
    try { localStorage.setItem(PKEY, JSON.stringify(all)); } catch (e) { }
  };

  /* ---- shared markup ---- */
  const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
  FMZ.PLAY_SVG = PLAY;
  FMZ.hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  FMZ.initials = s => String(s).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => [...w][0] || '').join('').toUpperCase();

  FMZ.thumbHTML = function (item, opts = {}) {
    const p = FMZ.getProgress(item.id);
    const pct = p && p.d ? Math.min(100, p.t / p.d * 100) : 0;
    const art = item.poster
      ? `<img src="${FMZ.esc(FMZ.directLink(item.poster))}" alt="" loading="lazy">`
      : `<div class="art" style="--h:${FMZ.hue(item.title || item.id)}"><span>${FMZ.esc(FMZ.initials(item.title || ''))}</span></div>`;
    const tag = opts.tag ? `<span class="tag">${FMZ.esc(opts.tag)}</span>` : '';
    return `<div class="thumb">${art}${tag}<span class="play">${PLAY}</span>${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}</div>`;
  };

  FMZ.renderNav = function (data, activeId) {
    const nav = document.getElementById('nav');
    if (!nav) return;
    nav.innerHTML = FMZ.items(data).map(it =>
      `<a href="${FMZ.watchUrl(it.id)}"${it.id === activeId ? ' class="active" aria-current="page"' : ''}>${FMZ.esc(it.nav || it.title || it.id)}</a>`).join('');
    const a = nav.querySelector('.active');
    if (a) a.scrollIntoView({ block: 'nearest', inline: 'center' });
  };

  /* ---- TV remote / keyboard arrow navigation ---- */
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])';
  FMZ.focusables = function (scope, exclude) {
    return [...(scope || document).querySelectorAll(FOCUSABLE)].filter(el => {
      if (exclude && exclude.contains(el) && exclude !== el) return false;
      if (el.closest('[hidden]')) return false;
      // Hidden player controls are skipped by page-wide navigation (the player handles them itself)
      if ((!scope || scope === document) && el.closest('[data-nav-skip]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  };

  /** Moves focus to the nearest element in a direction. Returns true if it moved. */
  FMZ.moveFocus = function (dir, scope, exclude) {
    const list = FMZ.focusables(scope, exclude);
    const cur = document.activeElement;
    if (!cur || cur === document.body || !list.includes(cur)) {
      if (!list.length) return false;
      list[0].focus(); list[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let main, cross;
      if (dir === 'right') { if (b.left < a.right - 2 && bx <= ax + 2) continue; main = bx - ax; cross = by - ay; }
      else if (dir === 'left') { if (b.right > a.left + 2 && bx >= ax - 2) continue; main = ax - bx; cross = by - ay; }
      else if (dir === 'down') { if (b.top < a.bottom - 2 && by <= ay + 2) continue; main = by - ay; cross = bx - ax; }
      else { if (b.bottom > a.top + 2 && by >= ay - 2) continue; main = ay - by; cross = bx - ax; }
      if (main <= 0) continue;
      // Prefer things on the same row (left/right) or the same column (up/down)
      const overlap = dir === 'left' || dir === 'right'
        ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0
        : Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
      const score = overlap ? main : main + Math.abs(cross) * 2.2 + 5000;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) return false;
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return true;
  };

  FMZ.keyDir = function (e) {
    const k = e.key, c = e.keyCode;
    if (k === 'ArrowLeft' || c === 37) return 'left';
    if (k === 'ArrowRight' || c === 39) return 'right';
    if (k === 'ArrowUp' || c === 38) return 'up';
    if (k === 'ArrowDown' || c === 40) return 'down';
    return null;
  };
  FMZ.isBackKey = e => ['GoBack', 'BrowserBack', 'XF86Back', 'Escape'].includes(e.key) || e.keyCode === 10009 || e.keyCode === 461 ||
    (FMZ.isTV && (e.key === 'Backspace' || e.keyCode === 8));

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (t && t.matches && t.matches('input[type=text],input[type=url],input[type=search],textarea,select,[contenteditable]')) return;
    const dir = FMZ.keyDir(e);
    if (dir) {
      if (t && t.matches && t.matches('input[type=range]') && (dir === 'left' || dir === 'right')) return;
      if (FMZ.moveFocus(dir)) e.preventDefault();
      return;
    }
    if (FMZ.isBackKey(e) && document.body.dataset.page === 'watch' && (e.key !== 'Escape' || FMZ.isTV)) {
      e.preventDefault();
      location.href = 'index.html';
    }
  });
})();
