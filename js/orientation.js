// orientation.js — device orientation → viewing direction in the local horizontal frame.
// No astronomy here. Output: forward / up unit vectors in HOR (x = East, y = North, z = Up).
//
// W3C DeviceOrientation (Z-X'-Y'' intrinsic Tait-Bryan): R = Rz(alpha) · Rx(beta) · Ry(gamma)
// maps device coordinates (x right, y top, z out of screen) to Earth (East, North, Up)
// when alpha is measured from north. Back camera looks along device −Z.

const DEG = Math.PI / 180;

export function rotationMatrix(alpha, beta, gamma) {
  const a = alpha * DEG, b = beta * DEG, g = gamma * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // columns are the device x, y, z axes in Earth coordinates
  return [
    ca * cg - sa * sb * sg, -cb * sa, ca * sg + cg * sa * sb,
    cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb,
    -cb * sg, sb, cb * cg,
  ];
}
const col = (m, j) => [m[j], m[3 + j], m[6 + j]];
function rotZ(v, deg) { // counter-clockwise seen from above
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
function norm(v) { const r = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / r, v[1] / r, v[2] / r]; }
function headingOf(v) { return ((Math.atan2(v[0], v[1]) / DEG) + 360) % 360; }

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation; // iOS < 16.4
  return 0;
}

export class OrientationTracker {
  constructor() {
    this.active = false;
    this.absolute = false;      // true once a compass reference is available
    this.declination = -7.5;    // magnetic declination (E positive). true = magnetic + declination
    this.userOffset = 0;        // manual heading correction (deg)
    this.compassOffset = null;  // iOS: webkitCompassHeading − heading(alpha)
    this.compassAccuracy = -1;
    this.rawF = null; this.rawU = null;
    this.f = [0, 1, 0]; this.u = [0, 0, 1];
    this.lastEvent = 0;
    this._onEvent = this._onEvent.bind(this);
    this._onAbs = this._onAbs.bind(this);
  }

  /** Must be called from a user gesture on iOS. Resolves to true if events can be received. */
  async start() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch (e) { return false; }
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this._onAbs);
    }
    window.addEventListener('deviceorientation', this._onEvent);
    this.active = true;
    return true;
  }
  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onAbs);
    window.removeEventListener('deviceorientation', this._onEvent);
    this.active = false;
  }
  /** True if events have arrived in the last 2 s. */
  receiving() { return this.active && performance.now() - this.lastEvent < 2000; }

  _onAbs(e) {
    if (e.alpha == null) return;
    this.absolute = true;
    this._update(e.alpha, e.beta, e.gamma, 0);
  }

  _onEvent(e) {
    if (e.alpha == null || e.beta == null) return;
    if (this.absolute && !('webkitCompassHeading' in e)) return; // Android: absolute stream wins
    let offset = 0;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: alpha has an arbitrary zero. Compare with the compass heading of the same axis.
      this.compassAccuracy = e.webkitCompassAccuracy;
      const R = rotationMatrix(e.alpha, e.beta, e.gamma);
      const back = col(R, 2).map((x) => -x), top = col(R, 1);
      // iOS reports a heading for whichever device axis is level: the top edge (portrait top) when that
      // edge is horizontal (lying flat, or held sideways in landscape), and the back camera when the
      // phone is held upright in portrait. Learn the offset only in those clear poses; when the camera
      // points high toward the zenith, or in between, keep the last good offset and let the gyroscope
      // carry the motion (the heading there is ill-defined and made the view spin or jump).
      const camHigh = back[2] > 0.6;
      let ref = null;
      if (!camHigh && Math.abs(top[2]) < 0.5) ref = top;          // flat, or landscape upright
      else if (!camHigh && Math.abs(back[2]) < 0.6 && Math.abs(top[2]) > 0.8) ref = back; // portrait upright
      if (ref || this.compassOffset == null) {
        const h = headingOf(ref || back);
        const d = e.webkitCompassHeading - h;
        // circular low-pass of the offset (handles 0/360)
        const s = Math.sin(d * DEG), c = Math.cos(d * DEG);
        if (this.compassOffset == null) this._co = [s, c];
        else { const k = 0.03; this._co = [this._co[0] + k * (s - this._co[0]), this._co[1] + k * (c - this._co[1])]; }
        this.compassOffset = Math.atan2(this._co[0], this._co[1]) / DEG;
      }
      offset = this.compassOffset;
      this.absolute = true;
    } else if (e.absolute) {
      this.absolute = true;
    }
    this._update(e.alpha, e.beta, e.gamma, offset);
  }

  _update(alpha, beta, gamma, compassOffset) {
    this.lastEvent = performance.now();
    const v = viewFromEuler(alpha, beta, gamma, screenAngle(), compassOffset + this.declination + this.userOffset);
    this.rawF = v.f; this.rawU = v.u;
  }

  /** Low-pass filter toward the latest sensor sample. Call once per animation frame. */
  smooth(dtMs) {
    if (!this.rawF) return false;
    const ang = Math.acos(Math.max(-1, Math.min(1, this.f[0] * this.rawF[0] + this.f[1] * this.rawF[1] + this.f[2] * this.rawF[2])));
    // adaptive: heavy smoothing for small jitter, fast follow for big moves
    const tau = ang > 0.15 ? 60 : ang > 0.03 ? 120 : 220;
    const k = 1 - Math.exp(-(dtMs || 16) / tau);
    const mix = (a, b) => [a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1]), a[2] + k * (b[2] - a[2])];
    let f = norm(mix(this.f, this.rawF));
    let u = mix(this.u, this.rawU);
    // re-orthogonalize up against forward
    const d = u[0] * f[0] + u[1] * f[1] + u[2] * f[2];
    u = norm([u[0] - d * f[0], u[1] - d * f[1], u[2] - d * f[2]]);
    const changed = Math.abs(f[0] - this.f[0]) + Math.abs(f[1] - this.f[1]) + Math.abs(f[2] - this.f[2]) +
      Math.abs(u[0] - this.u[0]) + Math.abs(u[1] - this.u[1]) + Math.abs(u[2] - this.u[2]) > 1e-5;
    this.f = f; this.u = u;
    return changed;
  }
}

/**
 * Pure function: device Euler angles (W3C) + screen orientation angle + heading correction (deg, added to
 * compass headings) → forward (back camera) and screen-up vectors in HOR (East, North, Up).
 */
export function viewFromEuler(alpha, beta, gamma, screenAngleDeg = 0, headingCorrection = 0) {
  const R = rotationMatrix(alpha, beta, gamma);
  const a = screenAngleDeg * DEG;
  const upDev = [Math.sin(a), Math.cos(a), 0];
  let f = col(R, 2).map((x) => -x);
  let u = [R[0] * upDev[0] + R[1] * upDev[1], R[3] * upDev[0] + R[4] * upDev[1], R[6] * upDev[0] + R[7] * upDev[1]];
  // rotating the Earth frame clockwise by h increases every heading by h
  f = rotZ(f, -headingCorrection); u = rotZ(u, -headingCorrection);
  return { f, u };
}

/** Manual (drag) view: azimuth/altitude of the view center, screen up kept vertical. */
export function viewFromAltAz(altDeg, azDeg) {
  const h = altDeg * DEG, A = azDeg * DEG;
  const f = [Math.cos(h) * Math.sin(A), Math.cos(h) * Math.cos(A), Math.sin(h)];
  // up = derivative toward zenith
  const u = [-Math.sin(h) * Math.sin(A), -Math.sin(h) * Math.cos(A), Math.cos(h)];
  return { f, u };
}
export function altAzOfView(f) {
  return { alt: Math.asin(Math.max(-1, Math.min(1, f[2]))) / DEG, az: headingOf(f) };
}
