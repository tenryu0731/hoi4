import type { CountryId, GameState, ProvinceId } from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';

/**
 * Supply propagation.
 *
 * Supply flows outward from supply heads through ground the country's own
 * coalition holds, losing strength with every province crossed and regaining
 * some of it where the rail network is good. That single rule produces the two
 * behaviours the period needs: a deep advance runs out of steam, and a pocket
 * that has been cut off withers instead of fighting on forever.
 *
 * A country has three kinds of supply head:
 *   - its capital, at full strength;
 *   - allied capitals, slightly weaker, because a coalition shares its rear;
 *   - a port in any theatre the capital cannot reach overland, weaker again,
 *     standing in for convoy traffic.
 *
 * That last one matters more than it looks. Without it, French North Africa and
 * British Egypt begin the scenario at zero supply and start starving on day one,
 * despite being connected to home by the sea lanes the whole war was fought over.
 */

/** How much a fully developed rail network extends reach. */
const INFRA_BONUS = 0.55;
/** Supply lost per province crossed. */
const DECAY_PER_STEP = 0.13;
/** Extra cost of pushing supply across a strait. */
const SEA_STEP_MULTIPLIER = 3;

/** Strength of each kind of supply head. */
export const SUPPLY_STRENGTH = {
  capital: 1,
  alliedCapital: 0.8,
  /** A port sustaining a theatre the capital cannot reach by land. */
  overseasPort: 0.6,
} as const;

export interface SupplySource {
  province: ProvinceId;
  strength: number;
}

/** Provinces held by a country's own coalition. */
function friendlyController(state: GameState, country: CountryId): (id: ProvinceId) => boolean {
  const c = state.countries[country];
  const bloc = new Set<CountryId>([country]);
  if (c.factionId !== null) {
    for (const m of state.factions[c.factionId].members) {
      if (!state.countries[m].capitulated) bloc.add(m);
    }
  }
  return (id: ProvinceId) => bloc.has(state.provinces[id].controller);
}

/**
 * Works out where a country's supply comes from.
 *
 * Territory is split into connected components; whichever holds the capital is
 * the metropolitan theatre, and any other component has to be fed through a
 * port it owns. A component with no port is genuinely cut off.
 */
export function supplySources(
  state: GameState, index: ProvinceIndex, country: CountryId,
): SupplySource[] {
  const c = state.countries[country];
  if (c.capitulated) return [];
  const friendly = friendlyController(state, country);
  const mine = (id: ProvinceId) => state.provinces[id].controller === country;

  const out: SupplySource[] = [];
  const visited = new Set<ProvinceId>();

  if (friendly(c.capital)) {
    out.push({ province: c.capital, strength: SUPPLY_STRENGTH.capital });
    for (const id of index.reachable(c.capital, friendly, { includeSea: true })) visited.add(id);
  }

  if (c.factionId !== null) {
    for (const memberId of state.factions[c.factionId].members) {
      if (memberId === country) continue;
      const member = state.countries[memberId];
      if (member.capitulated) continue;
      if (!friendly(member.capital) || visited.has(member.capital)) continue;
      out.push({ province: member.capital, strength: SUPPLY_STRENGTH.alliedCapital });
      for (const id of index.reachable(member.capital, friendly, { includeSea: true })) {
        visited.add(id);
      }
    }
  }

  // Anything still unvisited is a separate theatre, suppliable only through a
  // port the country owns.
  for (let i = 0; i < state.provinces.length; i++) {
    if (!mine(i) || visited.has(i)) continue;
    const component = index.reachable(i, friendly, { includeSea: true });

    let port = -1;
    let bestVp = -1;
    for (const id of component) {
      visited.add(id);
      const geo = index.get(id);
      // Only home or colonial territory sustains a port; ground just taken from
      // the enemy does not come with a working supply base.
      if (state.provinces[id].owner !== country) continue;
      if (!geo.coastal) continue;
      if (geo.vp > bestVp) { bestVp = geo.vp; port = id; }
    }
    if (port >= 0) out.push({ province: port, strength: SUPPLY_STRENGTH.overseasPort });
  }

  return out;
}

/**
 * Computes supply levels for one country.
 *
 * Best-first rather than plain breadth-first: a province reachable by two routes
 * keeps the better one, which is what makes a well-connected rear resilient to
 * losing any single corridor.
 */
export function computeSupply(
  state: GameState,
  index: ProvinceIndex,
  country: CountryId,
  sources: SupplySource[],
): Float32Array {
  const n = index.count;
  const levels = new Float32Array(n);
  if (sources.length === 0) return levels;

  const friendly = friendlyController(state, country);

  const queue: ProvinceId[] = [];
  for (const src of sources) {
    if (!friendly(src.province)) continue;
    if (src.strength > levels[src.province]) {
      levels[src.province] = src.strength;
      queue.push(src.province);
    }
  }

  let head = 0;
  while (head < queue.length) {
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
    const step = DECAY_PER_STEP * (1 - ((infra - 1) / 4) * INFRA_BONUS);

    for (const nb of geo.neighbors) {
      if (!friendly(nb)) continue;
      const candidate = here - step;
      if (candidate > levels[nb] + 1e-6) {
        levels[nb] = candidate;
        queue.push(nb);
      }
    }
    for (const nb of geo.seaNeighbors) {
      if (!friendly(nb)) continue;
      const candidate = here - step * SEA_STEP_MULTIPLIER;
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

/**
 * Recomputes supply for every country at war and writes it onto the provinces.
 * A province's stored supply is that of whoever controls it.
 */
export function tickSupplyDaily(state: GameState, index: ProvinceIndex): void {
  const active: CountryId[] = [];
  for (const c of state.countries) {
    if (c.capitulated) continue;
    if (c.atWarWith.length > 0) active.push(c.id);
  }
  // Peacetime countries sit at full supply at home; only wars create shortages.
  const atWar = new Set(active);
  for (let i = 0; i < state.provinces.length; i++) {
    const p = state.provinces[i];
    p.supply = atWar.has(p.controller) ? 0 : 1;
  }

  for (const country of active) {
    const levels = computeSupply(state, index, country, supplySources(state, index, country));
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
 * Provinces a country controls that no supply head can reach.
 *
 * This is the encirclement test. A theatre with a friendly port is not
 * encircled, however far from home it is: Egypt in 1936 is not a pocket. A
 * landlocked salient with the enemy behind it is.
 */
export function encircledProvinces(
  state: GameState, index: ProvinceIndex, country: CountryId,
): Set<ProvinceId> {
  const sources = supplySources(state, index, country);
  const friendly = friendlyController(state, country);
  const connected = new Set<ProvinceId>();
  for (const src of sources) {
    if (!friendly(src.province)) continue;
    for (const id of index.reachable(src.province, friendly, { includeSea: true })) {
      connected.add(id);
    }
  }
  const out = new Set<ProvinceId>();
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller === country && !connected.has(i)) out.add(i);
  }
  return out;
}
