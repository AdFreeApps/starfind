// astro.js — pure astronomy functions (no DOM). Angles in degrees unless noted.
// Frames:
//   EQ  : equatorial J2000 unit vectors  (x→RA 0h, z→north celestial pole)
//   HOR : local horizontal, x = East, y = North, z = Up.  Azimuth from North toward East.
// Accuracy target ~0.1–0.5°: IAU1976 precession, no nutation/aberration, TT≈UT.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
const AU_KM = 149597870.7;

export const norm360 = (x) => ((x % 360) + 360) % 360;
export const norm180 = (x) => { x = norm360(x); return x > 180 ? x - 360 : x; };

export function julianDay(date) { return date.getTime() / 86400000 + 2440587.5; }
export function centuries(jd) { return (jd - 2451545.0) / 36525; }

/** Greenwich mean sidereal time, degrees. */
export function gmst(jd) {
  const T = centuries(jd);
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000);
}
/** Local mean sidereal time, degrees (lon east positive). */
export function lst(jd, lonDeg) { return norm360(gmst(jd) + lonDeg); }

// ---------------------------------------------------------------- vectors / matrices (row-major 3x3)
export function vecFromRaDec(raDeg, decDeg) {
  const a = raDeg * DEG, d = decDeg * DEG, c = Math.cos(d);
  return [c * Math.cos(a), c * Math.sin(a), Math.sin(d)];
}
export function raDecFromVec(v) {
  const r = Math.hypot(v[0], v[1], v[2]);
  return { ra: norm360(Math.atan2(v[1], v[0]) * RAD), dec: Math.asin(v[2] / r) * RAD };
}
export function mulMV(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
          m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
          m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
export function mulMM(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
export function transpose(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
// frame rotations (rotate the coordinate axes by angle a, radians)
function R1(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; }
function R2(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; }
function R3(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; }
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function normalize(v) { const r = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / r, v[1] / r, v[2] / r]; }
export function angleBetween(a, b) { return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) * RAD; }

/** Precession matrix J2000 → mean equator/equinox of date (IAU 1976). */
export function precessionMatrix(jd) {
  const T = centuries(jd), as = DEG / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * as;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * as;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * as;
  return mulMM(R3(-z), mulMM(R2(theta), R3(-zeta)));
}

/** Matrix taking EQ(J2000) vectors to HOR (East, North, Up). */
export function eqToHorMatrix(jd, latDeg, lonDeg) {
  const phi = latDeg * DEG, L = lst(jd, lonDeg) * DEG;
  const sp = Math.sin(phi), cp = Math.cos(phi);
  // after R3(L): x' = toward meridian on equator, y' = East, z' = NCP
  const H = [0, 1, 0, -sp, 0, cp, cp, 0, sp];
  return mulMM(H, mulMM(R3(L), precessionMatrix(jd)));
}

export function altAzFromHor(v) {
  return { alt: Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD, az: norm360(Math.atan2(v[0], v[1]) * RAD) };
}
export function horFromAltAz(altDeg, azDeg) {
  const h = altDeg * DEG, A = azDeg * DEG, c = Math.cos(h);
  return [c * Math.sin(A), c * Math.cos(A), Math.sin(h)];
}

const EPS0 = 23.43928 * DEG; // J2000 obliquity
export function eclToEq(v) {
  const c = Math.cos(EPS0), s = Math.sin(EPS0);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
export function eqToEcl(v) {
  const c = Math.cos(EPS0), s = Math.sin(EPS0);
  return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
}
/** J2000 north ecliptic pole as EQ vector. */
export const ECLIPTIC_POLE = eclToEq([0, 0, 1]);
export const CELESTIAL_POLE = [0, 0, 1];

// ---------------------------------------------------------------- planets (JPL approximate elements, 1800–2050)
// a [au], e, I, L, long.peri, long.node  and rates per Julian century. J2000 ecliptic/equinox.
const ELEMENTS = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
            0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus:   [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
            0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  earth:   [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
            0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  mars:    [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
            0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
            -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn:  [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
            -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus:  [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503,
            -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
            0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
};
export const PLANET_KEYS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/** Heliocentric ecliptic J2000 position [au]. */
export function heliocentric(key, jd) {
  const el = ELEMENTS[key], T = centuries(jd);
  const a = el[0] + el[6] * T, e = el[1] + el[7] * T, I = (el[2] + el[8] * T) * DEG;
  const L = el[3] + el[9] * T, wb = el[4] + el[10] * T, Om = el[5] + el[11] * T;
  const w = (wb - Om) * DEG, O = Om * DEG;
  const M = norm180(L - wb) * DEG;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return [(cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
          (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
          (sw * sI) * xp + (cw * sI) * yp];
}

const MAG = {
  mercury: (r, d, i) => -0.42 + 5 * Math.log10(r * d) + 0.0380 * i - 0.000273 * i * i + 0.000002 * i * i * i,
  venus: (r, d, i) => -4.40 + 5 * Math.log10(r * d) + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i,
  mars: (r, d, i) => -1.52 + 5 * Math.log10(r * d) + 0.016 * i,
  jupiter: (r, d, i) => -9.40 + 5 * Math.log10(r * d) + 0.005 * i,
  saturn: (r, d) => -8.88 + 5 * Math.log10(r * d),
  uranus: (r, d) => -7.19 + 5 * Math.log10(r * d),
  neptune: (r, d) => -6.87 + 5 * Math.log10(r * d),
};

/** Geocentric planet: EQ J2000 unit vector, distance [au], magnitude, phase angle. One light-time iteration. */
export function planet(key, jd) {
  const earth = heliocentric('earth', jd);
  let p = heliocentric(key, jd);
  let g = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
  const lt = Math.hypot(...g) * 0.0057755183; // days per au
  p = heliocentric(key, jd - lt);
  g = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
  const d = Math.hypot(...g), r = Math.hypot(...p);
  const cosi = (r * r + d * d - dot(earth, earth)) / (2 * r * d);
  const i = Math.acos(Math.max(-1, Math.min(1, cosi))) * RAD;
  return { v: normalize(eclToEq(g)), dist: d, mag: MAG[key](r, d, i), phase: i };
}

/** Geocentric Sun: EQ J2000 unit vector, distance [au]. */
export function sun(jd) {
  const e = heliocentric('earth', jd);
  const g = [-e[0], -e[1], -e[2]];
  return { v: normalize(eclToEq(g)), dist: Math.hypot(...g), mag: -26.7 };
}

/**
 * Moon, low precision (Astronomical Almanac, ~0.3°), topocentric when lat/lon given.
 * Returns EQ J2000 unit vector, distance [km], illuminated fraction, age [days], waxing flag.
 */
export function moon(jd, latDeg, lonDeg) {
  const T = centuries(jd), s = (x) => Math.sin(x * DEG), c = (x) => Math.cos(x * DEG);
  const lam = 218.32 + 481267.881 * T + 6.29 * s(135.0 + 477198.87 * T) - 1.27 * s(259.3 - 413335.36 * T)
    + 0.66 * s(235.7 + 890534.22 * T) + 0.21 * s(269.9 + 954397.74 * T) - 0.19 * s(357.5 + 35999.05 * T)
    - 0.11 * s(186.5 + 966404.03 * T);
  const bet = 5.13 * s(93.3 + 483202.02 * T) + 0.28 * s(228.2 + 960400.89 * T) - 0.28 * s(318.3 + 6003.15 * T)
    - 0.17 * s(217.6 - 407332.21 * T);
  const par = 0.9508 + 0.0518 * c(135.0 + 477198.87 * T) + 0.0095 * c(259.3 - 413335.36 * T)
    + 0.0078 * c(235.7 + 890534.22 * T) + 0.0028 * c(269.9 + 954397.74 * T);
  const rER = 1 / Math.sin(par * DEG); // distance in Earth radii
  const eps = (23.439 - 0.0130 * T) * DEG;
  const l = [Math.cos(bet * DEG) * Math.cos(lam * DEG), Math.cos(bet * DEG) * Math.sin(lam * DEG), Math.sin(bet * DEG)];
  // ecliptic of date → equator of date
  let q = [l[0] * rER, (Math.cos(eps) * l[1] - Math.sin(eps) * l[2]) * rER, (Math.sin(eps) * l[1] + Math.cos(eps) * l[2]) * rER];
  if (latDeg !== undefined) {
    const L = lst(jd, lonDeg) * DEG, ph = latDeg * DEG;
    q = [q[0] - Math.cos(ph) * Math.cos(L), q[1] - Math.cos(ph) * Math.sin(L), q[2] - Math.sin(ph)];
  }
  const dist = Math.hypot(...q) * 6378.14;
  const v = normalize(mulMV(transpose(precessionMatrix(jd)), q)); // of date → J2000
  const S = sun(jd);
  const elong = angleBetween(S.v, v);
  const sunKm = S.dist * AU_KM;
  const iang = Math.atan2(sunKm * Math.sin(elong * DEG), dist - sunKm * Math.cos(elong * DEG));
  const illum = (1 + Math.cos(iang)) / 2;
  const le = eqToEcl(v), se = eqToEcl(S.v);
  const dlon = norm360(Math.atan2(le[1], le[0]) * RAD - Math.atan2(se[1], se[0]) * RAD);
  const ideg = iang * RAD;
  const mag = -12.73 + 0.026 * ideg + 4e-9 * ideg ** 4;
  return { v, dist, illum, age: dlon / 360 * 29.530589, waxing: dlon < 180, elong, phase: ideg, mag };
}

/** Altitude [deg] of an EQ vector at jd. */
export function altitudeOf(vEq, jd, lat, lon) {
  return altAzFromHor(mulMV(eqToHorMatrix(jd, lat, lon), vEq)).alt;
}

/**
 * Next rise and set within the next 24 h (search from jd).
 * vecAt(jd) → EQ vector. h0: altitude threshold (deg).
 * Returns {rise, set, always, never} with rise/set as Date or null.
 */
export function riseSet(vecAt, jd, lat, lon, h0 = -0.5667) {
  const step = 10 / 1440, n = 145;
  let prev = altitudeOf(vecAt(jd), jd, lat, lon) - h0;
  let rise = null, set = null, minA = prev, maxA = prev;
  for (let k = 1; k < n; k++) {
    const t = jd + k * step;
    const a = altitudeOf(vecAt(t), t, lat, lon) - h0;
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    if (prev < 0 && a >= 0 && !rise) rise = t - step * a / (a - prev);
    if (prev >= 0 && a < 0 && !set) set = t - step * a / (a - prev);
    prev = a;
  }
  const toDate = (j) => (j ? new Date((j - 2440587.5) * 86400000) : null);
  return { rise: toDate(rise), set: toDate(set), always: minA > 0, never: maxA < 0 };
}

// ---------------------------------------------------------------- spherical point-in-polygon (constellation lookup)
function winding(p, ring) {
  // local tangent frame at p, project vertices stereographically from -p, sum the winding angle
  const up = Math.abs(p[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e = normalize(cross(up, p)), n = cross(p, e);
  let total = 0, prevAng = null;
  for (let i = 0; i <= ring.length; i++) {
    const q = ring[i % ring.length];
    const v = vecFromRaDec(q[0], q[1]);
    const z = dot(v, p);
    const ang = Math.atan2(dot(v, n) / (1 + z), dot(v, e) / (1 + z));
    if (prevAng !== null) {
      let d = ang - prevAng;
      if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
      total += d;
    }
    prevAng = ang;
  }
  return Math.abs(total) > Math.PI;
}
/** True if EQ vector p lies inside the ring of [ra,dec] points (ring smaller than a hemisphere). */
export function insideRing(p, ring) {
  // winding != 0 means p and -p are on different sides of the ring; the side holding the
  // ring's mean vertex direction is the (small) interior.
  if (!winding(p, ring)) return false;
  let c = [0, 0, 0];
  for (const q of ring) { const v = vecFromRaDec(q[0], q[1]); c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  return dot(c, p) > 0;
}

/** Format helpers */
export function formatRA(ra) {
  const h = norm360(ra) / 15, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `${hh}h${String(mm).padStart(2, '0')}m`;
}
export function formatDec(dec) {
  const s = dec < 0 ? '−' : '+', a = Math.abs(dec), d = Math.floor(a), m = Math.floor((a - d) * 60);
  return `${s}${d}°${String(m).padStart(2, '0')}′`;
}
