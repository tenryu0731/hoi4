/**
 * National laws.
 *
 * The two decisions every Hearts of Iron campaign is actually built around:
 * how many of your people you are willing to put in uniform, and how much of
 * your industry you are willing to take away from them. Before this the game
 * made both of them for you -- the consumer-goods share drifted from 32% to
 * 15% on its own the moment war broke out, and manpower accrued at one fixed
 * rate forever -- so the largest strategic choice in the genre was a cutscene.
 *
 * Values follow the real game: seven steps on each ladder, 150 political power
 * to move one step, and gates that stop a peacetime democracy conscripting
 * like a besieged dictatorship. Trade laws are deliberately absent; there is
 * no trade system for them to act on, and a law that modifies nothing is worse
 * than a law that does not exist.
 */

import type { Ideology } from '../core/types';

export const CONSCRIPTION_LAWS = [
  'disarmed',
  'volunteer',
  'limited',
  'extensive',
  'service_by_requirement',
  'all_adults',
  'scraping_the_barrel',
] as const;
export type ConscriptionLaw = (typeof CONSCRIPTION_LAWS)[number];

export const ECONOMY_LAWS = [
  'undisturbed_isolation',
  'isolation',
  'civilian',
  'early_mobilisation',
  'partial_mobilisation',
  'war_economy',
  'total_mobilisation',
] as const;
export type EconomyLaw = (typeof ECONOMY_LAWS)[number];

/** What one step on either ladder costs, up or down. */
export const LAW_COST = 150;

export interface ConscriptionDef {
  id: ConscriptionLaw;
  /** Share of the recruitable population this law puts in uniform. */
  fraction: number;
  /** Factories lost to keeping that many men out of the workforce. */
  factoryPenalty: number;
  /** War support needed before a country will accept it. */
  needsWarSupport: number;
  /** Stability this law costs while it is in force. */
  stabilityCost: number;
}

export const CONSCRIPTION: Record<ConscriptionLaw, ConscriptionDef> = {
  disarmed: {
    id: 'disarmed', fraction: 0.015, factoryPenalty: 0,
    needsWarSupport: 0, stabilityCost: 0,
  },
  volunteer: {
    id: 'volunteer', fraction: 0.025, factoryPenalty: 0,
    needsWarSupport: 0, stabilityCost: 0,
  },
  limited: {
    id: 'limited', fraction: 0.05, factoryPenalty: 0.02,
    needsWarSupport: 0.1, stabilityCost: 0,
  },
  extensive: {
    id: 'extensive', fraction: 0.1, factoryPenalty: 0.05,
    needsWarSupport: 0.2, stabilityCost: 0.05,
  },
  service_by_requirement: {
    id: 'service_by_requirement', fraction: 0.15, factoryPenalty: 0.1,
    needsWarSupport: 0.4, stabilityCost: 0.1,
  },
  all_adults: {
    id: 'all_adults', fraction: 0.2, factoryPenalty: 0.2,
    needsWarSupport: 0.6, stabilityCost: 0.2,
  },
  scraping_the_barrel: {
    id: 'scraping_the_barrel', fraction: 0.25, factoryPenalty: 0.35,
    needsWarSupport: 0.8, stabilityCost: 0.3,
  },
};

export interface EconomyDef {
  id: EconomyLaw;
  /** Share of civilian industry that never reaches the war. */
  consumerGoods: number;
  /** Multiplier on how fast anything gets built. */
  construction: number;
  /** Multiplier on military factory output. */
  output: number;
  /** World tension, as a fraction, before a country will consider it. */
  needsTension: number;
  /** True when only a country already at war may take it. */
  needsWar: boolean;
}

export const ECONOMY: Record<EconomyLaw, EconomyDef> = {
  undisturbed_isolation: {
    id: 'undisturbed_isolation', consumerGoods: 0.4, construction: 0.7, output: 0.9,
    needsTension: 0, needsWar: false,
  },
  isolation: {
    id: 'isolation', consumerGoods: 0.35, construction: 0.85, output: 0.95,
    needsTension: 0, needsWar: false,
  },
  civilian: {
    id: 'civilian', consumerGoods: 0.3, construction: 1, output: 1,
    needsTension: 0, needsWar: false,
  },
  early_mobilisation: {
    id: 'early_mobilisation', consumerGoods: 0.25, construction: 1.1, output: 1.05,
    needsTension: 0.05, needsWar: false,
  },
  partial_mobilisation: {
    id: 'partial_mobilisation', consumerGoods: 0.2, construction: 1.2, output: 1.1,
    needsTension: 0.15, needsWar: false,
  },
  war_economy: {
    id: 'war_economy', consumerGoods: 0.15, construction: 1.3, output: 1.2,
    needsTension: 0.25, needsWar: false,
  },
  total_mobilisation: {
    id: 'total_mobilisation', consumerGoods: 0.1, construction: 1.4, output: 1.3,
    needsTension: 0.5, needsWar: true,
  },
};

/**
 * Where each ideology starts, and where its people will not follow it.
 *
 * Germany, Italy and Japan open on partial mobilisation in the real game while
 * the democracies sit on civilian economy, and that gap is most of why the
 * 1936 start is a race at all.
 */
export function startingLaws(ideology: Ideology, major: boolean): {
  conscription: ConscriptionLaw; economy: EconomyLaw;
} {
  switch (ideology) {
    case 'fascist':
      return {
        conscription: major ? 'extensive' : 'limited',
        economy: major ? 'partial_mobilisation' : 'civilian',
      };
    case 'communist':
      return {
        conscription: major ? 'extensive' : 'limited',
        economy: major ? 'early_mobilisation' : 'civilian',
      };
    case 'democratic':
      return { conscription: 'volunteer', economy: major ? 'civilian' : 'isolation' };
    default:
      return { conscription: 'volunteer', economy: 'isolation' };
  }
}

/**
 * The ceiling a democracy will not go past without being attacked.
 *
 * In the real game this is enforced by war support and by focus trees; here it
 * is the one rule that keeps a democratic AI from mobilising like a
 * dictatorship in 1936 and turning the historical shape of the war upside
 * down.
 */
export const DEMOCRATIC_PEACETIME_CAP: Record<'conscription' | 'economy', number> = {
  conscription: 2,
  economy: 3,
};
