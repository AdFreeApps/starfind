// render.js — 2D canvas overlay: stars, lines, labels, planets, Moon, guides.
// Stereographic projection centred on the view direction; field of view spans the SHORTER screen axis.
// The sky background / Milky Way / ground colour are drawn underneath by skygl.js (WebGL); if WebGL
// is missing this renderer paints a simple background and a sampled Milky Way itself.
import { mulMV, mulMM, cross, normalize, transpose, horFromAltAz, ECLIPTIC_POLE, CELESTIAL_POLE, DEG } from './astro.js';

// B−V → RGB (blackbody-like, gently saturated)
const BV_BUCKETS = [-0.15, 0.1, 0.35, 0.6, 0.85, 1.15, 1.5, 9];
const BV_RGB = [[155, 180, 255], [185, 205, 255], [222, 230, 255], [255, 250, 242], [255, 236, 205], [255, 214, 165], [255, 190, 130], [255, 165, 105]];
// faint stars look nearly white to the eye: keep only a hint of colour
const FAINT_RGB = BV_RGB.map((c) => c.map((v) => Math.round(v * 0.4 + 255 * 0.6)));
const bvBucket = (bv) => { let i = 0; while (bv > BV_BUCKETS[i]) i++; return i; };

const PLANET_COLOR = {
  sun: [255, 226, 150], moon: [236, 234, 222], mercury: [205, 195, 180], venus: [255, 248, 225], mars: [255, 128, 82],
  jupiter: [244, 224, 188], saturn: [236, 214, 160], uranus: [175, 228, 236], neptune: [125, 160, 255],
};
const FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif';

// near-side maria (selenographic lat, lon, radius°) for a subtle Moon texture
const MARIA = [[33, -16, 17], [28, 17, 10], [8.5, 31, 11], [17, 59, 7], [-8, 51, 9], [-15, 35, 6], [-21, -17, 10],
  [18, -57, 20], [-24, -39, 6], [56, 1, 6], [13, 3, 4], [-10, -23, 7], [8, -31, 7], [-3, -41, 9]];

export class SkyRenderer {
  constructor(canvas, { transparent = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.transparent = transparent; // WebGL draws the background
    this.night = false;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.picks = [];
    this.moonCache = null;
    this.mwCanvas = null;
    this.makeSprites();
    this.reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    if (!this.transparent) {
      this.mwCanvas = this.mwCanvas || document.createElement('canvas');
      this.mwCanvas.width = Math.ceil(w / 3); this.mwCanvas.height = Math.ceil(h / 3);
    }
    this.moonCache = null;
  }

  // night mode maps every colour to red luminance
  col(rgb, a = 1) {
    if (this.night) {
      const L = Math.round(Math.max(rgb[0], rgb[1], rgb[2]) * 0.55 + (0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]) * 0.35);
      return `rgba(${L},0,0,${a})`;
    }
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  }

  // ------------------------------------------------------------------ star sprites (high-res, generated once)
  makeSprites() {
    const mk = (size, draw) => { const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size); return c; };
    const build = (night) => BV_RGB.map((rgb0) => {
      const rgb = night ? [Math.round(Math.max(...rgb0) * 0.9), 0, 0] : rgb0;
      const core = mk(128, (g, S) => {
        const h = S / 2, gr = g.createRadialGradient(h, h, 0, h, h, h);
        // sharp core: white centre, coloured rim, steep falloff (PSF-like)
        const c = (a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
        gr.addColorStop(0, night ? c(1) : 'rgba(255,255,255,1)');
        gr.addColorStop(0.28, c(1));
        gr.addColorStop(0.5, c(0.55));
        gr.addColorStop(0.72, c(0.12));
        gr.addColorStop(1, c(0));
        g.fillStyle = gr; g.fillRect(0, 0, S, S);
      });
      const halo = mk(256, (g, S) => {
        const h = S / 2, gr = g.createRadialGradient(h, h, 0, h, h, h);
        const c = (a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
        for (let k = 0; k <= 10; k++) { const t = k / 10; gr.addColorStop(t, c(0.42 * Math.exp(-t * t * 7) * (1 - t))); }
        g.fillStyle = gr; g.fillRect(0, 0, S, S);
        // faint diffraction-like cross for the brightest stars
        g.globalCompositeOperation = 'lighter';
        const lg = g.createLinearGradient(0, h, S, h);
        lg.addColorStop(0, c(0)); lg.addColorStop(0.5, c(0.10)); lg.addColorStop(1, c(0));
        g.fillStyle = lg; g.fillRect(0, h - 0.7, S, 1.4);
        const lg2 = g.createLinearGradient(h, 0, h, S);
        lg2.addColorStop(0, c(0)); lg2.addColorStop(0.5, c(0.10)); lg2.addColorStop(1, c(0));
        g.fillStyle = lg2; g.fillRect(h - 0.7, 0, 1.4, S);
      });
      return { core, halo };
    });
    this.sprites = { day: build(false), night: build(true) };
  }

  /** Set up the projection for this frame. f/u: forward and up (HOR). M: EQ→HOR. */
  setView(f, u, M, fov) {
    const r = normalize(cross(f, u));
    const uu = cross(r, f);
    this.V = [r[0], r[1], r[2], uu[0], uu[1], uu[2], f[0], f[1], f[2]]; // HOR → camera
    this.M = M;
    this.C = mulMM(this.V, M); // EQ → camera
    this.fov = fov;
    const minDim = Math.min(this.w, this.h);
    this.scale = (minDim / 2) / (2 * Math.tan(fov * DEG / 4)); // CSS px per stereographic unit
    this.cx = this.w / 2; this.cy = this.h / 2;
    const rCorner = Math.hypot(this.w, this.h) / 2 / this.scale;
    const cCorner = 2 * Math.atan(rCorner / 2);
    this.zCull = Math.cos(Math.min(Math.PI * 0.95, cCorner + 5 * DEG));
  }

  projCam(c, out) {
    if (c[2] < this.zCull) return false;
    const k = 2 * this.scale / (1 + c[2]);
    out[0] = this.cx + k * c[0]; out[1] = this.cy - k * c[1];
    return true;
  }
  projEq(v, out) { return this.projCam(mulMV(this.C, v), out); }
  projHor(v, out) { return this.projCam(mulMV(this.V, v), out); }
  onScreen(p, m = 0) { return p[0] >= -m && p[0] <= this.w + m && p[1] >= -m && p[1] <= this.h + m; }

  unproject(x, y) {
    const X = (x - this.cx) / this.scale, Y = -(y - this.cy) / this.scale, r2 = X * X + Y * Y;
    const c = [4 * X / (4 + r2), 4 * Y / (4 + r2), (4 - r2) / (4 + r2)];
    const hor = mulMV(transpose(this.V), c);
    return { hor, eq: mulMV(transpose(this.M), hor) };
  }

  // crisp label with a soft dark outline (cheaper than shadowBlur)
  label(text, x, y, rgb, a = 0.9, size = 12.5, weight = 500, align = 'left') {
    const ctx = this.ctx;
    size *= this.labelScale || 1;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.night ? 'rgba(0,0,0,0.85)' : 'rgba(2,4,10,0.72)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = this.col(rgb, a);
    ctx.fillText(text, x, y);
  }
  placeLabel(x, y, text, size = 12.5, align = 'left') {
    size *= this.labelScale || 1;
    this.ctx.font = `500 ${size}px ${FONT}`;
    const w = this.ctx.measureText(text).width + 6, h = size + 4;
    const x0 = align === 'center' ? x - w / 2 : x - 2, y0 = y - h / 2;
    if (x0 < 0 || x0 + w > this.w || y0 < (this.labelTop || 0) || y0 + h > this.h - (this.labelBottom || 0)) return false;
    for (const r of this.labelRects) if (x0 < r[0] + r[2] && x0 + w > r[0] && y0 < r[1] + r[3] && y0 + h > r[1]) return false;
    this.labelRects.push([x0, y0, w, h]);
    return true;
  }

  render(s) {
    const ctx = this.ctx, L = s.layers;
    this.night = s.night;
    this.picks = [];
    this.labelRects = [];
    this.state = s;
    this.names = s.names;
    this.labelScale = s.labelScale || 1;
    this.labelTop = s.labelTop || 0; this.labelBottom = s.labelBottom || 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textBaseline = 'middle';
    const sa = s.sunAlt ?? -90;
    // star visibility vs daylight (stars stay faintly visible in daytime to help learning)
    this.skyVis = sa < -12 ? 1 : sa > 0 ? 0.4 : 0.4 + 0.6 * (-sa / 12);
    if (this.transparent) ctx.clearRect(0, 0, this.w, this.h);
    else {
      const t = sa > -18 ? Math.min(1, (sa + 18) / 24) : 0;
      ctx.fillStyle = this.col([Math.round(7 + 14 * t), Math.round(12 + 31 * t), Math.round(31 + 51 * t)]);
      ctx.fillRect(0, 0, this.w, this.h);
      if (L.milkyway && (s.mwVis ?? 1) > 0) this.drawMilkyWayFallback(s.cat.mw, sa, s.mwVis ?? 1);
    }
    if (L.grid) this.drawAltAzGrid();
    if (L.eqlines) {
      this.drawGreatCircle(mulMV(this.C, CELESTIAL_POLE), this.col([90, 160, 210], 0.4), 1, [6, 6]);
      this.drawGreatCircle(mulMV(this.C, ECLIPTIC_POLE), this.col([230, 185, 90], 0.4), 1, [2, 5]);
    }
    if (L.bounds) this.drawBounds(s.cat.cons);
    if (L.constellations || s.egg) this.drawConstellationLines(s.cat.cons, s.highlightCon, s.egg, L.constellations);
    if (L.constellations && s.highlightCon) this.drawConstellationNames(s.cat.cons, s.highlightCon, true);
    if (s.asterism) this.drawAsterism(s.asterism);
    if (L.stars) this.drawStars(s.cat.stars, L.starNames, s);
    if (L.planets) this.drawSolarSystem(s.bodies, s);
    if (L.messier) this.drawMessier(s.cat.messier.concat(s.cat.extra));
    if (L.showers) this.drawShowers(s.cat.showers, s.date, s.showerStatus);
    if (L.constellations) this.drawConstellationNames(s.cat.cons, s.highlightCon);
    if (L.horizon) this.drawGround();
    if (s.selected) this.drawSelection(s.selected);
    this.targetInfo = s.target ? this.drawTarget(s.target, s.time) : null;
  }

  // ------------------------------------------------------------------ fallback Milky Way (no WebGL)
  drawMilkyWayFallback(mw, sunAlt, vis = 1) {
    const g = this.mwCanvas.getContext('2d'), W = this.mwCanvas.width, H = this.mwCanvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const C = this.C, zc = this.zCull, sc = 2 * this.scale / 3;
    const base = mw.spacing * this.scale / 3 * 1.25;
    const alphas = [0, 0.06, 0.08, 0.10, 0.13, 0.16];
    g.fillStyle = this.night ? '#ff0000' : '#c8d4ff';
    for (let lv = 1; lv <= 5; lv++) {
      g.globalAlpha = alphas[lv] * vis;
      g.beginPath();
      for (let i = 0; i < mw.n; i++) {
        if (mw.lv[i] !== lv) continue;
        const x = mw.x[i], y = mw.y[i], z = mw.z[i];
        const cz = C[6] * x + C[7] * y + C[8] * z;
        if (cz < zc) continue;
        const k = sc / (1 + cz);
        const px = W / 2 + k * (C[0] * x + C[1] * y + C[2] * z);
        const py = H / 2 - k * (C[3] * x + C[4] * y + C[5] * z);
        const r = base * (2 / (1 + cz));
        g.rect(px - r, py - r, 2 * r, 2 * r);
      }
      g.fill();
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = sunAlt > -12 ? Math.max(0, (-sunAlt - 6) / 6) : 1;
    ctx.drawImage(this.mwCanvas, 0, 0, W * 3, H * 3);
    ctx.restore();
  }

  // ------------------------------------------------------------------ great circles (exact circles in stereographic)
  drawGreatCircle(n, style, width = 1, dash = null) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = style; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    this.greatCirclePath(n);
    ctx.stroke();
    ctx.restore();
  }
  /** Adds the projected great circle with camera-frame normal n to the current path. */
  greatCirclePath(n) {
    const ctx = this.ctx, s = this.scale;
    if (Math.abs(n[2]) > 1e-4) {
      const R = 2 * s / Math.abs(n[2]);
      if (R < 2e5) {
        const x = this.cx + 2 * s * n[0] / n[2], y = this.cy - 2 * s * n[1] / n[2];
        ctx.moveTo(x + R, y);
        ctx.arc(x, y, R, 0, Math.PI * 2);
        return;
      }
    }
    const len = Math.hypot(n[0], n[1]) || 1, dx = -n[1] / len, dy = -n[0] / len, D = this.w + this.h;
    ctx.moveTo(this.cx - dx * D, this.cy - dy * D);
    ctx.lineTo(this.cx + dx * D, this.cy + dy * D);
  }

  /** Path of the region below the horizon (for evenodd fill). Returns false if nothing to do. */
  groundPath(up) {
    const ctx = this.ctx, s = this.scale;
    ctx.beginPath();
    if (Math.abs(up[2]) > 1e-4) {
      const R = 2 * s / Math.abs(up[2]);
      const ccx = this.cx + 2 * s * up[0] / up[2], ccy = this.cy - 2 * s * up[1] / up[2];
      if (R < 2e5) {
        if (up[2] > 0) { ctx.rect(0, 0, this.w, this.h); ctx.moveTo(ccx + R, ccy); ctx.arc(ccx, ccy, R, 0, Math.PI * 2, true); }
        else { ctx.moveTo(ccx + R, ccy); ctx.arc(ccx, ccy, R, 0, Math.PI * 2); }
        return;
      }
    }
    const len = Math.hypot(up[0], up[1]) || 1, gx = -up[0] / len, gy = up[1] / len;
    const D = this.w + this.h, px = -gy, py = gx;
    ctx.moveTo(this.cx + px * D, this.cy + py * D);
    ctx.lineTo(this.cx - px * D, this.cy - py * D);
    ctx.lineTo(this.cx - px * D + gx * D, this.cy - py * D + gy * D);
    ctx.lineTo(this.cx + px * D + gx * D, this.cy + py * D + gy * D);
    ctx.closePath();
  }

  drawGround() {
    const ctx = this.ctx;
    const up = [this.V[2], this.V[5], this.V[8]]; // zenith in camera frame
    ctx.save();
    this.groundPath(up);
    if (this.transparent) {
      // fade out everything drawn below the horizon; the WebGL ground shows through
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fill('evenodd');
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.fillStyle = this.col([12, 13, 11], 0.85);
      ctx.fill('evenodd');
    }
    // horizon: soft glow + thin line
    ctx.beginPath();
    this.greatCirclePath(up);
    ctx.strokeStyle = this.col([120, 150, 190], 0.10);
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = this.col([150, 190, 150], 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    const names = this.names.cardinal.map((nm, k) => [nm, k * 45]);
    const p = [0, 0];
    for (const [nm, az] of names) {
      if (!this.projHor(horFromAltAz(0, az), p) || !this.onScreen(p, -12)) continue;
      const major = az % 90 === 0;
      const y = p[1] + (major ? 18 : 13);
      this.label(nm, p[0], y, az === 0 ? [255, 125, 110] : [175, 215, 175], major ? 0.95 : 0.7, major ? 20 : 13, major ? 700 : 500, 'center');
      this.labelRects.push([p[0] - 14, y - 12, 28, 24]);
    }
  }

  drawAltAzGrid() {
    const ctx = this.ctx, p = [0, 0];
    ctx.save();
    ctx.strokeStyle = this.col([120, 150, 210], 0.22);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let az = 0; az < 180; az += 30) this.greatCirclePath(mulMV(this.V, horFromAltAz(0, az + 90)));
    for (let alt = 15; alt < 90; alt += 15) {
      let pen = false;
      for (let az = 0; az <= 360; az += 2) {
        if (this.projHor(horFromAltAz(alt, az), p)) { pen ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); pen = true; } else pen = false;
      }
    }
    ctx.stroke();
    ctx.restore();
    const f = [this.V[6], this.V[7], this.V[8]];
    const vaz = Math.atan2(f[0], f[1]) / DEG;
    for (let alt = 15; alt < 90; alt += 15) {
      if (this.projHor(horFromAltAz(alt, vaz), p) && this.onScreen(p)) this.label(alt + '°', p[0] + 4, p[1] - 6, [150, 175, 230], 0.6, 11);
    }
  }

  drawBounds(cons) {
    const ctx = this.ctx, p = [0, 0];
    ctx.save();
    ctx.strokeStyle = this.col([130, 130, 180], 0.22);
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (const c of cons) for (const ring of c.bvecs) {
      let pen = false;
      for (let k = 0; k <= ring.length; k++) {
        if (this.projEq(ring[k % ring.length], p)) { pen ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); pen = true; } else pen = false;
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // constellation edges are star-to-star polylines; leave a small gap at each star
  drawConstellationLines(cons, highlight, egg = null, showAll = true) {
    const ctx = this.ctx;
    const gap = Math.max(3.5, Math.min(7, 140 / this.fov));
    const pts = [];
    const pathEdge = (edge, frac = 1) => {
      pts.length = 0;
      for (const v of edge) {
        const p = [0, 0];
        if (!this.projEq(v, p)) return;
        pts.push(p);
      }
      if (pts.length < 2) return;
      // trim both ends by `gap` along the polyline
      let total = 0;
      for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (total < 2 * gap + 3) return;
      const a = pts[0], b = pts[1], la = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = pts.length, c = pts[n - 1], d = pts[n - 2], lc = Math.hypot(d[0] - c[0], d[1] - c[1]);
      const s0 = [a[0] + (b[0] - a[0]) * Math.min(0.49, gap / la), a[1] + (b[1] - a[1]) * Math.min(0.49, gap / la)];
      const s1 = [c[0] + (d[0] - c[0]) * Math.min(0.49, gap / lc), c[1] + (d[1] - c[1]) * Math.min(0.49, gap / lc)];
      ctx.moveTo(s0[0], s0[1]);
      if (frac >= 1) {
        for (let k = 1; k < n - 1; k++) ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.lineTo(s1[0], s1[1]);
        return;
      }
      // 途中まで（なぞる演出）：s0 → 途中の点 → s1 の折れ線を、長さの frac まで描く
      const path = [s0, ...pts.slice(1, n - 1), s1];
      let len = 0; for (let k = 1; k < path.length; k++) len += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
      let left = len * Math.max(0, frac);
      for (let k = 1; k < path.length && left > 0; k++) {
        const q = path[k - 1], r = path[k], l = Math.hypot(r[0] - q[0], r[1] - q[1]);
        if (l <= left) { ctx.lineTo(r[0], r[1]); left -= l; }
        else { ctx.lineTo(q[0] + (r[0] - q[0]) * left / l, q[1] + (r[1] - q[1]) * left / l); left = 0; }
      }
    };
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = this.col([110, 150, 220], 0.42);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    if (showAll) for (const c of cons) if (c.id !== highlight) for (const e of c.edges) pathEdge(e);
    ctx.stroke();
    const hc = cons.find((c) => c.id === highlight);
    if (hc) {
      if (egg && hc.id === 'Cyg') {
        // 合言葉のあと：はくちょう座の線は、いったん消しておき（待機中）、
        // 真ん中に来たら細い一本の線で、端から順になぞっていく
        if (!egg.armed) {
          const f = Math.min(1, (this.state.time - egg.t0) / 4000) * hc.edges.length;
          ctx.strokeStyle = this.col([255, 215, 140], 0.95);
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          hc.edges.forEach((e, i) => { if (i < Math.floor(f)) pathEdge(e); else if (i === Math.floor(f)) pathEdge(e, f - i); });
          ctx.stroke();
        }
      } else {
        const edges = hc.edges;
        ctx.strokeStyle = this.col([255, 205, 125], 0.32);
        ctx.lineWidth = 4;
        ctx.beginPath(); for (const e of edges) pathEdge(e); ctx.stroke();
        ctx.strokeStyle = this.col([255, 215, 140], 0.9);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawAsterism(a) {
    const ctx = this.ctx, p = [0, 0];
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const e of a.edges) {
      let pen = false;
      for (const v of e) { if (this.projEq(v, p)) { pen ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); pen = true; } else pen = false; }
    }
    if (a.guide) ctx.setLineDash([6, 6]);
    ctx.strokeStyle = this.col([120, 235, 220], 0.22); ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = this.col([140, 245, 230], 0.9); ctx.lineWidth = 1.6; ctx.stroke();
    ctx.restore();
    if (a.guide) { // mark the end point (pole)
      const last = a.pts[a.pts.length - 1];
      if (this.projEq(last, p) && this.onScreen(p)) {
        ctx.save(); ctx.strokeStyle = this.col([140, 245, 230], 0.9); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.moveTo(p[0] - 11, p[1]); ctx.lineTo(p[0] + 11, p[1]); ctx.moveTo(p[0], p[1] - 11); ctx.lineTo(p[0], p[1] + 11); ctx.stroke(); ctx.restore();
      }
    }
    if (this.projEq(a.center, p) && this.onScreen(p, -30)) {
      const nm = this.names.ast(a);
      this.label(nm, p[0], p[1], [150, 245, 230], 0.95, 14, 700, 'center');
      this.ctx.font = `700 ${14 * this.labelScale}px ${FONT}`;
      const w = this.ctx.measureText(nm).width;
      this.labelRects.push([p[0] - w / 2 - 3, p[1] - 10, w + 6, 20]);
    }
  }

  drawConstellationNames(cons, highlight, onlyHighlight = false) {
    const p = [0, 0], fov = this.fov;
    const maxRank = fov > 80 ? 1 : fov > 50 ? 2 : 3;
    for (const c of cons) {
      const hl = c.id === highlight;
      if (onlyHighlight !== hl) continue;
      if (c.rank > maxRank && !hl) continue;
      if (!this.projEq(c.center, p) || !this.onScreen(p, -20)) continue;
      const size = hl ? 16 : 13;
      const nm = this.names.con(c);
      if (this.placeLabel(p[0], p[1], nm, size, 'center'))
        this.label(nm, p[0], p[1], hl ? [255, 212, 135] : [135, 168, 235], hl ? 0.95 : 0.72, size, hl ? 700 : 500, 'center');
    }
  }

  // ------------------------------------------------------------------ stars
  drawStars(S, names, st) {
    const ctx = this.ctx, C = this.C, zc = this.zCull, fov = this.fov, W = this.w, H = this.h;
    // ref: zoom-dependent magnitude used for star size and brightness (unchanged by the sky setting)
    const ref = fov >= 100 ? 5.3 : fov >= 70 ? 5.8 : fov >= 45 ? 6.2 : 6.5;
    // lim: faintest star drawn — the sky setting at the default view, a little more when zoomed in, less when wide
    const lim = (st.skyLim ?? 5.8) + (ref - 5.8);
    const zoom = Math.min(1.7, Math.max(0.8, Math.pow(60 / fov, 0.4)));
    const nameLim = fov >= 100 ? 0.9 : fov >= 70 ? 1.4 : fov >= 45 ? 2.1 : fov >= 30 ? 3.0 : 4.2;
    const sprites = this.night ? this.sprites.night : this.sprites.day;
    const vis = this.skyVis;
    // zenith in EQ for twinkle (stronger near the horizon)
    const M = this.M, zx = M[6], zy = M[7], zz = M[8];
    const twinkle = st.twinkle && !this.reducedMotion;
    const t = st.time / 1000;
    const faint = [];
    const bright = [];
    const labels = [];
    const sc = 2 * this.scale;
    for (let i = 0; i < S.n; i++) {
      const m = S.mag[i];
      if (m > lim) break; // sorted by magnitude
      const x = S.x[i], y = S.y[i], z = S.z[i];
      const cz = C[6] * x + C[7] * y + C[8] * z;
      if (cz < zc) continue;
      const k = sc / (1 + cz);
      const px = this.cx + k * (C[0] * x + C[1] * y + C[2] * z);
      const py = this.cy - k * (C[3] * x + C[4] * y + C[5] * z);
      if (px < -30 || py < -30 || px > W + 30 || py > H + 30) continue;
      const b = bvBucket(S.bv[i]);
      // PSF size from flux: ~ (relative flux)^0.33, with a boost for the brightest
      const flux = Math.pow(10, -0.4 * (m - ref));
      let r = (0.55 + 0.5 * Math.pow(flux, 0.3)) * zoom;
      if (m < 1) r *= 1.12;
      let a = Math.min(1, 0.35 + 0.18 * (ref - m)) * vis;
      a *= Math.min(1, 0.45 + 1.1 * (lim - m)); // fade in the last half magnitude
      if (twinkle && m < 3) {
        const sAlt = zx * x + zy * y + zz * z;
        const amp = 0.06 + 0.22 * Math.max(0, 1 - sAlt * 2.5);
        a *= 1 - amp * (0.5 + 0.5 * Math.sin(t * (5 + (i % 7)) + i * 1.7) * Math.sin(t * (3.1 + (i % 5) * 0.7) + i));
      }
      if (m < 4.2) bright.push(px, py, r, a, b, m);
      else faint.push(px, py, r, a, b);
      this.picks.push({ x: px, y: py, r: Math.max(r * 2, 5), kind: 'star', idx: i, mag: m });
      const inf = S.info[i];
      if (names && inf && inf.en && (m < nameLim || (inf.ja && m < nameLim + 0.5))) labels.push(px, py, r, i);
    }
    // faint stars: batched by colour, tiny antialiased discs
    const groups = [];
    for (let j = 0; j < faint.length; j += 5) { const g = faint[j + 4]; (groups[g] || (groups[g] = [])).push(j); }
    for (let g = 0; g < groups.length; g++) {
      if (!groups[g]) continue;
      ctx.fillStyle = this.col(FAINT_RGB[g], 0.8 * vis);
      ctx.beginPath();
      for (const j of groups[g]) { const r = Math.max(0.45, faint[j + 2] * 0.9); ctx.moveTo(faint[j] + r, faint[j + 1]); ctx.arc(faint[j], faint[j + 1], r, 0, Math.PI * 2); }
      ctx.fill();
    }
    // bright stars: halo (additive) + sharp core sprite
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let j = 0; j < bright.length; j += 6) {
      const m = bright[j + 5];
      if (m > 2.6) continue;
      const R = bright[j + 2] * (5 + 2.2 * (2.6 - m));
      ctx.globalAlpha = Math.min(1, 0.35 + 0.22 * (2.6 - m)) * bright[j + 3];
      ctx.drawImage(sprites[bright[j + 4]].halo, bright[j] - R, bright[j + 1] - R, 2 * R, 2 * R);
    }
    ctx.restore();
    ctx.save();
    for (let j = 0; j < bright.length; j += 6) {
      const R = bright[j + 2] * 2.4;
      ctx.globalAlpha = bright[j + 3];
      ctx.drawImage(sprites[bright[j + 4]].core, bright[j] - R, bright[j + 1] - R, 2 * R, 2 * R);
    }
    ctx.restore();
    if (st.albireoIdx >= 0 && st.highlightCon === 'Cyg') this.drawAlbireo(S, st.albireoIdx, st.egg && !st.egg.armed ? st.egg : null);
    for (let j = 0; j < labels.length; j += 4) {
      const i = labels[j + 3];
      if (i === st.albireoIdx && st.highlightCon === 'Cyg' && fov <= 50) continue;
      const inf = S.info[i];
      const txt = this.names.star(i);
      if (!txt) continue;
      const x = labels[j] + labels[j + 2] * 1.6 + 5, y = labels[j + 1];
      if (!this.placeLabel(x, y, txt, 12.5)) continue;
      this.label(txt, x, y, i === st.albireoIdx ? [255, 212, 135] : [220, 228, 242], 0.88 * Math.max(0.6, this.skyVis));
    }
  }

  drawAlbireo(S, i, egg = null) {
    const ctx = this.ctx, p = [0, 0];
    if (!this.projEq([S.x[i], S.y[i], S.z[i]], p) || !this.onScreen(p)) return;
    const sp = this.night ? this.sprites.night : this.sprites.day;
    if (this.fov > 50 && !egg) {
      ctx.save();
      ctx.beginPath(); ctx.arc(p[0], p[1], 4.2, 0, Math.PI * 2);
      ctx.lineWidth = 1; ctx.strokeStyle = this.col([120, 165, 255], 0.75); ctx.stroke();
      ctx.restore();
      if (this.placeLabel(p[0] + 8, p[1], this.names.albireo, 12)) this.label(this.names.albireo, p[0] + 8, p[1], [255, 212, 135], 0.9, 12);
      return;
    }
    // zoomed in: gold primary and blue companion (separation exaggerated), companion at PA ≈ 54°
    const north = [0, 0];
    this.projEq(normalize([S.x[i], S.y[i], S.z[i] + 0.002]), north);
    let nx = north[0] - p[0], ny = north[1] - p[1];
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const ex = ny, ey = -nx; // east is 90° from north (sky seen from inside)
    const pa = 54 * DEG, sep = Math.max(egg ? 7 : 10, 13 * (50 / this.fov));
    const bx = p[0] + sep * (Math.cos(pa) * nx + Math.sin(pa) * ex), by = p[1] + sep * (Math.cos(pa) * ny + Math.sin(pa) * ey);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gsz = egg ? 1.6 + (this.reducedMotion ? 0 : 0.25 * Math.sin(this.state.time / 700)) : 1;
    ctx.drawImage(sp[6].halo, p[0] - 22 * gsz, p[1] - 22 * gsz, 44 * gsz, 44 * gsz);
    ctx.drawImage(sp[0].halo, bx - 15 * gsz, by - 15 * gsz, 30 * gsz, 30 * gsz);
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.arc(p[0], p[1], 3.4, 0, Math.PI * 2); ctx.fillStyle = this.col([255, 196, 92]); ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, 2.9, 0, Math.PI * 2); ctx.fillStyle = this.col([120, 168, 255]); ctx.fill();
    // くちばしの星から、白い細い輪が一度だけ広がる（十字をなぞり終えた直後）
    if (egg && !egg.armed) {
      const dt = this.state.time - egg.t0;
      if (dt > 4100 && dt < 4570) {
        // 輪の大きさは、案内の緑の円（半径約28px）の半分ほどまで。小さい分、白くはっきり。約0.5秒で消える
        const k = (dt - 4100) / 470, e = 1 - Math.pow(1 - k, 3);
        const a = 1 - k * k;
        ctx.strokeStyle = this.col([255, 255, 255], 0.98 * a);
        ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.arc(p[0], p[1], 4 + 11 * e, 0, Math.PI * 2); ctx.stroke();
        if (k < 0.25) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, Math.PI * 2); ctx.fillStyle = this.col([255, 255, 255], 1 - k / 0.25); ctx.fill(); }
      }
    }
    ctx.restore();
    const lx = Math.max(p[0], bx) + 12;
    this.label(this.names.albireo, lx, p[1] - 8, [255, 212, 135], 0.95, 13, 700);
    this.label(this.names.albireoNote, lx, p[1] + 9, [190, 210, 255], 0.9, 11.5);
    this.labelRects.push([lx - 2, p[1] - 18, 96, 36]);
  }

  // ------------------------------------------------------------------ deep sky
  drawMessier(list) {
    const ctx = this.ctx, p = [0, 0], fov = this.fov;
    const showAll = fov <= 40;
    ctx.save();
    ctx.lineWidth = 1;
    for (const m of list) {
      const famous = !!m.ja || m.kind === 'dso';
      if (!showAll && !(famous && m.mag < (fov > 80 ? 5 : 7.5))) continue;
      if (!this.projEq(m.v, p) || !this.onScreen(p)) continue;
      const r = 4.5;
      ctx.strokeStyle = this.col([150, 222, 195], 0.7);
      ctx.beginPath();
      if (m.t === 'dn') { ctx.setLineDash([1.5, 2.5]); ctx.ellipse(p[0], p[1], r * 1.6, r * 1.2, 0, 0, Math.PI * 2); }
      else if (m.t === 's' || m.t === 'e' || m.t === 'i') ctx.ellipse(p[0], p[1], r * 1.5, r * 0.7, -0.5, 0, Math.PI * 2);
      else if (m.t === 'gc') { ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.moveTo(p[0] - r, p[1]); ctx.lineTo(p[0] + r, p[1]); ctx.moveTo(p[0], p[1] - r); ctx.lineTo(p[0], p[1] + r); }
      else if (m.t === 'oc' || m.t === 'pos') { ctx.setLineDash([2, 2]); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); }
      else ctx.rect(p[0] - r, p[1] - r, 2 * r, 2 * r);
      ctx.stroke();
      ctx.setLineDash([]);
      this.picks.push({ x: p[0], y: p[1], r: 9, kind: m.kind, obj: m, mag: Math.min(m.mag, 12) + 2 });
      const t = this.names.dso(m, famous && fov <= 60);
      if (this.placeLabel(p[0] + 9, p[1], t, 11)) this.label(t, p[0] + 9, p[1], [150, 222, 195], 0.8, 11);
    }
    ctx.restore();
  }

  drawShowers(list, date, status) {
    const ctx = this.ctx, p = [0, 0];
    for (const sh of list) {
      const stt = status(sh, date);
      if (!stt.active && this.fov > 40) continue;
      if (!this.projEq(sh.v, p) || !this.onScreen(p)) continue;
      const a = stt.active ? 0.95 : 0.45;
      ctx.save();
      ctx.strokeStyle = this.col([255, 150, 210], a);
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const ang = k * Math.PI / 4 + 0.2;
        ctx.moveTo(p[0] + Math.cos(ang) * 4, p[1] + Math.sin(ang) * 4);
        ctx.lineTo(p[0] + Math.cos(ang) * (k % 2 ? 8 : 11), p[1] + Math.sin(ang) * (k % 2 ? 8 : 11));
      }
      ctx.stroke();
      ctx.restore();
      this.picks.push({ x: p[0], y: p[1], r: 12, kind: 'shower', obj: sh, mag: 3 });
      const t = this.names.shower(sh) + (stt.active && Math.abs(stt.daysToPeak) <= 2 ? this.names.peakTag : '');
      if (this.placeLabel(p[0] + 14, p[1], t, 12)) this.label(t, p[0] + 14, p[1], [255, 175, 222], a, 12);
    }
  }

  // ------------------------------------------------------------------ Sun, Moon, planets
  drawSolarSystem(bodies, st) {
    const ctx = this.ctx, p = [0, 0];
    const pxPerRad = this.scale; // at the centre of a stereographic projection
    for (const b of bodies) {
      if (!st.layers.sunmoon && (b.key === 'sun' || b.key === 'moon')) continue;
      if (!this.projEq(b.v, p) || !this.onScreen(p, 40)) continue;
      const rgb = PLANET_COLOR[b.key];
      let r;
      if (b.key === 'sun' || b.key === 'moon') {
        const trueR = (b.key === 'sun' ? 0.2666 : 0.2725 * 384400 / b.dist) * DEG * pxPerRad;
        r = Math.max(b.key === "moon" ? 12 : 9, trueR);
        if (b.key === 'sun') {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(p[0], p[1], r * 0.9, p[0], p[1], r * 5);
          g.addColorStop(0, this.col(rgb, 0.55)); g.addColorStop(0.3, this.col(rgb, 0.15)); g.addColorStop(1, this.col(rgb, 0));
          ctx.fillStyle = g; ctx.fillRect(p[0] - r * 5, p[1] - r * 5, r * 10, r * 10);
          ctx.restore();
          const g2 = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
          g2.addColorStop(0, this.col([255, 252, 235])); g2.addColorStop(0.8, this.col([255, 236, 175])); g2.addColorStop(1, this.col([255, 210, 130]));
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fillStyle = g2; ctx.fill();
        } else this.drawMoon(p, r, b, st);
      } else {
        r = Math.max(2.4, Math.min(6.5, 3.9 - b.mag * 0.65));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const R = r * 3.4;
        const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], R);
        g.addColorStop(0, this.col(rgb, 0.5)); g.addColorStop(0.35, this.col(rgb, 0.12)); g.addColorStop(1, this.col(rgb, 0));
        ctx.fillStyle = g; ctx.fillRect(p[0] - R, p[1] - R, 2 * R, 2 * R);
        ctx.restore();
        // disc with a little limb shading
        const g2 = ctx.createRadialGradient(p[0] - r * 0.3, p[1] - r * 0.3, 0, p[0], p[1], r);
        g2.addColorStop(0, this.col(rgb.map((c) => Math.min(255, c + 25))));
        g2.addColorStop(1, this.col(rgb.map((c) => Math.round(c * 0.72))));
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fillStyle = g2; ctx.fill();
        if (b.key === 'jupiter' && this.fov < 45) {
          ctx.save(); ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.clip();
          ctx.fillStyle = this.col([170, 130, 95], 0.45);
          ctx.fillRect(p[0] - r, p[1] - r * 0.38, 2 * r, r * 0.22); ctx.fillRect(p[0] - r, p[1] + r * 0.18, 2 * r, r * 0.2);
          ctx.restore();
        }
        if (b.key === 'saturn' && this.fov < 45) {
          ctx.save();
          ctx.beginPath(); ctx.ellipse(p[0], p[1], r * 2.2, r * 0.42, -0.4, 0, Math.PI * 2);
          ctx.strokeStyle = this.col([230, 210, 160], 0.75); ctx.lineWidth = 1.1; ctx.stroke();
          ctx.restore();
        }
      }
      this.picks.push({ x: p[0], y: p[1], r: Math.max(r, 12), kind: 'body', obj: b, mag: -30 });
      const x = p[0] + r + 6;
      const nm = this.names.body(b.key);
      this.label(nm, x, p[1], rgb, 0.95, 13, 700);
      ctx.font = `700 ${13 * this.labelScale}px ${FONT}`;
      this.labelRects.push([x - 2, p[1] - 9, ctx.measureText(nm).width + 6, 18 * this.labelScale]);
    }
  }

  /** Moon with a smoothly shaded terminator, maria and earthshine; cached image rotated per frame. */
  drawMoon(p, r, b, st) {
    const ctx = this.ctx;
    const sunB = st.bodies.find((x) => x.key === 'sun');
    // screen angle toward the Sun (bright limb) and toward celestial north
    const dirTo = (v2) => {
      const t = 0.003;
      const v = normalize([b.v[0] + (v2[0] - b.v[0]) * t, b.v[1] + (v2[1] - b.v[1]) * t, b.v[2] + (v2[2] - b.v[2]) * t]);
      const c = mulMV(this.C, v);
      const k = 2 * this.scale / (1 + c[2]);
      return Math.atan2(this.cy - k * c[1] - p[1], this.cx + k * c[0] - p[0]);
    };
    const angSun = sunB ? dirTo(sunB.v) : 0;
    const angN = dirTo([0, 0, 1]);
    const dpr = this.dpr;
    const R = Math.round(r * dpr);
    const phase = b.phase ?? 90;            // phase angle (0 = full)
    const rel = angN - angSun;              // north relative to the sun direction
    const darkA = this.skyVis >= 1 ? 0.92 : 0.12 + 0.8 * (this.skyVis - 0.4) / 0.6;
    const key = `${R}|${Math.round(phase)}|${Math.round(rel * 30)}|${this.night}|${darkA.toFixed(1)}`;
    if (!this.moonCache || this.moonCache.key !== key) this.moonCache = { key, img: this.renderMoonImage(R, phase, rel, darkA) };
    ctx.save();
    // soft glow
    ctx.globalCompositeOperation = 'lighter';
    const gl = ctx.createRadialGradient(p[0], p[1], r * 0.8, p[0], p[1], r * 3.2);
    const lum = 0.25 * b.illum;
    gl.addColorStop(0, this.col([235, 235, 220], lum)); gl.addColorStop(1, this.col([235, 235, 220], 0));
    ctx.fillStyle = gl; ctx.fillRect(p[0] - r * 3.2, p[1] - r * 3.2, r * 6.4, r * 6.4);
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(p[0], p[1]);
    ctx.rotate(angSun);
    const S = this.moonCache.img.width / dpr;
    ctx.drawImage(this.moonCache.img, -S / 2, -S / 2, S, S);
    ctx.restore();
  }

  renderMoonImage(R, phaseDeg, rel, darkA = 0.9) {
    const size = 2 * R + 2;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const i0 = phaseDeg * DEG;
    const sx = Math.sin(i0), sz = Math.cos(i0); // sun direction in (x toward sun, y, z toward viewer)
    // moon-north axis in this frame (screen y down → use -sin)
    const nX = Math.cos(rel), nY = -Math.sin(rel);
    const maria = MARIA.map(([la, lo, rr]) => {
      const L = la * DEG, O = lo * DEG;
      return [Math.cos(L) * Math.sin(O), Math.sin(L), Math.cos(L) * Math.cos(O), Math.cos(rr * DEG)];
    });
    const night = this.night;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const X = (x + 0.5 - size / 2) / R, Y = (y + 0.5 - size / 2) / R;
        const d2 = X * X + Y * Y;
        if (d2 > 1.0) continue;
        const Z = Math.sqrt(1 - d2);
        // edge antialias
        const edge = Math.min(1, (1 - Math.sqrt(d2)) * R + 0.5);
        // selenographic: express normal in a frame with moon-north up (east = right when north up, from viewer)
        const up = -(X * nX + Y * nY) * -1; // component along north
        const nUp = X * nX + Y * nY;         // north component (screen)
        const nRight = X * (-nY) + Y * nX;   // perpendicular
        // maria albedo
        let alb = 1;
        for (const m of maria) {
          const dd = nRight * m[0] * -1 + -nUp * m[1] * -1 + Z * m[2];
          if (dd > m[3]) alb -= 0.28 * Math.min(1, (dd - m[3]) / (1 - m[3]) * 4);
        }
        alb = Math.max(0.55, alb);
        const lam = X * sx + Z * sz;
        const lit = Math.max(0, Math.min(1, lam * 6 + 0.15)) * (0.65 + 0.35 * Math.max(0, lam));
        const limb = 0.82 + 0.18 * Z;
        let v = (lit * alb * limb) + 0.045 * (1 - lit);   // earthshine on the dark side
        v = Math.min(1, v);
        const o = (y * size + x) * 4;
        if (night) { img.data[o] = 255 * v; img.data[o + 1] = 0; img.data[o + 2] = 0; }
        else { img.data[o] = 248 * v; img.data[o + 1] = 244 * v; img.data[o + 2] = 228 * v; }
        img.data[o + 3] = 255 * edge * Math.min(1, lit * 1.5 + darkA * (1 - Math.min(1, lit * 1.5)));
        void up;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  drawSelection(sel) {
    const ctx = this.ctx, p = [0, 0];
    if (!this.projEq(sel.v, p) || !this.onScreen(p)) return;
    ctx.save();
    ctx.strokeStyle = this.col([255, 255, 255], 0.75);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const R = 15, gap = 0.35;
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + gap; ctx.moveTo(p[0] + R * Math.cos(a), p[1] + R * Math.sin(a)); ctx.arc(p[0], p[1], R, a, a + Math.PI / 2 - 2 * gap); }
    ctx.stroke();
    ctx.restore();
  }

  /** Target guidance: circle when visible, edge arrow otherwise. Returns info for the UI. */
  drawTarget(t, time) {
    const ctx = this.ctx, c = mulMV(this.C, t.v), p = [0, 0];
    const visible = this.projCam(c, p) && this.onScreen(p, -30);
    const dist = Math.acos(Math.max(-1, Math.min(1, c[2]))) / DEG;
    const centered = dist < Math.max(2.5, this.fov * 0.06);
    const pulse = this.reducedMotion ? 0.7 : 0.5 + 0.5 * Math.sin(time / 250);
    const rgb = centered ? [120, 255, 165] : [255, 215, 120];
    ctx.save();
    if (visible) {
      const R = centered ? 26 + 6 * pulse : 30;
      ctx.strokeStyle = this.col(rgb, 0.25); ctx.lineWidth = 7;
      ctx.beginPath(); ctx.arc(p[0], p[1], R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = this.col(rgb, 0.95); ctx.lineWidth = centered ? 2.5 : 1.8;
      ctx.stroke();
      if (!centered) {
        ctx.setLineDash([4, 6]); ctx.lineWidth = 1.2; ctx.strokeStyle = this.col(rgb, 0.6);
        const dx = p[0] - this.cx, dy = p[1] - this.cy, l = Math.hypot(dx, dy);
        if (l > R + 16) { ctx.beginPath(); ctx.moveTo(this.cx + dx / l * 14, this.cy + dy / l * 14); ctx.lineTo(p[0] - dx / l * R, p[1] - dy / l * R); ctx.stroke(); }
      }
    } else {
      let dx = c[0], dy = -c[1];
      if (Math.hypot(dx, dy) < 1e-6) { dx = 0; dy = 1; }
      const l = Math.hypot(dx, dy); dx /= l; dy /= l;
      const mx = 46, myTop = 130, myBot = 130;
      const kx = (this.w / 2 - mx) / Math.abs(dx || 1e-9);
      const ky = dy < 0 ? (this.h / 2 - myTop) / Math.abs(dy || 1e-9) : (this.h / 2 - myBot) / Math.abs(dy || 1e-9);
      const k = Math.min(kx, ky);
      ctx.translate(this.cx + dx * k, this.cy + dy * k);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.beginPath();
      ctx.moveTo(24, 0); ctx.lineTo(-10, -16); ctx.lineTo(-3, 0); ctx.lineTo(-10, 16); ctx.closePath();
      ctx.fillStyle = this.col(rgb, 0.65 + 0.3 * pulse); ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
    }
    ctx.restore();
    if (!centered) {
      ctx.save();
      ctx.strokeStyle = this.col([255, 255, 255], 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b2, c2, d] of [[-12, 0, -4, 0], [4, 0, 12, 0], [0, -12, 0, -4], [0, 4, 0, 12]]) { ctx.moveTo(this.cx + a, this.cy + b2); ctx.lineTo(this.cx + c2, this.cy + d); }
      ctx.stroke();
      ctx.restore();
    }
    return { visible, centered, dist, x: p[0], y: p[1] };
  }

  /** Nearest pickable object to a point. */
  pick(x, y, slop = 18) {
    let best = null, bestScore = Infinity;
    for (const o of this.picks) {
      const d = Math.hypot(o.x - x, o.y - y);
      if (d > o.r + slop) continue;
      const score = d + o.mag * 3;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    return best;
  }
}
