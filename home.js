/* Faruk's Movie Zone — browsing: Home, Movies, Web Series, a series page, জলসার নাটক */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const E = FMZ.esc;
  let cat = null;

  init();

  async function init() {
    try { cat = await FMZ.loadCatalog(); }
    catch (e) {
      app.innerHTML = `<div class="empty"><h2>Could not open the movie list</h2><p>${E(e.message)}</p><p>Check the internet connection and refresh the page.</p></div>`;
      return;
    }
    window.addEventListener('hashchange', route);
    document.addEventListener('keydown', onBack);
    route();
    if (FMZ.welcome) toast('Welcome, ' + FMZ.welcome + '!');
  }

  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    let active = 'home';
    window.scrollTo(0, 0);
    if (h === 'movies') { active = 'movies'; gridPage('Movies', cat.movies.map(m => tile(m))); }
    else if (h === 'series') { active = 'series'; gridPage('Web Series', cat.series.map(s => tile(s))); }
    else if (h.startsWith('s/')) { active = 'series'; seriesPage(cat.series.find(s => s.id === h.slice(2))); }
    else if (h === 'jolsa' && cat.jolsa) { active = 'jolsa'; jolsaPage(); }
    else home();
    FMZ.renderNav(cat, active);
    document.body.dataset.route = active;
    FMZ.fillImages(app);
    focusFirst();
  }

  function onBack(e) {
    if (!FMZ.isBackKey(e) || e.defaultPrevented) return;
    if (document.fullscreenElement) return;
    if (location.hash && location.hash !== '#') { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = ''); }
  }

  function focusFirst() {
    if (!FMZ.isTV && !matchMedia('(hover:none)').matches && document.activeElement && document.activeElement !== document.body) return;
    const el = app.querySelector('[data-autofocus]') || app.querySelector('a.tile, a.btn, button');
    if (el && FMZ.isTV) el.focus({ preventScroll: true });
  }

  /* ---------------- pieces ---------------- */
  const subsChip = it => {
    const has = it.subs || (it.eps && it.eps.some(e => e.subs));
    return has ? '<span class="chip gold">বাংলা সাবটাইটেল</span>' : '';
  };
  function metaLine(it) {
    const bits = [];
    if (it.y) bits.push(`<span>${E(it.y)}</span>`);
    if (it.eps) bits.push(`<span>${it.eps.length} episode${it.eps.length > 1 ? 's' : ''}</span>`);
    else if (it.rt) bits.push(`<span>${FMZ.fmtRuntime(it.rt)}</span>`);
    if (it.g && it.g.length) bits.push(`<span>${E(it.g.join(' · '))}</span>`);
    return `<div class="meta-line">${bits.join('<i>•</i>')}${subsChip(it)}</div>`;
  }

  /** A landscape card: picture + title on it + progress */
  function tile(it, opt = {}) {
    const isSeries = !!it.eps;
    let href, sub = '', p = null, badge = '';
    if (isSeries) {
      const t = opt.ep ? { ep: opt.ep } : null;
      href = opt.ep ? FMZ.watchUrl(opt.ep.id) : FMZ.seriesUrl(it.id);
      if (opt.ep) { p = opt.p; sub = `Episode ${opt.ep.n}` + (p ? ' · ' + FMZ.fmtLeft(p) : opt.upNext ? ' · Up next' : ''); }
      else sub = `${it.eps.length} episode${it.eps.length > 1 ? 's' : ''}`;
      const newest = Math.max(...it.eps.map(e => e.add || 0));
      if (Date.now() - newest < 7 * 864e5) badge = it.eps.some(e => Date.now() - e.add > 7 * 864e5) ? 'NEW EPISODES' : 'NEW';
      if (t && opt.ep) badge = '';
    } else {
      href = FMZ.watchUrl(it.id);
      p = FMZ.getProgress(it.id);
      sub = p ? FMZ.fmtLeft(p) : [it.y, FMZ.fmtRuntime(it.rt)].filter(Boolean).join(' · ');
      if (!opt.continue && FMZ.isNew(it)) badge = 'NEW';
    }
    const pct = p && p.d ? Math.min(100, p.t / p.d * 100) : 0;
    return `<a class="tile" href="${href}">
      <div class="tile-img">${FMZ.imgTag(it, false, 'tile-pic')}<span class="tile-shade"></span>
        ${badge ? `<span class="badge">${badge}</span>` : ''}
        ${opt.ep ? `<span class="ep-tag">E${opt.ep.n}</span>` : ''}
        <div class="tile-title">${FMZ.titleArt(it, 'tile-logo')}</div>
        ${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}
      </div>
      <div class="tile-sub">${E(sub)}&nbsp;</div>
    </a>`;
  }

  function row(title, tiles) {
    if (!tiles.length) return '';
    return `<section class="row"><h2 class="row-title">${E(title)}</h2><div class="tiles">${tiles.join('')}</div></section>`;
  }

  /* ---------------- Home ---------------- */
  function home() {
    const all = cat.movies.concat(cat.series);
    if (!all.length && !cat.jolsa) { app.innerHTML = '<div class="empty"><h2>No movies yet</h2><p>Add a movie to the Dropbox folder and it will appear here.</p></div>'; return; }
    const cont = FMZ.continueList(cat);
    const heroItem = all.slice().sort((a, b) => (b.add || 0) - (a.add || 0))[0];
    let h = heroItem ? hero(heroItem) : '';
    h += row('Continue watching', cont.map(c => c.kind === 'series' ? tile(c.it, { ep: c.ep, p: c.p, upNext: c.upNext, continue: true }) : tile(c.it, { continue: true })));
    h += row('Movies', sortNew(cat.movies).map(m => tile(m)));
    h += row('Web Series', sortNew(cat.series).map(s => tile(s)));
    if (cat.jolsa) h += `<section class="row"><h2 class="row-title">জলসার নাটক</h2><div class="tiles">
      <a class="tile" href="#jolsa"><div class="tile-img"><div class="tile-pic noart jolsa-art"></div><span class="tile-shade"></span>
      <div class="tile-title"><span class="tile-logo-text bn">${E(cat.jolsa.title)}</span></div></div>
      <div class="tile-sub">${cat.jolsa.links.length} videos</div></a></div></section>`;
    app.innerHTML = h;
  }
  const sortNew = list => list.slice().sort((a, b) => (b.add || 0) - (a.add || 0));

  function hero(it) {
    const isSeries = !!it.eps;
    let play, playLabel, second = '', p = null;
    if (isSeries) {
      const t = FMZ.seriesTarget(it);
      play = FMZ.watchUrl(t.ep.id);
      p = t.resume ? FMZ.getProgress(t.ep.id) : null;
      playLabel = (t.resume ? 'Resume' : t.upNext ? 'Play' : 'Play') + ` Episode ${t.ep.n}`;
      second = `<a class="btn ghost" href="${FMZ.seriesUrl(it.id)}">☰&nbsp; Episodes</a>`;
    } else {
      play = FMZ.watchUrl(it.id);
      p = FMZ.getProgress(it.id);
      playLabel = p ? 'Resume' : 'Play';
      if (p) second = `<a class="btn ghost" href="${play}&t=0">↺&nbsp; Start over</a>`;
    }
    const kicker = (FMZ.isNew(it) || (isSeries && it.eps.some(FMZ.isNew)) ? '● New this week · ' : '') + (isSeries ? 'Web Series' : 'Movie');
    return `<section class="hero">
      <div class="hero-bg">${FMZ.imgTag(it, true, 'hero-pic')}</div>
      <div class="hero-in">
        <div class="kicker">${kicker}</div>
        <h1 class="hero-title">${FMZ.titleArt(it, 'hero-logo')}</h1>
        ${metaLine(it)}
        ${it.o ? `<p class="hero-text">${E(it.o)}</p>` : ''}
        <div class="hero-btns"><a class="btn primary big" href="${play}" data-autofocus>${FMZ.PLAY_SVG}<span>${playLabel}</span></a>${second}</div>
        ${p ? `<div class="hero-prog"><span class="bar"><i style="width:${Math.min(100, p.t / p.d * 100)}%"></i></span><small>${FMZ.fmtLeft(p)}</small></div>` : ''}
      </div>
    </section>`;
  }

  /* ---------------- Movies / Web Series ---------------- */
  function gridPage(title, tiles) {
    app.innerHTML = `<section class="page"><h1 class="page-title">${E(title)}</h1>
      ${tiles.length ? `<div class="tile-grid">${tiles.join('')}</div>` : '<p class="empty">Nothing here yet.</p>'}</section>`;
  }

  /* ---------------- One web series ---------------- */
  function seriesPage(s) {
    if (!s) { app.innerHTML = '<p class="empty">This series is not available any more.</p>'; return; }
    document.title = s.t + " · Faruk's Movie Zone";
    const t = FMZ.seriesTarget(s);
    const p = t.resume ? FMZ.getProgress(t.ep.id) : null;
    const label = (t.resume ? 'Resume' : 'Play') + ` Episode ${t.ep.n}`;
    const eps = s.eps.map(e => {
      const ep = FMZ.getProgress(e.id), watched = FMZ.isWatched(e.id);
      const pct = ep && ep.d ? Math.min(100, ep.t / ep.d * 100) : 0;
      const desc = ep ? FMZ.fmtLeft(ep) + (e.subs ? ' · বাংলা সাবটাইটেল' : '') : (e.o || (e.subs ? 'বাংলা সাবটাইটেল' : ''));
      return `<a class="ep${e.id === t.ep.id ? ' current' : ''}" href="${FMZ.watchUrl(e.id)}">
        <span class="ep-n">${e.n}</span>
        <div class="ep-img">${FMZ.imgTag(e, false, 'ep-pic')}<span class="play-dot">${FMZ.PLAY_SVG}</span>${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}</div>
        <div class="ep-txt"><h3>Episode ${e.n}${e.t ? ' · ' + E(e.t) : ''}</h3><p>${E(desc)}</p></div>
        <span class="ep-st${watched ? ' ok' : ''}">${watched ? '✓ Watched' : e.rt ? e.rt + ' min' : ''}</span>
      </a>`;
    }).join('');
    app.innerHTML = `<section class="hero series-hero">
        <div class="hero-bg">${FMZ.imgTag(s, true, 'hero-pic')}</div>
        <div class="hero-in">
          <div class="kicker">Web Series</div>
          <h1 class="hero-title">${FMZ.titleArt(s, 'hero-logo')}</h1>
          ${metaLine(s)}
          ${s.o ? `<p class="hero-text">${E(s.o)}</p>` : ''}
          <div class="hero-btns"><a class="btn primary big" href="${FMZ.watchUrl(t.ep.id)}" data-autofocus>${FMZ.PLAY_SVG}<span>${label}</span></a>
            ${t.ep !== s.eps[0] ? `<a class="btn ghost" href="${FMZ.watchUrl(s.eps[0].id)}&t=0">↺&nbsp; Start from Episode 1</a>` : ''}</div>
          ${p ? `<div class="hero-prog"><span class="bar"><i style="width:${Math.min(100, p.t / p.d * 100)}%"></i></span><small>${FMZ.fmtLeft(p)}</small></div>` : ''}
        </div>
      </section>
      <section class="page eps-page"><h2 class="row-title">Episodes</h2><div class="eps">${eps}</div></section>`;
  }

  /* ---------------- জলসার নাটক ---------------- */
  function jolsaPage() {
    const j = cat.jolsa, links = j.links || [];
    const LSkey = 'fmz-ep:jolsa';
    let saved = 0; try { saved = +localStorage.getItem(LSkey) || 0; } catch (e) { }
    app.innerHTML = `<section class="page jolsa">
      <h1 class="page-title bn">${E(j.title)}</h1>
      <div class="links" id="links">${links.map((l, i) =>
        `<button class="link-btn" type="button" data-i="${i}"><span class="play">${FMZ.PLAY_SVG}</span><span>${E(l.title || 'Video ' + (i + 1))}</span></button>`).join('')}</div>
      <h2 class="frame-now bn" id="frameNow"></h2>
      <div class="frame-box" id="frameBox">
        <div class="player frame-player" id="framePlayer"><iframe id="frame" title="Video" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe></div>
        <div class="frame-tools"><button class="btn" type="button" id="frameFS">Full screen</button>
          <a class="btn" id="frameOpen" href="#" target="_blank" rel="noopener noreferrer">Open in new tab</a></div>
      </div></section>`;
    if (!links.length) { $('#frameBox').hidden = true; return; }
    const frame = $('#frame'), fp = $('#framePlayer'), box = $('#links');
    function play(i) {
      const l = links[i]; if (!l) return;
      if (frame.src !== l.url) frame.src = l.url;
      $('#frameOpen').href = l.url;
      $('#frameNow').textContent = l.title || '';
      box.querySelectorAll('.link-btn').forEach((b, k) => b.classList.toggle('active', k === i));
      try { localStorage.setItem(LSkey, i); } catch (e) { }
    }
    box.addEventListener('click', e => { const b = e.target.closest('.link-btn'); if (b) play(+b.dataset.i); });
    $('#frameFS').onclick = () => { if (fp.requestFullscreen) fp.requestFullscreen().catch(() => { }); else if (fp.webkitRequestFullscreen) fp.webkitRequestFullscreen(); };
    play(saved < links.length ? saved : 0);
    const act = box.querySelector('.link-btn.active'); if (act) act.setAttribute('data-autofocus', '');
  }

  function toast(text) {
    const t = $('#pageToast');
    t.textContent = text; t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 400); }, 2600);
  }
})();
