# -*- coding: utf-8 -*-
"""Build the Milky Way texture (equirectangular, J2000 RA/Dec) used by the WebGL sky layer.

Usage:  python -I tools/build_milkyway.py <download_dir>/mw.json data/milkyway.jpg

Structure comes from the d3-celestial Milky Way outlines (5 brightness levels, BSD-3-Clause);
fine detail is procedural noise, and a dark dust lane (Great Rift) is added along the galactic
plane between Sagittarius and Cygnus.
Layout: x = RA 0..360° left→right, y = Dec +90 (top) .. −90 (bottom).
"""
import json, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC, OUT = sys.argv[1], sys.argv[2]
W, H = 4096, 2048
mw = json.load(open(SRC, encoding='utf-8'))

levels = []
for f in sorted(mw['features'], key=lambda f: f['id']):
    m = np.zeros((H, W), dtype=bool)
    for poly in f['geometry']['coordinates']:
        for ring in poly:
            r = np.array(ring, dtype=float)
            d = np.diff(r[:, 0]); d = (d + 180) % 360 - 180
            x = np.concatenate([[r[0, 0]], r[0, 0] + np.cumsum(d)])
            net = x[-1] - x[0] + ((r[0, 0] - r[-1, 0] + 180) % 360 - 180)
            X = x / 360 * W
            Y = (90 - r[:, 1]) / 180 * H
            pts = list(zip(X, Y))
            if abs(net) > 180:
                pts += [(X[-1], H + 2), (X[0], H + 2)]
            img = Image.new('1', (W, H), 0)
            dr = ImageDraw.Draw(img)
            for sh in (-W, 0, W, 2 * W, -2 * W):
                dr.polygon([(px + sh, py) for px, py in pts], fill=1)
            m ^= np.array(img, dtype=bool)
    levels.append(m)
print('levels rasterized')

def box1(a, r, axis, wrap):
    if r < 1:
        return a
    n = a.shape[axis]
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r + 1, r)
    a2 = np.pad(a, pad, mode='wrap' if wrap else 'edge')
    c = np.cumsum(a2, axis=axis, dtype=np.float64)
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)

def blur(a, s):
    """approximate gaussian (3 box passes), wrapping in RA"""
    a = a.astype(np.float32)
    r = max(1, int(round(s * 0.93)))
    for _ in range(3):
        a = box1(a, r, 1, True)
        a = box1(a, r, 0, False)
    return a

dens = np.zeros((H, W), dtype=np.float32)
for i, m in enumerate(levels):
    dens += (0.55 + 0.45 * i) * blur(m, (5.0 - 0.7 * i) * W / 2048)

# coordinates
ra = (np.arange(W) + 0.5) / W * 2 * np.pi
dec = np.pi / 2 - (np.arange(H) + 0.5) / H * np.pi
RA, DEC = np.meshgrid(ra, dec)
vx, vy, vz = np.cos(DEC) * np.cos(RA), np.cos(DEC) * np.sin(RA), np.sin(DEC)
# galactic coordinates (J2000 → galactic rotation matrix)
G = np.array([[-0.0548755604, -0.8734370902, -0.4838350155],
              [0.4941094279, -0.4448296300, 0.7469822445],
              [-0.8676661490, -0.1980763734, 0.4559837762]])
gx = G[0, 0] * vx + G[0, 1] * vy + G[0, 2] * vz
gy = G[1, 0] * vx + G[1, 1] * vy + G[1, 2] * vz
gz = G[2, 0] * vx + G[2, 1] * vy + G[2, 2] * vz
gl = np.degrees(np.arctan2(gy, gx))          # −180..180, 0 = galactic centre
gb = np.degrees(np.arcsin(np.clip(gz, -1, 1)))

# periodic value noise (fbm) on the sphere via 3D noise of the unit vector
rng = np.random.default_rng(7)
def noise3(x, y, z, freq):
    n = 64
    tab = rng.random((n, n, n)).astype(np.float32)
    X, Y, Z = (x + 1.5) * freq, (y + 1.5) * freq, (z + 1.5) * freq
    xi, yi, zi = np.floor(X).astype(int), np.floor(Y).astype(int), np.floor(Z).astype(int)
    xf, yf, zf = X - xi, Y - yi, Z - zi
    u, v, w = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf), zf * zf * (3 - 2 * zf)
    def T(a, b, c): return tab[a % n, b % n, c % n]
    c00 = T(xi, yi, zi) * (1 - u) + T(xi + 1, yi, zi) * u
    c10 = T(xi, yi + 1, zi) * (1 - u) + T(xi + 1, yi + 1, zi) * u
    c01 = T(xi, yi, zi + 1) * (1 - u) + T(xi + 1, yi, zi + 1) * u
    c11 = T(xi, yi + 1, zi + 1) * (1 - u) + T(xi + 1, yi + 1, zi + 1) * u
    return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w

fbm = np.zeros_like(dens)
amp, tot = 1.0, 0.0
for k, fr in enumerate([4, 9, 19, 38, 76]):
    fbm += amp * noise3(vx, vy, vz, fr); tot += amp; amp *= 0.55
fbm /= tot
print('noise done')

# unresolved disc light, brighter toward the galactic centre
core = np.exp(-(gl / 38.0) ** 2) * np.exp(-(gb / 7.0) ** 2)
disc = 0.10 * np.exp(-(gb / 10.0) ** 2)
# Great Rift / dust lanes between Sagittarius (l≈0) and Cygnus (l≈80), and toward Scorpius/Ophiuchus
lane_win = 1 / (1 + np.exp(-(gl + 25) / 4)) * 1 / (1 + np.exp((gl - 85) / 4))
lowf = noise3(vx, vy, vz, 6) - 0.5
lane = lane_win * np.exp(-((gb - 0.8 + 5.0 * lowf) / (2.2 + 2.0 * fbm)) ** 2)
lane *= np.clip(0.2 + 1.6 * (fbm - 0.3), 0, 1.2)

val = dens / dens.max()
val = val * (0.35 + 1.3 * fbm) + disc + 0.55 * core * (0.6 + 0.6 * fbm)
val *= 1 - np.clip(0.75 * lane, 0, 0.85)
val = np.clip(val / np.percentile(val, 99.7), 0, 1) ** 0.85
img = Image.fromarray((val * 255).astype(np.uint8), 'L')
img.save(OUT, quality=88, optimize=True)
print(OUT, 'written')
