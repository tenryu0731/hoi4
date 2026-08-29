import type { ResourceType, TerrainType } from '../core/types';

/**
 * Wire format of `public/data/map.json`, produced by `tools/map-build`.
 *
 * Two things about this format are worth knowing before reading anything else.
 *
 * **The geometry is a topology, not a bag of polygons.** Every boundary on the
 * map is stored once, in `arcs`, and a province's rings are lists of signed
 * references into it -- `i` reads arc `i` forward, `~i` reads it backwards.
 * Two neighbours therefore share the same vertices by construction rather than
 * by agreement, which is what stops a sliver of sea opening between them, and
 * the file does not pay twice for a border that two provinces both own. It is
 * also what makes the border tiers cheap: `borders` is four lists of arc
 * indices rather than four more copies of the same lines.
 *
 * **Render coordinates and real distances are different things.** 「円筒図法に
 * して、距離は別に持つ」. The map draws in the reference export's own cylindrical
 * frame, so it looks like the game it is modelled on; nothing measures anything
 * in that frame, because a cylindrical projection stretches east-west by
 * 1/cos(latitude) and Narvik would be nearer Reykjavik than the map says.
 * Positions are therefore stored once, on the source lattice, and the
 * `projection` block turns them into either a render coordinate or a place on
 * the Earth. `ProvinceIndex` measures on the sphere.
 */

export const MAP_FORMAT_VERSION = 3;

/**
 * How to get from a stored integer to a render coordinate, and from a render
 * coordinate to a place on the Earth.
 *
 * Arc coordinates are integers on a lattice `quantum` times finer than the
 * source raster's pixel grid, which is what lets them stay integers after the
 * one corner-smoothing pass. Render units are `scale` of those, chosen so that
 * one unit is a kilometre along the 45th parallel -- true there, and honest
 * nowhere else, which is exactly why nothing measures with them.
 */
export interface MapProjection {
  name: 'reference';
  /** Render units per stored integer. */
  scale: number;
  /** Stored integers per source pixel. */
  quantum: number;
  /** Longitude is linear in the column: lon = lon0 + lonStep * column. */
  lon0: number;
  lonStep: number;
  /** Latitude is a polynomial in v = latV0 + row * latVStep, highest power first. */
  latPoly: number[];
  latV0: number;
  latVStep: number;
}

export interface ProvinceGeoJson {
  id: number;
  name: string;
  stateId: number;
  /** 1936 owner tag, e.g. 'GER'. */
  ownerTag: string;
  terrain: TerrainType;
  /** Victory points held by this province (0 when it holds none). */
  vp: number;
  coastal: boolean;
  /**
   * Outer rings first, each a list of signed arc references. Positive `i`
   * reads `arcs[i]` forward; negative reads `arcs[~i]` backwards.
   *
   * Which of them are holes is not stored: every ring is wound with the
   * province on its left, so an outer boundary and a hole come out with
   * opposite signed areas and the reader can see it for itself.
   */
  rings: number[][];
  /**
   * Where a counter goes, in the same lattice integers the arcs use. The
   * projection turns it into render units and into a place on the Earth, so
   * the file does not carry the same point twice in two coordinate systems.
   */
  center: [number, number];
  /** Square kilometres, measured on the sphere rather than on the page. */
  area: number;
  neighbors: number[];
  /** Reachable across a strait or a short sea crossing. */
  seaNeighbors: number[];
}

export interface StateGeoJson {
  id: number;
  name: string;
  ownerTag: string;
  provinces: number[];
  /** Recruitable population in thousands. */
  manpower: number;
  resources: Partial<Record<ResourceType, number>>;
  infrastructure: number;
  civilianFactories: number;
  militaryFactories: number;
  dockyards: number;
  /**
   * Shared civilian + military factory slots, scaled by population. A flat cap
   * would be meaningless: one state is an entire nation on the country-level
   * map and a handful of provinces once the map is subdivided.
   */
  buildingSlots: number;
}

export interface CityJson {
  name: string;
  /** Lattice integers, as the arcs and province centres use. */
  x: number;
  y: number;
  /** Population in thousands, circa 1936 estimate. */
  pop: number;
  province: number;
  capitalOf: string | null;
  vp: number;
}

export interface MapDataJson {
  version: number;
  projection: MapProjection;
  /** [minX, minY, maxX, maxY] over all land geometry, in render units. */
  bounds: [number, number, number, number];
  /**
   * Every boundary line on the map, each stored once.
   *
   * Delta-encoded: `[x0, y0, dx1, dy1, ...]`, lattice integers throughout. The
   * points of an arc are a few units apart and the map is seven thousand units
   * across, so the deltas are one or two digits where the absolute positions
   * are four -- worth about a fifth of the whole file, for a decode that is
   * one running sum.
   */
  arcs: number[][];
  provinces: ProvinceGeoJson[];
  states: StateGeoJson[];
  /** The land silhouette, as rings of signed arc references. */
  land: number[][];
  /** Rivers, as flat polylines of lattice integers. */
  rivers: number[][];
  /**
   * Arc indices by the tier they belong to. Every arc appears in exactly one
   * of these, so the four together are the whole boundary set.
   */
  borders: {
    /** Between two different countries. */
    country: number[];
    /** Between two states of the same country. */
    state: number[];
    /** Between two provinces of the same state. */
    province: number[];
    /** Land against water, or the edge of the map. */
    coast: number[];
  };
  cities: CityJson[];
}
