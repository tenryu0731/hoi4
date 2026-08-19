import type { CountryId, GameState, ProvinceId } from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';

/**
 * Supply propagation.
 *
 * Supply flows outward from each country's capital (and from the capitals of
 * its faction partners, so an ally's ports keep an expeditionary force fed)
 * through provinces that side controls. Range decays with distance and is
 * extended by infrastructure, which is what makes a deep advance run out of
 * steam and an encircled pocket wither.
 *
 * The result is one number per province per side: `0` means no supply reaches
 * it at all, `1` means fully supplied.
 */

/** How much a fully developed rail network extends reach. */
const INFRA_BONUS = 0.55;
/** Supply lost per step beyond the source. */
const DECAY_PER_STEP = 0.13;

export interface SupplyMap {
  /** Indexed by province; 0..1. */
  levels: Float32Array;
}

/**
 * Computes supply for one country over the provinces it controls.
 *
 * Deliberately a plain BFS with a decay term rather than a flow network: the
 * province graph is small, this runs daily for every country at war, and the
 * gameplay only needs "how far from home are you" to be legible.
 */
export function computeSupply(
  state: GameState,
  index: ProvinceIndex,
  country: CountryId,
  sources: ProvinceId[],
): Float32Array {
  const n = index.count;
  const levels = new Float32Array(n);
  if (sources.length === 0) return levels;

  const controlledBy = (id: ProvinceId) => state.provinces[id].controller === country;

  // Best-first: always expand the province with the most supply left, so a
  // province reached by two routes keeps the better one.
  const queue: ProvinceId[] = [];
  for (const src of sources) {
    if (!controlledBy(src)) continue;
    levels[src] = 1;
    queue.push(src);
  }

  let head = 0;
  while (head < queue.length) {
    // Pull the highest-supply frontier node.
    let bestIdx = head;
    for (let i = head + 1; i < queue.length; i++) {
      if (levels[queue[i]] > levels[queue[bestIdx]]) bestIdx = i;
    }
    const cur = queue[bestIdx];
    queue[bestIdx] = queue[head];
    queue[head] = cur;
    head++;

    const here = levels[cur];
    if (here <= 0.02) continue;

    const geo = index.get(cur);
    const infra = state.states[geo.stateId]?.infrastructure ?? 1;
    // Better infrastructure means each hop costs less supply.
    const step = DECAY_PER_STEP * (1 - ((infra - 1) / 4) * INFRA_BONUS);

    for (const nb of geo.neighbors) {
      if (!controlledBy(nb)) continue;
      const candidate = here - step;
      if (candidate > levels[nb] + 1e-6) {
        levels[nb] = candidate;
        queue.push(nb);
      }
    }
    // Sea crossings carry supply, but poorly: an amphibious lodgement is
    // always short of everything until a port is captured.
    for (const nb of geo.seaNeighbors) {
      if (!controlledBy(nb)) continue;
      const candidate = here - step * 3;
      if (candidate > levels[nb] + 1e-6) {
        levels[nb] = candidate;
        queue.push(nb);
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (levels[i] < 0) levels[i] = 0;
    else if (levels[i] > 1) levels[i] = 1;
  }
  return levels;
}

/** Provinces a country draws supply from: its capital plus allied capitals. */
export function supplySources(state: GameState, country: CountryId): ProvinceId[] {
  const c = state.countries[country];
  const out: ProvinceId[] = [];
  if (state.provinces[c.capital]?.controller === country) out.push(c.capital);

  if (c.factionId !== null) {
    for (const memberId of state.factions[c.factionId].members) {
      if (memberId === country) continue;
      const member = state.countries[memberId];
      if (member.capitulated) continue;
      // An ally's capital only helps if this country can actually reach it,
      // which the BFS enforces by only walking provinces it controls.
      const cap = member.capital;
      if (state.provinces[cap]?.controller === country) out.push(cap);
    }
  }
  return out;
}

/**
 * Recomputes supply for every country at war and writes the result onto the
 * provinces. A province's stored supply is that of whoever controls it.
 */
export function tickSupplyDaily(state: GameState, index: ProvinceIndex): void {
  const active = new Set<CountryId>();
  for (const c of state.countries) {
    if (c.capitulated) continue;
    if (c.atWarWith.length > 0) active.add(c.id);
  }
  // Peacetime countries sit at full supply at home; only wars create shortages.
  for (let i = 0; i < state.provinces.length; i++) {
    const p = state.provinces[i];
    p.supply = active.has(p.controller) ? 0 : 1;
  }

  for (const country of active) {
    const levels = computeSupply(state, index, country, supplySources(state, country));
    for (let i = 0; i < levels.length; i++) {
      if (state.provinces[i].controller !== country) continue;
      if (levels[i] > state.provinces[i].supply) state.provinces[i].supply = levels[i];
    }
  }

  for (const d of state.divisions) {
    if (d.dead) continue;
    d.supplyLevel = state.provinces[d.provinceId].supply;
  }
}

/**
 * Provinces a country controls that are cut off from its supply sources.
 *
 * An encircled pocket cannot be reinforced and its divisions bleed out, which
 * is the decisive mechanic of the period and the thing that makes a
 * breakthrough worth more than a grind.
 */
export function encircledProvinces(
  state: GameState, index: ProvinceIndex, country: CountryId,
): Set<ProvinceId> {
  const sources = supplySources(state, country);
  const connected = new Set<ProvinceId>();
  for (const src of sources) {
    if (state.provinces[src].controller !== country) continue;
    for (const id of index.reachable(src, (p) => state.provinces[p].controller === country)) {
      connected.add(id);
    }
  }
  const out = new Set<ProvinceId>();
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller === country && !connected.has(i)) out.add(i);
  }
  return out;
}
