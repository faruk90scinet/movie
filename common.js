/* Faruk's Movie Zone — shared helpers: password lock, movie list, watch history, TV remote navigation */
(function () {
  'use strict';
  const FMZ = window.FMZ = {};

  const ua = navigator.userAgent;
  FMZ.isTV = /SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|HbbTV|Opera TV|VIDAA|Hisense|Toshiba|TSBNetTV|PhilipsTV|Large Screen/i.test(ua);
  // Android TV boxes/browsers (e.g. TV Bro) often look like a tablet: Android, not "Mobile", no touch screen
  if (!FMZ.isTV && /TV ?Bro/i.test(ua)) FMZ.isTV = true;
  if (!FMZ.isTV && /Android/i.test(ua) && !/Mobile/i.test(ua) && !('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) FMZ.isTV = true;
  const root = document.documentElement;
  if (FMZ.isTV) root.classList.add('tv');

  /* Layout decided by the real screen shape: landscape → sidebar on the right, player fits the screen height */
  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    const wide = FMZ.isTV || (w > h && w >= 600);
    root.classList.toggle('wide', wide);
    root.classList.toggle('narrow', !wide);
    const bar = document.querySelector('.topbar');
    const room = h - (bar ? bar.offsetHeight : 50) - 110;   // leave space for the movie title under the player
    root.style.setProperty('--pmax', Math.max(320, Math.round(room * 16 / 9)) + 'px');
    const ep = document.getElementById('epTop');
    const epRoom = h - (bar ? bar.offsetHeight : 50) - (ep && !ep.hidden ? ep.offsetHeight : 140) - 90;
    root.style.setProperty('--pmax-ep', Math.max(320, Math.round(epRoom * 16 / 9)) + 'px');
  }
  layout();
  window.addEventListener('resize', layout);
  document.addEventListener('DOMContentLoaded', layout);

  /* Screen text size (S / M / L), remembered on this device */
  const UI_SIZES = [['S', .85], ['M', 1], ['L', 1.18]];
  let uiIdx = 1;
  try { const v = localStorage.getItem('fmz-ui'); if (v != null && UI_SIZES[+v]) uiIdx = +v; } catch (e) { }
  const applyUi = () => document.documentElement.style.setProperty('--ui', UI_SIZES[uiIdx][1]);
  applyUi();
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ui-size'; b.title = 'Text size';
    const label = () => { b.innerHTML = 'Aa<b>' + UI_SIZES[uiIdx][0] + '</b>'; };
    label();
    b.addEventListener('click', () => {
      uiIdx = (uiIdx + 1) % UI_SIZES.length;
      try { localStorage.setItem('fmz-ui', uiIdx); } catch (e) { }
      applyUi(); label();
    });
    bar.appendChild(b);
  });

  FMZ.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ================= Locked library: password → key → movie list ================= */
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = buf => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  const subtle = window.crypto && window.crypto.subtle;
  let KEY = null, catalogPromise = null;

  async function fetchKeys() {
    const r = await fetch('data/keys.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('keys ' + r.status);
    return r.json();
  }
  async function tryKek(rawKek, keys) {
    const kek = await subtle.importKey('raw', rawKek, 'AES-GCM', false, ['decrypt']);
    for (const e of keys.entries) {
      const blob = b64(e);
      try {
        const pt = await subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, kek, blob.subarray(12));
        const o = JSON.parse(new TextDecoder().decode(pt));
        return { key: await subtle.importKey('raw', b64(o.k), 'AES-GCM', false, ['decrypt']), name: o.n };
      } catch (err) { }
    }
    return null;
  }
  async function decrypt(buf) {
    const u = new Uint8Array(buf);
    return subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, KEY, u.subarray(12));
  }

  /** Shows the password screen until a correct password is entered. Resolves with {key, name}. */
  function askPassword(keys, message) {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'login';
      box.innerHTML = `<form class="login-card" autocomplete="off">
          <div class="login-logo"><b>FMZ</b>Faruk's Movie Zone</div>
          <h1>Enter your password</h1>
          <p class="login-msg">${FMZ.esc(message || 'Ask Faruk for a password. You only need it once on this device.')}</p>
          <div class="login-field"><input id="loginPw" type="password" inputmode="text" autocomplete="current-password" placeholder="Password" aria-label="Password">
          <button type="button" class="login-eye" aria-label="Show password">👁</button></div>
          <button class="btn primary login-go" type="submit">Enter</button>
          <p class="login-err" hidden></p>
        </form>`;
      document.body.appendChild(box);
      document.documentElement.classList.add('locked');
      const input = box.querySelector('input'), err = box.querySelector('.login-err'), go = box.querySelector('.login-go');
      box.querySelector('.login-eye').onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; input.focus(); };
      box.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const pw = input.value.trim();
        if (!pw) return;
        go.disabled = true; go.textContent = 'Checking…'; err.hidden = true;
        try {
          const base = await subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
          const raw = await subtle.deriveBits({ name: 'PBKDF2', salt: b64(keys.salt), iterations: keys.iter, hash: 'SHA-256' }, base, 256);
          const ok = await tryKek(raw, keys);
          if (ok) {
            try { localStorage.setItem('fmz-kek', toB64(raw)); localStorage.setItem('fmz-name', ok.name || ''); } catch (x) { }
            box.remove(); document.documentElement.classList.remove('locked');
            FMZ.welcome = ok.name;
            resolve(ok); return;
          }
          err.textContent = 'Wrong password. Please try again.';
        } catch (x) { err.textContent = 'Something went wrong. Please try again.'; }
        err.hidden = false; go.disabled = false; go.textContent = 'Enter'; input.select();
      };
      setTimeout(() => input.focus(), 50);
    });
  }

  FMZ.unlock = async function () {
    if (!subtle) throw new Error('This browser is too old or the page is not on https.');
    const keys = await fetchKeys();
    let saved = null;
    try { saved = localStorage.getItem('fmz-kek'); } catch (e) { }
    if (saved) {
      const ok = await tryKek(b64(saved), keys);
      if (ok) return ok;
      try { localStorage.removeItem('fmz-kek'); } catch (e) { }
      return askPassword(keys, 'Your access has changed. Please enter your password again.');
    }
    return askPassword(keys);
  };

  /** The decrypted movie list: {movies:[…], series:[…], jolsa:{…}} */
  FMZ.loadCatalog = function () {
    if (!catalogPromise) catalogPromise = (async () => {
      const ok = await FMZ.unlock();
      KEY = ok.key; FMZ.userName = ok.name;
      const r = await fetch('data/c.bin', { cache: 'no-cache' });
      if (!r.ok) throw new Error('list ' + r.status);
      const cat = JSON.parse(new TextDecoder().decode(await decrypt(await r.arrayBuffer())));
      cat.movies = cat.movies || []; cat.series = cat.series || [];
      cat.series.forEach(s => s.eps.forEach(e => { e.series = s; }));
      return cat;
    })();
    return catalogPromise;
  };

  const fileCache = {};
  FMZ.fileBytes = function (fid) {
    if (!fileCache[fid]) fileCache[fid] = fetch('data/f/' + fid + '.bin').then(r => { if (!r.ok) throw new Error('file ' + r.status); return r.arrayBuffer(); }).then(decrypt);
    return fileCache[fid];
  };
  FMZ.fileText = async fid => new TextDecoder().decode(await FMZ.fileBytes(fid));
  const urlCache = {};
  FMZ.fileURL = fid => urlCache[fid] || (urlCache[fid] = FMZ.fileBytes(fid).then(b => URL.createObjectURL(new Blob([b], { type: 'image/jpeg' }))));

  /** Fills every <img data-fid> / [data-bgfid] inside an element with its decrypted picture */
  FMZ.fillImages = function (scope) {
    (scope || document).querySelectorAll('[data-fid]').forEach(el => {
      const fid = el.dataset.fid; el.removeAttribute('data-fid');
      FMZ.fileURL(fid).then(u => { el.src = u; el.classList.add('ready'); }).catch(() => { });
    });
  };

  const TMDB_IMG = 'https://image.tmdb.org/t/p/';
  FMZ.tmdbImg = (p, size) => p ? TMDB_IMG + (size || 'w780') + p : '';

  /** Picture for a movie / series / episode: {src} or {fid} */
  FMZ.picture = function (it, big) {
    if (it.bd) return { src: FMZ.tmdbImg(it.bd, big ? 'w1280' : 'w780') };
    if (it.st) return { src: FMZ.tmdbImg(it.st, big ? 'original' : 'w500') };
    if (it.th) return { fid: it.th };
    if (it.series) return FMZ.picture(it.series, big);
    return {};
  };
  FMZ.imgTag = function (it, big, cls) {
    const p = FMZ.picture(it, big);
    if (p.src) return `<img class="${cls || ''} ready" src="${FMZ.esc(p.src)}" alt="" loading="lazy">`;
    if (p.fid) return `<img class="${cls || ''}" data-fid="${p.fid}" alt="">`;
    return `<div class="${cls || ''} noart" style="--h:${FMZ.hue(it.t || it.id)}"></div>`;
  };
  /** Title shown on top of a picture: the official logo if there is one, otherwise big letters */
  FMZ.titleArt = function (it, cls) {
    if (it.lg) return `<img class="${cls || 'logo'}" src="${FMZ.esc(FMZ.tmdbImg(it.lg, 'w500'))}" alt="${FMZ.esc(it.t)}" loading="lazy">`;
    return `<span class="${cls ? cls + '-text' : 'logo-text'}">${FMZ.esc(it.t || '')}</span>`;
  };

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

  FMZ.fmtTime = function (t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  FMZ.fmtRuntime = min => !min ? '' : (min >= 60 ? Math.floor(min / 60) + 'h ' + String(min % 60).padStart(2, '0') + 'm' : min + ' min');
  FMZ.fmtLeft = p => { const s = Math.max(0, p.d - p.t), m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm left' : m + ' min left'; };
  FMZ.isNew = it => it.add && Date.now() - it.add < 7 * 86400000;

  /* ---- watch history (kept on this device) ---- */
  const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
  FMZ.getProgress = id => LSget('fmz-progress', {})[id] || null;
  FMZ.isWatched = id => !!LSget('fmz-watched', {})[id];
  FMZ.setProgress = function (id, t, d) {
    const all = LSget('fmz-progress', {});
    if (d && t > d - Math.min(90, d * 0.05)) {            // finished
      delete all[id];
      const w = LSget('fmz-watched', {}); w[id] = Date.now(); LSset('fmz-watched', w);
    } else if (!d || t < 15) delete all[id];
    else all[id] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
    LSset('fmz-progress', all);
  };
  FMZ.setSeriesLast = (sid, epId) => { const a = LSget('fmz-series', {}); a[sid] = { ep: epId, at: Date.now() }; LSset('fmz-series', a); };
  FMZ.getSeriesLast = sid => LSget('fmz-series', {})[sid] || null;

  /** The episode to play next for a series: the one in progress, else the next unwatched one */
  FMZ.seriesTarget = function (s) {
    const last = FMZ.getSeriesLast(s.id);
    if (last) {
      const i = s.eps.findIndex(e => e.id === last.ep);
      if (i >= 0) {
        if (FMZ.getProgress(s.eps[i].id)) return { ep: s.eps[i], resume: true, at: last.at };
        if (!FMZ.isWatched(s.eps[i].id)) return { ep: s.eps[i], resume: false, at: last.at, upNext: true };
        const next = s.eps.slice(i + 1).find(e => !FMZ.isWatched(e.id)) || s.eps[i + 1];
        if (next) return { ep: next, resume: false, at: last.at, upNext: true };
        return { ep: s.eps[0], resume: false, at: last.at, done: true };
      }
    }
    return { ep: s.eps.find(e => !FMZ.isWatched(e.id)) || s.eps[0], resume: false };
  };

  /** Everything in progress, newest first */
  FMZ.continueList = function (cat) {
    const out = [];
    cat.movies.forEach(m => { const p = FMZ.getProgress(m.id); if (p) out.push({ kind: 'movie', it: m, p, at: p.at }); });
    cat.series.forEach(s => {
      const t = FMZ.seriesTarget(s);
      if (t.at && !t.done) out.push({ kind: 'series', it: s, ep: t.ep, p: FMZ.getProgress(t.ep.id), at: t.at, upNext: t.upNext });
    });
    return out.sort((a, b) => b.at - a.at);
  };

  /** "Episode 4" or, for one video holding several episodes, "Episodes 61–68" */
  FMZ.epLabel = e => e.n2 ? `Episodes ${e.n}–${e.n2}` : `Episode ${e.n}`;
  FMZ.epShort = e => e.n2 ? `E${e.n}–${e.n2}` : `E${e.n}`;
  FMZ.epCount = s => s.eps.reduce((n, e) => n + (e.n2 ? e.n2 - e.n + 1 : 1), 0);
  FMZ.watchUrl = id => 'watch.html?v=' + encodeURIComponent(id);
  FMZ.seriesUrl = id => 'index.html#s/' + encodeURIComponent(id);
  FMZ.hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
  FMZ.PLAY_SVG = PLAY;

  /** Top menu: Home · Movies · Web Series · জলসার নাটক */
  FMZ.renderNav = function (cat, active) {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const items = [['home', 'index.html', 'Home'], ['movies', 'index.html#movies', 'Movies'], ['series', 'index.html#series', 'Web Series']];
    if (cat && cat.jolsa) items.push(['jolsa', 'index.html#jolsa', 'জলসার নাটক']);
    nav.innerHTML = items.map(([k, href, label]) => `<a href="${href}" data-k="${k}"${k === active ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('');
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
    if (t && t.matches && t.matches('input[type=text],input[type=password],input[type=url],input[type=search],textarea,select,[contenteditable]')) return;
    const dir = FMZ.keyDir(e);
    if (dir) {
      if (t && t.matches && t.matches('input[type=range]') && (dir === 'left' || dir === 'right')) return;
      if (FMZ.moveFocus(dir)) e.preventDefault();
      return;
    }
    if (FMZ.isBackKey(e) && document.body.dataset.page === 'watch' && (e.key !== 'Escape' || FMZ.isTV)) {
      e.preventDefault();
      location.href = document.body.dataset.back || 'index.html';
    }
  });
})();
