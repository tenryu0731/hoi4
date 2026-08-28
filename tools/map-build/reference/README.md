# What the reference map is for

Two things about *Hearts of Iron IV*'s map are worth copying, and neither of
them is geometry:

- **which of our cells belong to the same state**, and
- **where its provinces actually sit**.

`hoi4-cells.json` holds both: a raster of state-cell ids, a raster of
province-cell ids, and the lon/lat fit that places them. The build reads it to
group its own cells and to decide where to seed them. It never takes a line
from it.

Every border the game draws comes from **Natural Earth** (public domain), at
10 m resolution, with the 1936 owners applied by `historical.ts`.

## The export it is derived from

A [mapchart.net](https://www.mapchart.net/hearts-of-iron-iv.html) Hearts of
Iron IV export, in **primary colours**:

| | |
|---|---|
| sea and lakes | pure blue |
| land | white |
| province borders | green |
| state borders | black |

The colours are the whole trick. Telling the two tiers apart by the colour of
the line is exact, where telling them apart by anything else is not — see
below. The export must also be cropped above the Horn of Africa, or mapchart's
watermark sits on land and its lettering cuts the cells underneath it into
confetti.

## Regenerating

    python3 tools/map-build/reference/derive/derive.py map.png

Needs `numpy`, `scipy` and `pillow`, and the export above, which is not in this
repository.

State borders are drawn *over* the province borders they follow, so a pixel or
two of green can survive beside the black. That costs nothing here: a state
border is always also a province border, so black is treated as splitting both
tiers, and the hairline cells the leftovers would make fall under the minimum
size.

## Why not trace the map instead

Because tracing it would make the map worse, and because the geometry is not
ours to ship. Natural Earth's coastline is a couple of orders of magnitude
finer than any screenshot, and the reference is not needed for it — only for
the grouping and the seeding, which are counts and positions rather than
shapes.

## The fit

Longitude is linear in the column; latitude is a quintic in the row, fitted by
matching each row's land/sea profile against Natural Earth's coastline.
Measured against that coastline:

| | |
|---|---|
| land intersection-over-union | **0.928** |
| pixels agreeing | **96.95%** |
| root-mean-square of the row fit | **0.15°** (≈17 km) |

Longitude was also fitted column-wise as a cubic and came back no better than
the straight line (rms 0.55° either way), which is the expected answer for a
cylindrical projection.

The one place the source itself is off is Iceland, about 1.5° north of where
Natural Earth puts it — the real game's map is a game map, not a survey.

## What it reads out

| | |
|---|---|
| states | **435** |
| provinces | **4,271** |
| provinces to a state | median **12**, p10 4, p90 24 |

and what the build makes of it:

| | ours | reference |
|---|---|---|
| states | 450 | 435 |
| provinces | 4,222 | 4,271 |
| provinces to a state | median 8 | median 12 |
| our land against its land, in its own frame | IoU **0.870** | — |

## The reference this replaced, and why

The previous one read a state-mode *screenshot* by runs of flat colour. In
state mode the game still draws its province borders inside each state, in the
same shade — so a run of flat colour stops at a province border, not a state
one. It was a province map wearing a state map's name.

It was not a clean province map either: a 12-pixel floor and the fitted window
dropped most of them, which left 415 cells and looked like a plausible number
of states. What survived was uneven — Germany came out about right while
Iceland was split into six and Latvia into seven, which is what players saw as
「ドイツ以外が細すぎる」.

Two workarounds existed to compensate, and both are gone with it: a hand-written
table of state counts per country, and a floor on cell size that followed where
the towns were. Neither is needed once the reference can be believed.
