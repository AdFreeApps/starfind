// app.js — UI glue: state, settings, input, panels, i18n, recommendations.
// Astronomy: astro.js · sensors: orientation.js · drawing: render.js (2D) + skygl.js (WebGL sky) ·
// data: catalog.js · strings: i18n.js + /i18n/*.json
import * as A from './astro.js';
import { OrientationTracker, viewFromAltAz, altAzOfView } from './orientation.js';
import { SkyRenderer } from './render.js';
import { SkyGL } from './skygl.js';
import { loadCatalog, buildSearch, showerStatus, PLANET_KEYS_ALL, SEARCH_ALIASES } from './catalog.js';
import * as I from './i18n.js';

const { t } = I;
const $ = (id) => document.getElementById(id);
const DEFAULT_LOC = { lat: 34.57, lon: 135.48 };
const LAYERS = ['stars', 'starNames', 'constellations', 'messier', 'planets', 'sunmoon', 'showers', 'milkyway', 'horizon', 'grid', 'eqlines', 'bounds'];

// ------------------------------------------------------------------ device capabilities (no UA sniffing)
const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
const CAP = {
  coarse: mq('(pointer: coarse)'),
  fine: mq('(pointer: fine)'),
  hover: mq('(hover: hover)'),
  orientationAPI: typeof DeviceOrientationEvent !== 'undefined',
};
CAP.likelyHandheld = CAP.coarse && CAP.orientationAPI;
document.body.classList.toggle('touch', CAP.coarse);
document.body.classList.toggle('mouse', CAP.fine && CAP.hover);

// ------------------------------------------------------------------ settings (localStorage, guarded)
const defaults = {
  layers: { stars: true, starNames: true, constellations: true, messier: true, planets: true, sunmoon: true, showers: true,
    milkyway: true, horizon: true, grid: false, eqlines: false, bounds: false },
  // skyLim: faintest magnitude the naked eye reaches under this sky (big city ≈ 3.5, dark site ≈ 6.5)
  night: false, dim: false, twinkle: true, skyLim: 4.5, fov: CAP.likelyHandheld ? 70 : 90,
  lat: DEFAULT_LOC.lat, lon: DEFAULT_LOC.lon, locKind: 'default',
  declination: -7.5, userOffset: 0, viewAz: 180, viewAlt: 35, lang: 'auto', mode: null,
};
let settings = structuredClone(defaults);
try {
  const saved = JSON.parse(localStorage.getItem('skymap.settings') || 'null');
  if (saved) {
    // migrate away from the removed kids mode
    if (saved.kids && saved.layersBeforeKids) saved.layers = saved.layersBeforeKids;
    delete saved.kids; delete saved.layersBeforeKids;
    settings = { ...settings, ...saved, layers: { ...defaults.layers, ...(saved.layers || {}) } };
  }
} catch (e) { /* storage unavailable */ }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      // privacy: never store a precise position (≈1 km rounding)
      const s = { ...settings, lat: Math.round(settings.lat * 100) / 100, lon: Math.round(settings.lon * 100) / 100 };
      localStorage.setItem('skymap.settings', JSON.stringify(s));
    } catch (e) { /* ignore */ }
  }, 300);
}

// ------------------------------------------------------------------ URL parameters (testing / sharing)
const params = new URLSearchParams(location.search);
const num = (k) => (params.has(k) && !isNaN(parseFloat(params.get(k))) ? parseFloat(params.get(k)) : null);
if (num('lat') !== null) { settings.lat = num('lat'); settings.locKind = 'url'; }
if (num('lon') !== null) settings.lon = num('lon');
if (num('fov') !== null) settings.fov = num('fov');
if (num('az') !== null) settings.viewAz = num('az');
if (num('alt') !== null) settings.viewAlt = num('alt');
if (params.has('night')) settings.night = params.get('night') !== '0';
if (params.has('lang')) settings.lang = params.get('lang');
if (params.has('twinkle')) settings.twinkle = params.get('twinkle') !== '0';
if (num('lim') !== null) settings.skyLim = num('lim');

// ------------------------------------------------------------------ state
const state = {
  cat: null, mode: 'manual', viewAz: settings.viewAz, viewAlt: settings.viewAlt,
  live: true, simBase: Date.now(), realBase: performance.now(), rate: 1,
  bodies: [], bodiesAt: -Infinity, target: null, selected: null, dirty: true, slew: null, search: null,
};
if (params.has('t')) setTime(new Date(params.get('t')).getTime(), 0, true);

function simNow() { return state.simBase + (performance.now() - state.realBase) * state.rate; }
function setTime(ms, rate = 0, silent = false) {
  state.live = false; state.simBase = ms; state.realBase = performance.now(); state.rate = rate; state.dirty = true;
  state.bodiesAt = -Infinity; if (!silent) updateTimeUI();
}
function resetTime() {
  state.live = true; state.simBase = Date.now(); state.realBase = performance.now(); state.rate = 1; state.dirty = true;
  state.bodiesAt = -Infinity; updateTimeUI();
}
const southern = () => settings.lat < 0;

// ------------------------------------------------------------------ renderers
const canvas = $('sky');
let gl = null;
try { gl = new SkyGL($('skygl')); } catch (e) { gl = null; $('skygl').hidden = true; console.info('WebGL unavailable, 2D fallback', e.message); }
const renderer = new SkyRenderer(canvas, { transparent: !!gl });
const orient = new OrientationTracker();
orient.declination = settings.declination;
orient.userOffset = settings.userOffset;

// adaptive resolution: full devicePixelRatio; lowered only if frames are slow
const quality = { dprMax: window.devicePixelRatio || 1, glScale: 1, twoDScale: 1, frames: 0, acc: 0, t0: performance.now() };
function viewportSize() {
  const vv = window.visualViewport;
  return { w: Math.round(vv ? vv.width : window.innerWidth), h: Math.round(vv ? vv.height : window.innerHeight) };
}
function resizeAll() {
  const { w, h } = viewportSize();
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(w, h, dpr * quality.twoDScale);
  if (gl) gl.resize(w, h, dpr * quality.glScale);
  state.dirty = true;
}
function monitorPerformance(dt) {
  quality.frames++; quality.acc += dt;
  if (quality.acc < 1500) return;
  const avg = quality.acc / quality.frames;
  quality.frames = 0; quality.acc = 0;
  // only judge while we are animating continuously
  if (!(state.mode === 'sensor' || state.slew || state.target)) return;
  if (avg > 24) {
    if (gl && quality.glScale > 0.5) quality.glScale = Math.max(0.5, quality.glScale - 0.25);
    else if (quality.twoDScale > 0.67) quality.twoDScale = Math.max(0.67, quality.twoDScale - 0.17);
    else return;
    resizeAll();
  }
}

// ------------------------------------------------------------------ names (current language)
const L = () => I.lang();
function conName(c) { return (c.names && (c.names[L()] || c.names.en)) || c.la; }
function starName(i, allowDesig = false) {
  const inf = state.cat.stars.info[i];
  if (!inf) return allowDesig ? `HR ${state.cat.stars.hr[i]}` : null;
  if (L() === 'ja' && inf.ja) return inf.ja;
  if (inf.en) return inf.en;
  return allowDesig ? (inf.d || `HR ${state.cat.stars.hr[i]}`) : null;
}
function bodyName(key) { return t(`planet.${key}`); }
function dsoName(m, long = true) {
  if (m.kind === 'dso') return t(`obj.${m.id}`);
  const local = L() === 'ja' ? m.ja : m.en;
  return long && local ? `${m.id} ${local}` : m.id;
}
function showerName(sh) { return L() === 'ja' ? sh.ja : sh.en; }
function astName(a) { return southern() && a.southName && I.has(`ast.${a.id}.s`) ? t(`ast.${a.id}.s`) : t(`ast.${a.id}`); }
const rendererNames = {
  con: (c) => conName(c),
  star: (i) => { const inf = state.cat.stars.info[i]; if (L() === 'ja' && !inf.ja && settings.fov > 45) return null; return starName(i); },
  body: (k) => bodyName(k), dso: (m, long) => dsoName(m, long), shower: (sh) => showerName(sh), ast: (a) => astName(a),
  get cardinal() { return I.tv('cardinal'); },
  get albireo() { return t('albireo.label'); }, get albireoNote() { return t('albireo.note'); },
  get peakTag() { return t('val.peakTag'); },
};

// ------------------------------------------------------------------ solar system bodies
function computeBodies(ms) {
  const jd = A.julianDay(new Date(ms));
  const out = [{ key: 'sun', ...A.sun(jd) }, { key: 'moon', ...A.moon(jd, settings.lat, settings.lon) }];
  for (const k of A.PLANET_KEYS) out.push({ key: k, ...A.planet(k, jd) });
  return out;
}
function bodyVecAt(key) {
  return (jd) => (key === 'sun' ? A.sun(jd).v : key === 'moon' ? A.moon(jd, settings.lat, settings.lon).v : A.planet(key, jd).v);
}

// ------------------------------------------------------------------ objects
function objectFromKey(key) {
  const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1);
  const cat = state.cat;
  if (kind === 'planet') {
    return { kind: 'body', key, id, get name() { return bodyName(id); }, get v() { return state.bodies.find((x) => x.key === id).v; }, vecAt: bodyVecAt(id) };
  }
  if (kind === 'con') { const c = cat.conById.get(id); return c && { kind: 'con', key, id, get name() { return conName(c); }, v: c.center, con: c }; }
  if (kind === 'star') { const idx = cat.stars.byName.get(id); return idx === undefined ? null : starObject(idx); }
  if (kind === 'messier' || kind === 'dso') {
    const m = (kind === 'messier' ? cat.messier : cat.extra).find((x) => x.id === id);
    return m && { kind, key, id, get name() { return dsoName(m); }, v: m.v, m };
  }
  if (kind === 'shower') { const s = cat.showers.find((x) => x.id === id); return s && { kind: 'shower', key, id, get name() { return showerName(s); }, v: s.v, sh: s }; }
  if (kind === 'ast') { const a = cat.asterisms.find((x) => x.id === id); return a && { kind: 'ast', key, id, get name() { return astName(a); }, v: a.center, ast: a }; }
  return null;
}
function starObject(i) {
  const S = state.cat.stars, inf = S.info[i] || {};
  return { kind: 'star', idx: i, key: inf.en ? `star:${inf.en}` : `hr:${S.hr[i]}`, get name() { return starName(i, true); }, v: [S.x[i], S.y[i], S.z[i]] };
}
function namesForSearch(key) {
  const o = objectFromKey(key);
  if (!o) return null;
  const tag = (k) => t(`tag.${k}`);
  if (o.kind === 'body') return { label: o.name, sub: o.id === 'sun' || o.id === 'moon' ? '' : tag('planet'), words: [o.name, o.id] };
  if (o.kind === 'con') { const c = o.con; return { label: o.name, sub: `${c.la} · ${tag('con')}`, words: [...Object.values(c.names), c.ja.replace(/座$/, ''), c.common, c.id] }; }
  if (o.kind === 'star') {
    const inf = state.cat.stars.info[o.idx];
    return { label: o.name, sub: [L() === 'ja' && inf.ja ? inf.en : '', inf.d].filter(Boolean).join(' · '), words: [inf.ja, inf.en, inf.d] };
  }
  if (o.kind === 'messier' || o.kind === 'dso') { const m = o.m; return { label: o.name, sub: `${t(`type.${m.t}`)}${m.ngc ? ' · ' + m.ngc : ''}`, words: [m.id, m.ja, m.en, m.ngc, o.name] }; }
  if (o.kind === 'shower') return { label: o.name, sub: tag('shower'), words: [o.sh.ja, o.sh.en, o.sh.ja.replace('流星群', '')] };
  if (o.kind === 'ast') return { label: o.name, sub: tag('asterism'), words: [o.name, t(`ast.${o.id}`), t(`ast.${o.id}.s`)] };
  return null;
}

// ------------------------------------------------------------------ main loop
let lastFrame = performance.now(), lastGuide = 0;
function frame(now) {
  const dt = now - lastFrame; lastFrame = now;
  let changed = state.dirty;
  if (state.mode === 'sensor' && orient.smooth(dt)) changed = true;
  if (state.slew) {
    const s = state.slew, k = Math.min(1, (now - s.t0) / s.dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    state.viewAz = A.norm360(s.az0 + s.daz * e); state.viewAlt = s.alt0 + (s.alt1 - s.alt0) * e;
    if (k >= 1) state.slew = null;
    changed = true;
  }
  const ms = simNow();
  if (state.rate !== 0 && Math.abs(ms - (state.lastRenderSim || 0)) > (state.rate === 1 ? 1000 : 0)) changed = true;
  if (state.target) changed = true;                         // pulsing guide
  if (state.egg && (state.egg.armed || now - state.egg.t0 < 8000)) changed = true; // tracing animation
  if (settings.twinkle && !renderer.reducedMotion && now - (state.lastTw || 0) > 50) { changed = true; state.lastTw = now; }
  if (changed) {
    if (Math.abs(ms - state.bodiesAt) > (state.rate > 1 ? 60000 : 15000)) { state.bodies = computeBodies(ms); state.bodiesAt = ms; }
    draw(ms, now);
    state.lastRenderSim = ms;
    state.dirty = false;
    monitorPerformance(dt);
  }
  if (now - lastGuide > 150) { lastGuide = now; updateGuide(); updateClock(ms); updateSunWarning(); }
  requestAnimationFrame(frame);
}

let lastM = null, lastView = null, lastSunAlt = -90;
function draw(ms, now) {
  const jd = A.julianDay(new Date(ms));
  const M = A.eqToHorMatrix(jd, settings.lat, settings.lon);
  let f, u;
  if (state.mode === 'sensor' && orient.rawF) { f = orient.f; u = orient.u; }
  else ({ f, u } = viewFromAltAz(state.viewAlt, state.viewAz));
  renderer.setView(f, u, M, settings.fov);
  lastM = M; lastView = { f, u };
  const sun = state.bodies.find((b) => b.key === 'sun');
  const sunAlt = sun ? A.altAzFromHor(A.mulMV(M, sun.v)).alt : -90;
  lastSunAlt = sunAlt;
  const Mt = A.transpose(M);
  if (gl) {
    gl.render({
      C: renderer.C, scale: renderer.scale, zenith: A.mulMV(Mt, [0, 0, 1]), north: A.mulMV(Mt, [0, 1, 0]),
      sun: sun ? sun.v : [1, 0, 0], sunAlt, night: settings.night, milkyway: settings.layers.milkyway, mwVis: mwVis(),
      ground: settings.layers.horizon, fov: settings.fov,
    });
  }
  const tgt = state.target, sel = state.selected;
  const tcon = tgt && tgt.kind === 'con' ? tgt.id : sel && sel.kind === 'con' ? sel.id : null;
  const ast = (tgt && tgt.kind === 'ast' && tgt.ast) || (sel && sel.kind === 'ast' && sel.ast) || null;
  renderer.render({
    cat: state.cat, layers: settings.layers, night: settings.night, bodies: state.bodies, sunAlt, names: rendererNames,
    highlightCon: tcon || (state.egg ? 'Cyg' : null), asterism: ast, egg: state.egg,
    twinkle: settings.twinkle, skyLim: settings.skyLim, mwVis: mwVis(), labelTop: 64, labelBottom: 84,
    albireoIdx: state.cat.stars.byHr.get(7417) ?? -1,
    target: tgt, selected: sel, time: now, date: new Date(ms), showerStatus,
  });
}

// ------------------------------------------------------------------ guidance text, sun warning
function updateGuide() {
  const el = $('guide');
  if (!state.target || !lastM) { el.hidden = true; return; }
  const tg = state.target;
  const th = A.altAzFromHor(A.mulMV(lastM, tg.v));
  const vh = altAzOfView(lastView.f);
  const info = renderer.targetInfo || {};
  const name = tg.name;
  let msg;
  if (info.centered && state.egg && state.egg.armed && tg.key === 'con:Cyg') {
    state.egg.armed = false; state.egg.t0 = performance.now();
    toast(tmsg(1));
  }
  if (info.centered) msg = t('guide.found', { name });
  else {
    const daz = A.norm180(th.az - vh.az), dalt = th.alt - vh.alt;
    const parts = [];
    if (Math.abs(vh.alt) > 75) parts.push(t('guide.arrow', { n: Math.round(info.dist || 0) }));
    else {
      if (Math.abs(daz) >= 2) parts.push(t(daz > 0 ? 'guide.right' : 'guide.left', { n: Math.round(Math.abs(daz)) }));
      if (Math.abs(dalt) >= 2) parts.push(t(dalt > 0 ? 'guide.up' : 'guide.down', { n: Math.round(Math.abs(dalt)) }));
    }
    msg = t('guide.more', { name, dirs: parts.join(t('guide.join')) || t('guide.little') });
  }
  if (th.alt < 0) msg += t('guide.below');
  $('guideText').textContent = msg;
  el.classList.toggle('found', !!info.centered);
  el.hidden = false;
}
function updateSunWarning() {
  const sun = state.bodies.find((b) => b.key === 'sun');
  let show = false;
  if (sun && lastM && lastSunAlt > -1) {
    const sh = A.mulMV(lastM, sun.v);
    const ang = A.angleBetween(sh, lastView.f);
    show = ang < Math.max(25, settings.fov * 0.6);
  }
  const el = $('sunWarn');
  if (show) $('searchHint').hidden = true;
  if (el.hidden === show) { el.hidden = !show; if (show) el.querySelector('span').textContent = t('sunWarn'); }
}

function updateClock(ms) {
  const s = I.fmtDateTime(new Date(ms));
  const el = $('clock');
  if (el.textContent !== s) el.textContent = s;
  $('clockWrap').classList.toggle('travel', !state.live);
}
const SPEEDS = [60, 600, 3600];
function updateTimeUI() {
  $('resetTime').hidden = state.live;
  $('timeReset2').disabled = state.live;
  const d = new Date(simNow());
  const pad = (n) => String(n).padStart(2, '0');
  $('timeInput').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('playBtn').textContent = state.rate > 1 ? t('time.stop') : t('time.play');
  $('speedBtn').textContent = t('time.speed', { s: t(`speed.${SPEEDS[state.speedIdx || 0]}`) });
  $('speedLabel').textContent = state.rate > 1 ? `× ${t(`speed.${state.rate}`)}` : '';
}

// ------------------------------------------------------------------ targets
function setTarget(obj) {
  state.target = obj;
  state.dirty = true;
  if (obj && state.mode !== 'sensor') slewTo(obj.v);
}
function slewTo(vEq) {
  if (!lastM) return;
  const h = A.altAzFromHor(A.mulMV(lastM, vEq));
  state.slew = { t0: performance.now(), dur: 900, az0: state.viewAz, daz: A.norm180(h.az - state.viewAz), alt0: state.viewAlt,
    alt1: Math.max(-80, Math.min(85, h.alt)) };
}

// ------------------------------------------------------------------ info card
function riseSetText(vecAt, h0) {
  const jd = A.julianDay(new Date(simNow()));
  const r = A.riseSet(vecAt, jd, settings.lat, settings.lon, h0);
  if (r.always) return t('val.always');
  if (r.never) return t('val.never');
  const a = [];
  if (r.rise) a.push(t('val.rise', { t: I.fmtTime(r.rise) }));
  if (r.set) a.push(t('val.set', { t: I.fmtTime(r.set) }));
  return a.join('　');
}
function dirName(az) { return I.tv('dirs')[Math.round(az / 22.5) % 16]; }
function altAzText(v) {
  const h = A.altAzFromHor(A.mulMV(lastM, v));
  return h.alt < 0 ? t('val.below', { dir: dirName(h.az), n: Math.round(-h.alt) }) : t('val.above', { dir: dirName(h.az), n: Math.round(h.alt) });
}
const fmtLy = (ly) => I.fmtNum(ly, ly < 20 ? 1 : 0);

function showCard(obj) {
  state.selected = obj; state.dirty = true;
  const rows = [];
  let sub = '', note = '';
  const cat = state.cat;
  const conOf = (v) => { const c = cat.constellationAt(v); return c ? conName(c) : '—'; };
  const simple = false; // detailed rows always shown
  if (obj.kind === 'star') {
    const S = cat.stars, i = obj.idx, inf = S.info[i] || {};
    sub = [L() === 'ja' && inf.ja ? inf.en : '', inf.d].filter(Boolean).join(' · ') || `HR ${S.hr[i]}`;
    rows.push([t('row.mag'), t('val.mag', { m: I.fmtNum(S.mag[i], 1) })]);
    if (inf.ly) rows.push([t('row.dist'), t('val.ly', { n: fmtLy(inf.ly) }) + (inf.lyq && !simple ? t('val.lyOld') : '')]);
    rows.push([t('row.con'), conOf(obj.v)]);
    rows.push([t('row.pos'), altAzText(obj.v)]);
    rows.push([t('row.riseSet'), riseSetText(() => obj.v, -0.57)]);
    if (!simple) rows.push([t('row.radec'), `${A.formatRA(S.ra[i])}  ${A.formatDec(S.dec[i])}`]);
    const notes = { Albireo: 'note.albireo', Polaris: 'note.polaris', Vega: 'note.vega', Altair: 'note.altair', Deneb: 'note.deneb' };
    if (notes[inf.en]) note = t(notes[inf.en]);
  } else if (obj.kind === 'body') {
    const b = state.bodies.find((x) => x.key === obj.id);
    sub = obj.id === 'sun' || obj.id === 'moon' ? '' : t('tag.planet');
    if (obj.id === 'moon') {
      rows.push([t('row.age'), t(b.waxing ? 'val.wax' : 'val.wane', { a: I.fmtNum(b.age, 1) })]);
      rows.push([t('row.illum'), `${Math.round(b.illum * 100)}%`]);
      rows.push([t('row.dist'), t('val.km', { n: I.fmtNum(Math.round(b.dist)) })]);
    } else if (obj.id === 'sun') {
      rows.push([t('row.dist'), t('val.au', { au: I.fmtNum(b.dist, 3), min: I.fmtNum(b.dist * 8.317, 1) })]);
      note = t('note.sun');
    } else {
      rows.push([t('row.mag'), t('val.mag', { m: I.fmtNum(b.mag, 1) })]);
      rows.push([t('row.dist'), t('val.au', { au: I.fmtNum(b.dist, 2), min: I.fmtNum(Math.round(b.dist * 8.317)) })]);
    }
    rows.push([t('row.con'), conOf(b.v)]);
    rows.push([t('row.pos'), altAzText(b.v)]);
    rows.push([t('row.riseSet'), riseSetText(bodyVecAt(obj.id), obj.id === 'sun' ? -0.833 : obj.id === 'moon' ? 0.125 : -0.57)]);
    if (!simple) { const rd = A.raDecFromVec(b.v); rows.push([t('row.radec'), `${A.formatRA(rd.ra)}  ${A.formatDec(rd.dec)}`]); }
  } else if (obj.kind === 'messier' || obj.kind === 'dso') {
    const m = obj.m;
    sub = [L() === 'ja' ? m.en : '', m.ngc].filter(Boolean).join(' · ');
    rows.push([t('row.type'), t(`type.${m.t}`)]);
    if (m.mag < 50) rows.push([t('row.mag'), t('val.mag', { m: I.fmtNum(m.mag, 1) })]);
    if (m.dim && !simple) rows.push([t('row.size'), `${m.dim}′`]);
    rows.push([t('row.con'), conOf(m.v)]);
    rows.push([t('row.pos'), altAzText(m.v)]);
    rows.push([t('row.riseSet'), riseSetText(() => m.v, -0.57)]);
  } else if (obj.kind === 'shower') {
    const s = obj.sh, st = showerStatus(s, new Date(simNow()));
    sub = L() === 'ja' ? s.en : '';
    rows.push([t('row.active'), `${I.fmtMonthDay(...s.start)} – ${I.fmtMonthDay(...s.end)}`]);
    rows.push([t('row.peak'), t('val.peak', { d: I.fmtMonthDay(...s.peak) })]);
    rows.push([t('row.zhr'), t('val.zhr', { n: s.zhr })]);
    rows.push([t('row.now'), st.active ? (st.daysToPeak === 0 ? t('val.activePeak') : st.daysToPeak > 0 ? t('val.activeTo', { n: st.daysToPeak }) : t('val.activeFrom', { n: -st.daysToPeak })) : t('val.inactive')]);
    rows.push([t('row.radiant'), `${conOf(s.v)} · ${altAzText(s.v)}`]);
    note = t('note.shower');
  } else if (obj.kind === 'con') {
    const c = obj.con;
    sub = `${c.la} (${c.id})`;
    rows.push([t('row.centerPos'), altAzText(c.center)]);
    rows.push([t('row.riseSet'), riseSetText(() => c.center, -0.57)]);
    const S = cat.stars, bright = [];
    for (let i = 0; i < S.n && bright.length < 4; i++) {
      const inf = S.info[i];
      if (inf && inf.d && inf.d.endsWith(' ' + c.id) && inf.en) bright.push(starName(i));
    }
    if (bright.length) rows.push([t('row.bright'), bright.join(L() === 'ja' ? '、' : ', ')]);
    if (c.id === 'Cyg') note = t('note.cyg');
  } else if (obj.kind === 'ast') {
    sub = t('tag.asterism');
    rows.push([t('row.centerPos'), altAzText(obj.v)]);
    rows.push([t('row.riseSet'), riseSetText(() => obj.v, 10)]);
  }
  const R = esc;
  $('cardTitle').innerHTML = R(obj.name);
  $('cardSub').textContent = sub;
  $('cardRows').innerHTML = rows.map(([k, v]) => `<dt>${R(k)}</dt><dd>${R(v)}</dd>`).join('');
  $('cardNote').innerHTML = note ? R(note) : '';
  $('cardNote').hidden = !note;
  $('card').hidden = false;
  $('cardGuide').onclick = () => { setTarget(obj); hideCard(true); };
}
function hideCard(keepSelection = false) { $('card').hidden = true; if (!keepSelection) state.selected = null; state.dirty = true; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ "tonight" recommendations (computed from the real sky)
const REC_KEYS = [
  'ast:ST', 'ast:WT', 'ast:SpT', 'ast:GS', 'ast:WD', 'ast:SC', 'ast:BD', 'ast:CW', 'ast:PT', 'ast:FP', 'ast:FS',
  'con:Ori', 'con:Sco', 'con:Cyg', 'con:Cas', 'con:Leo', 'con:Sgr', 'con:Cru', 'con:Cen', 'con:Lyr', 'con:Tau',
  'messier:M45', 'messier:M31', 'messier:M42', 'messier:M13', 'messier:M44',
  'dso:LMC', 'dso:SMC', 'dso:NGC3372', 'dso:NGC5139', 'dso:NGC104',
  'star:Sirius', 'star:Canopus', 'star:Vega', 'star:Arcturus', 'star:Polaris',
];
function darkTimeFrom(ms) {
  // first time from `ms` when the Sun is below −12° (scan 10-min steps, 24 h)
  for (let k = 0; k <= 144; k++) {
    const tms = ms + k * 600000, jd = A.julianDay(new Date(tms));
    if (A.altitudeOf(A.sun(jd).v, jd, settings.lat, settings.lon) < -12) return tms;
  }
  return ms; // polar day: no darkness, use now
}
function recommendations() {
  const now = simNow();
  const at = darkTimeFrom(now);
  const jd = A.julianDay(new Date(at));
  const M = A.eqToHorMatrix(jd, settings.lat, settings.lon);
  const altOf = (v) => A.altAzFromHor(A.mulMV(M, v)).alt;
  const vis = [], later = [];
  const consider = (key, score0 = 0) => {
    const o = objectFromKey(key);
    if (!o) return;
    if (o.kind === 'ast' && o.ast.hemi && o.ast.hemi !== (southern() ? 'S' : 'N')) return;
    let alt;
    if (o.kind === 'ast') alt = Math.min(...o.ast.pts.filter((p) => !(p[2] < -0.9999)).map(altOf)); // lowest star
    else alt = altOf(typeof o.v === 'function' ? o.v() : o.v);
    if (o.kind === 'ast' && o.ast.guide) alt = altOf(o.ast.pts[0]);
    if (alt > 8) vis.push({ o, alt, score: alt + score0 });
    else {
      const vecAt = o.vecAt || (() => o.v);
      const r = A.riseSet(vecAt, jd, settings.lat, settings.lon, 10);
      if (!r.never && r.rise) later.push({ o, rise: r.rise });
    }
  };
  // bright planets and the Moon (computed for that time)
  const bodies = computeBodies(at);
  for (const b of bodies) {
    if (b.key === 'sun') continue;
    if (b.key !== 'moon' && b.mag > 2.5) continue;
    const alt = altOf(b.v);
    const o = objectFromKey(`planet:${b.key}`);
    if (alt > 5) vis.push({ o, alt, score: alt + 40 });
    else { const r = A.riseSet(bodyVecAt(b.key), jd, settings.lat, settings.lon, 5); if (r.rise) later.push({ o, rise: r.rise }); }
  }
  for (const k of REC_KEYS) consider(k);
  vis.sort((a, b) => b.score - a.score);
  later.sort((a, b) => a.rise - b.rise);
  return { at, isNow: at === now, vis, later: later.slice(0, 5) };
}

function renderSearchList(items, recMode) {
  const ul = $('searchResults');
  ul.innerHTML = '';
  const R = esc;
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<button><b>${R(it.label)}</b><small>${R(it.sub || '')}</small><em>${R(it.where || '')}</em></button>`;
    if (it.dim) li.classList.add('dim');
    li.querySelector('button').addEventListener('click', () => {
      closePanels();
      const obj = objectFromKey(it.key);
      if (obj) { setTarget(obj); toast(t('toast.guideTo', { name: obj.name })); if (recMode) showCard(obj); }
    });
    ul.appendChild(li);
  }
}
function runSearch(e) {
  const q = $('searchInput').value;
  // 日本語入力の変換中（よびご…）は合言葉を判定しない。確定してから判定する
  const composing = !!(e && e.isComposing);
  if (!composing) { const qq = q.trim().toLowerCase().replace(/\s+/g, ' '); isTrace(qq).then((ok) => { if (ok && $('searchInput').value.trim().toLowerCase().replace(/\s+/g, ' ') === qq) { $('searchInput').value = ''; triggerEgg(); } }); }
  const rt = $('recTitle');
  if (!q.trim()) {
    const rec = recommendations();
    rt.textContent = rec.isNow ? t('rec.title') : t('rec.titleAt', { t: I.fmtTime(new Date(rec.at)) });
    rt.hidden = false;
    const items = rec.vis.slice(0, 16).map(({ o, alt }) => ({ key: o.key, label: o.name, sub: recSub(o), where: t('search.alt', { n: Math.round(alt) }) }));
    for (const { o, rise } of rec.later) items.push({ key: o.key, label: o.name, sub: t('rec.later'), where: t('rec.next', { t: I.fmtTime(rise) }), dim: true });
    renderSearchList(items, true);
    return;
  }
  rt.hidden = true;
  const res = state.search(q);
  if (!res.length) { $('searchResults').innerHTML = `<li class="empty">${esc(t('search.none'))}</li>`; return; }
  renderSearchList(res.map((it) => {
    const obj = objectFromKey(it.key);
    let where = '';
    if (obj && lastM) { const h = A.altAzFromHor(A.mulMV(lastM, obj.v)); where = h.alt >= 0 ? t('search.alt', { n: Math.round(h.alt) }) : t('search.below'); }
    return { ...it, where };
  }), false);
}
function recSub(o) {
  if (o.kind === 'body') return o.id === 'moon' ? '' : t('tag.planet');
  if (o.kind === 'ast') return t('tag.asterism');
  if (o.kind === 'con') return t('tag.con');
  if (o.kind === 'star') return t('tag.star');
  if (o.kind === 'messier' || o.kind === 'dso') return t(`type.${o.m.t}`);
  return '';
}

// ------------------------------------------------------------------ input: drag, pinch, wheel, tap, hover, keys
const pointers = new Map();
let gesture = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  $('tooltip').hidden = true;
  if (pointers.size === 1) gesture = { type: 'tap', x0: e.clientX, y0: e.clientY, t0: performance.now(), lx: e.clientX, ly: e.clientY };
  else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), fov0: settings.fov }; }
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) { if (e.pointerType === 'mouse') hover(e.clientX, e.clientY); return; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.type === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    setFov(gesture.fov0 * gesture.d0 / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)));
    return;
  }
  if (gesture.type === 'tap' && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 8) {
    gesture.type = 'drag';
    if (state.mode === 'sensor') { setMode('manual'); toast(t('toast.manual')); }
    state.slew = null;
  }
  if (gesture.type === 'drag') {
    pan(e.clientX - gesture.lx, e.clientY - gesture.ly);
    gesture.lx = e.clientX; gesture.ly = e.clientY;
  }
});
function pan(dx, dy) {
  const dpp = settings.fov / Math.min(renderer.w, renderer.h);
  state.viewAz = A.norm360(state.viewAz - dx * dpp / Math.max(0.35, Math.cos(state.viewAlt * A.DEG)));
  state.viewAlt = Math.max(-89, Math.min(89, state.viewAlt + dy * dpp));
  settings.viewAz = state.viewAz; settings.viewAlt = state.viewAlt; save();
  state.dirty = true;
}
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture && gesture.type === 'tap' && pointers.size === 0 && performance.now() - gesture.t0 < 500) onTap(e.clientX, e.clientY);
  if (pointers.size === 0) gesture = null;
  else if (gesture && gesture.type === 'pinch') gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { $('tooltip').hidden = true; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); setFov(settings.fov * Math.exp(e.deltaY * 0.001)); }, { passive: false });
canvas.addEventListener('dblclick', (e) => {
  if (state.mode === 'sensor') return;
  const h = A.altAzFromHor(renderer.unproject(e.clientX, e.clientY).hor);
  state.slew = { t0: performance.now(), dur: 500, az0: state.viewAz, daz: A.norm180(h.az - state.viewAz), alt0: state.viewAlt, alt1: h.alt };
});
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  const step = settings.fov / 12;
  if (e.key === 'ArrowLeft') { pan(step / (settings.fov / Math.min(renderer.w, renderer.h)), 0); }
  else if (e.key === 'ArrowRight') { pan(-step / (settings.fov / Math.min(renderer.w, renderer.h)), 0); }
  else if (e.key === 'ArrowUp') { pan(0, step / (settings.fov / Math.min(renderer.w, renderer.h))); }
  else if (e.key === 'ArrowDown') { pan(0, -step / (settings.fov / Math.min(renderer.w, renderer.h))); }
  else if (e.key === '+' || e.key === '=') setFov(settings.fov / 1.2);
  else if (e.key === '-' || e.key === '_') setFov(settings.fov * 1.2);
  else if (e.key === 'Escape') { closePanels(); hideCard(); }
  else if (e.key === '/' ) { e.preventDefault(); $('searchBtn').click(); }
  else return;
  if (e.key.startsWith('Arrow') && state.mode === 'sensor') setMode('manual');
});
function setFov(f) { settings.fov = Math.max(20, Math.min(120, f)); state.dirty = true; save(); }

function pickObject(x, y) {
  const p = renderer.pick(x, y, CAP.coarse ? 18 : 8);
  if (!p) return null;
  if (p.kind === 'star') return starObject(p.idx);
  if (p.kind === 'body') return objectFromKey('planet:' + p.obj.key);
  if (p.kind === 'messier' || p.kind === 'dso') return objectFromKey(`${p.kind}:${p.obj.id}`);
  if (p.kind === 'shower') return objectFromKey('shower:' + p.obj.id);
  return null;
}
function onTap(x, y) {
  let obj = pickObject(x, y);
  if (!obj) { const c = state.cat.constellationAt(renderer.unproject(x, y).eq); if (c) obj = objectFromKey('con:' + c.id); }
  if (obj) showCard(obj); else hideCard();
}
let hoverTimer = 0;
function hover(x, y) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const o = pickObject(x, y), tip = $('tooltip');
    if (!o) { tip.hidden = true; canvas.style.cursor = ''; return; }
    tip.textContent = o.name;
    tip.style.left = `${Math.min(x + 14, renderer.w - 160)}px`; tip.style.top = `${y + 14}px`;
    tip.hidden = false; canvas.style.cursor = 'pointer';
  }, 40);
}

// ------------------------------------------------------------------ modes
function setMode(m, persist = true) {
  state.mode = m;
  if (persist) { settings.mode = m; save(); }
  $('modeBtn').classList.toggle('on', m === 'sensor');
  $('modeLabel').textContent = t(m === 'sensor' ? 'mode.sensor' : 'mode.manual');
  if (m === 'manual' && orient.rawF) { const v = altAzOfView(orient.f); state.viewAz = v.az; state.viewAlt = v.alt; }
  state.dirty = true;
}
async function startSensor() {
  const ok = await orient.start();
  if (!ok) { toast(t('toast.noSensorPerm')); setMode('manual', false); return false; }
  setMode('sensor');
  setTimeout(() => {
    if (state.mode === 'sensor' && !orient.receiving()) { toast(t('toast.noSensorData')); setMode('manual', false); }
    else if (state.mode === 'sensor' && !orient.absolute) toast(t('toast.noCompass'));
  }, 2500);
  return true;
}

// ------------------------------------------------------------------ location, wake lock
function requestLocation(manualClick = false) {
  if (!navigator.geolocation) { if (manualClick) toast(t('toast.noGeo')); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    settings.lat = pos.coords.latitude; settings.lon = pos.coords.longitude; settings.locKind = 'here';
    save(); state.bodiesAt = -Infinity; state.dirty = true; updateLocUI();
    if (manualClick) toast(t('toast.locOk'));
  }, () => { if (manualClick) toast(t('toast.locFail')); updateLocUI(); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
}
function updateLocUI() {
  $('latInput').value = (Math.round(settings.lat * 100) / 100).toString(); $('lonInput').value = (Math.round(settings.lon * 100) / 100).toString();
  const kind = { default: 'loc.default', here: 'loc.here', manual: 'loc.manual', url: 'loc.url' }[settings.locKind] || 'loc.manual';
  $('locLabel').textContent = `${t(kind)} ${Math.abs(settings.lat).toFixed(2)}°${settings.lat >= 0 ? 'N' : 'S'} ${Math.abs(settings.lon).toFixed(2)}°${settings.lon >= 0 ? 'E' : 'W'}`;
}
let wakeLock = null;
async function requestWakeLock() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wakeLock !== null) requestWakeLock(); });

// the Milky Way fades out under bright skies (gone by mag 4, full at 6)
function mwVis() { return Math.max(0, Math.min(1, (settings.skyLim - 4) / 2)); }

// ------------------------------------------------------------------ toast / panels
let toastTimer = 0;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
const PANELS = ['menu', 'search', 'timepanel', 'help'];
function openPanel(id) { for (const p of PANELS) if (p !== id) $(p).hidden = true; $(id).hidden = false; }
function closePanels() { for (const p of PANELS) $(p).hidden = true; }

function buildLayerList() {
  const list = $('layerList');
  list.innerHTML = '';
  for (const k of LAYERS) {
    const row = document.createElement('label');
    row.className = 'switch';
    row.innerHTML = `<span></span><input type="checkbox" ${settings.layers[k] ? 'checked' : ''}><i></i>`;
    row.querySelector('span').textContent = t(`layer.${k}`);
    row.querySelector('input').addEventListener('change', (e) => { settings.layers[k] = e.target.checked; save(); state.dirty = true; });
    list.appendChild(row);
  }
}
function buildMenu() {
  buildLayerList();
  const bind = (id, key, after) => {
    const el = $(id); el.checked = settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; save(); state.dirty = true; after && after(); });
  };
  bind('optNight', 'night', applyLook);
  bind('optDim', 'dim', applyLook);
  bind('optTwinkle', 'twinkle');
  const sky = $('skySelect');
  sky.value = String(settings.skyLim);
  if (sky.value !== String(settings.skyLim)) sky.value = '4.5';
  sky.onchange = () => { settings.skyLim = parseFloat(sky.value); save(); state.dirty = true; };
  const sel = $('langSelect');
  sel.innerHTML = `<option value="auto">${esc(t('lang.auto'))}</option>` + I.languages().map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join('');
  sel.value = settings.lang;
  sel.onchange = async () => { settings.lang = sel.value; save(); await I.initI18n(settings.lang); applyLanguage(); };
  $('declInput').value = settings.declination;
  $('declInput').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { settings.declination = v; orient.declination = v; save(); } });
  $('offsetInput').value = settings.userOffset;
  $('offsetVal').textContent = `${settings.userOffset}°`;
  $('offsetInput').addEventListener('input', (e) => { settings.userOffset = +e.target.value; orient.userOffset = settings.userOffset; $('offsetVal').textContent = `${settings.userOffset}°`; save(); });
  const locChange = () => {
    const la = parseFloat($('latInput').value), lo = parseFloat($('lonInput').value);
    if (isNaN(la) || isNaN(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) { toast(t('toast.badLoc')); return; }
    settings.lat = la; settings.lon = lo; settings.locKind = 'manual'; save(); state.bodiesAt = -Infinity; state.dirty = true; updateLocUI();
  };
  $('latInput').addEventListener('change', locChange);
  $('lonInput').addEventListener('change', locChange);
  $('locBtn').addEventListener('click', () => requestLocation(true));
  $('locDefault').addEventListener('click', () => { settings.lat = DEFAULT_LOC.lat; settings.lon = DEFAULT_LOC.lon; settings.locKind = 'default'; save(); state.bodiesAt = -Infinity; state.dirty = true; updateLocUI(); });
}
function applyLook() {
  document.body.classList.toggle('night', settings.night);
  $('dim').hidden = !settings.dim;
  $('nightBtn').classList.toggle('on', settings.night);
  for (const [id, k] of [['optNight', 'night'], ['optDim', 'dim']]) $(id).checked = settings[k];
  state.dirty = true;
}
function applyLanguage() {
  I.applyDOM();
  buildLayerList();
  $('langSelect').options[0].textContent = t('lang.auto');
  $('modeLabel').textContent = t(state.mode === 'sensor' ? 'mode.sensor' : 'mode.manual');
  updateLocUI(); updateTimeUI();
  if (state.cat) state.search = buildSearch(state.cat, namesForSearch, SEARCH_ALIASES);
  if (state.selected && !$('card').hidden) showCard(state.selected);
  state.dirty = true;
}

// ------------------------------------------------------------------ trace
const TH = ['cf4995d42264c379bf0599d65c9682fa0eb37a5cb3b6a433e46aed7a452b4b65', '1e0064b44c44fc848d57e6f9366793d295f6ffd049d828bc84ca5a7a927f4bf2', '82fb145be0b5a2855a2cc0b507adb3abc5ffed87bfd28856ab66d145fcd1172b',
  '29853adba5910a688eab44f1946c6a72f3d3682ba84f13bc104748ab95002838', '6b112b2bc418cfea975e711c3fd119ba4bb4307a22b5f496d578534be5f2a355',
  'c0b9607a30fa589fd52931239f84b66fdf9cce74b999a035acada122550a5490', 'd8af786b4dad16a73f0c222fbe885d61606f5bad5c2cbd6154d61d76fd5addb0'];
const TM = {"ja": ["5ZG844Gz5aOw44Gu5pa56KeS44G444CB44GL44GW44GX44Gm44GP44Gg44GV44GE", "44Gv44GP44Gh44KH44GG5bqn44CC6YeR44Go6Z2S44Gu44CB44Ki44Or44OT44Os44Kq"], "en": ["UG9pbnQgeW91ciBwaG9uZSB0b3dhcmQgdGhlIGNhbGw=", "Q3lnbnVzLiBBbGJpcmVvLCBnb2xkIGFuZCBibHVl"]};
function tmsg(i) { const m = TM[String(I.lang() || '').startsWith('ja') ? 'ja' : 'en'];
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[i]), (c) => c.charCodeAt(0))); } catch (e) { return ''; } }
async function isTrace(q) {
  if (!q || q.length > 40 || !(window.crypto && crypto.subtle)) return false;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sf:' + q));
  return TH.includes(Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join(''));
}
function triggerEgg() {
  // 合言葉の直後は「待機」。はくちょう座が画面の真ん中に来た瞬間に演出を始める
  state.egg = { t0: 0, armed: true };
  closePanels();
  toast(tmsg(0));
  const o = objectFromKey('con:Cyg');
  if (o) setTarget(o);
  state.dirty = true;
}

// ------------------------------------------------------------------ first-run onboarding demo
function maybeOnboard() {
  const forced = params.get('onboard');
  if (forced === '0') return;
  if (forced !== '1' && (settings.onboarded || ['target', 'select', 'panel', 'search'].some((k) => params.has(k)))) return;
  settings.onboarded = true; save();
  const altNow = (v) => A.altAzFromHor(A.mulMV(lastM, v)).alt;
  let obj = null;
  for (const r of recommendations().vis) if (altNow(r.o.v) > 10) { obj = r.o; break; }
  if (obj) { setTarget(obj); state.selected = obj; }
  $('searchHint').hidden = false;
  setTimeout(() => { $('searchHint').hidden = true; }, 15000);
}

// ------------------------------------------------------------------ wire up UI
function wire() {
  $('menuBtn').addEventListener('click', () => ($('menu').hidden ? openPanel('menu') : closePanels()));
  $('searchBtn').addEventListener('click', () => { $('searchHint').hidden = true; openPanel('search'); $('searchInput').value = ''; runSearch(); if (!CAP.coarse) $('searchInput').focus(); });
  $('searchInput').addEventListener('input', runSearch);
  $('searchInput').addEventListener('compositionend', () => runSearch());
  $('timeBtn').addEventListener('click', () => { updateTimeUI(); $('timepanel').hidden ? openPanel('timepanel') : closePanels(); });
  $('helpBtn').addEventListener('click', () => openPanel('help'));
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closePanels);
  $('modeBtn').addEventListener('click', async () => { if (state.mode === 'sensor') setMode('manual'); else await startSensor(); });
  $('nightBtn').addEventListener('click', () => { settings.night = !settings.night; save(); applyLook(); });
  $('zoomIn').addEventListener('click', () => setFov(settings.fov / 1.3));
  $('zoomOut').addEventListener('click', () => setFov(settings.fov * 1.3));
  $('guideClose').addEventListener('click', () => { state.target = null; state.egg = null; state.dirty = true; });
  $('cardClose').addEventListener('click', () => hideCard());
  $('resetTime').addEventListener('click', resetTime);
  $('timeReset2').addEventListener('click', resetTime);
  $('timeInput').addEventListener('change', (e) => { const tm = new Date(e.target.value).getTime(); if (!isNaN(tm)) setTime(tm, 0); });
  for (const b of document.querySelectorAll('[data-step]')) b.addEventListener('click', () => setTime(simNow() + parseFloat(b.dataset.step) * 3600000, state.rate > 1 ? state.rate : 0));
  $('tonightBtn').addEventListener('click', () => { const d = new Date(); d.setHours(21, 0, 0, 0); setTime(d.getTime(), 0); });
  $('nowBtn').addEventListener('click', resetTime);
  $('playBtn').addEventListener('click', () => { if (state.rate > 1) setTime(simNow(), 0); else setTime(simNow(), SPEEDS[state.speedIdx || 0]); });
  $('speedBtn').addEventListener('click', () => {
    state.speedIdx = ((state.speedIdx || 0) + 1) % SPEEDS.length;
    if (state.rate > 1) setTime(simNow(), SPEEDS[state.speedIdx]); else updateTimeUI();
  });
  $('startSensor').addEventListener('click', async () => { $('intro').hidden = true; requestWakeLock(); await startSensor(); requestLocation(); maybeOnboard(); });
  $('startManual').addEventListener('click', () => { $('intro').hidden = true; requestWakeLock(); setMode('manual'); requestLocation(); maybeOnboard(); });
  $('searchHintClose').addEventListener('click', () => { $('searchHint').hidden = true; });
  const onResize = () => { resizeAll(); };
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', () => setTimeout(onResize, 100));
}

// ------------------------------------------------------------------ boot
(async function boot() {
  await I.initI18n(settings.lang);
  wire();
  buildMenu();
  applyLook();
  applyLanguage();
  resizeAll();
  $('loading').textContent = t('loading');
  try {
    const [cat] = await Promise.all([loadCatalog(), gl ? gl.loadTexture('data/milkyway.jpg') : null]);
    state.cat = cat;
  } catch (e) {
    $('loading').textContent = t('loadError');
    console.error(e);
    return;
  }
  state.search = buildSearch(state.cat, namesForSearch, SEARCH_ALIASES);
  $('loading').hidden = true;
  // device adaptation: phones/tablets start at the "point at the sky" screen; computers go straight to manual
  const forcedManual = params.get('mode') === 'manual' || params.has('skipintro');
  if (forcedManual || !CAP.likelyHandheld) { $('intro').hidden = true; setMode('manual', false); if (!forcedManual && settings.locKind === 'default') requestLocation(); }
  else if (settings.mode === 'manual') { $('intro').hidden = true; setMode('manual', false); requestLocation(); }
  else setMode('manual', false);
  state.bodies = computeBodies(simNow()); state.bodiesAt = simNow();
  draw(simNow(), performance.now());
  if ($('intro').hidden) maybeOnboard();
  if (params.has('target')) {
    const k = params.get('target');
    const obj = objectFromKey(k.includes(':') ? k : 'con:' + k);
    if (obj) { state.target = obj; if (!params.has('az')) slewTo(obj.v); }
  }
  if (params.has('select')) { const o = objectFromKey(params.get('select')); if (o) showCard(o); }
  if (params.has('search')) { openPanel('search'); $('searchInput').value = params.get('search'); runSearch(); }
  if (params.has('panel')) { openPanel(params.get('panel')); if (params.get('panel') === 'search') runSearch(); }
  requestAnimationFrame(frame);
})();
