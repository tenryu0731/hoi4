import { atWar } from '../diplomacy/diplomacy';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import type {
  Army, CountryId, Division, GameState, ProvinceId,
} from '../core/types';
import { armyById, commandModifiers, commanderById, overloadScale } from './command';
import { isHostile, orderMove, type MilitaryContext } from './movement';
import { stackLimit } from './supply';

/**
 * Battle plans: front lines, offensives, and the bonus for having thought
 * about it first.
 *
 * A front line is a standing instruction rather than a list of destinations.
 * The army is told which enemy to face; every day it works out which of our
 * provinces actually touch theirs and spreads itself along them, and it does
 * that again as the border moves. This is the difference between ordering an
 * army and ordering forty divisions one at a time, and it is most of why the
 * real game is playable at all.
 *
 * The preparation numbers are the real game's: 2% of bonus a day, a ceiling of
 * 30% before an officer's planning attribute raises it, 1% a day lost while
 * the plan is executing.
 *
 * Drawing a plan and carrying it out are two separate acts, as they are in the
 * reference -- 「将軍のアイコンの上の計画実行ボタン（矢印のあるボタン）をクリック
 * して軍や軍集団ごとに実行し、停止する場合は計画実行ボタン左側の赤いボタンを
 * クリック」. A holding order needs no word to go, because holding is what it
 * does; an attack waits for one, and the waiting is what buys the bonus.
 */

/** Bonus accumulated per day while an army sits on its plan. */
export const PLANNING_PER_DAY = 0.02;
/** Ceiling before a commander's planning attribute raises it. */
export const BASE_MAX_PLANNING = 0.3;
/** Bonus shed per day once the army is moving under its own plan. */
export const PLANNING_DECAY_PER_DAY = 0.01;

/**
 * Provinces of ours that touch the enemy: the line itself.
 *
 * Computed from control rather than ownership, because a front follows who is
 * standing where, not whose name is on the deed.
 */
export function frontProvinces(
  state: GameState, index: ProvinceIndex, owner: CountryId, against: CountryId,
): ProvinceId[] {
  const out: ProvinceId[] = [];
  for (const province of index.provinces) {
    const here = state.provinces[province.id];
    if (!here || here.controller !== owner) continue;
    for (const nb of province.neighbors) {
      const there = state.provinces[nb];
      if (there && there.controller === against) { out.push(province.id); break; }
    }
  }
  return out;
}

/**
 * Where the front would be if the enemy is not named -- against everyone we
 * are at war with. This is what an army ordered to "hold the line" gets.
 */
export function hostileFront(
  state: GameState, index: ProvinceIndex, owner: CountryId,
): ProvinceId[] {
  const out: ProvinceId[] = [];
  for (const province of index.provinces) {
    const here = state.provinces[province.id];
    if (!here || here.controller !== owner) continue;
    for (const nb of province.neighbors) {
      const there = state.provinces[nb];
      if (there && there.controller !== owner && atWar(state, owner, there.controller)) {
        out.push(province.id);
        break;
      }
    }
  }
  return out;
}

/**
 * Hands out the front's provinces to the army's divisions.
 *
 * Each division goes to the nearest unclaimed one, nearest first, so a line
 * fills from wherever the army already is rather than crossing over itself.
 * Divisions left over once every province has a holder double up on the ones
 * that matter most -- the provinces worth victory points.
 */
export function assignToFront(
  state: GameState, ctx: MilitaryContext, army: Army, front: ProvinceId[],
): void {
  if (front.length === 0) return;
  const divisions = army.divisions
    .map((id) => state.divisions.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> =>
      !!d && !d.dead && d.combatId === null && !d.detached);
  if (divisions.length === 0) return;

  const posts = new Set(front);
  const held = new Map<ProvinceId, number>();
  const loose: Division[] = [];
  for (const div of divisions) {
    // Already on a post, or already walking to one: leave it alone. This is
    // the whole of the fix. What this replaces sorted every division against
    // every post from scratch every day, so a division that arrived yesterday
    // was re-sorted today and sent somewhere else -- measured on a six-province
    // line held by twenty-four divisions, 99 re-orders of a division that was
    // already standing on the line in sixty days, with a third of the posts
    // empty on any given day because their garrison was walking to another
    // one. The reference has the same failure and the same workaround: a
    // fallback line is what players use when they want a line that "doesn't
    // shuffle units", and the shuffling is exactly what opens the gaps.
    const going = div.order?.kind === 'move' ? div.order.target : null;
    const settled = posts.has(div.provinceId) ? div.provinceId
      : (going !== null && posts.has(going) ? going : null);
    if (settled !== null) {
      held.set(settled, (held.get(settled) ?? 0) + 1);
      continue;
    }
    loose.push(div);
  }
  if (loose.length === 0) return;

  // Holes first: a post of ours with nobody on it and nobody walking to it is
  // where the enemy comes through.
  const holes = front.filter((p) => (held.get(p) ?? 0) === 0);
  const send = (div: Division, choices: readonly ProvinceId[]): boolean => {
    const from = ctx.index.get(div.provinceId);
    const order = [...choices].sort((a, b) => {
      const pa = ctx.index.get(a);
      const pb = ctx.index.get(b);
      const da = Math.hypot(from.centerX - pa.centerX, from.centerY - pa.centerY)
        + (held.get(a) ?? 0) * 4000;
      const db = Math.hypot(from.centerX - pb.centerX, from.centerY - pb.centerY)
        + (held.get(b) ?? 0) * 4000;
      // By id after that, so the assignment is the same on every machine.
      return da - db || a - b;
    });
    for (const target of order) {
      if (!reorder(state, ctx, div, target)) continue;
      held.set(target, (held.get(target) ?? 0) + 1);
      return true;
    }
    return false;
  };

  const spare: Division[] = [];
  for (const div of loose) {
    const open = holes.filter((p) => (held.get(p) ?? 0) === 0);
    if (open.length === 0) { spare.push(div); continue; }
    // The nearest division fills the nearest hole. Not "whichever division the
    // sort happens to reach first": the reference's own failure on an
    // encirclement is that it picks distant divisions and strategic-redeploys
    // them, which arrives late and disorganised.
    if (!send(div, open)) spare.push(div);
  }

  // Everything left over doubles up on the line, thickest where the ground is
  // worth most. Sorted by victory points so the second rank lands on what is
  // worth holding rather than on whichever post is nearest to the depot.
  if (spare.length === 0) return;
  const ranked = [...front].sort((a, b) => {
    const va = state.provinces[a]?.vp ?? 0;
    const vb = state.provinces[b]?.vp ?? 0;
    return vb - va || a - b;
  });
  for (const div of spare) send(div, ranked);
}

/** How far a drawn line may walk from its anchors in one day. */
export const LINE_DRIFT = 3;

/**
 * Where a hand-drawn line actually stands today.
 *
 * The anchors are ground the finger passed over, which is where the line was
 * yesterday. From the ones we still hold, walk out through our own territory
 * as far as LINE_DRIFT and keep whatever faces somebody else: that is the
 * border in this neighbourhood, wherever it has moved to. Bounded, because an
 * unbounded search would let a line drawn on the Rhine reappear on the Vistula
 * the day Poland fell.
 */
export function lineFront(
  state: GameState, ctx: MilitaryContext, army: Army, anchors: readonly ProvinceId[],
): ProvinceId[] {
  const ours = (id: ProvinceId): boolean => state.provinces[id]?.controller === army.owner;
  const faces = (id: ProvinceId): boolean =>
    ctx.index.get(id).neighbors.some((nb) => !ours(nb));

  // Each post moves at most one province a day, on its own, and the line keeps
  // the order and the length the finger gave it.
  //
  // What this replaces searched three hops out from the whole line and then
  // kept whichever border provinces were nearest -- and "nearest" over a set
  // has no memory of shape. Measured on a line traced across the four northern
  // provinces of the Polish border: after one advance it came back as four
  // provinces two hundred kilometres to the south, half of them behind the
  // line rather than on it. A front that reappears somewhere else is not a
  // front the player drew.
  // A line none of whose posts faces anybody is a holding line, and it stays
  // exactly where it was traced. Stepping it forward would walk a reserve line
  // drawn behind the front onto the front the moment it was given, which is
  // 「国境線じゃないところに戦線引こうとした時」.
  const held = anchors.filter(ours);
  if (held.length > 0 && !held.some(faces)) return held;

  const out: ProvinceId[] = [];
  const seen = new Set<ProvinceId>();
  for (const a of anchors) {
    const moved = step(ctx, a, ours, faces);
    if (moved === null || seen.has(moved)) continue;
    seen.add(moved);
    out.push(moved);
  }
  return out;
}

/**
 * Where one post of a drawn line stands today.
 *
 * Held and facing somebody: it is already the front, and it stays. Held but
 * facing nobody: the army advanced past it, so the post follows to the nearest
 * neighbour that does face somebody. Lost: the post falls back to the nearest
 * neighbour we still hold. One province either way -- a line that can teleport
 * is a line the player has to keep checking.
 */
function step(
  ctx: MilitaryContext, at: ProvinceId,
  ours: (id: ProvinceId) => boolean, faces: (id: ProvinceId) => boolean,
): ProvinceId | null {
  if (ours(at)) {
    if (faces(at)) return at;
    const ahead = ctx.index.get(at).neighbors.find((nb) => ours(nb) && faces(nb));
    return ahead ?? at;
  }
  const back = ctx.index.get(at).neighbors;
  return back.find((nb) => ours(nb) && faces(nb)) ?? back.find(ours) ?? null;
}

/**
 * The run of front line between two places, along the front itself.
 *
 * 「実際のhoi4みたいに端から延長したり縮めたり」. Dragging an end of a line does
 * not draw a new line freehand: it says how far along the border this army's
 * line now reaches, and everything between the far end and the finger belongs
 * to it. Walking our own facing provinces gets that run without the player
 * having to trace it, which on a 412px screen they cannot do accurately
 * anyway.
 *
 * Both ends snap to the front: a finger that drifts a province inland while
 * dragging still means "out to about here".
 */
export function frontChain(
  state: GameState, ctx: MilitaryContext, owner: CountryId,
  from: ProvinceId, to: ProvinceId,
): ProvinceId[] {
  const ours = (id: ProvinceId): boolean => state.provinces[id]?.controller === owner;
  const onFront = (id: ProvinceId): boolean =>
    ours(id) && ctx.index.get(id).neighbors.some((nb) => !ours(nb));

  const a = snapToFront(ctx, from, ours, onFront);
  const b = snapToFront(ctx, to, ours, onFront);
  if (a === null || b === null) return [];
  if (a === b) return [a];

  // Breadth-first through the front, so the run is the shortest way along it
  // rather than a line drawn through the country behind it.
  const prev = new Map<ProvinceId, ProvinceId>();
  const seen = new Set<ProvinceId>([a]);
  let ring: ProvinceId[] = [a];
  while (ring.length > 0 && !seen.has(b)) {
    const next: ProvinceId[] = [];
    for (const id of ring) {
      for (const nb of ctx.index.get(id).neighbors) {
        if (seen.has(nb) || !onFront(nb)) continue;
        seen.add(nb);
        prev.set(nb, id);
        next.push(nb);
      }
    }
    ring = next;
  }
  if (!seen.has(b)) return [];

  const chain: ProvinceId[] = [b];
  for (let at = b; at !== a;) {
    const back = prev.get(at);
    if (back === undefined) return [];
    chain.push(back);
    at = back;
  }
  return chain.reverse();
}

/** The nearest province that is actually on the front, walking our ground. */
function snapToFront(
  ctx: MilitaryContext, from: ProvinceId,
  ours: (id: ProvinceId) => boolean, onFront: (id: ProvinceId) => boolean,
): ProvinceId | null {
  if (onFront(from)) return from;
  const seen = new Set<ProvinceId>([from]);
  let ring: ProvinceId[] = [from];
  for (let hop = 0; hop < LINE_DRIFT && ring.length > 0; hop++) {
    const next: ProvinceId[] = [];
    for (const id of ring) {
      for (const nb of ctx.index.get(id).neighbors) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        if (onFront(nb)) return nb;
        if (ours(nb)) next.push(nb);
      }
    }
    ring = next;
  }
  return null;
}

/** Divisions of one country standing in a province. */
function friendlyStack(state: GameState, owner: CountryId, id: ProvinceId): number {
  let n = 0;
  for (const divId of state.provinces[id]?.divisions ?? []) {
    const d = state.divisions[divId];
    if (d && !d.dead && d.owner === owner) n++;
  }
  return n;
}

/**
 * Pushes an army at its objectives.
 *
 * Divisions go at the nearest objective that still has room, and once the
 * objectives are full the rest fan out over the ground the attack is mounted
 * from. What they must not do is all go to the same place: measured in a 1946
 * campaign, the Soviet AI had six armies on offensive orders and every one of
 * them sent every division at the single nearest target, which put **114
 * divisions in one province** on the heel of Italy. That province carries
 * about six. Its supply came out of the map at 0.47 and was divided down to
 * 0.06 by the stack standing on it, so all 114 fell below the organisation
 * the AI needs to attack with, and 176 of the country's 183 divisions were
 * sitting on `defend` -- unable to attack because they had no supply, and
 * with no supply because they were all standing in one place. The map did not
 * change hands again for four years.
 *
 * `stackLimit` is the same figure `applyThroughput` charges against, so the
 * ceiling here is the mechanic rather than a number chosen to dodge it.
 */
export function pressOffensive(
  state: GameState, ctx: MilitaryContext, army: Army, targets: ProvinceId[],
): void {
  const live = targets.filter((t) => {
    const p = state.provinces[t];
    return p && p.controller !== army.owner;
  });
  if (live.length === 0) return;

  // The ground the attack goes in from: ours, and touching an objective.
  const staging: ProvinceId[] = [];
  const seen = new Set<ProvinceId>();
  for (const t of live) {
    for (const nb of ctx.index.get(t).neighbors) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      if (state.provinces[nb]?.controller === army.owner) staging.push(nb);
    }
  }

  // Counted from the divisions actually on the ground, so the armies of one
  // country stay out of each other's way without being told about each other.
  const booked = new Map<ProvinceId, number>();
  const room = (id: ProvinceId): number =>
    stackLimit(ctx.index, id) - friendlyStack(state, army.owner, id) - (booked.get(id) ?? 0);

  /** Somewhere with room this division can actually march to, nearest first. */
  const send = (div: Division, choices: readonly ProvinceId[]): boolean => {
    const here = ctx.index.get(div.provinceId);
    const order = choices
      .filter((id) => room(id) > 0)
      .sort((a, b) => {
        const pa = ctx.index.get(a);
        const pb = ctx.index.get(b);
        return Math.hypot(here.centerX - pa.centerX, here.centerY - pa.centerY)
          - Math.hypot(here.centerX - pb.centerX, here.centerY - pb.centerY);
      });
    for (const target of order) {
      if (!reorder(state, ctx, div, target)) continue;
      booked.set(target, (booked.get(target) ?? 0) + 1);
      return true;
    }
    return false;
  };

  for (const id of army.divisions) {
    const div = state.divisions.find((d) => d.id === id);
    if (!div || div.dead || div.combatId !== null || div.detached) continue;
    // Empty ground next door first. An offensive in the reference paints
    // forward: a province the enemy has left goes to whoever is standing
    // beside it, and the line moves up a square, rather than everybody
    // marching past it toward a capital three hundred kilometres away. It is
    // also the only way a breakthrough turns into a pocket -- ground taken
    // behind a defended province is what cuts it off.
    const open = ctx.index.get(div.provinceId).neighbors.filter((nb) => {
      const p = state.provinces[nb];
      if (!p || p.controller === army.owner) return false;
      if (!isHostile(state, army.owner, p.controller)) return false;
      // Undefended: nobody in it to fight. A defended one is a battle, and a
      // battle is what the objectives below are for.
      return !p.divisions.some((x) => {
        const other = state.divisions[x];
        return other && !other.dead && isHostile(state, army.owner, other.owner);
      });
    });
    // An objective second, the ground in front of it third, and if all of them
    // are full or out of reach then nowhere: a division that cannot be fed at
    // the front is worth more standing where it is than starving on top of the
    // ones that can.
    if (send(div, open)) continue;
    if (!send(div, live)) send(div, staging);
  }
}

/**
 * The line an offensive springs from: ours, and touching whoever holds an
 * objective. Falling back to everyone we are shooting at, and then to the
 * staging ground itself, so an army that has already crossed the border still
 * has something drawn for it.
 */
function offensiveFront(
  state: GameState, ctx: MilitaryContext, army: Army, targets: readonly ProvinceId[],
): ProvinceId[] {
  const holders = new Set<CountryId>();
  for (const t of targets) {
    const c = state.provinces[t]?.controller;
    if (c !== undefined && c !== army.owner) holders.add(c);
  }
  const out = new Set<ProvinceId>();
  for (const against of holders) {
    for (const id of frontProvinces(state, ctx.index, army.owner, against)) out.add(id);
  }
  if (out.size > 0) return [...out];
  const hostile = hostileFront(state, ctx.index, army.owner);
  if (hostile.length > 0) return hostile;
  // Nothing of ours touches them -- an amphibious objective, or a pocket we
  // are already inside. Draw the ground the army is standing on instead of
  // nothing: a plan the map does not show is a plan the player forgot giving.
  const standing = new Set<ProvinceId>();
  for (const id of army.divisions) {
    const div = state.divisions.find((d) => d.id === id);
    if (div && !div.dead && state.provinces[div.provinceId]?.controller === army.owner) {
      standing.add(div.provinceId);
    }
  }
  return [...standing];
}

/** True when every objective of the current plan is in our hands. */
function isDone(state: GameState, army: Army): boolean {
  const order = army.order;
  if (!order) return true;
  if (order.kind === 'offensive') {
    return order.targets.every((t) => state.provinces[t]?.controller === army.owner);
  }
  if (order.kind === 'spearhead') {
    return state.provinces[order.target]?.controller === army.owner;
  }
  return false;
}

/**
 * The route a spearhead drives down.
 *
 * One path from the ground the army is standing on to the objective, so the
 * advance is a corridor rather than a face -- 「目標のワルシャワまでの経路のみ
 * 進攻する計画になる」. Costed to prefer ground we already hold, so the corridor
 * runs up our own side of the line before it crosses it, and hostile ground is
 * expensive rather than forbidden because crossing it is the point.
 */
export function corridor(
  state: GameState, ctx: MilitaryContext, army: Army, target: ProvinceId,
): ProvinceId[] {
  const from = nearestHeld(state, ctx, army, target);
  if (from === null) return [target];
  const path = ctx.index.path(from, target, {
    allowSea: true,
    seaMultiplier: 6,
    cost: (id) => (state.provinces[id]?.controller === army.owner ? 1 : 4),
  });
  return path ?? [target];
}

/** The army's own province closest to the objective; where the drive starts. */
function nearestHeld(
  state: GameState, ctx: MilitaryContext, army: Army, target: ProvinceId,
): ProvinceId | null {
  let best: ProvinceId | null = null;
  let bestCost = Infinity;
  for (const id of army.divisions) {
    const div = state.divisions.find((d) => d.id === id);
    if (!div || div.dead) continue;
    const cost = ctx.index.distance(div.provinceId, target);
    if (cost < bestCost) { bestCost = cost; best = div.provinceId; }
  }
  return best;
}

/**
 * Drives an army down one corridor.
 *
 * Everything goes at the first province on the route we do not hold, up to
 * what that province can carry, and the rest close up behind it. That is what
 * makes a spearhead a spearhead: it is the same divisions as an offensive
 * arranged as a column instead of a line, and a column is what cuts a pocket.
 */
export function pressSpearhead(
  state: GameState, ctx: MilitaryContext, army: Army, route: readonly ProvinceId[],
): void {
  const tip = route.find((p) => state.provinces[p]?.controller !== army.owner);
  if (tip === undefined) return;

  const booked = new Map<ProvinceId, number>();
  const room = (id: ProvinceId): number =>
    stackLimit(ctx.index, id) - friendlyStack(state, army.owner, id) - (booked.get(id) ?? 0);
  // Behind the tip, nearest to it first: the queue forms up along the route
  // rather than piling on the last province of it.
  const behind = route.slice(0, route.indexOf(tip)).reverse();

  for (const id of army.divisions) {
    const div = state.divisions.find((d) => d.id === id);
    if (!div || div.dead || div.combatId !== null || div.detached) continue;
    for (const target of [tip, ...behind]) {
      if (room(target) <= 0) continue;
      if (!reorder(state, ctx, div, target)) continue;
      booked.set(target, (booked.get(target) ?? 0) + 1);
      break;
    }
  }
}

/**
 * Sends a division somewhere, unless it is already on its way there.
 *
 * This guard is the whole reason a standing order works at all. orderMove
 * resets moveProgress, and these plans are re-issued every day: re-ordering a
 * division that is already walking to the same province throws away the
 * progress it made yesterday, so anything more than a day's march away is
 * never reached. Measured before the guard, a German army told to hold the
 * Polish border had three divisions in motion on day 5 and the same three on
 * day 20, having gone nowhere.
 */
function reorder(
  state: GameState, ctx: MilitaryContext, div: Division, target: ProvinceId,
): boolean {
  if (div.provinceId === target) return true;
  if (div.order?.kind === 'move' && div.order.target === target && div.path.length > 0) return true;
  return orderMove(state, ctx, div, target);
}

/** The ceiling this army's planning may reach, with its officers' help. */
export function maxPlanning(state: GameState, army: Army): number {
  const first = army.divisions[0];
  const div = first === undefined ? null : state.divisions.find((d) => d.id === first);
  const mods = div ? commandModifiers(state, div) : null;
  return BASE_MAX_PLANNING + (mods?.maxPlanningBonus ?? 0);
}

/** How fast this army prepares, with its officers' help. */
function planningSpeed(state: GameState, army: Army): number {
  const commander = commanderById(state, army.commander);
  if (!commander) return 1;
  const scale = overloadScale(state, army, commander);
  const fast = commander.traits.includes('fast_planner') ? 0.1 : 0;
  return 1 + (commander.planning * 0.05 + fast) * scale;
}

/**
 * One day of every army's standing orders.
 *
 * Re-spreads fronts, presses offensives, and moves the planning bar. Runs
 * daily rather than hourly because a front that re-forms every hour thrashes:
 * divisions would spend the whole war walking between two adjacent provinces
 * as the line wobbled.
 */
export function tickBattlePlansDaily(state: GameState, ctx: MilitaryContext): void {
  const armies = state.armies;
  if (!armies) return;

  for (const army of armies) {
    if (army.isArmyGroup) {
      // A group has no divisions; it passes its order to the armies under it.
      for (const childId of army.children) {
        const child = armyById(state, childId);
        if (!child || !army.order || child.order) continue;
        child.order = army.order;
        // With the word to go, if the group already has it: an army posted to
        // a group whose plan is already running joins the plan that is running.
        child.executing = army.executing === true;
      }
      continue;
    }
    if (army.divisions.length === 0) {
      army.planning = 0;
      army.frontProvinces = [];
      continue;
    }
    if (!army.order) {
      // An army with no plan still digs in, at half the rate and with no help
      // finding the line. This is not decoration: the AI gives orders to
      // divisions directly and never sets an army order, so without it the
      // planning bonus would be a mechanic only the human player could ever
      // have, and every battle in the game would be tilted by up to 45%
      // toward whoever happened to be reading the screen.
      army.frontProvinces = [];
      accruePlanning(state, army, 0.5);
      continue;
    }

    // An AI army declares its front so that the preparation and the front
    // bookkeeping are real, but keeps moving its own divisions: its loop is
    // tuned around garrison budgets and re-order suppression this spreader
    // does not model, and two controllers issuing movement on the same day
    // would leave divisions walking back and forth.
    const spread = !state.countries[army.owner].isAI;

    let front: ProvinceId[] = [];
    // A plan is drawn, prepared, and then carried out. Holding orders need no
    // carrying out -- a front line is where an army waits -- but an attack
    // waits for the word, which is the whole reason the preparation bar is
    // worth filling.
    const executing = army.executing === true;
    switch (army.order.kind) {
      case 'front':
        front = frontProvinces(state, ctx.index, army.owner, army.order.against);
        // A named enemy we no longer touch anywhere leaves the army facing
        // whoever else is shooting at us, rather than standing idle.
        if (front.length === 0) front = hostileFront(state, ctx.index, army.owner);
        if (spread) assignToFront(state, ctx, army, front);
        break;
      case 'line': {
        // The length the finger drew, remembered the first time it is asked
        // for: a save written before the span existed still knows how long its
        // line was, because its anchors are still the ones that were drawn.
        front = lineFront(state, ctx, army, army.order.anchors);
        // What the line worked out today is what it anchors on tomorrow, so a
        // drawn front walks forward with the army that holds it instead of
        // staying pinned to the ground it was first traced over.
        if (front.length > 0) army.order.anchors = front;
        if (spread) assignToFront(state, ctx, army, front);
        break;
      }
      case 'garrison':
        front = army.order.provinces.filter((p) => state.provinces[p]?.controller === army.owner);
        if (spread) assignToFront(state, ctx, army, front);
        break;
      case 'offensive':
        // The line the attack is mounted from, not the places it is aimed at.
        // 攻撃線 is drawn out of a 前線 in the reference and the army goes on
        // holding one while it attacks; drawing the objectives as the "front"
        // put the army's own line inside the country it was invading.
        front = offensiveFront(state, ctx, army, army.order.targets);
        if (spread && executing) pressOffensive(state, ctx, army, army.order.targets);
        break;
      case 'spearhead':
        front = corridor(state, ctx, army, army.order.target);
        if (spread && executing) pressSpearhead(state, ctx, army, front);
        break;
    }
    army.frontProvinces = front;

    // A plan that has arrived is finished, and an army left executing a plan
    // it has completed goes on shedding the preparation for the next one.
    if (executing && isDone(state, army)) army.executing = false;

    accruePlanning(state, army, 1);
  }
}

/**
 * Moves the preparation bar for one army.
 *
 * Grows while the army holds and drains while it executes. "Executing" is
 * measured by how many divisions are actually walking, which is the honest
 * signal: an army repositioning along its own line is not preparing, whatever
 * its orders say.
 */
function accruePlanning(state: GameState, army: Army, rate: number): void {
  const moving = army.divisions.reduce((n, id) => {
    const div = state.divisions.find((d) => d.id === id);
    return n + (div && !div.dead && div.path.length > 0 ? 1 : 0);
  }, 0);
  if (moving > army.divisions.length / 2) {
    army.planning = Math.max(0, army.planning - PLANNING_DECAY_PER_DAY);
    return;
  }
  const ceiling = maxPlanning(state, army) * rate;
  army.planning = Math.min(
    ceiling, army.planning + PLANNING_PER_DAY * planningSpeed(state, army) * rate,
  );
}
