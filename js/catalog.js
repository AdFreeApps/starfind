// catalog.js — loads data files, precomputes unit vectors, defines asterisms and extra deep-sky
// objects, builds the multilingual search index. No DOM.
import { vecFromRaDec, normalize, insideRing, DEG } from './astro.js';

export const PLANET_KEYS_ALL = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

// Major annual meteor showers (approximate; radiant at peak, J2000). Dates as [month, day]. Names in i18n? No:
// shower names live here for ja/en; other languages fall back to English.
export const METEOR_SHOWERS = [
  { id: 'QUA', ja: 'しぶんぎ座流星群', en: 'Quadrantids', ra: 230, dec: 49, start: [12, 28], end: [1, 12], peak: [1, 4], zhr: 110 },
  { id: 'LYR', ja: 'こと座流星群', en: 'Lyrids', ra: 271, dec: 34, start: [4, 14], end: [4, 30], peak: [4, 22], zhr: 18 },
  { id: 'ETA', ja: 'みずがめ座η流星群', en: 'Eta Aquariids', ra: 338, dec: -1, start: [4, 19], end: [5, 28], peak: [5, 6], zhr: 50 },
  { id: 'SDA', ja: 'みずがめ座δ南流星群', en: 'Southern Delta Aquariids', ra: 340, dec: -16, start: [7, 12], end: [8, 23], peak: [7, 31], zhr: 25 },
  { id: 'CAP', ja: 'やぎ座α流星群', en: 'Alpha Capricornids', ra: 307, dec: -10, start: [7, 3], end: [8, 15], peak: [7, 30], zhr: 5 },
  { id: 'PER', ja: 'ペルセウス座流星群', en: 'Perseids', ra: 48, dec: 58, start: [7, 17], end: [8, 24], peak: [8, 13], zhr: 100 },
  { id: 'DRA', ja: 'りゅう座流星群', en: 'Draconids', ra: 262, dec: 54, start: [10, 6], end: [10, 10], peak: [10, 8], zhr: 10 },
  { id: 'STA', ja: 'おうし座南流星群', en: 'Southern Taurids', ra: 32, dec: 9, start: [9, 10], end: [11, 20], peak: [10, 10], zhr: 5 },
  { id: 'ORI', ja: 'オリオン座流星群', en: 'Orionids', ra: 95, dec: 16, start: [10, 2], end: [11, 7], peak: [10, 21], zhr: 20 },
  { id: 'NTA', ja: 'おうし座北流星群', en: 'Northern Taurids', ra: 58, dec: 22, start: [10, 20], end: [12, 10], peak: [11, 12], zhr: 5 },
  { id: 'LEO', ja: 'しし座流星群', en: 'Leonids', ra: 152, dec: 22, start: [11, 6], end: [11, 30], peak: [11, 17], zhr: 15 },
  { id: 'GEM', ja: 'ふたご座流星群', en: 'Geminids', ra: 112, dec: 33, start: [12, 4], end: [12, 20], peak: [12, 14], zhr: 150 },
  { id: 'URS', ja: 'こぐま座流星群', en: 'Ursids', ra: 217, dec: 76, start: [12, 17], end: [12, 26], peak: [12, 22], zhr: 10 },
];

/** Is the shower active on `date`? Returns {active, daysToPeak}. */
export function showerStatus(sh, date) {
  const y = date.getFullYear();
  const md = (m, d, yy) => new Date(yy, m - 1, d).getTime();
  let s = md(...sh.start, y), e = md(...sh.end, y);
  const t = date.getTime();
  if (e < s) { if (t < e + 86400000) s = md(...sh.start, y - 1); else e = md(...sh.end, y + 1); }
  let p = md(...sh.peak, y);
  if (Math.abs(p - t) > 182 * 86400000) p = md(...sh.peak, p < t ? y + 1 : y - 1);
  return { active: t >= s && t <= e + 86400000, daysToPeak: Math.round((p - t) / 86400000) };
}

// Extra (non-Messier) deep-sky objects, mainly for the southern sky. J2000.
export const EXTRA_DSO = [
  { id: 'LMC', t: 'i', ra: 80.89, dec: -69.76, mag: 0.9, dim: '650x550' },
  { id: 'SMC', t: 'i', ra: 13.19, dec: -72.83, mag: 2.7, dim: '320x185' },
  { id: 'NGC3372', t: 'sfr', ra: 161.27, dec: -59.87, mag: 1.0, dim: '120x120' },
  { id: 'NGC5139', t: 'gc', ra: 201.70, dec: -47.48, mag: 3.7, dim: '36' },
  { id: 'NGC104', t: 'gc', ra: 6.02, dec: -72.08, mag: 4.1, dim: '31' },
  { id: 'Coalsack', t: 'dn', ra: 193.0, dec: -62.5, mag: 99, dim: '420x300' },
];

// Asterisms: star references by IAU name, 'HRnnn', or [ra, dec]. Each line is a polyline.
// hemi: 'N'/'S' = suggested only there. southName: use the ".s" name key for southern users.
export const ASTERISMS = [
  { id: 'ST', lines: [['Vega', 'Altair', 'Deneb', 'Vega']], southName: true },
  { id: 'WT', lines: [['Betelgeuse', 'Sirius', 'Procyon', 'Betelgeuse']], southName: true },
  { id: 'SpT', lines: [['Arcturus', 'Spica', 'Denebola', 'Arcturus']], southName: true },
  { id: 'GS', lines: [['Markab', 'Scheat', 'Alpheratz', 'Algenib', 'Markab']], southName: true },
  { id: 'WD', lines: [['Sirius', 'Procyon', 'Pollux', 'Capella', 'Aldebaran', 'Rigel', 'Sirius']], southName: true },
  { id: 'SC', lines: [['Alioth', 'Mizar', 'Alkaid', 'Arcturus', 'Spica']], southName: true },
  { id: 'BD', lines: [['Alkaid', 'Mizar', 'Alioth', 'Megrez', 'Dubhe', 'Merak', 'Phecda', 'Megrez']] },
  { id: 'CW', lines: [['Caph', 'Schedar', 'HR264', 'Ruchbah', 'Segin']] },
  { id: 'PT', lines: [['Rigil Kentaurus', 'Hadar']] },
  { id: 'FP', hemi: 'N', lines: [['Merak', 'Dubhe', 'Polaris']], guide: true },
  { id: 'FS', hemi: 'S', lines: [['Gacrux', 'Acrux', [0, -90]]], guide: true },
];

export async function loadCatalog(base = 'data/') {
  const get = (f) => fetch(base + f).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
  const [stars, cons, messier, mw] = await Promise.all([
    get('stars.json'), get('constellations.json'), get('messier.json'), get('milkyway.json')]);

  // ---- stars (sorted bright → faint)
  const d = stars.d, n = d.length / 5;
  const S = {
    n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    mag: new Float32Array(n), bv: new Float32Array(n), hr: new Int32Array(n),
    ra: new Float32Array(n), dec: new Float32Array(n), info: [], byHr: new Map(), byName: new Map(),
  };
  for (let i = 0; i < n; i++) {
    const ra = d[i * 5], dec = d[i * 5 + 1];
    const v = vecFromRaDec(ra, dec);
    S.x[i] = v[0]; S.y[i] = v[1]; S.z[i] = v[2];
    S.ra[i] = ra; S.dec[i] = dec;
    S.mag[i] = d[i * 5 + 2]; S.bv[i] = d[i * 5 + 3]; S.hr[i] = d[i * 5 + 4];
    S.info[i] = stars.info[S.hr[i]] || null;
    S.byHr.set(S.hr[i], i);
    if (S.info[i] && S.info[i].en) S.byName.set(S.info[i].en, i);
  }
  const starVec = (i) => [S.x[i], S.y[i], S.z[i]];

  // great-circle densify a list of unit vectors to ≤ maxDeg steps
  const densify = (a, b, maxDeg = 4) => {
    const out = [];
    const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const steps = Math.max(1, Math.ceil(ang / (maxDeg * DEG)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      out.push(normalize([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]));
    }
    return out;
  };

  // ---- constellations: star-to-star edges (each densified), boundaries densified along RA/Dec
  const C = cons.map((c) => {
    const edges = [];
    for (const line of c.l || []) {
      for (let k = 1; k < line.length; k++) {
        const a = vecFromRaDec(line[k - 1][0], line[k - 1][1]), b = vecFromRaDec(line[k][0], line[k][1]);
        edges.push(densify(a, b));
      }
    }
    const bounds = (c.b || []).map((ring) => {
      const pts = [];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        let dra = b[0] - a[0];
        if (dra > 180) dra -= 360; else if (dra < -180) dra += 360;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dra) * Math.cos(a[1] * DEG), Math.abs(b[1] - a[1])) / 3));
        for (let s = 0; s < steps; s++) pts.push(vecFromRaDec(a[0] + dra * s / steps, a[1] + (b[1] - a[1]) * s / steps));
      }
      return pts;
    });
    return { ...c, edges, bvecs: bounds, center: vecFromRaDec(c.c[0], c.c[1]) };
  });
  const conById = new Map(C.map((c) => [c.id, c]));

  // ---- deep sky: Messier + extras
  const M = messier.map((m) => ({ ...m, kind: 'messier', v: vecFromRaDec(m.ra, m.dec) }));
  const X = EXTRA_DSO.map((m) => ({ ...m, kind: 'dso', v: vecFromRaDec(m.ra, m.dec) }));

  // ---- asterisms
  const ref = (r) => {
    if (Array.isArray(r)) return vecFromRaDec(r[0], r[1]);
    const i = r.startsWith('HR') ? S.byHr.get(+r.slice(2)) : S.byName.get(r);
    if (i === undefined) { console.warn('asterism star missing', r); return null; }
    return starVec(i);
  };
  const A = ASTERISMS.map((a) => {
    const lines = a.lines.map((l) => l.map(ref).filter(Boolean));
    const pts = lines.flat();
    const edges = [];
    for (const l of lines) for (let k = 1; k < l.length; k++) edges.push(densify(l[k - 1], l[k], 3));
    let c = [0, 0, 0];
    for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    return { ...a, pts, edges, center: normalize(c) };
  });

  // ---- milky way samples (2D fallback only)
  const mwn = mw.d.length / 3;
  const MW = { n: mwn, x: new Float32Array(mwn), y: new Float32Array(mwn), z: new Float32Array(mwn), lv: new Uint8Array(mwn),
    spacing: Math.sqrt(4 * Math.PI / mw.n) };
  for (let i = 0; i < mwn; i++) {
    const v = vecFromRaDec(mw.d[i * 3], mw.d[i * 3 + 1]);
    MW.x[i] = v[0]; MW.y[i] = v[1]; MW.z[i] = v[2]; MW.lv[i] = mw.d[i * 3 + 2];
  }

  const showers = METEOR_SHOWERS.map((s) => ({ ...s, v: vecFromRaDec(s.ra, s.dec) }));

  const cat = { stars: S, cons: C, conById, messier: M, extra: X, asterisms: A, mw: MW, showers, starVec };
  cat.constellationAt = (v) => {
    for (const c of C) if (c.b.some((ring) => insideRing(v, ring))) return c;
    return null;
  };
  return cat;
}

export function normalizeQuery(s) { // katakana → hiragana, lower-case, drop spaces / dots / hyphens
  return s.toLowerCase().normalize('NFKC').replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/[\s・･\-–()（）]/g, '');
}

/**
 * Build a search function. `names` provides display names in the current language:
 * names(key) → {label, sub, words[]}. Items are keyed "planet:mars", "con:Cyg", "star:Vega",
 * "messier:M31", "dso:LMC", "ast:ST", "shower:PER".
 */
export function buildSearch(cat, names, aliases = {}) {
  const items = [];
  const add = (key) => { const nm = names(key); if (nm) items.push({ key, ...nm, words: nm.words.filter(Boolean).map(normalizeQuery) }); };
  for (const k of PLANET_KEYS_ALL) add(`planet:${k}`);
  for (const a of cat.asterisms) add(`ast:${a.id}`);
  for (const c of cat.cons) add(`con:${c.id}`);
  const S = cat.stars;
  for (let i = 0; i < S.n; i++) if (S.info[i] && S.info[i].en) add(`star:${S.info[i].en}`);
  for (const m of cat.messier) add(`messier:${m.id}`);
  for (const m of cat.extra) add(`dso:${m.id}`);
  for (const s of cat.showers) add(`shower:${s.id}`);
  const aliasKeys = Object.entries(aliases).map(([w, key]) => ({ w: normalizeQuery(w), key }));
  return (q) => {
    q = normalizeQuery(q.trim());
    if (!q) return [];
    const scored = [];
    for (const it of items) {
      let best = 0;
      for (const w of it.words) {
        if (w === q) best = Math.max(best, 3);
        else if (w.startsWith(q)) best = Math.max(best, 2);
        else if (w.includes(q)) best = Math.max(best, 1);
      }
      if (best) scored.push([best, it]);
    }
    for (const a of aliasKeys) if (a.w.startsWith(q) || q.startsWith(a.w)) {
      const it = items.find((x) => x.key === a.key);
      if (it) scored.push([2.5, it]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const seen = new Set(), out = [];
    for (const [, it] of scored) if (!seen.has(it.key)) { seen.add(it.key); out.push(it); if (out.length >= 30) break; }
    return out;
  };
}

export const SEARCH_ALIASES = {
  '北極星': 'star:Polaris', '織姫': 'star:Vega', '織女星': 'star:Vega', '彦星': 'star:Altair', '牽牛星': 'star:Altair',
  'プレアデス': 'messier:M45', '昴': 'messier:M45', 'アンドロメダ大星雲': 'messier:M31', '南十字星': 'con:Cru',
  'カシオペア座': 'con:Cas', 'ペガサス座': 'con:Peg', '白鳥': 'con:Cyg', 'ベテルギュース': 'star:Betelgeuse',
  'アークツルス': 'star:Arcturus', 'イータカリーナ星雲': 'dso:NGC3372', 'マゼラン': 'dso:LMC', '南極老人星': 'star:Canopus',
  'North Star': 'star:Polaris', 'Pole Star': 'star:Polaris', 'Southern Cross': 'con:Cru', 'Seven Sisters': 'messier:M45',
  'Plough': 'ast:BD', 'Winter Diamond': 'ast:WD', 'Great Square': 'ast:GS', '夏の大三角形': 'ast:ST',
};
