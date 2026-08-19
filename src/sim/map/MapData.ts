import type { ResourceType, TerrainType } from '../core/types';

/**
 * Wire format of `public/data/map.json`, produced by `tools/map-build`.
 *
 * Coordinates are in world units where 1 unit is approximately 1 km, already
 * projected (Lambert Conformal Conic) so the runtime never does trigonometry on
 * geographic coordinates. Rings are flat `[x0, y0, x1, y1, ...]` arrays because
 * that halves the JSON size versus nested pairs and feeds straight into Pixi.
 */

export const MAP_FORMAT_VERSION = 2;

export interface MapProjection {
  name: 'lcc';
  lon0: number;
  lat0: number;
  lat1: number;
  lat2: number;
  scale: number;
  offsetX: number;
  offsetY: number;
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
  /** Outer rings first; a province may be a multipolygon (colonies, islands). */
  rings: number[][];
  /** Ring index to nesting depth: 0 = outer, 1 = hole. */
  ringDepth: number[];
  center: [number, number];
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
  /** [minX, minY, maxX, maxY] over all land geometry. */
  bounds: [number, number, number, number];
  provinces: ProvinceGeoJson[];
  states: StateGeoJson[];
  /** Full land silhouette including land outside any playable nation. */
  land: number[][];
  lakes: number[][];
  rivers: number[][];
  cities: CityJson[];
  /** Border segments classified for rendering. */
  borders: {
    /** Between two different countries. */
    country: number[][];
    /** Between two provinces of the same country. */
    province: number[][];
    /** Land/water edge. */
    coast: number[][];
  };
}
