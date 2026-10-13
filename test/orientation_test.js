// Checks the device-orientation math (W3C Z-X'-Y'' Euler angles → view direction).   node test/orientation_test.js
import { viewFromEuler, viewFromAltAz, altAzOfView } from '../js/orientation.js';

let fails = 0;
const near = (a, b, tol = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < tol);
function check(name, got, want) {
  const ok = near(got.f, want.f, 1e-6) && near(got.u, want.u, 1e-6);
  if (!ok) fails++;
  const r = (v) => v.map((x) => x.toFixed(3)).join(',');
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: f=(${r(got.f)}) u=(${r(got.u)})`);
}
const N = [0, 1, 0], E = [1, 0, 0], S = [0, -1, 0], W = [-1, 0, 0], UP = [0, 0, 1], DOWN = [0, 0, -1];

// Phone upright in portrait, screen facing the user, back camera toward the horizon.
check('portrait, camera north', viewFromEuler(0, 90, 0), { f: N, u: UP });
// alpha increases counter-clockwise: alpha=90 → camera faces west; alpha=270 → east
check('portrait, camera west (alpha 90)', viewFromEuler(90, 90, 0), { f: W, u: UP });
check('portrait, camera east (alpha 270)', viewFromEuler(270, 90, 0), { f: E, u: UP });
// Flat on a table, screen up: camera looks down, screen-top points north
check('flat, top north', viewFromEuler(0, 0, 0), { f: DOWN, u: N });
// Upright, tilted back 45° (camera 45° above the horizon, facing north)
{
  const s = Math.SQRT1_2;
  check('portrait, 45° up, north', viewFromEuler(0, 135, 0), { f: [0, s, s], u: [0, -s, s] });
}
// Landscape: phone turned 90° counter-clockwise (window.orientation = 90), camera toward north.
// Device axes: x → up, y → west, z → south  ⇒  alpha 90, beta 0, gamma −90.
check('landscape (angle 90), camera north', viewFromEuler(90, 0, -90, 90), { f: N, u: UP });
// Same pose but the UI did not rotate (angle 0): screen-up is the device top = west
check('landscape pose, portrait UI', viewFromEuler(90, 0, -90, 0), { f: N, u: W });
// Heading correction: +10° → camera that reads north is really at heading 10°
{
  const v = viewFromEuler(0, 90, 0, 0, 10);
  const az = altAzOfView(v.f).az;
  const ok = Math.abs(az - 10) < 1e-6;
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} heading correction +10° → azimuth ${az.toFixed(3)}`);
}
// Manual view helper round trip
{
  const v = viewFromAltAz(30, 200), a = altAzOfView(v.f);
  const ok = Math.abs(a.alt - 30) < 1e-9 && Math.abs(a.az - 200) < 1e-9 && Math.abs(v.u[2] - Math.cos(30 * Math.PI / 180)) < 1e-9;
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} manual view alt/az round trip`);
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
