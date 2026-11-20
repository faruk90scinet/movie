// Faruk's Movie Zone — Dropbox → website sync (runs on GitHub Actions)
//
// Dropbox folder layout:
//   Game (2024).mkv          → a movie            (a same-name .srt / .jpg next to it is used if present)
//   Panchayat/1.mkv, 2.mkv…  → a web series        (folder name = series name; "Name S2" = season 2)
//   Heart.Beat.61-68.mkv     → one video holding episodes 61–68 of "Heart Beat" (works loose or in a folder)
//   Jolsar Natok.txt         → the জলসার নাটক page
//   password.txt             → who can open the site: one "Name,Password" per line
//
// Everything published to GitHub (movie list, video links, subtitles, pictures) is encrypted.
// Only someone with a password from password.txt can open it.
//
// Secrets: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, DROPBOX_FOLDER, TMDB_API_KEY (optional)
// The GitHub log is public, so this script never prints names of movies or people.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MkvSubs = require(path.join(ROOT, 'mkvsubs.js'));
const S = require(path.join(ROOT, 'subtitles.js'));

const DATA = path.join(ROOT, 'data');
const FILES = path.join(DATA, 'f');
const KEYS_FILE = path.join(DATA, 'keys.json');
const CATALOG_FILE = path.join(DATA, 'c.bin');
const STATE_FILE = path.join(DATA, 's.bin');
const LEGACY = ['movie-data.json', 'subs', 'thumbs', 'sync-config.json'];

const VIDEO = /\.(mkv|webm|mk3d|mp4|m4v|mov)$/i;
const MATROSKA = /\.(mkv|webm|mk3d)$/i;
const SUBFILE = /\.(srt|vtt|ass|ssa)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const LANG = { en: 'English', eng: 'English', hi: 'Hindi', hin: 'Hindi', ml: 'Malayalam', mal: 'Malayalam', ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', kn: 'Kannada', kan: 'Kannada', bn: 'বাংলা', ben: 'বাংলা' };
const ITER = 150000;

const log = (...a) => console.log(...a);
const QUICK = process.argv.includes('--quick');   // only the list (fast); without it also subtitles and pictures
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------------- Encryption (AES-256-GCM; compatible with the browser's WebCrypto) ---------------- */
const kekFor = (pw, salt) => crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, ITER, 32, 'sha256');
function seal(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]);
}
function unseal(key, blob) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}
const tryUnseal = (key, blob) => { try { return unseal(key, blob); } catch { return null; } };
const fileId = (K, logical) => sha(Buffer.concat([K, Buffer.from(logical)])).slice(0, 24);

/* ---------------- Dropbox API ---------------- */
let TOKEN = '';
async function login() {
  const { DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret, DROPBOX_REFRESH_TOKEN: refresh } = process.env;
  if (!key || !secret || !refresh) throw new Error('Dropbox secrets are missing (DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN).');
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: key, client_secret: secret })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Dropbox login failed: ' + (j.error_description || j.error || r.status));
  TOKEN = j.access_token;
}

async function api(endpoint, body) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch('https://api.dropboxapi.com/2/' + endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (r.status === 429 && attempt < 5) { await sleep(2000 * attempt); continue; }
    if (!r.ok) { const e = new Error(endpoint + ': ' + String(j.error_summary || r.status).split('/')[0]); e.data = j; throw e; }
    return j;
  }
}

const asciiJson = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
async function download(id) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Dropbox-API-Arg': asciiJson({ path: id }) }
  });
  if (!r.ok) throw new Error('Download failed (' + r.status + ')');
  return r;
}

async function folderPath() {
  const f = (process.env.DROPBOX_FOLDER || '').trim();
  if (!f) throw new Error('Add the secret DROPBOX_FOLDER: the folder path in your Dropbox, for example /Movie Zone');
  if (/^https?:\/\//i.test(f)) {
    const m = await api('sharing/get_shared_link_metadata', { url: f });
    if (m.path_lower) return m.path_lower;
    throw new Error('DROPBOX_FOLDER link must point to a folder in the same Dropbox account.');
  }
  return f.startsWith('/') ? f.replace(/\/+$/, '') : '/' + f.replace(/\/+$/, '');
}

async function listFolder(p) {
  let res = await api('files/list_folder', { path: p, recursive: true, limit: 2000 });
  const out = [...res.entries];
  while (res.has_more) { res = await api('files/list_folder/continue', { cursor: res.cursor }); out.push(...res.entries); }
  return out.filter(e => e['.tag'] === 'file');
}

const direct = u => {
  try { const x = new URL(u); x.hostname = 'dl.dropboxusercontent.com'; x.searchParams.delete('dl'); x.searchParams.delete('raw'); return x.toString(); }
  catch { return u; }
};

async function revokeLinks(file) {
  try {
    const l = await api('sharing/list_shared_links', { path: file.id, direct_only: true });
    for (const k of l.links || []) { try { await api('sharing/revoke_shared_link', { url: k.url }); } catch { } }
  } catch { }
}

async function shareLink(file, state, rotate) {
  const cached = state.links[file.id];
  if (cached && cached.rev === file.rev && !rotate) return cached.url;
  if (rotate) await revokeLinks(file);
  let url;
  try {
    url = (await api('sharing/create_shared_link_with_settings', { path: file.id })).url;
  } catch (err) {
    const md = err.data && err.data.error && err.data.error.shared_link_already_exists && err.data.error.shared_link_already_exists.metadata;
    if (md && md.url) url = md.url;
    else {
      const l = await api('sharing/list_shared_links', { path: file.id, direct_only: true });
      if (!l.links || !l.links.length) throw err;
      url = l.links[0].url;
    }
  }
  state.links[file.id] = { rev: file.rev, url: direct(url) };
  return state.links[file.id].url;
}

/* ---------------- Names ---------------- */
const JUNK = /\b(2160p|1080p|720p|480p|4k|uhd|hdr|web[- ]?dl|web[- ]?rip|webrip|hdrip|brrip|bluray|blu[- ]?ray|dvdrip|hdtv|x26[45]|h\.?26[45]|hevc|avc|aac|ac3|eac3|ddp?5\.?1|dts|10bit|esub|esubs|hindi|tamil|telugu|malayalam|dual audio|multi audio|org|uncut|proper|amzn|nf|hs|zee5|hq)\b.*$/i;

/** "Game (2024) 1080p WEB-DL.mkv" → { title: "Game", year: 2024 } */
function parseName(name) {
  let s = name.replace(/\.[^.]+$/, '').replace(/^\s*\d+\s*_\s*/, '');   // old "3_Name" style
  let year = null;
  const ys = [...s.matchAll(/[\[(]?\b((?:19|20)\d{2})\b[\])]?/g)].filter(m => m.index > 0);
  const y = ys[0];
  if (y) { year = +y[1]; s = s.slice(0, y.index); }
  s = s.replace(/[._]+/g, ' ').replace(JUNK, '').replace(/[\s\-–:]+$/, '').replace(/\s+/g, ' ').trim();
  if (/^([A-Za-z] )+[A-Za-z]$/.test(s)) s = s.replace(/ /g, '');           // "S I G M A" → "SIGMA"
  return { title: s || name, year };
}

/** Series folder "Panchayat S2" / "Panchayat Season 2" → { title, season } */
function parseSeries(folder) {
  let season = 1;
  const m = folder.match(/\s*[-_.]?\s*(?:S|Season\s*)(\d{1,2})\s*$/i);
  if (m) { season = +m[1]; folder = folder.slice(0, m.index); }
  const p = parseName(folder + '.x');
  return { title: p.title, year: p.year, season };
}

const clean = name => name.replace(/\.[^.]+$/, '').replace(/\b(2160p|1080p|720p|480p|x26[45]|h\.?26[45]|10bit|ddp?5\.?1|5\.1|(?:19|20)\d{2})\b/gi, ' ');

/** One video holding several episodes: "Heart.Beat.61-68" → { n: 61, n2: 68, before: "Heart.Beat." } */
function episodeRange(name) {
  const b = clean(name);
  const m = b.match(/(?:\bE(?:p(?:isode)?s?)?\s*\.?\s*)?(\d{1,4})\s*(?:-|–|—|~|to)\s*(?:E(?:p)?\s*)?(\d{1,4})(?!.*\d)/i);
  if (!m) return null;
  const n = +m[1], n2 = +m[2];
  if (!(n2 > n) || n2 - n > 60) return null;
  return { n, n2, before: b.slice(0, m.index) };
}

/** Episode number from "S01E03", "E03", "Ep 3", "Episode 3", "03 - Name", "3" (or a range, see above) */
function episodeNumber(name) {
  const r = episodeRange(name);
  if (r) return r.n;
  const b = name.replace(/\.[^.]+$/, '').replace(/\b(2160p|1080p|720p|480p|x26[45]|h\.?26[45]|10bit|ddp?5\.?1|5\.1|(?:19|20)\d{2})\b/gi, ' ');
  let m = b.match(/S\d{1,2}\s*E(\d{1,3})/i) || b.match(/\bE(?:p(?:isode)?)?\s*\.?\s*(\d{1,3})\b/i) || b.match(/^\s*(\d{1,3})(?!\d)/) || b.match(/(\d{1,3})(?!.*\d)/);
  return m ? +m[1] : null;
}

function parseNatok(text) {
  let title = 'জলসার নাটক', pendingName = null;
  const links = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const t = line.match(/^title\s*[:：]\s*(.+)$/i);
    if (t && !/https?:\/\//i.test(line)) { title = t[1].trim(); continue; }
    const m = line.match(/^(.*?)\s*[:：\-–|]?\s*["'“”]?(https?:\/\/[^\s"'“”]+)["'“”]?\s*$/);
    if (m) {
      const name = m[1].replace(/[:：\-–|"'“”\s]+$/, '').trim() || pendingName || 'Video ' + (links.length + 1);
      links.push({ title: name, url: m[2] });
      pendingName = null;
    } else pendingName = line.replace(/[:：]\s*$/, '');
  }
  return { title, links };
}

function parsePasswords(text) {
  const users = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(',');
    if (i < 1) continue;
    const name = line.slice(0, i).trim(), pw = line.slice(i + 1).trim();
    if (name && pw) users.push({ name, pw });
  }
  return users;
}

/* ---------------- TMDB (posters, story, year…) ---------------- */
async function tmdb(p, params = {}) {
  const key = process.env.TMDB_API_KEY;
  const u = new URL('https://api.themoviedb.org/3/' + p);
  const bearer = key && key.length > 60;   // the long "Read Access Token" also works
  if (!bearer) u.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  for (let i = 1; ; i++) {
    const r = await fetch(u, bearer ? { headers: { Authorization: 'Bearer ' + key } } : undefined);
    if (r.status === 429 && i < 4) { await sleep(1500 * i); continue; }
    if (!r.ok) throw new Error('TMDB ' + r.status);
    return r.json();
  }
}

function pickImages(images, fallbackBackdrop, fallbackPoster) {
  const logos = (images && images.logos) || [];
  const logo = logos.find(l => l.iso_639_1 === 'en') || logos.find(l => !l.iso_639_1) || logos[0];
  const bds = (images && images.backdrops) || [];
  const clean = bds.filter(b => !b.iso_639_1).sort((a, b) => b.vote_average - a.vote_average)[0];
  const titled = bds.filter(b => b.iso_639_1 === 'en').sort((a, b) => b.vote_average - a.vote_average)[0];
  return {
    bd: (clean || {}).file_path || fallbackBackdrop || (titled || {}).file_path || null,
    bdt: (titled || {}).file_path || null,     // a backdrop that already shows the title
    lg: logo ? logo.file_path : null,
    ps: fallbackPoster || null
  };
}

async function tmdbMovie(title, year) {
  let r = await tmdb('search/movie', { query: title, year: year || '' });
  if (!r.results.length && year) r = await tmdb('search/movie', { query: title });
  const hit = r.results[0];
  if (!hit) return null;
  const d = await tmdb('movie/' + hit.id, { append_to_response: 'images', include_image_language: 'en,null' });
  return Object.assign({
    tmdb: d.id, t: d.title, y: (d.release_date || '').slice(0, 4), rt: d.runtime || null,
    g: (d.genres || []).map(g => g.name).slice(0, 3), o: d.overview || ''
  }, pickImages(d.images, d.backdrop_path, d.poster_path));
}

async function tmdbSeries(title, year, season) {
  let r = await tmdb('search/tv', { query: title, first_air_date_year: year || '' });
  if (!r.results.length && year) r = await tmdb('search/tv', { query: title });
  const hit = r.results[0];
  if (!hit) return null;
  const d = await tmdb('tv/' + hit.id, { append_to_response: 'images', include_image_language: 'en,null' });
  let eps = {};
  try {
    const s = await tmdb(`tv/${hit.id}/season/${season}`);
    for (const e of s.episodes || []) eps[e.episode_number] = { t: e.name || '', o: e.overview || '', st: e.still_path || null, rt: e.runtime || null };
  } catch { }
  return Object.assign({
    tmdb: d.id, t: d.name, y: (d.first_air_date || '').slice(0, 4),
    g: (d.genres || []).map(g => g.name).slice(0, 3), o: d.overview || '', eps
  }, pickImages(d.images, d.backdrop_path, d.poster_path));
}

async function lookup(state, kind, q, fn) {
  if (!process.env.TMDB_API_KEY) return null;
  const key = kind + ':' + q;
  const c = state.tmdb[key];
  if (c && (c.r || Date.now() - c.at < 86400000)) return c.r;     // misses are retried once a day
  try { const r = await fn(); state.tmdb[key] = { at: Date.now(), r }; return r; }
  catch (e) { console.error('   lookup error: ' + e.message); return c ? c.r : null; }
}

/* ---------------- Encrypted file store ---------------- */
class Store {
  constructor(K, state) { this.K = K; this.state = state; this.used = new Set(); }
  id(logical) { return fileId(this.K, logical); }
  has(logical) { return !!this.state.files[logical] && fs.existsSync(path.join(FILES, this.id(logical) + '.bin')); }
  put(logical, buf) {
    fs.writeFileSync(path.join(FILES, this.id(logical) + '.bin'), seal(this.K, buf));
    this.state.files[logical] = 1; this.used.add(logical);
    return this.id(logical);
  }
  get(logical) {
    const p = path.join(FILES, this.id(logical) + '.bin');
    return fs.existsSync(p) ? tryUnseal(this.K, fs.readFileSync(p)) : null;
  }
  use(logical) { if (this.has(logical)) { this.used.add(logical); return this.id(logical); } return null; }
  drop(logical) { delete this.state.files[logical]; fs.rmSync(path.join(FILES, this.id(logical) + '.bin'), { force: true }); }
}

/* ---------------- Pictures taken from the video ---------------- */
let ffmpegReady = false;
function ensureFfmpeg() {
  if (ffmpegReady) return;
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); }
  catch { log('   installing ffmpeg…'); execSync('sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg', { stdio: 'ignore' }); }
  ffmpegReady = true;
}

/** Returns an encrypted file id for a picture of this video (own .jpg if given, else a frame) */
async function makeThumb(vid, video, image, store, state) {
  const logical = 'th/' + vid;
  const sig = image ? 'img:' + image.content_hash : 'vid:' + video.content_hash;
  const prev = state.thumbs[vid];
  if (prev && prev.sig === sig) { if (prev.ok) return store.use(logical); if ((prev.tries || 0) >= 3) return null; }
  try {
    let buf;
    if (image) buf = Buffer.from(await (await download(image.id)).arrayBuffer());
    else {
      ensureFfmpeg();
      const { link } = await api('files/get_temporary_link', { path: video.id });
      let dur = 0;
      try { dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', link], { timeout: 90000 }).toString()) || 0; } catch { }
      const points = dur > 0 ? [0.15, 0.32, 0.5].map(f => dur * f) : [180, 420, 900];
      let best = null, bestSize = 0;
      points.forEach((t, i) => {
        const f = path.join(os.tmpdir(), `fmz-${vid}-${i}.jpg`);
        try {
          execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.floor(t)), '-i', link, '-frames:v', '1', '-vf', 'scale=780:-2', '-q:v', '4', f], { timeout: 180000 });
          const s = fs.statSync(f).size;
          if (s > bestSize) { bestSize = s; best = f; }    // most detailed frame: avoids black/blank shots
        } catch { }
      });
      if (!best) throw new Error('could not grab a frame');
      buf = fs.readFileSync(best);
    }
    const id = store.put(logical, buf);
    state.thumbs[vid] = { sig, ok: true };
    return id;
  } catch (e) {
    console.error('   picture error: ' + e.message);
    state.thumbs[vid] = { sig, ok: false, tries: (prev && prev.sig === sig ? prev.tries || 0 : 0) + 1 };
    return null;
  }
}

/* ---------------- Subtitles ---------------- */
function pickTrack(tracks) {
  const text = tracks.filter(t => t.kind === 'text' && t.cues.length > 0);
  if (!text.length) return null;
  const bn = text.find(t => /^(ben|bn)\b/i.test(t.lang) || S.isBengali(t.cues));
  if (bn) return bn;
  const full = text.filter(t => !t.forced && !/sdh|sign|song|forced|commentary/i.test(t.name));
  const pool = full.length ? full : text;
  const en = pool.filter(t => /^en/i.test(t.lang));
  return (en.length ? en : pool).sort((a, b) => b.cues.length - a.cues.length)[0];
}

async function cuesFromVideo(file) {
  const tmp = path.join(os.tmpdir(), 'fmz-' + Date.now() + path.extname(file.name));
  try {
    log(`   downloading (${(file.size / 1e9).toFixed(2)} GB)…`);
    const t0 = Date.now();
    const r = await download(file.id);
    const body = Readable.fromWeb(r.body);
    let got = 0, next = 0.1;
    body.on('data', c => { got += c.length; if (file.size && got / file.size >= next) { log(`   downloaded ${Math.round(next * 100)}%`); next += 0.1; } });
    await pipeline(body, fs.createWriteStream(tmp));
    log(`   downloaded in ${((Date.now() - t0) / 1000).toFixed(0)}s, reading subtitle tracks…`);
    const res = await MkvSubs.extract(await fs.openAsBlob(tmp));
    res.tracks.forEach(t => log(`     track ${t.number}: ${t.codec} ${t.lang} ${t.kind} ${t.cues.length} lines`));
    const ch = (res.chapters || []).filter((c, i, a) => i === 0 || c.t - a[i - 1].t > 30)
      .map(c => ({ t: c.t, l: /^(chapter|part|ch)?\s*\d+$/i.test(c.l.trim()) || /^\d{1,2}:\d{2}/.test(c.l) ? '' : c.l.trim() }));
    if (ch.length) log(`   ${ch.length} chapters`);
    const tr = pickTrack(res.tracks);
    if (!tr) return { status: res.tracks.some(t => t.kind === 'image') ? 'image' : 'none', ch };
    return { status: 'ok', cues: tr.cues, lang: tr.lang, ch };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function translate(cues) {
  const t = new S.Translator({ cues, tl: 'bn', onProgress: p => { if (Math.round(p * 100) % 25 === 0) log(`   translating… ${Math.round(p * 100)}%`); } });
  await t.start(2);
  return { texts: cues.map((c, i) => t.out[i] != null ? t.out[i] : c.text), failed: t.failed };
}

async function buildSubtitles(vid, video, sidecar, store, state) {
  const sig = sidecar ? 'side:' + sidecar.content_hash : 'vid:' + video.content_hash;
  const prev = state.subs[vid] || {};
  const bnL = `sub/${vid}/bn`, origL = `sub/${vid}/orig`;
  const keep = st => { if (['ok', 'partial', 'bn'].includes(st.status)) { store.use(bnL); if (st.status !== 'bn') store.use(origL); } return st; };

  if (prev.sig === sig && ['ok', 'none', 'image', 'bn'].includes(prev.status) && (prev.status !== 'ok' || store.has(bnL))) return keep(prev);
  if (prev.sig === sig && prev.status === 'error' && prev.tries >= 3) return prev;

  if (prev.sig === sig && prev.status === 'partial' && store.has(origL)) {
    log('   retrying translation');
    const cues = S.parse(store.get(origL).toString('utf8'));
    const { texts, failed } = await translate(cues);
    store.put(bnL, Buffer.from(S.toVTT(cues, texts)));
    store.use(origL);
    return Object.assign(prev, { status: failed ? 'partial' : 'ok' });
  }

  log('   preparing subtitles');
  try {
    let got;
    if (sidecar) {
      const cues = S.parse(await (await download(sidecar.id)).text());
      got = cues.length ? { status: 'ok', cues, lang: '' } : { status: 'none' };
    } else if (MATROSKA.test(video.name)) got = await cuesFromVideo(video);
    else got = { status: 'none' };
    const ch = got.ch && got.ch.length > 1 ? got.ch : undefined;
    if (got.status !== 'ok') { log(`   no text subtitles (${got.status})`); return { sig, status: got.status, ch }; }

    if (S.isBengali(got.cues)) {
      store.put(bnL, Buffer.from(S.toVTT(got.cues)));
      log(`   Bengali subtitles found (${got.cues.length} lines)`);
      return { sig, status: 'bn', ch };
    }
    store.put(origL, Buffer.from(S.toVTT(got.cues)));
    const { texts, failed } = await translate(got.cues);
    store.put(bnL, Buffer.from(S.toVTT(got.cues, texts)));
    log(`   translated ${got.cues.length} lines${failed ? ' (some failed, will retry next run)' : ''}`);
    return { sig, status: failed ? 'partial' : 'ok', ch, label: LANG[(got.lang || '').toLowerCase().split('-')[0]] || 'Original' };
  } catch (e) {
    console.error(`   subtitle error: ${e.message}`);
    return { sig, status: 'error', tries: (prev.sig === sig ? prev.tries || 0 : 0) + 1 };
  }
}

function subEntries(vid, st, store) {
  if (!st || !['ok', 'partial', 'bn'].includes(st.status)) return undefined;
  const list = [{ f: store.id(`sub/${vid}/bn`), l: 'বাংলা', lang: 'bn' }];
  if (st.status !== 'bn') list.push({ f: store.id(`sub/${vid}/orig`), l: st.label || 'Original' });
  return list;
}

/* ---------------- Keys: who can open the site ---------------- */
function setupKeys(users) {
  const old = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : null;
  const salt = old && old.salt ? Buffer.from(old.salt, 'base64') : crypto.randomBytes(16);
  const keks = users.map(u => ({ u, kek: kekFor(u.pw, salt) }));
  let oldK = null;
  const matched = new Set(), userHasEntry = new Set();
  if (old && old.iter === ITER) {
    old.entries.forEach((e, i) => {
      const blob = Buffer.from(e, 'base64');
      keks.forEach((x, j) => {
        const p = tryUnseal(x.kek, blob);
        if (p) { const o = JSON.parse(p); matched.add(i); userHasEntry.add(j); oldK = oldK || Buffer.from(o.k, 'base64'); }
      });
    });
  }
  const firstRun = !old;
  const removed = !!old && matched.size < old.entries.length;           // someone was removed or changed password
  const unchanged = !!old && !removed && userHasEntry.size === keks.length && old.entries.length === keks.length;
  const K = oldK && !removed ? oldK : crypto.randomBytes(32);
  let keysJson = old;
  if (!unchanged || !oldK || removed) {
    const entries = keks.map(x => seal(x.kek, Buffer.from(JSON.stringify({ k: K.toString('base64'), n: x.u.name }))).toString('base64'));
    entries.sort(() => Math.random() - .5);
    keysJson = { v: 1, salt: salt.toString('base64'), iter: ITER, entries };
  }
  return { K, oldK, rotate: firstRun || removed || !oldK, firstRun, removed, keysJson, keysChanged: keysJson !== old };
}

/* ---------------- Main ---------------- */
async function main() {
  fs.mkdirSync(FILES, { recursive: true });
  await login();
  const dir = await folderPath();
  const files = await listFolder(dir);
  log(`Dropbox: ${files.length} files`);

  const rel = f => f.path_display.slice(dir.length).replace(/^\/+/, '');
  const pwFile = files.find(f => /^password\.txt$/i.test(rel(f)));
  if (!pwFile) throw new Error('password.txt is missing in the Dropbox folder. Nothing was published.');
  const users = parsePasswords(await (await download(pwFile.id)).text());
  if (!users.length) throw new Error('password.txt has no "Name,Password" lines. Nothing was published.');
  log(`People with access: ${users.length}`);

  const keys = setupKeys(users);
  if (keys.firstRun) log('First secure run: creating keys and fresh video links');
  else if (keys.removed) log('Someone was removed or changed password: new keys and new video links');

  // Saved progress from earlier runs (encrypted with the previous key)
  let state = {};
  if (keys.oldK && fs.existsSync(STATE_FILE)) {
    const p = tryUnseal(keys.oldK, fs.readFileSync(STATE_FILE));
    if (p) state = JSON.parse(p);
  }
  state.links = state.links || {}; state.subs = state.subs || {}; state.thumbs = state.thumbs || {};
  state.tmdb = state.tmdb || {}; state.files = state.files || {}; state.added = state.added || {};
  const stateBefore = JSON.stringify(state);

  // New key: move every encrypted file over to it
  const store = new Store(keys.K, state);
  if (keys.rotate && keys.oldK && !keys.oldK.equals(keys.K)) {
    const oldStore = new Store(keys.oldK, state);
    for (const logical of Object.keys(state.files)) {
      const buf = oldStore.get(logical);
      if (buf) fs.writeFileSync(path.join(FILES, store.id(logical) + '.bin'), seal(keys.K, buf));
      else delete state.files[logical];
    }
  }
  if (keys.rotate) state.links = {};      // old video links are revoked and replaced below

  /* ---- sort the Dropbox files ---- */
  const movies = [], seriesMap = new Map(), byPath = new Map();
  let natokFile = null;
  for (const f of files) byPath.set(rel(f).toLowerCase(), f);
  const sibling = (f, re) => {
    const base = rel(f).replace(/\.[^.]+$/, '').toLowerCase();
    for (const [p, g] of byPath) if (p.startsWith(base + '.') && re.test(p) && p.slice(base.length + 1).indexOf('/') < 0) return g;
    return null;
  };
  for (const f of files) {
    const r = rel(f), parts = r.split('/');
    const plain = f.name.toLowerCase().replace(/[^a-z]/g, '');
    if (parts.length === 1 && /\.txt$/i.test(f.name) && plain.includes('jolsa') && plain.includes('natok')) { natokFile = f; continue; }
    if (!VIDEO.test(f.name)) continue;
    let name, folder = null;
    if (parts.length > 1) { folder = parts[0]; name = folder; }
    else {
      const rg = episodeRange(f.name);                     // loose "Heart.Beat.61-68.mkv" → series "Heart Beat"
      if (!rg || !rg.before.trim()) { movies.push(f); continue; }
      name = rg.before;
    }
    const ps = parseSeries(name), key = ps.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + '|' + ps.season;
    if (!seriesMap.has(key)) seriesMap.set(key, { name, folder, files: [] });
    const g = seriesMap.get(key);
    if (folder && !g.folder) { g.folder = folder; g.name = folder; }
    g.files.push(f);
  }
  const vidOf = f => sha(f.id).slice(0, 12);
  const addedAt = f => { const v = vidOf(f); state.added[v] = state.added[v] || Date.parse(f.server_modified || f.client_modified) || Date.now(); return state.added[v]; };

  const catalog = { v: 2, movies: [], series: [], jolsa: null };
  const tmdbOn = !!process.env.TMDB_API_KEY;
  if (!tmdbOn) log('No TMDB_API_KEY: using pictures from the videos');

  /* ---- movies ---- */
  let n = 0;
  for (const f of movies.sort((a, b) => a.name.localeCompare(b.name))) {
    n++;
    const vid = vidOf(f), nm = parseName(f.name);
    log(`Movie #${n}`);
    const meta = await lookup(state, 'm', nm.title + '|' + (nm.year || ''), () => tmdbMovie(nm.title, nm.year));
    const img = sibling(f, IMAGE), side = sibling(f, SUBFILE);
    const m = {
      id: vid, t: nm.title, y: nm.year ? String(nm.year) : '', add: addedAt(f),
      v: await shareLink(f, state, keys.rotate)
    };
    if (meta) Object.assign(m, { t: meta.t || m.t, y: meta.y || m.y, rt: meta.rt, g: meta.g, o: meta.o, bd: meta.bd, bdt: meta.bdt, lg: meta.lg, ps: meta.ps });
    if (img || !m.bd) {
      const th = QUICK ? store.use('th/' + vid) : await makeThumb(vid, f, img, store, state);
      if (th) m.th = th;
    }
    if (!QUICK) state.subs[vid] = await buildSubtitles(vid, f, side, store, state);
    else if (state.subs[vid]) buildKeep(vid, state.subs[vid], store);
    const subs = subEntries(vid, state.subs[vid], store);
    if (subs) m.subs = subs;
    if (state.subs[vid] && state.subs[vid].ch) m.ch = state.subs[vid].ch;
    catalog.movies.push(m);
    if (!QUICK) saveState(keys.K, state);
  }

  /* ---- web series ---- */
  let sn = 0;
  for (const [key, grp] of [...seriesMap].sort((a, b) => a[0].localeCompare(b[0]))) {
    sn++;
    const eps = grp.files, folder = grp.folder;
    const ps = parseSeries(grp.name), sid = sha('series:' + key).slice(0, 12);
    log(`Series #${sn}: ${eps.length} episodes`);
    const meta = await lookup(state, 's', ps.title + '|' + (ps.year || '') + '|' + ps.season, () => tmdbSeries(ps.title, ps.year, ps.season));
    const cover = folder && [...byPath.entries()].find(([p]) => p.startsWith(folder.toLowerCase() + '/') && /\/(cover|poster|folder)\.(jpe?g|png|webp)$/.test(p));
    const s = { id: sid, t: ps.title, y: ps.year ? String(ps.year) : '', season: ps.season, eps: [] };
    if (meta) Object.assign(s, { t: meta.t || s.t, y: meta.y || s.y, g: meta.g, o: meta.o, bd: meta.bd, bdt: meta.bdt, lg: meta.lg, ps: meta.ps });

    const list = eps.map(f => { const rg = episodeRange(f.name); return { f, n: rg ? rg.n : episodeNumber(f.name), n2: rg ? rg.n2 : null }; })
      .sort((a, b) => (a.n ?? 9999) - (b.n ?? 9999) || a.f.name.localeCompare(b.f.name));
    let top = 0;
    const usedN = new Set();
    list.forEach(e => {
      if (e.n == null || usedN.has(e.n)) { e.n = top + 1; e.n2 = null; }
      for (let k = e.n; k <= (e.n2 || e.n); k++) usedN.add(k);
      top = Math.max(top, e.n2 || e.n);
    });
    for (const { f, n: en, n2 } of list) {
      const vid = vidOf(f), em = !n2 && meta && meta.eps ? meta.eps[en] : null;
      const ep = { id: vid, n: en, t: em && em.t ? em.t : '', o: em ? em.o : '', rt: em ? em.rt : null, add: addedAt(f), v: await shareLink(f, state, keys.rotate) };
      if (n2) ep.n2 = n2;
      if (em && em.st) ep.st = em.st;
      const img = sibling(f, IMAGE), side = sibling(f, SUBFILE);
      if (img || !ep.st) {
        const th = QUICK ? store.use('th/' + vid) : await makeThumb(vid, f, img, store, state);
        if (th) ep.th = th;
      }
      if (!QUICK) state.subs[vid] = await buildSubtitles(vid, f, side, store, state);
      else if (state.subs[vid]) buildKeep(vid, state.subs[vid], store);
      const subs = subEntries(vid, state.subs[vid], store);
      if (subs) ep.subs = subs;
      if (state.subs[vid] && state.subs[vid].ch) ep.ch = state.subs[vid].ch;
      s.eps.push(ep);
      if (!QUICK) saveState(keys.K, state);
    }
    s.add = Math.max(...s.eps.map(e => e.add));
    if (cover) {
      const cf = cover[1], logical = 'cv/' + sid, sig = 'img:' + cf.content_hash;
      if (state.thumbs[logical] && state.thumbs[logical].sig === sig && store.use(logical)) s.th = store.id(logical);
      else if (!QUICK) {
        try { s.th = store.put(logical, Buffer.from(await (await download(cf.id)).arrayBuffer())); state.thumbs[logical] = { sig, ok: true }; } catch { }
      }
    }
    if (!s.bd && !s.th && s.eps[0] && s.eps[0].th) s.th = s.eps[0].th;
    catalog.series.push(s);
  }

  /* ---- জলসার নাটক ---- */
  if (natokFile) {
    catalog.jolsa = parseNatok(await (await download(natokFile.id)).text());
    log(`জলসার নাটক: ${catalog.jolsa.links.length} links`);
  }

  /* ---- clean up: forget removed videos and unused files ---- */
  if (!QUICK) {
    for (const logical of Object.keys(state.files)) if (!store.used.has(logical)) store.drop(logical);
    const liveVids = new Set(files.map(vidOf));
    for (const v of Object.keys(state.subs)) if (!liveVids.has(v)) delete state.subs[v];
    for (const v of Object.keys(state.thumbs)) if (!liveVids.has(v) && !v.startsWith('cv/')) delete state.thumbs[v];
  }
  const live = new Set(files.map(f => f.id));
  for (const id of Object.keys(state.links)) if (!live.has(id)) delete state.links[id];
  const valid = new Set(Object.keys(state.files).map(l => store.id(l) + '.bin'));
  for (const f of fs.readdirSync(FILES)) if (!valid.has(f)) fs.rmSync(path.join(FILES, f), { force: true });

  /* ---- write ---- */
  const catJson = JSON.stringify(catalog);
  const catHash = sha(catJson);
  if (keys.keysChanged) fs.writeFileSync(KEYS_FILE, JSON.stringify(keys.keysJson));
  if (keys.keysChanged || state.catHash !== catHash || !fs.existsSync(CATALOG_FILE)) {
    fs.writeFileSync(CATALOG_FILE, seal(keys.K, Buffer.from(catJson)));
    state.catHash = catHash;
    log('Movie list updated');
  } else log('Movie list unchanged');
  if (keys.keysChanged || JSON.stringify(state) !== stateBefore || !fs.existsSync(STATE_FILE)) saveState(keys.K, state);

  for (const l of LEGACY) fs.rmSync(path.join(ROOT, l), { recursive: true, force: true });
}

function buildKeep(vid, st, store) {
  if (['ok', 'partial', 'bn'].includes(st.status)) { store.use(`sub/${vid}/bn`); if (st.status !== 'bn') store.use(`sub/${vid}/orig`); }
}
function saveState(K, state) { fs.writeFileSync(STATE_FILE, seal(K, Buffer.from(JSON.stringify(state)))); }

export { main, parseName, parseSeries, episodeNumber, episodeRange, parseNatok, parsePasswords, setupKeys, seal, unseal, kekFor };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('SYNC FAILED: ' + e.message); process.exit(1); });
}
