// Faruk's Movie Zone — Dropbox → website sync (runs on GitHub Actions every 15 minutes)
//
//  • Videos named "1_Jailer.mkv", "2_Three Idiots.mkv" … become Channel 1, Channel 2 …
//  • "Jolsar Natok.txt" becomes the জলসার নাটক page
//  • Subtitles inside each MKV are pulled out, translated to Bengali and saved in /subs
//  • Optional extras with the same number: "3_Sigma.srt" (use this subtitle instead),
//    "3_Sigma.jpg" (poster picture)
//
// Needs secrets: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MkvSubs = require(path.join(ROOT, 'mkvsubs.js'));
const S = require(path.join(ROOT, 'subtitles.js'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'sync-config.json'), 'utf8'));
const SUBS_DIR = path.join(ROOT, 'subs');
const THUMBS_DIR = path.join(ROOT, 'thumbs');
const STATE_FILE = path.join(SUBS_DIR, 'state.json');
const DATA_FILE = path.join(ROOT, 'movie-data.json');

const VIDEO = /\.(mkv|webm|mk3d|mp4|m4v|mov)$/i;
const MATROSKA = /\.(mkv|webm|mk3d)$/i;
const SUBFILE = /\.(srt|vtt|ass|ssa)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const LANG = { en: 'English', eng: 'English', hi: 'Hindi', hin: 'Hindi', ml: 'Malayalam', mal: 'Malayalam', ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', kn: 'Kannada', kan: 'Kannada', bn: 'বাংলা', ben: 'বাংলা' };

const log = (...a) => console.log(...a);
// --quick: only update the movie list (fast). Without it: also make thumbnails and subtitles.
const QUICK = process.argv.includes('--quick');

/* ---------------- Dropbox API ---------------- */
let TOKEN = '';
async function login() {
  const { DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret, DROPBOX_REFRESH_TOKEN: refresh } = process.env;
  if (!key || !secret || !refresh) throw new Error('Dropbox secrets are missing. Add DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN in GitHub → Settings → Secrets and variables → Actions.');
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: key, client_secret: secret })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Dropbox login failed: ' + JSON.stringify(j));
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
    if (!r.ok) { const e = new Error(endpoint + ': ' + (j.error_summary || text)); e.data = j; throw e; }
    return j;
  }
}

const asciiJson = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
async function download(id) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Dropbox-API-Arg': asciiJson({ path: id }) }
  });
  if (!r.ok) throw new Error('Download failed (' + r.status + '): ' + (await r.text()).slice(0, 300));
  return r;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function folderPath() {
  if (cfg.dropboxFolderPath) return cfg.dropboxFolderPath;
  const m = await api('sharing/get_shared_link_metadata', { url: cfg.dropboxFolderLink });
  if (m.path_lower) return m.path_lower;
  throw new Error('The shared folder must be in the same Dropbox account as the app. Or put its path in sync-config.json → "dropboxFolderPath" (for example "/Movies").');
}

async function listFolder(p) {
  let res = await api('files/list_folder', { path: p, limit: 2000 });
  const out = [...res.entries];
  while (res.has_more) { res = await api('files/list_folder/continue', { cursor: res.cursor }); out.push(...res.entries); }
  return out.filter(e => e['.tag'] === 'file');
}

async function shareLink(file, state) {
  const cached = state.links[file.id];
  if (cached && cached.rev === file.rev) return cached.url;
  let url;
  try {
    url = (await api('sharing/create_shared_link_with_settings', { path: file.path_lower })).url;
  } catch (err) {
    const md = err.data && err.data.error && err.data.error.shared_link_already_exists && err.data.error.shared_link_already_exists.metadata;
    if (md && md.url) url = md.url;
    else {
      const l = await api('sharing/list_shared_links', { path: file.path_lower, direct_only: true });
      if (!l.links || !l.links.length) throw err;
      url = l.links[0].url;
    }
  }
  state.links[file.id] = { rev: file.rev, url };
  return url;
}

/* ---------------- Files → channels ---------------- */
function numbered(name) {
  const m = name.match(/^\s*(\d+)\s*[_\-.\s]\s*(.*)$/);
  return m ? { n: +m[1], rest: m[2] } : null;
}
const cleanTitle = (rest, n) => rest.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Channel ' + n;
const newest = (a, b) => (!a || new Date(b.server_modified) > new Date(a.server_modified)) ? b : a;

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

/* ---------------- Thumbnails (a picture taken from the movie) ---------------- */
let ffmpegReady = false;
function ensureFfmpeg() {
  if (ffmpegReady) return;
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); }
  catch { log('   installing ffmpeg…'); execSync('sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg', { stdio: 'inherit' }); }
  ffmpegReady = true;
}

async function makeThumb(key, video, state) {
  const out = path.join(THUMBS_DIR, key + '.jpg');
  const prev = state.thumbs[key];
  if (prev && prev.sig === video.content_hash && (prev.ok ? fs.existsSync(out) : (prev.tries || 0) >= 3)) return prev;
  log(` ${key}: making thumbnail`);
  try {
    ensureFfmpeg();
    // A temporary link lets ffmpeg jump straight to a point in the movie without downloading all of it
    const { link } = await api('files/get_temporary_link', { path: video.id });
    let dur = 0;
    try { dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', link], { timeout: 90000 }).toString()) || 0; } catch { }
    const points = dur > 0 ? [0.15, 0.32, 0.5].map(f => dur * f) : [180, 420, 900];
    let best = null, bestSize = 0;
    points.forEach((t, i) => {
      const f = path.join(os.tmpdir(), `${key}-${i}.jpg`);
      try {
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.floor(t)), '-i', link, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', f], { timeout: 180000 });
        const s = fs.statSync(f).size;
        if (s > bestSize) { bestSize = s; best = f; }   // the most detailed frame — avoids dark or blank shots
      } catch { }
    });
    if (!best) throw new Error('could not grab a frame');
    fs.copyFileSync(best, out);
    return { sig: video.content_hash, ok: true, v: Date.now().toString(36) };
  } catch (e) {
    console.error('   thumbnail error: ' + e.message);
    return { sig: video.content_hash, ok: false, tries: (prev && prev.sig === video.content_hash ? prev.tries || 0 : 0) + 1 };
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
    log(`   downloading ${file.name} (${(file.size / 1e9).toFixed(2)} GB)…`);
    const t0 = Date.now();
    const r = await download(file.id);
    const body = Readable.fromWeb(r.body);
    let got = 0, next = 0.1;
    body.on('data', c => { got += c.length; if (file.size && got / file.size >= next) { log(`   downloaded ${Math.round(next * 100)}%`); next += 0.1; } });
    await pipeline(body, fs.createWriteStream(tmp));
    log(`   downloaded in ${((Date.now() - t0) / 1000).toFixed(0)}s, reading subtitle tracks…`);
    const res = await MkvSubs.extract(await fs.openAsBlob(tmp));
    res.tracks.forEach(t => log(`     track ${t.number}: ${t.codec} ${t.lang} "${t.name}" ${t.kind} ${t.cues.length} lines`));
    const tr = pickTrack(res.tracks);
    if (!tr) return { status: res.tracks.some(t => t.kind === 'image') ? 'image' : 'none' };
    return { status: 'ok', cues: tr.cues, lang: tr.lang };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function translate(cues) {
  const t = new S.Translator({ cues, tl: 'bn', onProgress: p => { if (Math.round(p * 100) % 25 === 0) log(`   translating… ${Math.round(p * 100)}%`); } });
  await t.start(2);
  return { texts: cues.map((c, i) => t.out[i] != null ? t.out[i] : c.text), failed: t.failed };
}

async function buildSubtitles(key, video, sidecar, state) {
  const sig = sidecar ? 'side:' + sidecar.content_hash : 'vid:' + video.content_hash;
  const prev = state.subs[key] || {};
  const bnFile = path.join(SUBS_DIR, key + '.bn.vtt'), origFile = path.join(SUBS_DIR, key + '.orig.vtt');

  if (prev.sig === sig && ['ok', 'none', 'image', 'bn'].includes(prev.status)) return prev;
  if (prev.sig === sig && prev.status === 'error' && prev.tries >= 3) return prev;

  // Only the translation failed last time: try again without downloading the movie
  if (prev.sig === sig && prev.status === 'partial' && fs.existsSync(origFile)) {
    log(` ${key}: retrying translation`);
    const cues = S.parse(fs.readFileSync(origFile, 'utf8'));
    const { texts, failed } = await translate(cues);
    fs.writeFileSync(bnFile, S.toVTT(cues, texts));
    return Object.assign(prev, { status: failed ? 'partial' : 'ok', v: Date.now().toString(36) });
  }

  log(` ${key}: preparing subtitles (${sidecar ? sidecar.name : video.name})`);
  try {
    let got;
    if (sidecar) {
      const cues = S.parse(await (await download(sidecar.id)).text());
      got = cues.length ? { status: 'ok', cues, lang: '' } : { status: 'none' };
    } else if (MATROSKA.test(video.name)) {
      got = await cuesFromVideo(video);
    } else {
      got = { status: 'none' };   // MP4: add a numbered .srt next to it for subtitles
    }
    fs.rmSync(bnFile, { force: true }); fs.rmSync(origFile, { force: true });
    if (got.status !== 'ok') { log(`   no text subtitles (${got.status})`); return { sig, status: got.status }; }

    const v = Date.now().toString(36);
    if (S.isBengali(got.cues)) {
      fs.writeFileSync(bnFile, S.toVTT(got.cues));
      log(`   Bengali subtitles found (${got.cues.length} lines)`);
      return { sig, status: 'bn', v };
    }
    fs.writeFileSync(origFile, S.toVTT(got.cues));
    const { texts, failed } = await translate(got.cues);
    fs.writeFileSync(bnFile, S.toVTT(got.cues, texts));
    log(`   translated ${got.cues.length} lines${failed ? ' (some failed, will retry next run)' : ''}`);
    return { sig, status: failed ? 'partial' : 'ok', v, label: LANG[(got.lang || '').toLowerCase().split('-')[0]] || 'Original' };
  } catch (e) {
    console.error(`   subtitle error: ${e.message}`);
    return { sig, status: 'error', tries: (prev.sig === sig ? prev.tries || 0 : 0) + 1 };
  }
}

function subtitleEntries(key, st) {
  if (!st || !['ok', 'partial', 'bn'].includes(st.status)) return undefined;
  const list = [{ url: `subs/${key}.bn.vtt?v=${st.v}`, label: 'বাংলা', lang: 'bn', auto: false }];
  if (st.status !== 'bn') list.push({ url: `subs/${key}.orig.vtt?v=${st.v}`, label: st.label || 'Original', auto: false });
  return list;
}

/* ---------------- Main ---------------- */
async function main() {
  fs.mkdirSync(SUBS_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  state.links = state.links || {}; state.subs = state.subs || {}; state.thumbs = state.thumbs || {};

  await login();
  const dir = await folderPath();
  const files = await listFolder(dir);
  log(`Dropbox folder ${dir}: ${files.length} files`);

  const videos = {}, sidecars = {}, posters = {};
  let natokFile = null;
  for (const f of files) {
    const plain = f.name.toLowerCase().replace(/[^a-z]/g, '');
    if (/\.txt$/i.test(f.name) && plain.includes('jolsa') && plain.includes('natok')) { natokFile = newest(natokFile, f); continue; }
    const num = numbered(f.name);
    if (!num) continue;
    if (VIDEO.test(f.name)) videos[num.n] = newest(videos[num.n], f);
    else if (SUBFILE.test(f.name)) sidecars[num.n] = newest(sidecars[num.n], f);
    else if (IMAGE.test(f.name)) posters[num.n] = newest(posters[num.n], f);
  }

  const data = {};
  const keep = new Set();
  for (const n of Object.keys(videos).map(Number).sort((a, b) => a - b)) {
    const v = videos[n], key = 'channel' + n;
    keep.add(key);
    const entry = { title: cleanTitle(numbered(v.name).rest, n), nav: 'Channel ' + n, videoLink: await shareLink(v, state) };
    if (posters[n]) entry.poster = await shareLink(posters[n], state);
    else {
      if (!QUICK) state.thumbs[key] = await makeThumb(key, v, state);
      const th = state.thumbs[key];
      if (th && th.ok && th.sig === v.content_hash) entry.poster = `thumbs/${key}.jpg?v=${th.v}`;
    }
    if (!QUICK) state.subs[key] = await buildSubtitles(key, v, sidecars[n], state);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));   // save progress after each movie
    const subs = subtitleEntries(key, state.subs[key]);
    if (subs) entry.subtitles = subs;
    data[key] = entry;
    log(`Channel ${n}: ${entry.title} — subtitles: ${(state.subs[key] || {}).status || 'not yet'}`);
  }

  if (natokFile) {
    const { title, links } = parseNatok(await (await download(natokFile.id)).text());
    data.jolsa = { title, nav: 'জলসার নাটক', type: 'links', links };
    log(`জলসার নাটক: ${links.length} links`);
  }

  // Forget movies that were removed from Dropbox
  for (const key of Object.keys(state.thumbs)) if (!keep.has(key)) {
    delete state.thumbs[key];
    fs.rmSync(path.join(THUMBS_DIR, key + '.jpg'), { force: true });
  }
  for (const key of Object.keys(state.subs)) if (!keep.has(key)) {
    delete state.subs[key];
    fs.rmSync(path.join(SUBS_DIR, key + '.bn.vtt'), { force: true });
    fs.rmSync(path.join(SUBS_DIR, key + '.orig.vtt'), { force: true });
  }
  const live = new Set(files.map(f => f.id));
  for (const id of Object.keys(state.links)) if (!live.has(id)) delete state.links[id];

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
  log('movie-data.json updated');
}

export { main, parseNatok, numbered, cleanTitle, pickTrack };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('SYNC FAILED: ' + e.message); process.exit(1); });
}
