"""
Reads a mapchart Hearts of Iron IV export and writes the two tables the build
needs. Not run automatically: it needs a screenshot that is not in the repo.

    python3 tools/map-build/reference/derive/derive.py map.png

The export must use primary colours -- blue sea and lakes, green province
borders, black state borders, white land -- which is what makes the two tiers
separable at all. A state border is drawn over the province border it follows,
so black splits both tiers and the odd green pixel left beside it is harmless.
"""
import gzip, base64, json, sys
import numpy as np
from scipy import ndimage
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else '.ref/mc2.png'
OUT = 'tools/map-build/reference/hoi4-cells.json'
# The window the game covers, in source pixels: lon -24.2..53, lat 73..26.
X0, X1, Y0, Y1 = 0, 3404, 1871, 4692
SHRINK = 2

a, b = np.load('.ref/mc2_lon.npy')          # lon = a + b*x   (full-image x)
lat_poly = np.load('.ref/mc2_lat.npy')      # lat = poly(y / 6000)
FULL_H = 6000

im = np.asarray(Image.open(SRC).convert('RGB')).astype(np.int16)
r, g, bl = im[:, :, 0], im[:, :, 1], im[:, :, 2]
mx = im.max(2)
water = (bl - np.maximum(r, g)) > 40
green = (g - np.maximum(r, bl)) > 40
line = ~water & ~green & (mx < 210)
land = ~water

sl = (slice(Y0, Y1), slice(X0, X1))
land, green, line = land[sl], green[sl], line[sl]

def cells(mask, min_px):
    lab, _ = ndimage.label(mask & land)
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    keep = np.where(sizes >= min_px)[0]
    remap = np.zeros(sizes.shape, np.int32); remap[keep] = np.arange(1, len(keep) + 1)
    lab = remap[lab]
    _, idx = ndimage.distance_transform_edt(lab == 0, return_indices=True)
    out = lab[tuple(idx)]
    out[~land] = 0
    return out.astype(np.uint16), len(keep)

states, nst = cells(~line, 500)
provs, npv = cells(~line & ~green, 250)
states = states[::SHRINK, ::SHRINK]
provs = provs[::SHRINK, ::SHRINK]
H, W = states.shape
assert nst < 65535 and npv < 65535

def pack(arr):
    return base64.b64encode(gzip.compress(arr.tobytes(), 9)).decode('ascii')

doc = {
    'note': 'HOI4 state and province cell ids. Groupings only -- every line the '
            'game draws comes from Natural Earth.',
    'width': W, 'height': H,
    'states': nst, 'provinces': npv,
    # lon is linear in the column; lat is a quintic in the row, both fitted
    # against Natural Earth's coastline (IoU 0.928, rms 0.15 degrees).
    'lon0': float(a + b * X0), 'lonStep': float(b * SHRINK),
    'latPoly': [float(v) for v in lat_poly],
    'latY0': Y0, 'latScale': float(SHRINK / FULL_H),
    'stateCells': pack(states), 'provinceCells': pack(provs),
}
json.dump(doc, open(OUT, 'w'), separators=(',', ':'))
import os
print(f'{OUT}: {W}x{H}, {nst} states, {npv} provinces, {os.path.getsize(OUT)//1024} KB')
