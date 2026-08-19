import type { Ring } from './geo';
import type { ArcRef } from './topology';
import type { CityJson } from '../../src/sim/map/MapData';
import type { LccParams } from './geo';
import type { BuiltProvinces } from './build';

export interface SubdivideInput {
  units: { code: string; tag: string; rings: Ring[]; ringRefs: ArcRef[][] }[];
  cities: CityJson[];
  target: number;
  projection: LccParams;
}

/**
 * Iteration 2 of the map: cuts each nation into provinces and groups them into
 * states. Implemented in step 8 of the build order; the country-level map does
 * not call it.
 */
export function subdivideProvinces(_input: SubdivideInput): BuiltProvinces {
  throw new Error('subdivideProvinces: not implemented yet (run with --countries-only)');
}
