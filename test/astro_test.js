// Sanity checks for js/astro.js.   Run:  node test/astro_test.js
// Reference values: Meeus "Astronomical Algorithms" examples and JPL Horizons
// (observer site 135.48E 34.57N, 2026-10-15 11:00 UT = 20:00 JST, astrometric J2000 RA/Dec, airless az/el).
import * as A from '../js/astro.js';

let fails = 0;
function check(name, got, want, tol, unit = '°') {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: got ${got.toFixed(3)}${unit}, want ${want.toFixed(3)}${unit} (tol ${tol})`);
}

// 1. GMST (Meeus ex. 12.a: 1987-04-10 00:00 UT → 13h10m46.3668s)
check('GMST 1987-04-10', A.gmst(A.julianDay(new Date(Date.UTC(1987, 3, 10)))), (13 + 10 / 60 + 46.3668 / 3600) * 15, 0.001);

// 2. Precession (Meeus ex. 21.b: θ Per to 2028-11-13.19 TD)
{
  const P = A.precessionMatrix(2462088.69);
  const r = A.raDecFromVec(A.mulMV(P, A.vecFromRaDec(41.054063, 49.227750)));
  check('precession RA', r.ra, 41.547214, 0.002);
  check('precession Dec', r.dec, 49.348483, 0.002);
}

const lat = 34.57, lon = 135.48;
const date = new Date('2026-10-15T20:00:00+09:00');
const jd = A.julianDay(date);
const M = A.eqToHorMatrix(jd, lat, lon);

// 3. North celestial pole altitude = latitude; Polaris within its 0.7° circle
check('NCP altitude', A.altAzFromHor(A.mulMV(M, A.precessionMatrix(jd).slice(6, 9))).alt, lat, 1e-6);
{
  const pol = A.altAzFromHor(A.mulMV(M, A.vecFromRaDec(37.95, 89.26)));
  check('Polaris altitude ≈ latitude', pol.alt, lat, 0.8);
  check('Polaris azimuth ≈ 0 (north)', A.norm180(pol.az), 0, 1.0);
}

// 4. Sun / Moon / planets vs JPL Horizons (angular separation, degrees)
const ref = {
  sun: [200.09444, -8.47251, 283.100888, -32.726225],
  moon: [254.27987, -28.14929, 235.808215, -0.984560],
  mercury: [223.08223, -19.72200, 259.127428, -19.908519],
  venus: [210.28801, -20.30369, 265.151306, -30.645115],
  mars: [132.31190, 19.09482, 13.678660, -35.275106],
  jupiter: [144.23207, 14.89130, 359.843399, -40.658432],
  saturn: [10.31731, 1.49288, 117.091206, 35.876357],
  uranus: [62.90489, 20.94649, 67.789330, 4.905130],
  neptune: [2.48355, -0.47076, 125.917474, 39.980237],
};
for (const [k, [ra, dec, az, alt]] of Object.entries(ref)) {
  const o = k === 'sun' ? A.sun(jd) : k === 'moon' ? A.moon(jd, lat, lon) : A.planet(k, jd);
  check(`${k} RA/Dec separation`, A.angleBetween(o.v, A.vecFromRaDec(ra, dec)), 0, k === 'moon' ? 0.5 : 0.1);
  const h = A.altAzFromHor(A.mulMV(M, o.v));
  check(`${k} alt/az separation`, A.angleBetween(A.horFromAltAz(h.alt, h.az), A.horFromAltAz(alt, az)), 0, k === 'moon' ? 0.5 : 0.15);
}

// 5. Moon phase (Horizons illuminated fraction 21.10 %), waxing crescent in the SW evening sky
{
  const m = A.moon(jd, lat, lon);
  check('Moon illuminated %', m.illum * 100, 21.10, 2, '%');
  console.log(`     moon age ${m.age.toFixed(1)} d, waxing=${m.waxing}`);
  if (!m.waxing) { fails++; console.log('FAIL moon should be waxing'); }
}

// 6. Planet magnitudes vs Horizons (rough)
check('Venus magnitude', A.planet('venus', jd).mag, -4.261, 0.3, '');
check('Jupiter magnitude', A.planet('jupiter', jd).mag, -1.924, 0.3, '');
check('Mars magnitude', A.planet('mars', jd).mag, 0.976, 0.3, '');

// 7. Rise/set sanity: Sun on 2026-10-15 at Sakai rises ~06:00 and sets ~17:25 JST
{
  const d0 = A.julianDay(new Date('2026-10-15T00:00:00+09:00'));
  const rs = A.riseSet((t) => A.sun(t).v, d0, lat, lon, -0.833);
  const hm = (d) => (d.getTime() / 3600000 + 9) % 24;
  check('sunrise JST (h)', hm(rs.rise), 6.0, 0.2, 'h');
  check('sunset JST (h)', hm(rs.set), 17.42, 0.2, 'h');
}

// 8. Constellation lookup: Albireo inside Cygnus polygon
{
  const fs = await import('node:fs');
  const cons = JSON.parse(fs.readFileSync(new URL('../data/constellations.json', import.meta.url)));
  const find = (ra, dec) => {
    const p = A.vecFromRaDec(ra, dec);
    const c = cons.find((c) => c.b.some((ring) => A.insideRing(p, ring)));
    return c ? c.id : '?';
  };
  const cases = [[292.68, 27.96, 'Cyg'], [37.95, 89.26, 'UMi'], [101.29, -16.72, 'CMa'], [23.06, 12.0, 'Psc'], [41.24, 4.09, 'Cet'],
                 [186.65, -63.10, 'Cru'], [0.0, -89.5, 'Oct'], [279.23, 38.78, 'Lyr'], [180.0, 0.0, 'Vir']];
  for (const [ra, dec, want] of cases) {
    const got = find(ra, dec);
    if (got !== want) fails++;
    console.log(`${got === want ? 'OK  ' : 'FAIL'} constellation at ${ra},${dec}: ${got} (want ${want})`);
  }
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
