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
 * data rather than picking a number. Measured on the administrative map: of
 * 450 coastal provinces, 215 carry a single victory point, 214 carry three or
 * more, and 133 carry five or more. Three was the gap when provinces were
 * whole regions; once they were cut down to real size, half the coast cleared
 * it and a harbour stopped meaning anything. Five is where a coastal cell has
 * a town rather than a hamlet, and 133 harbours against 1704 provinces is
 * close to the reference's own density.
 */
const PORT_VP = 5;

const cache = new WeakMap<ProvinceIndex, Set<ProvinceId>>();

/**
 * Every harbour on the map.
 *
 * Coastal towns, plus a fallback: a country with a coastline and no town on it
 * still gets its best coastal province. Without that, Bulgaria and Lithuania --
 * both of which had a port and only one -- would be unable to put a man on a
 * ship anywhere in their own country. Keyed on the 1936 owner because this is
 * geography: harbours do not appear and disappear as the front moves, they
 * change hands.
 */
export function ports(index: ProvinceIndex): ReadonlySet<ProvinceId> {
  const hit = cache.get(index);
  if (hit) return hit;

  const out = new Set<ProvinceId>();
  const best = new Map<string, ProvinceId>();
  for (const p of index.provinces) {
    if (!p.coastal) continue;
    if (p.vp >= PORT_VP) { out.add(p.id); continue; }
    const held = best.get(p.ownerTag);
    if (held === undefined || p.vp > index.get(held).vp) best.set(p.ownerTag, p.id);
  }
  for (const [tag, id] of best) {
    if (![...out].some((q) => index.get(q).ownerTag === tag)) out.add(id);
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
