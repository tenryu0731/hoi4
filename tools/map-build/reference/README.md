# What the reference map is for

Two facts about *Hearts of Iron IV*'s map are worth copying, and neither of them
is geometry:

- **`hoi4-states.json`** — which of our cells belong together. A raster of cell
  ids plus the lon/lat fit that places it. The build reads it to group its own
  cells; it never takes a line from it.
- **`hoi4-province-density.json`** — how many square kilometres the reference
  gives one province, on a 1.5° lattice. The build reads it to decide how finely
  to cut a state.

Both are weaker witnesses than their names suggest, and the build corrects for
both — see **What the raster actually segments** below.

Every border the game draws comes from **Natural Earth** (public domain), at
10 m resolution, with the 1936 owners applied by `historical.ts`.

## Why not trace the map instead

Because tracing it would make the map worse. The screenshots are around a
thousand pixels across for the whole of Europe, so one pixel is about eleven
kilometres and a province is four to six pixels. Traced, every coastline would
come back as an eleven-kilometre staircase. Natural Earth's coastline is two
orders of magnitude finer, and the reference is not needed for it — only for
the two things above, which are counts and groupings rather than shapes.

## Regenerating

    python3 tools/map-build/reference/derive/derive.py states.png provinces.png

Needs `numpy`, `scipy` and `pillow`, and two screenshots of the game map — one
in state mode, one in province mode — which are not in this repository. The
script georeferences each against Natural Earth's coastline by searching for the
lon/lat window that maximises the overlap of the land masks, which reaches an
intersection-over-union of 0.86 for the state map and 0.93 for the province map.
It prints both, and they are the number to watch: a fit below about 0.85 means
the screenshot is cropped differently than the search expects and the tables it
produces will be off by a state's width.

## How closely the result follows it

Measured after a build, against the same screenshots:

| | |
|---|---|
| our state borders within one pixel of a reference cell edge | **49%** |
| within three pixels | **75%** |
| states | 344, against 415 cells in the reference's window and 246 thick-bordered regions |
| provinces | 2169, a median of 6 to a state |

The first two numbers were 75% and 81% when the build followed the raster's
cells exactly, and they went down on purpose. See below.

## What the raster actually segments

Not states. `derive.py` finds cells as connected runs of flat colour, and in a
state-mode screenshot Hearts of Iron draws its *province* borders inside each
state as thin lines of the same shade. A run of flat colour therefore stops at
a province border, not a state one, and the raster is a province map wearing a
state map's name.

It is not a clean province map either — the 12-pixel floor and the fitted
window drop most of them, which is why the count came out at 415 and looked
like a plausible number of states. What survives is uneven: counted against the
real game, Germany came out about right while Iceland was split into six,
Latvia into seven and Lithuania into seven. Cropping the Baltic out of the
screenshot and counting by hand settles it — twenty-seven cells across three
countries that have five or six states between them.

Two corrections follow from that, both in the build rather than here:

- `STATE_BUDGET_1936` in `historical.ts` gives each country the number of
  states the real game gives it, and the smallest are folded into their
  neighbours until the count fits. This is what the two agreement figures paid
  for: our borders now follow the real game's *states*, and the raster's edges
  are mostly province borders, so matching fewer of them is the point.
- `SETTLEMENT_REACH` in `provinces.ts` puts a floor under the cell size that
  follows where the towns are. The density lattice reads a screenshot too, and
  a screenshot of Lapland is mostly snow: it claimed as many borders per square
  degree above the Arctic circle as in Poland, which gave northern Sweden
  seventy provinces in one state and Iceland forty-two.

Segmenting by border *thickness* instead — state borders are drawn heavier than
province borders — yields 246 regions, which is state-scale, and would let the
raster carry state shapes rather than just groupings. It is not wired up: the
budget already fixes the counts, and the shapes would need the whole downstream
calibration measured again.
