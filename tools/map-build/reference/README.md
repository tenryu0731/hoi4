# What the reference map is for

Two facts about *Hearts of Iron IV*'s map are worth copying, and neither of them
is geometry:

- **`hoi4-states.json`** — which provinces belong to the same state. A raster of
  state-cell ids plus the lon/lat fit that places it. The build reads it to
  group its own cells; it never takes a line from it.
- **`hoi4-province-density.json`** — how many square kilometres the reference
  gives one province, on a 1.5° lattice. The build reads it to decide how finely
  to cut a state.

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
| provinces, ours vs the reference, over thirteen regions of Europe | **1.00** (0.93–1.10 by region) |
| our state borders within one pixel of one of theirs | **71%** |
| within three pixels | **81%** |
| states | 425, against 415 cells in the reference's window |
