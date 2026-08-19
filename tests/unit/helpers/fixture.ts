import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProvinceIndex } from '../../../src/sim/map/ProvinceIndex';
import type { MapDataJson } from '../../../src/sim/map/MapData';
import { createScenario } from '../../../src/sim/scenario/europe1936';
import type { Country, GameState } from '../../../src/sim/core/types';

/** Shared, cached map load: parsing map.json for every test file is wasteful. */
let cached: MapDataJson | null = null;

export function loadMap(): MapDataJson {
  if (!cached) {
    cached = JSON.parse(
      readFileSync(join(process.cwd(), 'public', 'data', 'map.json'), 'utf8'),
    ) as MapDataJson;
  }
  return cached;
}

export function makeIndex(): ProvinceIndex {
  return ProvinceIndex.load(loadMap());
}

export interface Fixture {
  index: ProvinceIndex;
  state: GameState;
  country(tag: string): Country;
  provinceOf(tag: string): number;
}

export function makeFixture(opts: { seed?: number; playerTag?: string } = {}): Fixture {
  const index = makeIndex();
  const state = createScenario(index, opts);
  return {
    index,
    state,
    country(tag: string): Country {
      const c = state.countries.find((x) => x.tag === tag);
      if (!c) throw new Error(`no country ${tag}`);
      return c;
    },
    provinceOf(tag: string): number {
      const p = index.provinces.find((x) => x.ownerTag === tag);
      if (!p) throw new Error(`no province for ${tag}`);
      return p.id;
    },
  };
}
