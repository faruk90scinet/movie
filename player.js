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

  const SIZES = [['S', .75], ['M', 1], ['L', 1.25], ['XL', 1.5], ['XXL', 1.85]];
  const SPEEDS = [.75, 1, 1.25, 1.5, 2];

  let item = null, itemId = '', srcUrl = '', hideTimer = 0, lastSave = 0, toastTimer = 0, osdTimer = 0;
  const sub = { sources: [], opts: [], cur: null, track: null, cueObjs: [], texts: [], pending: null, tr: null, offset: 0, scale: LS.get('fmz-sub-scale', 1) };

  init();

  async function init() {
    itemId = new URLSearchParams(location.search).get('id') || 'channel1';
    let data;
    try { data = await FMZ.loadData(); }
    catch (e) { $('#title').textContent = 'Could not load the movie list. Please refresh.'; return; }
    FMZ.renderNav(data, itemId);
    renderMore(data);
    item = data[itemId];
    if (!item) { $('#title').textContent = 'Movie not found'; return; }
    item.id = itemId;
    document.title = (item.title || itemId) + " · Faruk's Movie Zone";
    $('#title').textContent = item.title || itemId;
    if (FMZ.isLinks(item)) return renderLinks();
    setupPlayer();
  }

  function renderMore(data) {
    const others = FMZ.items(data).filter(it => it.id !== itemId);
    $('#more').innerHTML = others.map(it =>
      `<a class="mini" href="${FMZ.watchUrl(it.id)}">${FMZ.thumbHTML(it)}<span class="mini-title">${FMZ.esc(it.title || it.id)}</span></a>`).join('')
      || '<p class="card-sub">Nothing else yet.</p>';
  }

  function renderLinks() {
    const links = (item.links || []).filter(l => l && (l.url || l.link));
    const box = $('#links');
    box.hidden = false;
    $('#meta').innerHTML = `<span class="chip gold">${links.length} videos</span>`;
    if (!links.length) { box.innerHTML = '<p class="card-sub">No videos yet.</p>'; return; }
    $('#frameBox').hidden = false;
    box.innerHTML = links.map((l, i) =>
      `<button class="link-btn" type="button" data-i="${i}"><span class="play">${FMZ.PLAY_SVG}</span><span>${FMZ.esc(l.title || l.label || 'Video ' + (i + 1))}</span></button>`).join('');
    const frame = $('#frame'), fp = $('#framePlayer');
    const saved = LS.get('fmz-ep:' + itemId, 0);
    function play(i, focusFrame) {
      const l = links[i]; if (!l) return;
      const url = l.url || l.link;
      if (frame.src !== url) frame.src = url;
      $('#frameOpen').href = url;
      $('#frameNow').textContent = l.title || '';
      box.querySelectorAll('.link-btn').forEach((b, k) => b.classList.toggle('active', k === i));
      LS.set('fmz-ep:' + itemId, i);
      if (focusFrame) fp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    box.addEventListener('click', e => { const b = e.target.closest('.link-btn'); if (b) play(+b.dataset.i, true); });
    $('#frameFS').onclick = () => {
      if (fp.requestFullscreen) fp.requestFullscreen().catch(() => { });
      else if (fp.webkitRequestFullscreen) fp.webkitRequestFullscreen();
    };
    play(saved < links.length ? saved : 0, false);
    const act = box.querySelector('.link-btn.active'); act && act.focus({ preventScroll: true });
  }

  /* ================= Player setup ================= */
  function setupPlayer() {
    $('#playerBox').hidden = false;
    if (matchMedia('(hover:hover)').matches && !FMZ.isTV) $('#keys').hidden = false;
    srcUrl = FMZ.directLink(item.videoLink);
    sub.offset = LS.get('fmz-sub-offset:' + itemId, 0);
    player.style.setProperty('--sub-scale', sub.scale);

    sub.track = video.addTextTrack('subtitles', 'FMZ', 'bn');
    sub.track.mode = 'hidden';
    sub.track.addEventListener('cuechange', renderSubs);

    if (item.poster) video.poster = FMZ.directLink(item.poster);
    video.volume = LS.get('fmz-vol', 1);
    video.src = srcUrl;
    bindEvents();
    loadSubtitles();
    setupMediaSession();
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
    B.back.addEventListener('click', () => skip(-10));
    B.fwd.addEventListener('click', () => skip(10));
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
    let lastTap = 0, lastX = 0;
    tap.addEventListener('pointerup', e => {
      if (!menu.hidden) { closeMenu(); return; }
      if (e.pointerType === 'mouse') { togglePlay(); showControls(); return; }
      const now = Date.now(), r = player.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
      if (now - lastTap < 320 && Math.abs(e.clientX - lastX) < 70 && (x < .38 || x > .62)) {
        skip(x < .5 ? -10 : 10); lastTap = 0; return;
      }
      lastTap = now; lastX = e.clientX;
      if (player.classList.contains('show-controls') && !video.paused) hideControls(true); else showControls();
    });
    tap.addEventListener('dblclick', toggleFS);
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

    $('#errVlc').href = 'vlc://' + srcUrl;
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
    const p = FMZ.getProgress(itemId);
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
    const list = FMZ.subtitleList(item);
    if (!list.length) { B.cc.classList.remove('on'); renderMeta(); return; }
    sub.loading = true;
    const res = await Promise.all(list.map(async s => {
      try {
        const r = await fetch(s.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const cues = S.parse(await r.text());
        if (!cues.length) throw new Error('empty');
        return Object.assign({}, s, { cues, isBn: S.isBengali(cues) });
      } catch (e) { console.warn('Subtitle failed:', s.url, e); return null; }
    }));
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
    if (item.year) chips.push(`<span class="chip">${FMZ.esc(item.year)}</span>`);
    if (item.info) chips.push(`<span class="chip">${FMZ.esc(item.info)}</span>`);
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
    a.download = (item.title || itemId).replace(/[^\p{L}\p{N}]+/gu, '_') + '_bn.vtt';
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
    if (!item || FMZ.isLinks(item)) return;
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
        if (a === seek && (dir === 'left' || dir === 'right')) { skip(dir === 'left' ? -10 : 10); return; }
        if (!FMZ.moveFocus(dir, controls)) {
          if (dir === 'up') { hideControls(true); player.focus({ preventScroll: true }); }
          else if (dir === 'down' || dir === 'right') FMZ.moveFocus(dir, document, player);
        }
        return;
      }
      if (dir === 'left' || dir === 'right') skip(dir === 'left' ? -10 : 10);
      else B.play.focus({ preventScroll: true });
      return;
    }

    if (inCtl && a.tagName === 'BUTTON' && (k === 'Enter' || k === ' ')) return;   // the button handles it
    if ($('#toast').contains(a)) return;
    switch (k) {
      case ' ': case 'k': case 'K': case 'Enter': case 'MediaPlayPause': stop(); togglePlay(); showControls(); break;
      case 'MediaPlay': stop(); video.play().catch(() => { }); break;
      case 'MediaPause': case 'MediaStop': stop(); video.pause(); break;
      case 'f': case 'F': stop(); toggleFS(); break;
      case 'm': case 'M': stop(); video.muted = !video.muted; osd(video.muted ? 'Muted' : 'Sound on', 'center'); break;
      case 'c': case 'C': case 'Subtitle': stop(); cycleSubs(); break;
      case 'j': case 'J': case 'MediaRewind': case 'MediaTrackPrevious': stop(); skip(k.startsWith('Media') ? -30 : -10); break;
      case 'l': case 'L': case 'MediaFastForward': case 'MediaTrackNext': stop(); skip(k.startsWith('Media') ? 30 : 10); break;
    }
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: item.title || '', artist: "Faruk's Movie Zone", artwork: item.poster ? [{ src: FMZ.directLink(item.poster) }] : [] });
      [['play', () => video.play()], ['pause', () => video.pause()], ['seekbackward', () => skip(-10)], ['seekforward', () => skip(10)]]
        .forEach(([a, f]) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { } });
    } catch (e) { }
  }
})();
