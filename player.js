/* Faruk's Movie Zone — the player: custom controls, TV remote, subtitles + live Bengali translation */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const S = window.FMZSubs;
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };

  const video = $('#video'), player = $('#player'), controls = $('#controls'), seek = $('#seek');
  const menu = $('#menu'), subLayer = $('#subLayer'), vol = $('#vol');
  const B = { play: $('#bPlay'), back: $('#bBack'), fwd: $('#bFwd'), mute: $('#bMute'), cc: $('#bCC'), audio: $('#bAudio'), set: $('#bSet'), fs: $('#bFS'), big: $('#bigPlay') };

  const STEP = 15;   // seconds for ← → / skip buttons
  const SIZES = [['S', .75], ['M', 1], ['L', 1.25], ['XL', 1.5], ['XXL', 1.85]];
  const SPEEDS = [.75, 1, 1.25, 1.5, 2];

  let item = null, itemId = '', srcUrl = '', hideTimer = 0, lastSave = 0, toastTimer = 0, osdTimer = 0, cat = null, bound = false;
  const sub = { sources: [], opts: [], cur: null, track: null, cueObjs: [], texts: [], pending: null, tr: null, offset: 0, scale: LS.get('fmz-sub-scale', 1) };
  let resumeFrom = null;
  const nx = { ep: null, shown: false, cancelled: false, timer: 0, left: 0 };
  B.eps = $('#bEps');

  init();

  async function init() {
    const q = new URLSearchParams(location.search);
    try { cat = await FMZ.loadCatalog(); }
    catch (e) { $('#title').textContent = 'Could not open the movie list. Please refresh.'; return; }
    FMZ.renderNav(cat, '');
    const it = findItem(q.get('v'));
    if (!it) { $('#title').textContent = 'This video is not available any more.'; renderSide(null); return; }
    setupPlayer();
    loadItem(it, q.get('t') === '0');
  }

  /** A movie, or an episode with .series */
  function findItem(id) {
    if (!id) return null;
    return cat.movies.find(m => m.id === id) || cat.series.reduce((f, s) => f || s.eps.find(e => e.id === id), null);
  }
  const titleOf = it => it.series ? `${it.series.t} · Episode ${it.n}` : it.t;

  /** Loads a movie or episode into the player (also used for "next episode" without reloading the page) */
  function loadItem(it, fromStart) {
    if (item) saveProgress();
    item = it; itemId = it.id;
    history.replaceState(null, '', FMZ.watchUrl(it.id));
    document.title = titleOf(it) + " · Faruk's Movie Zone";
    $('#kicker').textContent = it.series ? it.series.t : (it.y || '');
    $('#title').textContent = it.series ? `Episode ${it.n}${it.t ? ' · ' + it.t : ''}` : it.t;
    if (it.series) FMZ.setSeriesLast(it.series.id, it.id);
    document.body.dataset.back = it.series ? FMZ.seriesUrl(it.series.id) : 'index.html';
    FMZ.renderNav(cat, it.series ? 'series' : 'movies');
    renderSide(it);
    B.eps.hidden = !it.series;

    // reset
    hideNext(); nx.cancelled = false;
    nx.ep = it.series ? it.series.eps[it.series.eps.findIndex(e => e.id === it.id) + 1] || null : null;
    $('#errorBox').hidden = true;
    resumeFrom = fromStart ? 0 : null;
    sub.offset = LS.get('fmz-sub-offset:' + itemId, 0);
    if (sub.tr) { sub.tr.stop(); sub.tr = null; }
    sub.sources = []; sub.opts = []; sub.cur = null; buildCues(); setTrStatus(null);

    srcUrl = FMZ.directLink(it.v);
    const pic = FMZ.picture(it, true);
    video.removeAttribute('poster');
    if (pic.src) video.poster = pic.src; else if (pic.fid) FMZ.fileURL(pic.fid).then(u => { if (item === it) video.poster = u; }).catch(() => { });
    video.src = srcUrl;
    $('#errVlc').href = 'vlc://' + srcUrl;
    loadSubtitles();
    setupMediaSession();
  }
  function renderSide(it) {
    const box = $('#more');
    if (it && it.series) {
      $('#sideTitle').textContent = 'Episodes';
      box.innerHTML = it.series.eps.map(e => {
        const p = FMZ.getProgress(e.id), w = FMZ.isWatched(e.id), pct = p && p.d ? Math.min(100, p.t / p.d * 100) : 0;
        return `<a class="mini${e.id === it.id ? ' current' : ''}" href="${FMZ.watchUrl(e.id)}" data-ep="${e.id}">
          <div class="thumb">${FMZ.imgTag(e, false, 'mini-pic')}${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}${e.id === it.id ? '<span class="now">▶ Playing</span>' : ''}</div>
          <span class="mini-title"><b>Episode ${e.n}</b>${e.t ? ' · ' + FMZ.esc(e.t) : ''}${w ? ' <em class="ok">✓</em>' : ''}</span></a>`;
      }).join('');
      box.querySelectorAll('[data-ep]').forEach(a => a.addEventListener('click', e => {
        const ep = findItem(a.dataset.ep);
        if (ep && !e.ctrlKey && !e.metaKey) { e.preventDefault(); loadItem(ep); video.play().catch(() => { }); player.focus({ preventScroll: true }); }
      }));
    } else {
      $('#sideTitle').textContent = 'More to watch';
      const others = cat.movies.filter(m => !it || m.id !== it.id).concat(cat.series).sort((a, b) => (b.add || 0) - (a.add || 0));
      box.innerHTML = others.map(o => `<a class="mini" href="${o.eps ? FMZ.seriesUrl(o.id) : FMZ.watchUrl(o.id)}">
          <div class="thumb">${FMZ.imgTag(o, false, 'mini-pic')}<div class="mini-on">${FMZ.titleArt(o, 'mini-logo')}</div></div>
          <span class="mini-title">${FMZ.esc(o.t)}<small>${o.eps ? o.eps.length + ' episodes' : [o.y, FMZ.fmtRuntime(o.rt)].filter(Boolean).join(' · ')}</small></span></a>`).join('')
        || '<p class="card-sub">Nothing else yet.</p>';
    }
    FMZ.fillImages(box);
  }

  /* ================= Next episode ================= */
  function checkNext() {
    if (!nx.ep || nx.cancelled || nx.shown) return;
    const d = video.duration, t = video.currentTime;
    if (isFinite(d) && d > 45 && d - t <= 20) showNext();
  }
  function showNext() {
    nx.shown = true; nx.left = 10;
    const e = nx.ep;
    $('#nextTitle').textContent = `Episode ${e.n}${e.t ? ' · ' + e.t : ''}`;
    $('#nextImg').innerHTML = FMZ.imgTag(e, false, 'next-pic');
    FMZ.fillImages($('#nextImg'));
    $('#nextCard').hidden = false;
    tickNext();
    nx.timer = setInterval(tickNext, 1000);
    if (FMZ.isTV) $('#nextPlay').focus({ preventScroll: true });
  }
  function tickNext() {
    $('#nextLabel').textContent = `Next episode in ${nx.left}s`;
    if (nx.left-- <= 0) playNext();
  }
  function hideNext() { clearInterval(nx.timer); nx.shown = false; $('#nextCard').hidden = true; }
  function playNext() {
    const e = nx.ep; hideNext();
    if (!e) return;
    FMZ.setProgress(itemId, video.duration, video.duration);   // mark this one watched
    loadItem(e, true);
    const p = video.play(); if (p) p.catch(() => { });
    player.focus({ preventScroll: true });
  }
  function openEpisodes() {
    const s = item.series;
    openMenu('Episodes', s.eps.map(e => ({
      label: `Episode ${e.n}${e.t ? ' · ' + e.t : ''}`, active: e.id === item.id,
      value: FMZ.isWatched(e.id) ? '✓' : '',
      onClick: () => { closeMenu(B.eps); if (e.id !== item.id) { loadItem(e); video.play().catch(() => { }); } }
    })));
  }

  /* ================= Player setup ================= */
  function setupPlayer() {
    $('#playerBox').hidden = false;
    if (matchMedia('(hover:hover)').matches && !FMZ.isTV) $('#keys').hidden = false;
    player.style.setProperty('--sub-scale', sub.scale);
    sub.track = video.addTextTrack('subtitles', 'FMZ', 'bn');
    sub.track.mode = 'hidden';
    sub.track.addEventListener('cuechange', renderSubs);
    video.volume = LS.get('fmz-vol', 1);
    bindEvents();
    $('#nextPlay').addEventListener('click', playNext);
    $('#nextCancel').addEventListener('click', () => { nx.cancelled = true; hideNext(); player.focus({ preventScroll: true }); });
    B.eps.addEventListener('click', () => toggleMenu('eps', openEpisodes));
    video.addEventListener('timeupdate', checkNext);
    video.addEventListener('ended', () => { if (nx.ep && !nx.cancelled) playNext(); else if (item) FMZ.setProgress(itemId, video.duration, video.duration); });
    player.focus({ preventScroll: true });
    showControls();
  }

  function bindEvents() {
    video.addEventListener('play', onPlayState);
    video.addEventListener('pause', onPlayState);
    video.addEventListener('ended', onPlayState);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('durationchange', onTime);
    video.addEventListener('progress', onBuffer);
    video.addEventListener('waiting', () => { $('#spinner').hidden = false; });
    video.addEventListener('playing', () => { $('#spinner').hidden = true; });
    video.addEventListener('canplay', () => { $('#spinner').hidden = true; });
    video.addEventListener('loadstart', () => { if (!video.paused) $('#spinner').hidden = false; });
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onError);
    video.addEventListener('ratechange', () => osd(video.playbackRate + '×', 'center'));
    // iPhone uses its own full-screen player: show subtitles through the native track there
    video.addEventListener('webkitbeginfullscreen', () => { if (sub.cur) sub.track.mode = 'showing'; });
    video.addEventListener('webkitendfullscreen', () => { sub.track.mode = 'hidden'; });

    B.play.addEventListener('click', togglePlay);
    B.big.addEventListener('click', e => { e.stopPropagation(); togglePlay(); });
    B.back.addEventListener('click', () => skip(-STEP));
    B.fwd.addEventListener('click', () => skip(STEP));
    B.mute.addEventListener('click', () => { video.muted = !video.muted; });
    B.fs.addEventListener('click', toggleFS);
    B.cc.addEventListener('click', () => toggleMenu('cc', openCCMenu));
    B.set.addEventListener('click', () => toggleMenu('set', openSettings));
    B.audio.addEventListener('click', () => toggleMenu('audio', openAudioMenu));
    vol.addEventListener('input', () => { video.volume = +vol.value; video.muted = video.volume === 0; });

    seek.addEventListener('input', () => {
      const d = video.duration;
      if (!isFinite(d)) return;
      const t = seek.value / 1000 * d;
      video.currentTime = t;
      seek.style.setProperty('--p', seek.value / 10 + '%');
      $('#time').textContent = FMZ.fmtTime(t) + ' / ' + FMZ.fmtTime(d);
      showControls();
    });
    seek.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.preventDefault(); });

    // Mouse: click = play/pause, double click = full screen. Touch: tap = show/hide controls, double-tap sides = ±10s
    const tap = $('#tap');
    // Double click / double tap: left half = back 15s, right half = forward 15s (keep clicking to skip more).
    // Single click: mouse = play/pause, touch = show/hide controls.
    let lastClick = 0, clickTimer = 0, chainUntil = 0;
    tap.addEventListener(window.PointerEvent ? 'pointerup' : 'click', e => {
      if (!menu.hidden) { closeMenu(); return; }
      const now = Date.now(), r = player.getBoundingClientRect();
      const step = (e.clientX - r.left) / r.width < .5 ? -STEP : STEP;
      if (now < chainUntil || now - lastClick < 350) {
        clearTimeout(clickTimer); lastClick = 0; chainUntil = now + 650;
        skip(step); return;
      }
      lastClick = now;
      const isMouse = !e.pointerType || e.pointerType === 'mouse';
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        if (isMouse) { togglePlay(); showControls(); }
        else if (player.classList.contains('show-controls') && !video.paused) hideControls(true);
        else showControls();
      }, 300);
    });
    tap.addEventListener('dblclick', e => e.preventDefault());
    player.addEventListener('mousemove', () => showControls());
    controls.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    controls.addEventListener('mouseleave', scheduleHide);
    controls.addEventListener('focusin', () => showControls());
    menu.addEventListener('click', e => e.stopPropagation());

    document.addEventListener('fullscreenchange', onFSChange);
    document.addEventListener('webkitfullscreenchange', onFSChange);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('pagehide', saveProgress);
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

    $('#errCopy').addEventListener('click', copyLink);
    $('#errRetry').addEventListener('click', () => { $('#errorBox').hidden = true; video.load(); video.play().catch(() => { }); });
    $('#toastBtn').addEventListener('click', () => { const f = $('#toastBtn')._fn; hideToast(); f && f(); });
  }

  /* ================= Playback ================= */
  function togglePlay() {
    if (video.paused || video.ended) { const p = video.play(); if (p) p.catch(() => { }); }
    else video.pause();
  }
  function skip(d) {
    if (!isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration - .5, video.currentTime + d));
    osd((d > 0 ? '+' : '−') + Math.abs(d) + 's', d > 0 ? 'right' : 'left');
    showControls();
  }
  function osd(text, pos) {
    const o = $('#osd');
    o.textContent = text; o.className = 'osd show ' + pos;
    clearTimeout(osdTimer); osdTimer = setTimeout(() => o.classList.remove('show'), 700);
  }
  function onPlayState() {
    const playing = !video.paused && !video.ended;
    player.classList.toggle('playing', playing);
    B.play.classList.toggle('toggled', playing);
    if (playing) { $('#errorBox').hidden = true; scheduleHide(); } else { showControls(); saveProgress(); }
  }
  function onTime() {
    const d = video.duration, t = video.currentTime;
    if (isFinite(d) && d > 0) {
      seek.value = Math.round(t / d * 1000);
      seek.style.setProperty('--p', (t / d * 100) + '%');
    }
    $('#time').textContent = FMZ.fmtTime(t) + ' / ' + FMZ.fmtTime(d);
    if (Date.now() - lastSave > 5000) saveProgress();
  }
  function onBuffer() {
    const d = video.duration, b = video.buffered;
    if (!isFinite(d) || !b.length) return;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 1) end = Math.max(end, b.end(i));
    seek.style.setProperty('--b', (end / d * 100) + '%');
  }
  function onVolume() {
    B.mute.classList.toggle('toggled', video.muted || video.volume === 0);
    vol.value = video.muted ? 0 : video.volume;
    vol.style.setProperty('--v', (video.muted ? 0 : video.volume * 100) + '%');
    if (!video.muted) LS.set('fmz-vol', video.volume);
  }
  function saveProgress() {
    lastSave = Date.now();
    if (isFinite(video.duration) && video.currentTime > 0) FMZ.setProgress(itemId, video.currentTime, video.duration);
  }
  function onMeta() {
    onTime(); onVolume();
    setupAudioTracks();
    const p = resumeFrom === 0 ? null : FMZ.getProgress(itemId);
    if (p && p.t > 15 && p.t < video.duration - 60) {
      video.currentTime = p.t;
      toast('Resumed from ' + FMZ.fmtTime(p.t), 'Start over', () => { video.currentTime = 0; });
    }
  }
  function onError() {
    const code = video.error && video.error.code;
    $('#spinner').hidden = true;
    $('#errTitle').textContent = code === 4 ? "This video can't play in this browser" : 'The video could not be loaded';
    $('#errText').textContent = code === 4
      ? 'MKV files play in Chrome and Edge on PC and Android. On iPhone, iPad and many TVs, open it in the free VLC app instead.'
      : 'Check your internet connection and try again. If it keeps failing, the Dropbox link may have expired or hit its daily limit.';
    $('#errorBox').hidden = false;
  }
  function copyLink() {
    const done = () => toast('Video link copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(srcUrl).then(done, fallback); else fallback();
    function fallback() { const t = document.createElement('textarea'); t.value = srcUrl; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { } t.remove(); }
  }

  /* ================= Controls visibility ================= */
  function showControls() {
    player.classList.add('show-controls');
    scheduleHide();
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (video.paused || !menu.hidden) return;
    hideTimer = setTimeout(() => hideControls(false), FMZ.isTV ? 5000 : 3000);
  }
  function hideControls(force) {
    if (!force && (video.paused || !menu.hidden)) return;
    closeMenu();
    if (controls.contains(document.activeElement)) player.focus({ preventScroll: true });
    player.classList.remove('show-controls');
  }

  /* ================= Full screen ================= */
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function toggleFS() {
    if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (player.requestFullscreen) {
      player.requestFullscreen().then(() => {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => { });
      }).catch(() => { });
    } else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();   // iPhone
  }
  function onFSChange() { B.fs.classList.toggle('toggled', !!fsEl()); player.focus({ preventScroll: true }); }

  /* ================= Audio tracks (Safari / some TVs) ================= */
  function setupAudioTracks() {
    const at = video.audioTracks;
    B.audio.hidden = !(at && at.length > 1);
  }
  function openAudioMenu() {
    const at = video.audioTracks, items = [];
    for (let i = 0; i < at.length; i++) {
      const t = at[i];
      items.push({ label: t.label || (t.language ? t.language.toUpperCase() : 'Audio ' + (i + 1)), active: t.enabled, onClick: () => { for (let j = 0; j < at.length; j++) at[j].enabled = j === i; closeMenu(B.audio); } });
    }
    openMenu('Audio', items);
  }

  /* ================= Menus ================= */
  function toggleMenu(kind, open) {
    if (!menu.hidden && menu.dataset.kind === kind) { closeMenu(B[kind]); return; }
    menu.dataset.kind = kind; open();
  }
  function openMenu(title, items, back) {
    menu.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'menu-head';
    if (back) { const b = document.createElement('button'); b.type = 'button'; b.textContent = '‹ ' + title; b.onclick = back; h.appendChild(b); }
    else h.textContent = title;
    menu.appendChild(h);
    let focusEl = null;
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'menu-item';
      b.innerHTML = `<span class="mi-check">${it.active ? '✓' : ''}</span><span class="mi-label">${FMZ.esc(it.label)}</span>` +
        (it.value != null ? `<span class="mi-value">${FMZ.esc(it.value)}</span>` : '') + (it.sub ? '<span class="mi-arrow">›</span>' : '');
      b.onclick = e => { e.stopPropagation(); it.onClick(b); };
      menu.appendChild(b);
      if ((it.active || it.focus) && !focusEl) focusEl = b;
    });
    menu.hidden = false;
    clearTimeout(hideTimer);
    player.classList.add('show-controls');
    (focusEl || menu.querySelector('.menu-item')).focus({ preventScroll: true });
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (refocus && player.classList.contains('show-controls')) refocus.focus({ preventScroll: true });
    else if (menu.contains(document.activeElement)) player.focus({ preventScroll: true });
    scheduleHide();
  }

  function openCCMenu() {
    if (!sub.sources.length) {
      openMenu('Subtitles', [{ label: sub.loading ? 'Loading subtitles…' : 'No subtitles for this movie', onClick: () => closeMenu(B.cc) }]);
      return;
    }
    const items = [{ label: 'Off', active: !sub.cur, onClick: () => { applyOpt(null, true); closeMenu(B.cc); } }];
    sub.opts.forEach(o => items.push({ label: o.label, active: sub.cur && sub.cur.key === o.key, onClick: () => { applyOpt(o, true); closeMenu(B.cc); } }));
    openMenu('Subtitles', items);
  }

  function openSettings(focusKey) {
    const sizeName = (SIZES.find(s => s[1] === sub.scale) || SIZES[1])[0];
    const items = [
      { key: 'size', label: 'Subtitle size', value: sizeName, sub: true, onClick: openSizeMenu },
      { key: 'sync', label: 'Subtitle timing', value: fmtOffset(), sub: true, onClick: openSyncMenu },
      { key: 'speed', label: 'Playback speed', value: video.playbackRate + '×', sub: true, onClick: openSpeedMenu }
    ];
    if (sub.cur && sub.cur.bn) items.push({ label: 'Download Bengali subtitle (.vtt)', onClick: downloadSub });
    items.push({ label: 'Open in VLC app', onClick: () => { location.href = 'vlc://' + srcUrl; } });
    items.push({ label: 'Copy video link', onClick: () => { copyLink(); closeMenu(B.set); } });
    if (typeof focusKey === 'string') items.forEach(i => { if (i.key === focusKey) i.focus = true; });
    openMenu('Settings', items);
  }
  const back = key => () => openSettings(key);
  function openSizeMenu() {
    openMenu('Subtitle size', SIZES.map(([n, v]) => ({
      label: n, active: v === sub.scale,
      onClick: () => { sub.scale = v; LS.set('fmz-sub-scale', v); player.style.setProperty('--sub-scale', v); openSizeMenu(); }
    })), back('size'));
  }
  function fmtOffset() { return sub.offset === 0 ? 'In sync' : (sub.offset > 0 ? '+' : '') + sub.offset.toFixed(1) + 's'; }
  function openSyncMenu(focusLabel) {
    const set = (v, lbl) => { sub.offset = Math.round(v * 10) / 10; LS.set('fmz-sub-offset:' + itemId, sub.offset); buildCues(); openSyncMenu(lbl); };
    const items = [
      { label: 'Show earlier  −0.5s', onClick: () => set(sub.offset - .5, 'e') , k: 'e' },
      { label: 'Show later  +0.5s', onClick: () => set(sub.offset + .5, 'l'), k: 'l' },
      { label: 'Reset', value: fmtOffset(), onClick: () => set(0, 'r'), k: 'r' }
    ];
    items.forEach(i => { if (i.k === (typeof focusLabel === 'string' ? focusLabel : 'e')) i.focus = true; });
    openMenu('Timing ' + fmtOffset(), items, back('sync'));
  }
  function openSpeedMenu() {
    openMenu('Speed', SPEEDS.map(v => ({ label: v === 1 ? 'Normal' : v + '×', active: video.playbackRate === v, onClick: () => { video.playbackRate = v; openSettings('speed'); } })), back('speed'));
  }

  /* ================= Toast ================= */
  function toast(text, btnText, fn) {
    $('#toastText').textContent = text;
    const b = $('#toastBtn');
    b.hidden = !btnText; b.textContent = btnText || ''; b._fn = fn;
    $('#toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, btnText ? 7000 : 2500);
  }
  function hideToast() { $('#toast').classList.remove('show'); if ($('#toast').contains(document.activeElement)) player.focus({ preventScroll: true }); }

  /* ================= Subtitles ================= */
  async function loadSubtitles() {
    const me = item;
    const list = (item.subs || []).map(s => ({ f: s.f, url: s.f, label: s.l || '', lang: s.lang || '' }));
    const hasBn = list.some(s => s.lang === 'bn');
    list.forEach(s => { s.auto = !hasBn; });          // translate in the browser only if no Bengali file exists
    if (!list.length) { B.cc.classList.remove('on'); renderMeta(); return; }
    sub.loading = true;
    const res = await Promise.all(list.map(async s => {
      try {
        const cues = S.parse(await FMZ.fileText(s.f));
        if (!cues.length) throw new Error('empty');
        return Object.assign({}, s, { cues, isBn: S.isBengali(cues) });
      } catch (e) { console.warn('Subtitle failed', e); return null; }
    }));
    if (me !== item) return;
    sub.loading = false;
    sub.sources = res.filter(Boolean);
    sub.opts = buildOpts();
    const saved = LS.get('fmz-sub:' + itemId, null);
    let opt = saved && saved !== 'off' ? sub.opts.find(o => o.key === saved) : null;
    if (saved !== 'off' && !opt) {
      const pref = LS.get('fmz-sub-pref', 'bn');
      if (pref === 'orig') opt = sub.opts.find(o => !o.tr) || null;
      else if (pref !== 'off') opt = sub.opts.find(o => o.bn && !o.tr) || sub.opts.find(o => o.tr) || sub.opts[0] || null;
    }
    applyOpt(opt, false);
    renderMeta();
  }

  function buildOpts() {
    const o = [], multi = sub.sources.filter(s => !s.isBn).length > 1;
    sub.sources.forEach((s, i) => {
      if (s.isBn) o.push({ key: 's' + i, label: s.label && !/^(bn|ben|bengali|bangla|বাংলা)$/i.test(s.label) ? s.label : 'বাংলা', src: i, bn: true, tr: false });
      else {
        const base = s.label && !/^(bn|bengali|bangla)$/i.test(s.label) ? s.label : 'Original';
        o.push({ key: 's' + i, label: base, src: i, bn: false, tr: false });
        if (s.auto !== false) o.push({ key: 't' + i, label: 'বাংলা (অটো অনুবাদ)' + (multi ? ' · ' + base : ''), src: i, bn: true, tr: true });
      }
    });
    return o;
  }

  function renderMeta() {
    const chips = [];
    if (sub.opts.some(o => o.bn && !o.tr)) chips.push('<span class="chip gold">বাংলা সাবটাইটেল</span>');
    else if (sub.opts.some(o => o.tr)) chips.push('<span class="chip gold">বাংলা অটো অনুবাদ</span>');
    const base = item.series || item;
    if (!item.series && item.rt) chips.push(`<span class="chip">${FMZ.esc(FMZ.fmtRuntime(item.rt))}</span>`);
    if (base.g && base.g.length) chips.push(`<span class="chip">${FMZ.esc(base.g.join(' · '))}</span>`);
    $('#meta').innerHTML = chips.join('');
  }

  function applyOpt(opt, save) {
    if (sub.tr) { sub.tr.stop(); sub.tr = null; }
    sub.cur = opt; sub.pending = null;
    setTrStatus(null);
    if (save) {
      LS.set('fmz-sub:' + itemId, opt ? opt.key : 'off');
      LS.set('fmz-sub-pref', !opt ? 'off' : opt.bn ? 'bn' : 'orig');
    }
    B.cc.classList.toggle('on', !!opt);
    if (!opt) { buildCues(); return; }
    const src = sub.sources[opt.src];
    sub.texts = src.cues.map(c => c.text);
    if (opt.tr) {
      const t = new S.Translator({
        cues: src.cues, tl: 'bn', cacheKey: src.url,
        getTime: () => video.currentTime - sub.offset,
        onUpdate: idx => {
          idx.forEach(i => {
            const v = t.out[i];
            if (v == null) return;
            sub.texts[i] = v; sub.pending[i] = false;
            if (sub.cueObjs[i]) sub.cueObjs[i].text = S.plain(v);
          });
          renderSubs();
        },
        onProgress: p => setTrStatus(p, t)
      });
      sub.pending = t.out.map(v => v == null);
      t.out.forEach((v, i) => { if (v != null) sub.texts[i] = v; });
      sub.tr = t;
    }
    buildCues();
    if (sub.tr) sub.tr.start(2);
  }

  function buildCues() {
    const tr = sub.track;
    if (tr.cues) for (let i = tr.cues.length - 1; i >= 0; i--) tr.removeCue(tr.cues[i]);
    sub.cueObjs = [];
    if (sub.cur) {
      const Cue = window.VTTCue || window.TextTrackCue;
      sub.sources[sub.cur.src].cues.forEach((c, i) => {
        const s = Math.max(0, c.start + sub.offset), e = Math.max(s + .05, c.end + sub.offset);
        const v = new Cue(s, e, S.plain(sub.texts[i] || ''));
        v.fmzI = i;
        try { tr.addCue(v); } catch (err) { }
        sub.cueObjs.push(v);
      });
    }
    renderSubs();
  }

  function renderSubs() {
    if (!sub.cur || !sub.track) { subLayer.innerHTML = ''; return; }
    const act = sub.track.activeCues;
    let h = '';
    if (act) for (let i = 0; i < act.length; i++) {
      const c = act[i], t = sub.texts[c.fmzI];
      if (!t) continue;
      const pend = sub.pending && sub.pending[c.fmzI];
      h += (h ? '<br>' : '') + `<span${pend ? ' class="pending"' : ''}>${S.toHtml(t)}</span>`;
    }
    subLayer.innerHTML = h;
  }

  let statusTimer = 0;
  function setTrStatus(p, t) {
    const el = $('#trStatus');
    clearTimeout(statusTimer);
    if (p == null) { el.textContent = ''; return; }
    if (p >= 1) {
      el.textContent = t && t.failed ? 'অনুবাদ আংশিক' : 'বাংলা অনুবাদ ✓';
      statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
    } else el.textContent = 'বাংলা অনুবাদ ' + Math.round(p * 100) + '%';
  }

  function downloadSub() {
    if (!sub.cur) return;
    const src = sub.sources[sub.cur.src];
    const blob = new Blob([S.toVTT(src.cues, sub.texts)], { type: 'text/vtt' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = titleOf(item).replace(/[^\p{L}\p{N}]+/gu, '_') + '_bn.vtt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    closeMenu(B.set);
    if (sub.tr && sub.tr.progress < 1) toast('Translation not finished yet — the file has what is done so far');
  }

  function cycleSubs() {
    if (!sub.opts.length) return;
    const all = [null].concat(sub.opts);
    const i = all.findIndex(o => (o && o.key) === (sub.cur && sub.cur.key));
    const next = all[(i + 1) % all.length];
    applyOpt(next, true);
    osd(next ? next.label : 'Subtitles off', 'center');
  }

  /* ================= Keyboard + TV remote ================= */
  function onKey(e) {
    if (!item) return;
    if (!$('#nextCard').hidden && $('#nextCard').contains(document.activeElement) && FMZ.keyDir(e)) {
      const d = FMZ.keyDir(e);
      if (d === 'left' || d === 'right') { e.preventDefault(); e.stopPropagation(); (d === 'left' ? $('#nextPlay') : $('#nextCancel')).focus(); }
      return;
    }
    const t = e.target;
    if (t && t.matches && t.matches('input[type=text],textarea')) return;
    const a = document.activeElement;
    const inPlayer = player.contains(a) || a === document.body || a === null;
    const inMenu = !menu.hidden && menu.contains(a);
    const inCtl = controls.contains(a);
    const ctlVisible = player.classList.contains('show-controls');
    const dir = FMZ.keyDir(e), k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };

    if (FMZ.isBackKey(e)) {
      if (!menu.hidden) { stop(); closeMenu(B[menu.dataset.kind] || B.set); return; }
      if (fsEl()) { if (e.key !== 'Escape') { stop(); toggleFS(); } return; }
      if (inPlayer && ctlVisible && !video.paused) { stop(); hideControls(true); return; }
      return;   // falls through to "back to home"
    }
    if (!inPlayer) return;   // focus is in the page (menu bar / more list): normal arrow navigation

    if (inMenu) {
      if (dir) { stop(); if (dir === 'up' || dir === 'down') FMZ.moveFocus(dir, menu); else if (dir === 'left') { const hb = menu.querySelector('.menu-head button'); hb ? hb.click() : closeMenu(B[menu.dataset.kind]); } }
      return;
    }

    if (dir) {
      stop();
      showControls();
      if (inCtl && ctlVisible) {
        if (a === seek && (dir === 'left' || dir === 'right')) { skip(dir === 'left' ? -STEP : STEP); return; }
        if (!FMZ.moveFocus(dir, controls)) {
          if (dir === 'up') { hideControls(true); player.focus({ preventScroll: true }); }
          else if (dir === 'down' || dir === 'right') FMZ.moveFocus(dir, document, player);
        }
        return;
      }
      if (dir === 'left' || dir === 'right') skip(dir === 'left' ? -STEP : STEP);
      else B.play.focus({ preventScroll: true });
      return;
    }

    if (inCtl && a.tagName === 'BUTTON' && (k === 'Enter' || k === ' ')) return;   // the button handles it
    if ($('#toast').contains(a) || $('#nextCard').contains(a)) return;
    switch (k) {
      case ' ': case 'k': case 'K': case 'Enter': case 'MediaPlayPause': stop(); togglePlay(); showControls(); break;
      case 'MediaPlay': stop(); video.play().catch(() => { }); break;
      case 'MediaPause': case 'MediaStop': stop(); video.pause(); break;
      case 'f': case 'F': stop(); toggleFS(); break;
      case 'm': case 'M': stop(); video.muted = !video.muted; osd(video.muted ? 'Muted' : 'Sound on', 'center'); break;
      case 'c': case 'C': case 'Subtitle': stop(); cycleSubs(); break;
      case 'j': case 'J': case 'MediaRewind': case 'MediaTrackPrevious': stop(); skip(k.startsWith('Media') ? -30 : -STEP); break;
      case 'l': case 'L': case 'MediaFastForward': case 'MediaTrackNext': stop(); skip(k.startsWith('Media') ? 30 : STEP); break;
    }
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      const pic = FMZ.picture(item, false);
      navigator.mediaSession.metadata = new MediaMetadata({ title: titleOf(item), artist: "Faruk's Movie Zone", artwork: pic.src ? [{ src: pic.src }] : [] });
      [['play', () => video.play()], ['pause', () => video.pause()], ['seekbackward', () => skip(-STEP)], ['seekforward', () => skip(STEP)]]
        .forEach(([a, f]) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { } });
    } catch (e) { }
  }
})();
