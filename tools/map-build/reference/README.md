# The reference map

`hoi4-cells.json` is where the map comes from. It holds two rasters — one of
state-cell ids, one of province-cell ids — and the lon/lat fit that places
them. `tools/map-build` traces its cell boundaries into the shared arcs that
`public/data/map.json` ships, so **every line the game draws is the
reference's**: its coastline, its province borders, its state borders.

Natural Earth is still read, but only for facts rather than shapes:

| | |
|---|---|
| who held which ground in 1936 | `ne_10m_admin_1_states_provinces` |
| where the towns were, and how big | `ne_10m_populated_places` |
| which rivers are worth drawing | `ne_50m_rivers_lake_centerlines` |

## Provenance

This is a [mapchart.net](https://www.mapchart.net/hearts-of-iron-iv.html)
Hearts of Iron IV export, in **primary colours**:

| | |
|---|---|
| sea and lakes | pure blue |
| land | white |
| province borders | green |
| state borders | black |

The colours are the whole trick: telling the two tiers apart by the colour of
the line is exact, where telling them apart by anything else is not. An earlier
reference read a state-mode *screenshot* by runs of flat colour — but the game
draws its province borders inside each state in the same shade, so a run of
flat colour stops at a province border rather than a state one. It was a
province map wearing a state map's name, and it cut Latvia into seven.

The export must be cropped above the Horn of Africa, or mapchart's watermark
sits on land and its lettering cuts the cells underneath it into confetti.

The province layout in this file is Paradox's, and tracing it reproduces their
work rather than only their groupings. That is a deliberate choice by the
repository's owner, made after the alternative had been built and measured.

## Regenerating

    python3 tools/map-build/reference/derive/derive.py map.png

Needs `numpy`, `scipy` and `pillow`, and the export above, which is not in this
repository.

State borders are drawn *over* the province borders they follow, so a pixel or
two of green can survive beside the black. That costs nothing: a state border
is always also a province border, so black is treated as splitting both tiers,
and the hairline cells the leftovers would make fall under the minimum size.

## What it holds

| | |
|---|---|
| grid | 1702 × 1411, about 3.6 km to a pixel |
| window | lon −24.2 … 53.0, lat 26.0 … 73.0 |
| states | **435** |
| provinces | **4,271** |
| provinces to a state | median **12**, p10 4, p90 24 |

and what the build makes of it: 4,271 provinces and 483 states. The provinces
are one-for-one; the states are more numerous because a state here may not
straddle a 1936 frontier or arrive in two pieces, and the reference's own
grouping does both in a few places where its borders and Natural Earth's
disagree.

## The fit, and what it is good for

Longitude is linear in the column; latitude is a quintic in the row, fitted by
matching each row's land/sea profile against Natural Earth's coastline.
Measured against that coastline:

| | |
|---|---|
| land intersection-over-union | **0.928** |
| pixels agreeing | **96.95%** |
| root-mean-square of the row fit | **0.15°** (≈17 km) |

and measured a second way, by rasterising each 1936 administrative unit onto
this grid and comparing where its pixels land against where Natural Earth puts
its centroid: **median 7 km, p90 28 km, p99 106 km** over 1,484 units.

That is good enough to place a province, and it is *not* a promise that
distances inside the map are true. This is a game map: where Hearts of Iron IV
needs room for sea provinces it draws the coasts apart, so the Dover Strait,
thirty-four kilometres wide in life, measures a hundred and forty-four here.
The build measures crossings against this map rather than against the Earth,
and `STRAIT_KM` is set from what it finds.

Two known departures from the world:

- **Iceland** sits about 1.5° north of where Natural Earth puts it, far enough
  that Reykjavík's own coordinates land in the sea. Towns that fall outside
  every province are put ashore on the nearest ground their own country holds.
- **Malta** is not here at all: at 316 km² it is under the 250-pixel floor
  `derive.py` uses to reject the confetti left by the export's lettering.
  Nothing on this map is British Malta, and nothing should be: Sicily is drawn
  far enough south that Malta's own coordinates fall inside it, so the one
  Maltese pixel Natural Earth paints lands on a Sicilian province. Giving it
  to a Maltese parish painted a piece of Sicily British, which is why a
  rescued claim has to be either near the cell it takes or covering a real
  share of it (`RESCUE_REACH`, `RESCUE_SHARE` in `provinces.ts`).
