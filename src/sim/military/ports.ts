import type { ProvinceIndex } from '../map/ProvinceIndex';
import type { CountryId, GameState, ProvinceId } from '../core/types';


/**
 * Ports: where an army boards a ship.
 *
 * 「強襲上陸とは別に港を経由して移動できるように」. An assault and a transfer are
 * two different journeys. An assault crosses a strait onto a beach somebody is
 * defending and the men wade ashore out of order; a transfer sails from a quay
 * to a quay and the men walk down a gangway. Before this the simulation had
 * only the first, so moving a corps from Hamburg to Tripoli was a thing you
 * could only do by invading your own colony.
 *
 * A port is a place, not a possession: the set is fixed geography, and who may
 * use one is decided separately from whether one is there.
 */

/**
 * Victory points a coastal province needs to have a harbour.
 *
 * vp is how the map says "there is a town here", so the threshold reads the
 * data rather than picking a number. It is a sum over the towns inside a
 * province, which means it moves with how finely the map is cut: when the
 * cells were whole regions three was the gap, at 1704 cells five gave 133
 * harbours, and once the states were cut to the real game's granularity --
 * 2169 cells, a province being a town and its hinterland -- five let a
 * seventh of the whole map put a man on a ship. Of 1872 coastal cells, 637
 * carry three or more, 290 carry five, and 136 carry seven. Seven is where a
 * coastal cell has a town rather than a hamlet, and 136 harbours is the same
 * count the threshold was set to give when it was last measured.
 */
const PORT_VP = 7;

const cache = new WeakMap<ProvinceIndex, Set<ProvinceId>>();

/**
 * Every harbour on the map.
 *
 * Coastal towns, plus a quay for every piece of a country the sea cuts off.
 *
 * The threshold alone is not enough, and not only for Bulgaria and Lithuania
 * -- each of which had one port and would otherwise have none. East Prussia is
 * the case that matters: Konigsberg is one of the Baltic's great harbours and
 * still only the fifth town of the Reich, so a rule that ranks towns against
 * the whole map leaves the province Germany can reach by no other means with
 * nowhere to land. Ground nobody can sail to is ground nobody can reinforce or
 * evacuate, and a garrison walks into it once and never comes out.
 *
 * So each run of a country's own ground is walked separately, and any run with
 * a coast and no town big enough is given its best coastal province. Keyed on
 * the 1936 owner because this is geography: harbours do not appear and
 * disappear as the front moves, they change hands.
 */
export function ports(index: ProvinceIndex): ReadonlySet<ProvinceId> {
  const hit = cache.get(index);
  if (hit) return hit;

  const out = new Set<ProvinceId>();
  for (const p of index.provinces) if (p.coastal && p.vp >= PORT_VP) out.add(p.id);

  const seen = new Set<ProvinceId>();
  for (const start of index.provinces) {
    if (seen.has(start.id)) continue;
    const tag = start.ownerTag;
    const run: ProvinceId[] = [];
    const stack = [start.id];
    seen.add(start.id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      run.push(cur);
      for (const nb of index.get(cur).neighbors) {
        if (seen.has(nb) || index.get(nb).ownerTag !== tag) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    if (run.some((id) => out.has(id))) continue;
    let best: ProvinceId | null = null;
    for (const id of run) {
      const p = index.get(id);
      if (!p.coastal) continue;
      // By id after the town, so the same map always names the same quay.
      if (best === null || p.vp > index.get(best).vp) best = id;
    }
    if (best !== null) out.add(best);
  }
  cache.set(index, out);
  return out;
}

export function isPort(index: ProvinceIndex, id: ProvinceId): boolean {
  return ports(index).has(id);
}

/**
 * A harbour this country may sail from or into.
 *
 * Ours or an ally's. Not an enemy's: taking a port is what an assault is for,
 * and a transfer that could unload into a defended harbour would make the
 * assault pointless.
 */
/** Ours, or an ally's: the two sets of ground a transport may put in at. */
function friendly(state: GameState, owner: CountryId, controller: CountryId): boolean {
  if (controller === owner) return true;
  const a = state.countries[owner];
  const b = state.countries[controller];
  return a?.factionId != null && a.factionId === b?.factionId;
}

export function usablePort(
  state: GameState, index: ProvinceIndex, owner: CountryId, id: ProvinceId,
): boolean {
  if (!isPort(index, id)) return false;
  const controller = state.provinces[id]?.controller;
  if (controller === undefined) return false;
  return friendly(state, owner, controller);
}

/**
 * The harbour a division would march to, and how far it has to march.
 *
 * By land only. A port reachable only by sea is not an embarkation point; it
 * is somewhere the division is trying to get to.
 */
export function nearestUsablePort(
  state: GameState, index: ProvinceIndex, owner: CountryId, from: ProvinceId,
): ProvinceId | null {
  if (usablePort(state, index, owner, from)) return from;
  const seen = new Set<ProvinceId>([from]);
  let ring: ProvinceId[] = [from];
  // Bounded: a division a hundred provinces from the sea is not embarking, and
  // an unbounded search would walk the whole continent for every order.
  for (let hop = 0; hop < MARCH_TO_PORT_HOPS && ring.length > 0; hop++) {
    const next: ProvinceId[] = [];
    for (const id of ring) {
      for (const nb of index.get(id).neighbors) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        const controller = state.provinces[nb]?.controller;
        // Through our own ground and our allies', not through anybody else's.
        if (controller === undefined) continue;
        if (!friendly(state, owner, controller)) continue;
        if (usablePort(state, index, owner, nb)) return nb;
        next.push(nb);
      }
    }
    ring = next;
  }
  return null;
}

/** How far from the sea a division may be and still be worth embarking. */
export const MARCH_TO_PORT_HOPS = 12;
