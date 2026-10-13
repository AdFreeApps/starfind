// skygl.js — WebGL background layer: sky colour from the Sun's altitude, airglow, Milky Way texture
// with procedural fine detail, ground silhouette. Everything per pixel through the inverse
// stereographic projection, so it stays sharp at any devicePixelRatio and zoom.

const VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `
precision highp float;
uniform mat3 uCam2Eq;      // camera → EQ(J2000)
uniform vec2 uCenter;      // projection centre, drawing-buffer px (y up)
uniform float uScale;      // px per stereographic unit (drawing buffer)
uniform vec3 uZenith;      // EQ
uniform vec3 uNorth;       // EQ, horizontal north
uniform vec3 uSun;         // EQ
uniform float uSunAlt;     // degrees
uniform float uNight;      // 0/1 red mode
uniform float uMW;         // milky way strength 0..1
uniform float uGround;     // 0/1 draw ground
uniform float uDetail;     // fine-noise strength (grows when zoomed in)
uniform sampler2D uTex;

float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }

vec3 skyColor(float alt, float cosSun){
  // key colours: zenith / horizon for night, astro, nautical, civil, day
  float s = uSunAlt;
  vec3 zN = vec3(0.00215, 0.00367, 0.01370), hN = vec3(0.0050, 0.0080, 0.0230); // #070c1f zenith (linear)
  vec3 zA = vec3(0.006, 0.010, 0.030), hA = vec3(0.020, 0.028, 0.060);
  vec3 zU = vec3(0.030, 0.060, 0.140), hU = vec3(0.150, 0.130, 0.170);
  vec3 zC = vec3(0.090, 0.170, 0.340), hC = vec3(0.600, 0.420, 0.320);
  vec3 zD = vec3(0.170, 0.360, 0.700), hD = vec3(0.580, 0.720, 0.880);
  vec3 z, h;
  if (s < -18.0) { z = zN; h = hN; }
  else if (s < -12.0) { float t = (s + 18.0) / 6.0; z = mix(zN, zA, t); h = mix(hN, hA, t); }
  else if (s < -6.0) { float t = (s + 12.0) / 6.0; z = mix(zA, zU, t); h = mix(hA, hU, t); }
  else if (s < 0.0) { float t = (s + 6.0) / 6.0; z = mix(zU, zC, t); h = mix(hU, hC, t); }
  else { float t = clamp(s / 10.0, 0.0, 1.0); z = mix(zC, zD, t); h = mix(hC, hD, t); }
  float a = max(alt, 0.0);
  float hz = exp(-a / 0.20);                       // horizon brightening / airglow band
  vec3 c = mix(z, h, hz);
  // glow around the Sun (twilight and day)
  float sunGlow = smoothstep(-18.0, 2.0, s);
  float near = pow(max(cosSun, 0.0), 6.0);
  c += sunGlow * near * (s < 3.0 ? vec3(0.55, 0.30, 0.12) : vec3(0.35, 0.35, 0.30)) * (0.35 + 0.65 * hz);
  return c;
}

void main(){
  vec2 q = (gl_FragCoord.xy - uCenter) / uScale;
  float r2 = dot(q, q);
  vec3 cam = vec3(4.0 * q, 4.0 - r2) / (4.0 + r2);
  vec3 d = normalize(uCam2Eq * cam);
  float sinAlt = dot(d, uZenith);
  float alt = asin(clamp(sinAlt, -1.0, 1.0));
  vec3 east = cross(uNorth, uZenith);
  float az = atan(dot(d, east), dot(d, uNorth));
  float cosSun = dot(d, uSun);

  vec3 col = skyColor(alt, cosSun);

  // Milky Way
  if (uMW > 0.0) {
    float ra = atan(d.y, d.x);
    float u = fract(ra / 6.2831853);
    float v = 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.1415927;
    float m = texture2D(uTex, vec2(u, v)).r;
    // procedural detail: knots and dust at scales finer than the texture
    float n = fbm(d * 90.0);
    float n2 = vnoise(d * 420.0);
    m *= mix(1.0, 0.55 + 0.9 * n, 0.55 + 0.25 * uDetail);
    m *= mix(1.0, 0.75 + 0.5 * n2, uDetail);
    float ext = smoothstep(-0.02, 0.45, alt) * 0.75 + 0.25;  // atmospheric extinction near horizon
    float dark = 1.0 - smoothstep(-16.0, -6.0, uSunAlt);
    vec3 mwc = mix(vec3(0.62, 0.68, 0.85), vec3(1.0, 0.86, 0.68), smoothstep(0.35, 1.0, m));
    col += mwc * m * m * 0.30 * uMW * ext * dark + mwc * m * 0.05 * uMW * ext * dark;
  }

  // ground with gentle hills and a dark silhouette
  if (uGround > 0.5) {
    float hill = 0.006 + 0.008 * (0.5 + 0.5 * sin(az * 3.0 + 1.3)) * (0.5 + 0.5 * sin(az * 7.0 + 0.4))
               + 0.004 * vnoise(vec3(az * 6.0, 0.0, 1.0));
    if (alt < hill) {
      float depth = clamp((hill - alt) / 0.6, 0.0, 1.0);
      vec3 g = mix(vec3(0.0065, 0.0075, 0.0110), vec3(0.0020, 0.0024, 0.0034), sqrt(depth));
      float dayL = smoothstep(-8.0, 10.0, uSunAlt);
      g = mix(g, vec3(0.10, 0.11, 0.08), dayL);
      // soft edge
      float e = smoothstep(hill, hill - 0.004, alt);
      col = mix(col, g, e);
    }
  }

  if (uNight > 0.5) { float L = dot(col, vec3(0.45, 0.45, 0.2)); col = vec3(L * 1.3, 0.0, 0.0); }
  // 正しい sRGB 変換（暗い色で pow(1/2.2) だと明るく灰色っぽくなるため）
  vec3 lc = max(col, 0.0);
  vec3 outc = mix(lc * 12.92, 1.055 * pow(lc, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), lc));
  outc += (hash(vec3(gl_FragCoord.xy, 1.0)) - 0.5) / 255.0;   // dithering against banding
  gl_FragColor = vec4(outc, 1.0);
}`;

export class SkyGL {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
      || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('no webgl');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uCam2Eq', 'uCenter', 'uScale', 'uZenith', 'uNorth', 'uSun', 'uSunAlt', 'uNight', 'uMW', 'uGround', 'uDetail', 'uTex'])
      this.u[n] = gl.getUniformLocation(prog, n);
    // 1×1 placeholder texture until the Milky Way image loads
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    this.texReady = false;
  }

  loadTexture(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.texReady = true;
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  resize(cssW, cssH, dpr) {
    this.canvas.width = Math.round(cssW * dpr); this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px'; this.canvas.style.height = cssH + 'px';
    this.dpr = dpr;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** C: EQ→camera (row-major), scale in CSS px per stereographic unit. */
  render(o) {
    const gl = this.gl, u = this.u, dpr = this.dpr;
    // row-major C uploaded as column-major == Cᵀ == camera→EQ
    gl.uniformMatrix3fv(u.uCam2Eq, false, new Float32Array(o.C));
    gl.uniform2f(u.uCenter, this.canvas.width / 2, this.canvas.height / 2);
    gl.uniform1f(u.uScale, o.scale * dpr);
    gl.uniform3fv(u.uZenith, o.zenith);
    gl.uniform3fv(u.uNorth, o.north);
    gl.uniform3fv(u.uSun, o.sun);
    gl.uniform1f(u.uSunAlt, o.sunAlt);
    gl.uniform1f(u.uNight, o.night ? 1 : 0);
    gl.uniform1f(u.uMW, o.milkyway && this.texReady ? 1 : 0);
    gl.uniform1f(u.uGround, o.ground ? 1 : 0);
    gl.uniform1f(u.uDetail, Math.max(0, Math.min(1, (60 - o.fov) / 40)));
    gl.uniform1i(u.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
