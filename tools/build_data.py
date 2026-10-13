# -*- coding: utf-8 -*-
"""Convert downloaded source catalogs into compact JSON for the app.

Usage:  python -I tools/build_data.py <download_dir> <out_dir>

Inputs in <download_dir> (see README.md for URLs and licenses):
  bsc5.dat             Yale Bright Star Catalogue 5th ed. (VizieR V/50 catalog)
  iaucsn.txt           IAU Catalog of Star Names (WGSN, Mamajek's text version)
  lines.json           d3-celestial constellations.lines.json
  cons.json            d3-celestial constellations.json   (centers, rank)
  bounds.json          d3-celestial constellations.bounds.json
  mw.json              d3-celestial mw.json (Milky Way outlines)
  messier.json         d3-celestial messier.json
"""
import json, math, os, sys

import numpy as np

SRC, OUT = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from names_ja import CON_JA, STAR_JA, STAR_DIST_LY, MESSIER_JA, MESSIER_EN

# Traditional → Simplified for the characters used in Chinese constellation names
T2S = dict(zip('寶鷹壇獵馬鯨魚圓規鴿髮烏鴉鵝劍龍爐雙鶴時鐘長蠍獅貓顯鏡蒼蠅極戶飛鳳繪羅盤網儀遠鵑處',
               '宝鹰坛猎马鲸鱼圆规鸽发乌鸦鹅剑龙炉双鹤时钟长蝎狮猫显镜苍蝇极户飞凤绘罗盘网仪远鹃处'))

def load(name):
    with open(os.path.join(SRC, name), encoding='utf-8', errors='replace') as f:
        return json.load(f)

def dump(name, obj):
    path = os.path.join(OUT, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print(name, os.path.getsize(path), 'bytes')

def r2(x):
    return round(x, 2)

def ra0(x):  # d3 uses -180..180; store 0..360
    return x + 360 if x < 0 else x

GREEK = {'Alp': 'α', 'Bet': 'β', 'Gam': 'γ', 'Del': 'δ', 'Eps': 'ε', 'Zet': 'ζ', 'Eta': 'η',
         'The': 'θ', 'Iot': 'ι', 'Kap': 'κ', 'Lam': 'λ', 'Mu': 'μ', 'Nu': 'ν', 'Xi': 'ξ',
         'Omi': 'ο', 'Pi': 'π', 'Rho': 'ρ', 'Sig': 'σ', 'Tau': 'τ', 'Ups': 'υ', 'Phi': 'φ',
         'Chi': 'χ', 'Psi': 'ψ', 'Ome': 'ω'}

def bsc_desig(name):
    """'58Alp Ori' -> ('58 α Ori'), '  Alp1Cen' etc."""
    name = name.rstrip()
    if len(name) < 7:
        return ''
    con = name[7:10].strip() if len(name) >= 10 else ''
    flam = name[0:3].strip()
    bay = name[3:6].strip()
    sup = name[6:7].strip()
    g = GREEK.get(bay, bay)
    parts = []
    if g:
        parts.append(g + sup)
    elif flam:
        parts.append(flam)
    if not parts:
        return ''
    return ' '.join(parts + [con]) if con else ''

# ---------------------------------------------------------------- stars
iau = {}
with open(os.path.join(SRC, 'iaucsn.txt'), encoding='utf-8') as f:
    for line in f:
        if line.startswith(('#', '$')) or not line.strip():
            continue
        name = line[0:18].strip()
        desig = line[36:49].strip()
        if desig.startswith('HR '):
            hr = int(desig[3:])
            try:
                hip = int(line[88:95].strip())
            except ValueError:
                hip = 0
            iau[hr] = (name, hip)

stars = []
with open(os.path.join(SRC, 'bsc5.dat'), encoding='latin-1') as f:
    for line in f:
        line = line.rstrip('\n').ljust(197)
        if not line[75:77].strip() or not line[102:107].strip():
            continue  # removed objects (novae, clusters)
        hr = int(line[0:4])
        ra = (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600) * 15
        dec = int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600
        if line[83] == '-':
            dec = -dec
        mag = float(line[102:107])
        bv = line[109:114].strip()
        bv = float(bv) if bv else 0.6
        plx = line[161:166].strip()
        plx = float(plx) if (plx and line[160] != 'D') else 0.0
        dist = 0
        if plx >= 0.010:
            dist = round(3.26156 / plx)
        stars.append(dict(hr=hr, ra=ra, dec=dec, mag=mag, bv=bv, dist=dist,
                          desig=bsc_desig(line[4:14]), dm=line[14:25].strip()))

stars.sort(key=lambda s: s['mag'])
flat = []
names = {}
missing_ja = set(STAR_JA)
for s in stars:
    flat += [r2(s['ra']), r2(s['dec']), r2(s['mag']), r2(s['bv']), s['hr']]
    info = {}
    if s['desig']:
        info['d'] = s['desig']
    if s['hr'] in iau:
        en, hip = iau[s['hr']]
        info['en'] = en
        if hip:
            info['hip'] = hip
        if en in STAR_JA:
            info['ja'] = STAR_JA[en]
            missing_ja.discard(en)
        if en in STAR_DIST_LY:
            info['ly'] = STAR_DIST_LY[en]
    if 'ly' not in info and s['dist']:
        info['ly'] = s['dist']
        info['lyq'] = 1  # old BSC5 parallax -> rough
    if info:
        names[s['hr']] = info
if missing_ja:
    print('WARNING: Japanese star names not matched:', sorted(missing_ja))
dump('stars.json', {'cols': ['ra', 'dec', 'mag', 'bv', 'hr'], 'd': flat, 'info': names})
print('stars:', len(stars), ' named(IAU):', sum(1 for v in names.values() if 'en' in v))

# ---------------------------------------------------------------- constellations
lines = load('lines.json')
cons = load('cons.json')
bounds = load('bounds.json')
cmap = {}
for f in cons['features']:
    p = f['properties']
    c = f['geometry']['coordinates']
    if f['id'] in cmap:
        continue  # Serpens appears twice (Caput/Cauda); keep the first centre
    zht = p['zh'].replace('飛鱼', '飛魚').replace('蝘蜒', '蝘蜓').replace('處女', '室女')
    names = {'la': p['name'], 'en': p['name'], 'ja': CON_JA[f['id']], 'zh-Hant': zht,
             'zh-Hans': ''.join(T2S.get(ch, ch) for ch in zht), 'ko': p['ko'],
             'es': p['es'], 'fr': p['fr'], 'de': p['de']}
    cmap[f['id']] = {'id': f['id'], 'common': p['en'], 'la': p['name'], 'gen': p['gen'],
                     'ja': CON_JA[f['id']], 'names': names, 'rank': int(p['rank']),
                     'c': [r2(ra0(c[0])), r2(c[1])]}
    if p.get('ja') and p['ja'] != CON_JA[f['id']]:
        print('note: ja differs for', f['id'], CON_JA[f['id']], 'vs d3', p['ja'])
for f in lines['features']:
    cmap[f['id']].setdefault('l', []).extend([[[r2(ra0(a)), r2(b)] for a, b in seg] for seg in f['geometry']['coordinates']])
for f in bounds['features']:
    g = f['geometry']
    rings = g['coordinates'] if g['type'] == 'Polygon' else [r for p in g['coordinates'] for r in p]
    cmap[f['id']].setdefault('b', []).extend([[[r2(a), r2(b)] for a, b in ring] for ring in rings])
assert len(cmap) == 88, len(cmap)
dump('constellations.json', list(cmap.values()))

# ---------------------------------------------------------------- messier
ms = []
for f in load('messier.json')['features']:
    p = f['properties']
    c = f['geometry']['coordinates']
    ms.append({'id': f['id'], 'ngc': p['desig'], 't': p['type'], 'mag': p['mag'], 'dim': p['dim'],
               'en': MESSIER_EN.get(f['id'], ''), 'ja': MESSIER_JA.get(f['id'], ''),
               'ra': r2(ra0(c[0])), 'dec': r2(c[1])})
dump('messier.json', ms)

# ---------------------------------------------------------------- milky way samples
# Sample the sky on a Fibonacci sphere and record the brightest outline level containing
# each point (even-odd rule over all rings of a level). Rings never cross ra=+-180.
mw = load('mw.json')
N = 40000
k = np.arange(N) + 0.5
dec = np.degrees(np.arcsin(1 - 2 * k / N))
ra = (np.degrees(np.pi * (1 + 5 ** 0.5) * k)) % 360 - 180
level = np.zeros(N, dtype=int)

def pip(px, py, x1, y1):
    x2, y2 = np.roll(x1, -1), np.roll(y1, -1)
    res = np.zeros(len(px), dtype=bool)
    for i0 in range(0, len(px), 4000):
        qx = px[i0:i0 + 4000, None]
        qy = py[i0:i0 + 4000, None]
        cond = (y1 > qy) != (y2 > qy)
        xint = x1 + (qy - y1) * (x2 - x1) / np.where(y2 - y1 == 0, 1e-12, y2 - y1)
        res[i0:i0 + 4000] = (np.count_nonzero(cond & (qx < xint), axis=1) % 2 == 1)
    return res

for f in mw['features']:
    lv = int(f['id'][2:])
    inside = np.zeros(N, dtype=bool)
    for poly in f['geometry']['coordinates']:
        for ring in poly:
            r = np.array(ring, dtype=float)
            # unwrap longitudes so the ring is continuous across ra = +-180
            d = np.diff(r[:, 0])
            d = (d + 180) % 360 - 180
            x = np.concatenate([[r[0, 0]], r[0, 0] + np.cumsum(d)])
            y = r[:, 1].copy()
            net = x[-1] - x[0] + ((r[0, 0] - r[-1, 0] + 180) % 360 - 180)
            if abs(net) > 180:
                # ring encircles the pole: close it through the south pole (consistently for all rings)
                x = np.concatenate([x, [x[-1], x[0]]])
                y = np.concatenate([y, [-90.0, -90.0]])
                lo = min(x[0], x[-3])
                px = (ra - lo) % 360 + lo
                inside ^= pip(px, dec, x, y)
            else:
                hit = np.zeros(N, dtype=bool)
                for shift in (-360, 0, 360):
                    hit |= pip(ra + shift, dec, x, y)
                inside ^= hit
    level[inside] = np.maximum(level[inside], lv)
sel = level > 0
out = []
for a, d, l in zip(ra[sel], dec[sel], level[sel]):
    out += [r2(ra0(float(a))), r2(float(d)), int(l)]
dump('milkyway.json', {'n': N, 'd': out})
print('milky way samples:', int(sel.sum()), 'of', N)
