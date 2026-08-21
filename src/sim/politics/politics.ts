import {
  CONSCRIPTION, CONSCRIPTION_LAWS, DEMOCRATIC_PEACETIME_CAP, ECONOMY, ECONOMY_LAWS, LAW_COST,
  type ConscriptionLaw, type EconomyLaw,
} from './lawData';
import type { Country, CountryId, GameState } from '../core/types';

/**
 * Politics: laws, stability and war support.
 *
 * Stability and war support are here rather than in the economy because they
 * are what gate the laws, and the laws are what cost them. Every figure in
 * this file is consumed somewhere -- stability by political power and by the
 * consumer-goods share, war support by which conscription law a country will
 * accept and by how much of itself it will lose before it gives up -- because
 * a top-bar number that only decorates the top bar is the thing this project
 * keeps having to go back and delete.
 */

export interface LawEffects {
  /** Share of the recruitable population under arms. */
  conscriptionFraction: number;
  /** Civilian industry that never reaches the war, after stability. */
  consumerGoods: number;
  /** Multiplier on construction speed. */
  construction: number;
  /** Multiplier on military factory output. */
  output: number;
  /** Multiplier on the factories a country can actually staff. */
  factoryStaffing: number;
}

/** Political power a day at full stability, and the floor at none of it. */
const PP_AT_FULL_STABILITY = 1.4;
const PP_AT_NO_STABILITY = 0.4;
/** Consumer goods added when a country is coming apart. */
const INSTABILITY_CONSUMER_GOODS = 0.15;

export function lawEffects(c: Country): LawEffects {
  const con = CONSCRIPTION[c.laws.conscription];
  const eco = ECONOMY[c.laws.economy];
  // An unstable country wastes industry on keeping itself together.
  const unrest = (1 - c.stability) * INSTABILITY_CONSUMER_GOODS;
  return {
    conscriptionFraction: con.fraction,
    consumerGoods: Math.min(0.6, eco.consumerGoods + unrest),
    construction: eco.construction,
    output: eco.output,
    factoryStaffing: 1 - con.factoryPenalty,
  };
}

/** Political power earned per day, which is what stability is for. */
export function politicalPowerPerDay(c: Country): number {
  return PP_AT_NO_STABILITY + (PP_AT_FULL_STABILITY - PP_AT_NO_STABILITY) * c.stability;
}

/**
 * How much of its territory a country will lose before it capitulates.
 *
 * War support is the whole of it: a nation that believes in the war holds on
 * past the point where one that does not has already asked for terms.
 */
export function surrenderTolerance(c: Country): number {
  // A multiplier on the country's own limit rather than a replacement for it,
  // so the difference between a major and a minor survives.
  return 0.8 + 0.4 * c.warSupport;
}

/**
 * World tension as a fraction.
 *
 * It is stored 0..100, and reading it as though it were 0..1 pinned every
 * country's war support at the ceiling from the first declaration of war
 * onward -- the whole of Europe at 100%, which is not a scale, it is a
 * constant.
 */
export function tension(state: GameState): number {
  return Math.max(0, Math.min(1, state.worldTension / 100));
}

export type LawKind = 'conscription' | 'economy';

/** Index of the country's current law on the given ladder. */
export function lawIndex(c: Country, kind: LawKind): number {
  return kind === 'conscription'
    ? CONSCRIPTION_LAWS.indexOf(c.laws.conscription)
    : ECONOMY_LAWS.indexOf(c.laws.economy);
}

export interface LawCheck {
  allowed: boolean;
  /** Why not, for the panel to show. Empty when allowed. */
  reason: 'cost' | 'war_support' | 'tension' | 'needs_war' | 'democracy' | 'end' | '';
}

/**
 * Whether this country may move one step along a ladder right now.
 *
 * `step` is +1 to mobilise further, -1 to stand down. Standing down is always
 * permitted if it can be paid for: a country is allowed to change its mind.
 */
export function canChangeLaw(
  state: GameState, c: Country, kind: LawKind, step: 1 | -1,
): LawCheck {
  const list = kind === 'conscription' ? CONSCRIPTION_LAWS : ECONOMY_LAWS;
  const next = lawIndex(c, kind) + step;
  if (next < 0 || next >= list.length) return { allowed: false, reason: 'end' };
  if (c.economy.politicalPower < LAW_COST) return { allowed: false, reason: 'cost' };
  if (step === -1) return { allowed: true, reason: '' };

  const atWar = c.atWarWith.length > 0;
  if (c.ideology === 'democratic' && !atWar && next > DEMOCRATIC_PEACETIME_CAP[kind]) {
    return { allowed: false, reason: 'democracy' };
  }
  if (kind === 'conscription') {
    const def = CONSCRIPTION[CONSCRIPTION_LAWS[next]];
    if (c.warSupport < def.needsWarSupport) return { allowed: false, reason: 'war_support' };
  } else {
    const def = ECONOMY[ECONOMY_LAWS[next]];
    if (def.needsWar && !atWar) return { allowed: false, reason: 'needs_war' };
    if (tension(state) < def.needsTension) return { allowed: false, reason: 'tension' };
  }
  return { allowed: true, reason: '' };
}

/** Moves one step and charges for it. Returns false when it was not allowed. */
export function changeLaw(
  state: GameState, owner: CountryId, kind: LawKind, step: 1 | -1,
): boolean {
  const c = state.countries[owner];
  if (!c || c.capitulated) return false;
  if (!canChangeLaw(state, c, kind, step).allowed) return false;
  const next = lawIndex(c, kind) + step;
  if (kind === 'conscription') {
    c.laws.conscription = CONSCRIPTION_LAWS[next] as ConscriptionLaw;
  } else {
    c.laws.economy = ECONOMY_LAWS[next] as EconomyLaw;
  }
  c.economy.politicalPower -= LAW_COST;
  return true;
}

/** Where stability and war support settle, before the day's drift toward it. */
const DRIFT_PER_DAY = 0.004;
const BASE_STABILITY = 0.7;

function stabilityTarget(c: Country, invaded: number): number {
  let target = BASE_STABILITY - CONSCRIPTION[c.laws.conscription].stabilityCost;
  // Losing costs a government its authority.
  if (c.atWarWith.length > 0) target -= 0.1;
  target -= invaded * 0.25;
  return Math.max(0, Math.min(1, target));
}

function warSupportTarget(state: GameState, c: Country, invaded: number): number {
  // Nobody wants a war until there is one, and nothing makes a nation total-war
  // like losing. Tension and a declaration between them only reach two thirds;
  // the last third is bought by enemy soldiers standing on your own ground,
  // which is why an aggressor and its victim do not end up in the same place.
  let target = 0.1 + tension(state) * 0.25;
  if (c.atWarWith.length > 0) target += 0.25;
  if (c.ideology === 'fascist' || c.ideology === 'communist') target += 0.1;
  target += invaded * 0.35;
  return Math.max(0, Math.min(1, target));
}

function drift(current: number, target: number): number {
  if (current < target) return Math.min(target, current + DRIFT_PER_DAY);
  return Math.max(target, current - DRIFT_PER_DAY);
}

export function tickPoliticsDaily(state: GameState, occupation: (c: CountryId) => number): void {
  for (const c of state.countries) {
    if (c.capitulated) continue;
    const invaded = c.atWarWith.length > 0 ? occupation(c.id) : 0;
    c.stability = drift(c.stability, stabilityTarget(c, invaded));
    c.warSupport = drift(c.warSupport, warSupportTarget(state, c, invaded));
  }
}
