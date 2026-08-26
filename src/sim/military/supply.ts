import type { CountryId, GameState, ProvinceId } from '../core/types';
import { effectiveTemplate } from '../research';
import { commandModifiers } from './command';
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

/**
 * How far a supply head reaches, in world units, over undeveloped ground.
 *
 * Distance, not province hops. It used to be a flat 0.13 lost per province
 * crossed, which made supply range a function of how finely the map happened
 * to be cut: the subdivision pass took the map from 323 provinces to 1,266,
 * roughly doubling the hops across the same ground, and this constant was
 * never re-tuned. Measured at that setting, seven years into a campaign:
 *
 *   GER  front 16 steps from Berlin, supply there 0.00
 *   SOV  median division 11 steps from Moscow, supply there 0.20
 *
 * -- and organisation recovery scales with supply, so 17 of Germany's 23
 * divisions and 24 of the Soviet Union's 32 sat permanently below the
 * quarter-organisation mark at which the AI classes a division as spent and
 * tells it to hold. That is why the war stopped: from 1943 the whole map had
 * zero division-days of combat and no province changed hands, with 656
 * divisions standing on it.
 *
 * The map's own edges are 66 to 185 units long, so charging every hop the
 * same was wrong twice over. Berlin to Paris is 874 units, which is the
 * yardstick this is set against: a base-infrastructure line supplies an
 * offensive that far and no further, and a fully railed one a little over
 * twice that.
 */
export const SUPPLY_RANGE = 1200;
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
    // Cost per world unit, cheaper where the railways are good.
    const rate = (1 / SUPPLY_RANGE) * (1 - ((infra - 1) / 4) * INFRA_BONUS);

    for (const nb of geo.neighbors) {
      if (!friendly(nb)) continue;
      const candidate = here - rate * index.distance(cur, nb);
      if (candidate > levels[nb] + 1e-6) {
        levels[nb] = candidate;
        queue.push(nb);
      }
    }
    for (const nb of geo.seaNeighbors) {
      if (!friendly(nb)) continue;
      const candidate = here - rate * index.distance(cur, nb) * SEA_STEP_MULTIPLIER;
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

  applyThroughput(state, index);

  for (const d of state.divisions) {
    if (d.dead) continue;
    d.supplyLevel = state.provinces[d.provinceId].supply;
  }
}

/**
 * Supply throughput one point of infrastructure adds, in template supply units.
 *
 * An infantry division draws about 0.5, so a province on a rail hub
 * (infrastructure 5) carries roughly ten divisions before it starts to choke
 * and a poor one (infrastructure 1) about four. That range is the point: it
 * makes a wide front cheaper to hold than a deep stack, which is the decision
 * the operational layer was missing.
 */
const THROUGHPUT_PER_INFRASTRUCTURE = 0.7;

/** Even a roadless province supports a screen without collapsing. */
const BASE_THROUGHPUT = 1.6;

/**
 * Charges each province's garrison against what it can actually move forward.
 *
 * Every template computes a `supplyUse` and, until now, nothing consumed it --
 * so thirty divisions stacked on one tile were supplied exactly as well as
 * three, and "walk six divisions at one province and win" was the whole of
 * operational play. Overstacking now starves the whole stack in proportion,
 * which feeds the effectiveness and attrition paths that already exist, and
 * gives infrastructure and the supply map mode something to say.
 */
/**
 * What this province could move forward if nothing were stacked on it, as a
 * fraction of the most any province in the game can carry.
 *
 * Exposed because the supply map mode needs something to say in peacetime.
 * Shortage is a wartime quantity by design -- countries at peace sit at full
 * supply at home -- so for the first four years of a campaign the mode was one
 * flat colour over the whole of Europe, which reads as a broken screen rather
 * than as good news. Capacity is the standing fact underneath it: where the
 * roads are, and therefore where an offensive can be fed.
 */
export const MAX_THROUGHPUT = BASE_THROUGHPUT + 5 * THROUGHPUT_PER_INFRASTRUCTURE;

export function supplyCapacity(index: ProvinceIndex, province: ProvinceId): number {
  const infra = index.data.states[index.get(province).stateId]?.infrastructure ?? 1;
  return (BASE_THROUGHPUT + infra * THROUGHPUT_PER_INFRASTRUCTURE) / MAX_THROUGHPUT;
}

function applyThroughput(state: GameState, index: ProvinceIndex): void {
  for (let i = 0; i < state.provinces.length; i++) {
    const p = state.provinces[i];
    if (p.divisions.length === 0 || p.supply <= 0) continue;

    let demand = 0;
    for (const id of p.divisions) {
      const d = state.divisions[id];
      if (!d || d.dead) continue;
      const base = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
      const tpl = base ? effectiveTemplate(state, d.owner, base) : null;
      // A logistics-minded general moves the same divisions on less. This is
      // the one modifier in the chain of command that shows up away from the
      // battle line, and it is what makes a deep advance survivable.
      demand += (tpl?.supplyUse ?? 1) * commandModifiers(state, d).supplyUse;
    }
    if (demand <= 0) continue;

    const infra = index.data.states[index.get(i).stateId]?.infrastructure ?? 1;
    const capacity = BASE_THROUGHPUT + infra * THROUGHPUT_PER_INFRASTRUCTURE;
    if (demand <= capacity) continue;
    p.supply *= capacity / demand;
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
