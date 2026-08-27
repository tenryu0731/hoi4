#!/usr/bin/env python3
"""
Reads the two reference tables out of screenshots of the game map.

    python3 tools/map-build/reference/derive/derive.py states.png provinces.png

Neither screenshot is in this repository and neither needs to be: what the
build uses is the two JSON files next to this directory, and they carry no
geometry -- one says which provinces belong to the same state, the other says
how finely a part of the world is cut up. Everything the game draws comes from
Natural Earth.

The work is in three steps.

1.  Georeference. The screenshots are in the game's own projection, which is
    not documented, so it is fitted: rasterise Natural Earth's coastline,
    then search for the lon/lat window that makes the screenshot's own
    land/sea mask overlap it best. Longitude comes out linear in the column;
    latitude needs a cubic in the row, and with one the fit reaches an
    intersection-over-union of 0.86-0.88 against the coastline -- close enough
    that the overlay agrees to a couple of pixels along every European coast.

2.  Cells. A state is a patch of flat colour bounded by a drawn border, so the
    interiors are found first (a 3x3 neighbourhood that is all one colour, which
    the antialiased border lines fail) and the borders are then grown back into
    the nearest interior. Provinces are the same idea inverted: the border lines
    are found as local dips in brightness and the cells are what is left.

3.  Export. The state cells go out as a raster of cell ids, gzipped and
    base64'd. The province cells go out as a density grid -- how many square
    kilometres the reference gives one province, on a 1.5-degree lattice.
"""

import base64
import gzip
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.optimize import minimize

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, 'land.npy')
LAND_GEOJSON = os.path.join(OUT, '..', '..', '.cache', 'ne_10m_land.geojson')

# The window the coastline raster covers, and how fine it is.
LON0, LON1, LAT0, LAT1, STEP = -32.0, 72.0, 18.0, 76.0, 0.04
W = int((LON1 - LON0) / STEP)
H = int((LAT1 - LAT0) / STEP)

# The sea in the province screenshot is one specific slate blue. Testing for
# "bluish" instead put navy-coloured France in the ocean.
SEA_RGB = np.array([68, 106, 164])


def coastline():
    if os.path.exists(CACHE):
        return np.load(CACHE)
    fc = json.load(open(LAND_GEOJSON))
    grid = np.zeros((H, W), dtype=bool)
    for f in fc['features']:
        g = f['geometry']
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        for poly in polys:
            for ring in poly:
                pts = np.array(ring, dtype=float)
                x = (pts[:, 0] - LON0) / STEP
                y = (LAT1 - pts[:, 1]) / STEP
                lo = max(0, int(np.floor(y.min())))
                hi = min(H - 1, int(np.ceil(y.max())))
                for row in range(lo, hi + 1):
                    yc = row + 0.5
                    y0, y1 = y[:-1], y[1:]
                    x0, x1 = x[:-1], x[1:]
                    hit = (y0 > yc) != (y1 > yc)
                    if not hit.any():
                        continue
                    t = (yc - y0[hit]) / (y1[hit] - y0[hit])
                    xs = np.sort(x0[hit] + t * (x1[hit] - x0[hit]))
                    for i in range(0, len(xs) - 1, 2):
                        a = max(0, int(np.ceil(xs[i] - 0.5)))
                        b = min(W - 1, int(np.floor(xs[i + 1] - 0.5)))
                        if b >= a:
                            grid[row, a:b + 1] ^= True
    np.save(CACHE, grid)
    return grid


LAND = coastline()


def land_mask(path, sea):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
    if sea == 'black':
        return im.max(axis=2) > 8
    return np.abs(im - SEA_RGB).max(axis=2) > 26


def sample(lons, lats):
    xi = ((lons - LON0) / STEP).astype(int)
    yi = ((LAT1 - lats) / STEP).astype(int)
    ok = (xi >= 0) & (xi < W) & (yi >= 0) & (yi < H)
    out = np.zeros(lons.shape, bool)
    out[ok] = LAND[yi[ok], xi[ok]]
    return out


def lat_at(p, v):
    return p[2] + p[3] * v + p[4] * v * v + p[5] * v * v * v


def row_of(p, lat):
    """Bisection. The polynomial is monotone across the image."""
    lo, hi = 0.0, 1.0
    a, b = lat_at(p, lo), lat_at(p, hi)
    if (lat - a) * (lat - b) > 0:
        return None
    down = a > b
    for _ in range(60):
        m = (lo + hi) / 2
        if (lat_at(p, m) > lat) == down:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def fit(path, sea, guess, restarts=22):
    mask = land_mask(path, sea)[::2, ::2]
    h, w = mask.shape
    py, px = np.mgrid[0:h, 0:w]
    u = (px + 0.5) / w
    v = (py + 0.5) / h

    def cost(p):
        if p[1] <= 5 or abs(p[3]) < 2:
            return 1.0
        ref = sample(p[0] + p[1] * u, lat_at(p, v))
        return 1 - (ref & mask).sum() / max(1, (ref | mask).sum())

    best, score = None, 1.0
    for i in range(restarts):
        rng = np.random.default_rng(i)
        start = np.array(guess, float) + (rng.normal(0, [2, 4, 2, 4, 4, 4], 6) if i else 0)
        r = minimize(cost, start, method='Nelder-Mead',
                     options=dict(maxiter=4000, xatol=1e-3, fatol=1e-5))
        if r.fun < score:
            score, best = r.fun, r.x
    return best, 1 - score


def state_cells(path, flat_tol=6, min_px=12):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
    h, w, _ = im.shape
    land = im.max(axis=2) > 10
    mx = ndimage.maximum_filter(im, size=(3, 3, 1))
    mn = ndimage.minimum_filter(im, size=(3, 3, 1))
    flat = ((mx - mn).max(axis=2) <= flat_tol) & land
    key = ((im[:, :, 0].astype(np.int64) << 16)
           | (im[:, :, 1].astype(np.int64) << 8) | im[:, :, 2])
    lab = np.zeros((h, w), np.int32)
    nxt = 0
    for colour in np.unique(key[flat]):
        m = flat & (key == colour)
        piece, n = ndimage.label(m)
        lab[m] = piece[m] + nxt
        nxt += n
    sizes = np.bincount(lab.ravel())
    keep = np.where(sizes >= min_px)[0]
    keep = keep[keep > 0]
    remap = np.zeros(sizes.shape, np.int32)
    remap[keep] = np.arange(1, len(keep) + 1)
    lab = remap[lab]
    _, idx = ndimage.distance_transform_edt(lab == 0, return_indices=True)
    grown = lab[tuple(idx)]
    grown[~land] = 0
    return grown


def province_cells(path, dip=26, min_px=3):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
    land = np.abs(im - SEA_RGB).max(axis=2) > 26
    mx = ndimage.maximum_filter(im, size=(3, 3, 1))
    line = ((mx - im).sum(axis=2) > dip) & land
    lab, _ = ndimage.label(land & ~line)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    keep = np.where(sizes >= min_px)[0]
    remap = np.zeros(sizes.shape, np.int32)
    remap[keep] = np.arange(1, len(keep) + 1)
    lab = remap[lab]
    _, idx = ndimage.distance_transform_edt(lab == 0, return_indices=True)
    lab = lab[tuple(idx)]
    lab[~land] = 0
    return lab


def main(states_png, provinces_png):
    sp, s_iou = fit(states_png, 'black', [-28.3, 102.3, 71.7, -42.7, -10.2, 0])
    pp, p_iou = fit(provinces_png, 'blue', [-13.0, 63.5, 72.3, -34.2, -10.5, 0])
    print(f'states    IoU {s_iou:.3f}  lon {sp[0]:.2f}..{sp[0]+sp[1]:.2f}')
    print(f'provinces IoU {p_iou:.3f}  lon {pp[0]:.2f}..{pp[0]+pp[1]:.2f}')

    lab = state_cells(states_png)
    h, w = lab.shape
    n = int(lab.max())
    assert n < 65535
    payload = base64.b64encode(gzip.compress(lab.astype('<u2').tobytes(), 9)).decode()
    json.dump({
        'note': ('HOI4 state layout, read off a screenshot of the game map and '
                 'georeferenced against Natural Earth coastlines. Values are cell '
                 'ids; 0 is sea or outside. Used only to decide which provinces '
                 'form a state -- no Paradox geometry is shipped, the borders the '
                 'game draws come from Natural Earth.'),
        'width': w, 'height': h, 'cells': n,
        'fit': {'lon0': sp[0], 'lonSpan': sp[1], 'lat': list(sp[2:]),
                'model': 'lon = lon0 + lonSpan*u; lat = sum(lat[k]*v**k); u,v in [0,1)'},
        'data': payload,
    }, open(os.path.join(OUT, 'hoi4-states.json'), 'w'))
    print(f'  {n} state cells -> hoi4-states.json ({len(payload)//1024} KB)')

    plab = province_cells(provinces_png)
    ph, pw = plab.shape
    pn = int(plab.max())
    counts = np.bincount(plab.ravel())[1:]
    ys, xs = np.mgrid[0:ph, 0:pw]
    idx = np.arange(1, pn + 1)
    cy = ndimage.sum(ys, plab, index=idx) / counts
    cx = ndimage.sum(xs, plab, index=idx) / counts
    lon = pp[0] + pp[1] * (cx + 0.5) / pw
    lat = lat_at(pp, (cy + 0.5) / ph)

    step, g_lon0, g_lat0 = 1.5, -14.0, 27.0
    gw = int((51.0 - g_lon0) / step) + 1
    gh = int((73.0 - g_lat0) / step) + 1
    count = np.zeros((gh, gw))
    for a, b in zip(lon, lat):
        i, j = int((a - g_lon0) / step), int((b - g_lat0) / step)
        if 0 <= i < gw and 0 <= j < gh:
            count[j, i] += 1
    on_land = plab > 0
    land_km = np.zeros((gh, gw))
    for j in range(gh):
        centre = g_lat0 + (j + 0.5) * step
        box = (step * 111.32) ** 2 * math.cos(math.radians(centre))
        for i in range(gw):
            v0 = row_of(pp, g_lat0 + (j + 1) * step)
            v1 = row_of(pp, g_lat0 + j * step)
            if v0 is None or v1 is None:
                continue
            x0 = int((g_lon0 + i * step - pp[0]) / pp[1] * pw)
            x1 = int((g_lon0 + (i + 1) * step - pp[0]) / pp[1] * pw)
            y0, y1 = int(min(v0, v1) * ph), int(max(v0, v1) * ph)
            x0, x1 = max(0, min(x0, x1)), min(pw, max(x0, x1))
            y0, y1 = max(0, min(y0, y1)), min(ph, max(y0, y1))
            if x1 <= x0 or y1 <= y0:
                continue
            land_km[j, i] = box * on_land[y0:y1, x0:x1].mean()
    dens = np.where(land_km > 400, count / np.maximum(land_km, 1), np.nan)
    blank = np.isnan(dens)
    if blank.any():
        _, ind = ndimage.distance_transform_edt(blank, return_indices=True)
        dens = dens[tuple(ind)]
    dens = ndimage.uniform_filter(dens, size=3)
    km2 = np.clip(1.0 / np.maximum(dens, 1e-9), 500.0, 40000.0)
    json.dump({
        'note': ('Provinces per unit area, measured off a screenshot of the HOI4 '
                 'province map. Only the local density is kept -- it decides how '
                 'many cells a state is cut into, not where any border runs.'),
        'lon0': g_lon0, 'lat0': g_lat0, 'step': step, 'width': gw, 'height': gh,
        'kmPerProvince': [[round(float(x)) for x in row] for row in km2],
    }, open(os.path.join(OUT, 'hoi4-province-density.json'), 'w'))
    print(f'  {pn} province cells -> hoi4-province-density.json '
          f'({km2.min():.0f}..{km2.max():.0f} km2 each)')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
