/* Faruk's Movie Zone — reads subtitle tracks out of an MKV file on your own device.
   Nothing is uploaded: the file is read in 4 MB pieces straight from disk.
   Browser: window.MkvSubs.extract(file, {onProgress}); Node: require('./mkvsubs.js'). */
(function (root) {
  'use strict';

  const ID = {
    SEGMENT: 0x18538067, INFO: 0x1549A966, TRACKS: 0x1654AE6B, CLUSTER: 0x1F43B675,
    TIMESCALE: 0x2AD7B1, DURATION: 0x4489,
    TRACK_ENTRY: 0xAE, TRACK_NUMBER: 0xD7, TRACK_TYPE: 0x83, CODEC_ID: 0x86,
    LANGUAGE: 0x22B59C, LANGUAGE_BCP47: 0x22B59D, NAME: 0x536E,
    FLAG_DEFAULT: 0x88, FLAG_FORCED: 0x55AA,
    CONTENT_ENCODINGS: 0x6D80, CONTENT_ENCODING: 0x6240, CONTENT_COMPRESSION: 0x5034,
    COMP_ALGO: 0x4254, COMP_SETTINGS: 0x4255,
    TIMESTAMP: 0xE7, SIMPLEBLOCK: 0xA3, BLOCKGROUP: 0xA0, BLOCK: 0xA1, BLOCK_DURATION: 0x9B
  };
  // Elements that can only appear at segment level (used to end clusters of unknown size)
  const LEVEL1 = new Set([0x114D9B74, ID.INFO, ID.TRACKS, ID.CLUSTER, 0x1C53BB6B, 0x1941A469, 0x1043A770, 0x1254C367, 0x1A45DFA3, ID.SEGMENT]);

  function vint(a, p, keepMarker) {
    if (p >= a.length) return null;
    const f = a[p];
    let len = 1, mask = 0x80;
    while (len <= 8 && !(f & mask)) { len++; mask >>= 1; }
    if (len > 8 || p + len > a.length) return null;
    let v = keepMarker ? f : (f & (mask - 1));
    let ones = (f & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + a[p + i]; if (a[p + i] !== 255) ones = false; }
    return { v, len, unknown: !keepMarker && ones };
  }

  function* kids(a, start, end) {
    let p = start;
    while (p < end) {
      const id = vint(a, p, true); if (!id) return;
      const sz = vint(a, p + id.len, false); if (!sz) return;
      const ds = p + id.len + sz.len;
      const de = sz.unknown ? end : Math.min(end, ds + sz.v);
      yield { id: id.v, start: ds, end: de };
      if (sz.unknown) return;
      p = de;
    }
  }

  const uint = (a, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + a[i]; return v; };
  const str = (a, s, e) => new TextDecoder().decode(a.subarray(s, e)).replace(/\0+$/, '');
  const float = (a, s, e) => {
    const dv = new DataView(a.buffer, a.byteOffset + s, e - s);
    return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : 0;
  };

  class Reader {
    constructor(blob, chunk) { this.blob = blob; this.size = blob.size; this.chunk = chunk; this.start = 0; this.buf = new Uint8Array(0); }
    async ensure(pos, len) {
      const bEnd = this.start + this.buf.length;
      if (pos >= this.start && (pos + len <= bEnd || (bEnd === this.size && pos < bEnd))) return;
      const end = Math.min(this.size, pos + Math.max(len, this.chunk));
      this.buf = new Uint8Array(await this.blob.slice(pos, end).arrayBuffer());
      this.start = pos;
    }
    async header(pos) {
      if (pos >= this.size) return null;
      await this.ensure(pos, 16);
      const o = pos - this.start;
      const id = vint(this.buf, o, true); if (!id) return null;
      const sz = vint(this.buf, o + id.len, false); if (!sz) return null;
      const ds = pos + id.len + sz.len;
      return { id: id.v, ds, de: sz.unknown ? null : ds + sz.v };
    }
    async bytes(pos, len) {
      len = Math.max(0, Math.min(len, this.size - pos));
      await this.ensure(pos, len);
      return this.buf.subarray(pos - this.start, pos - this.start + len);
    }
  }

  function parseTracks(a, tracks) {
    for (const e of kids(a, 0, a.length)) {
      if (e.id !== ID.TRACK_ENTRY) continue;
      const t = { number: 0, type: 0, codec: '', lang: 'eng', name: '', isDefault: true, forced: false, comp: null };
      let bcp = '';
      for (const k of kids(a, e.start, e.end)) {
        switch (k.id) {
          case ID.TRACK_NUMBER: t.number = uint(a, k.start, k.end); break;
          case ID.TRACK_TYPE: t.type = uint(a, k.start, k.end); break;
          case ID.CODEC_ID: t.codec = str(a, k.start, k.end); break;
          case ID.LANGUAGE: t.lang = str(a, k.start, k.end); break;
          case ID.LANGUAGE_BCP47: bcp = str(a, k.start, k.end); break;
          case ID.NAME: t.name = str(a, k.start, k.end); break;
          case ID.FLAG_DEFAULT: t.isDefault = !!uint(a, k.start, k.end); break;
          case ID.FLAG_FORCED: t.forced = !!uint(a, k.start, k.end); break;
          case ID.CONTENT_ENCODINGS:
            for (const enc of kids(a, k.start, k.end)) {
              if (enc.id !== ID.CONTENT_ENCODING) continue;
              for (const x of kids(a, enc.start, enc.end)) {
                if (x.id !== ID.CONTENT_COMPRESSION) continue;
                const comp = { algo: 0, settings: null };
                for (const y of kids(a, x.start, x.end)) {
                  if (y.id === ID.COMP_ALGO) comp.algo = uint(a, y.start, y.end);
                  else if (y.id === ID.COMP_SETTINGS) comp.settings = a.slice(y.start, y.end);
                }
                t.comp = comp;
              }
            }
            break;
        }
      }
      if (bcp) t.lang = bcp;
      if (t.type !== 17) continue;   // 17 = subtitle track
      t.kind = /^S_TEXT\//.test(t.codec) || /^S_(ASS|SSA)$/.test(t.codec) || t.codec === 'D_WEBVTT/SUBTITLES' ? 'text' : 'image';
      t.cues = []; t.count = 0;
      tracks.set(t.number, t);
    }
  }

  async function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack compressed subtitles — try Chrome or Edge.');
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function textFromPayload(codec, raw) {
    let s = new TextDecoder().decode(raw).replace(/\0+$/, '').replace(/\r\n?/g, '\n');
    if (/ASS|SSA/.test(codec)) {
      // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
      let rest = s;
      for (let i = 0; i < 8; i++) { const k = rest.indexOf(','); if (k < 0) break; rest = rest.slice(k + 1); }
      s = rest.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
    } else {
      s = s.replace(/<\/?font[^>]*>/gi, '');
    }
    return s.trim();
  }

  async function addBlock(t, blk, clusterTs, dur, scale) {
    t.count++;
    if (t.kind !== 'text') return;
    const tn = vint(blk, 0, false); if (!tn) return;
    let rel = (blk[tn.len] << 8) | blk[tn.len + 1];
    if (rel & 0x8000) rel -= 0x10000;
    let data = blk.subarray(tn.len + 3);
    if (t.comp) {
      if (t.comp.algo === 0) data = await inflate(data);
      else if (t.comp.algo === 3 && t.comp.settings) { const m = new Uint8Array(t.comp.settings.length + data.length); m.set(t.comp.settings); m.set(data, t.comp.settings.length); data = m; }
    }
    const text = textFromPayload(t.codec, data);
    if (!text) return;
    const start = (clusterTs + rel) * scale / 1e9;
    t.cues.push({ start, end: dur != null && dur > 0 ? start + dur * scale / 1e9 : null, text });
  }

  async function parseCluster(r, h, segEnd, tracks, scale) {
    const end = h.de != null ? h.de : segEnd;
    let p = h.ds, ts = 0;
    while (p < end) {
      const c = await r.header(p);
      if (!c) return r.size;
      if (h.de == null && LEVEL1.has(c.id)) return p;     // unknown-size cluster ended
      if (c.de == null) return end;
      if (c.id === ID.TIMESTAMP) {
        const a = await r.bytes(c.ds, c.de - c.ds); ts = uint(a, 0, a.length);
      } else if (c.id === ID.SIMPLEBLOCK) {
        const head = await r.bytes(c.ds, Math.min(8, c.de - c.ds));
        const tn = vint(head, 0, false);
        const t = tn && tracks.get(tn.v);
        if (t) await addBlock(t, (await r.bytes(c.ds, c.de - c.ds)).slice(), ts, null, scale);
      } else if (c.id === ID.BLOCKGROUP) {
        const a = await r.bytes(c.ds, c.de - c.ds);
        let bs = -1, be = -1, dur = null;
        for (const k of kids(a, 0, a.length)) {
          if (k.id === ID.BLOCK) { bs = k.start; be = k.end; }
          else if (k.id === ID.BLOCK_DURATION) dur = uint(a, k.start, k.end);
        }
        if (bs >= 0) {
          const tn = vint(a, bs, false);
          const t = tn && tracks.get(tn.v);
          if (t) await addBlock(t, a.slice(bs, be), ts, dur, scale);
        }
      }
      p = c.de;
    }
    return end;
  }

  /** Returns {duration, tracks:[{number, codec, lang, name, kind:'text'|'image', cues, count}]} */
  async function extract(blob, opts = {}) {
    const { onProgress, signal } = opts;
    const r = new Reader(blob, 4 << 20);
    const size = blob.size;
    let scale = 1e6, duration = 0, segStart = -1, segEnd = size, p = 0;
    const tracks = new Map();

    while (p < size) {
      const h = await r.header(p);
      if (!h) break;
      if (h.id === ID.SEGMENT) { segStart = h.ds; segEnd = h.de != null ? Math.min(h.de, size) : size; break; }
      if (h.de == null) break;
      p = h.de;
    }
    if (segStart < 0) throw new Error('This is not an MKV (Matroska) file.');

    p = segStart;
    let lastReport = 0, tracksSeen = false;
    while (p < segEnd) {
      if (signal && signal.aborted) throw new Error('Cancelled');
      const h = await r.header(p);
      if (!h) break;
      if (h.id === ID.INFO && h.de != null) {
        const a = await r.bytes(h.ds, h.de - h.ds);
        for (const k of kids(a, 0, a.length)) {
          if (k.id === ID.TIMESCALE) scale = uint(a, k.start, k.end);
          else if (k.id === ID.DURATION) duration = float(a, k.start, k.end);
        }
        p = h.de;
      } else if (h.id === ID.TRACKS && h.de != null) {
        parseTracks((await r.bytes(h.ds, h.de - h.ds)).slice(), tracks);
        tracksSeen = true;
        if (![...tracks.values()].some(t => t.kind === 'text')) break;   // nothing readable, stop early
        p = h.de;
      } else if (h.id === ID.CLUSTER) {
        if (tracksSeen && !tracks.size) break;
        p = await parseCluster(r, h, segEnd, tracks, scale);
      } else {
        if (h.de == null) break;
        p = h.de;
      }
      if (onProgress && p - lastReport > size / 400) { lastReport = p; onProgress(Math.min(1, p / size)); }
    }
    onProgress && onProgress(1);

    const out = [...tracks.values()].map(t => {
      const cues = t.cues.sort((a, b) => a.start - b.start);
      cues.forEach((c, i) => {
        if (c.end == null) {
          const next = cues[i + 1];
          c.end = Math.min(next && next.start > c.start ? next.start : c.start + 4, c.start + 6);
        }
      });
      return { number: t.number, codec: t.codec, lang: t.lang, name: t.name, kind: t.kind, isDefault: t.isDefault, forced: t.forced, count: t.count, cues };
    });
    return { duration: duration * scale / 1e9, tracks: out };
  }

  const api = { extract };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MkvSubs = api;
})(typeof self !== 'undefined' ? self : this);
