import type { GameClock } from '../time/calendar';

/**
 * What each nation wants, and when -- as a table rather than as a score.
 *
 * A single scoring function cannot produce the Second World War. Ranked by
 * value-over-weakness, the most attractive target in Europe in 1936 is Norway:
 * rich, coastal, and defended by two divisions. The AI that maximises that
 * score is not wrong, it is simply playing a different game from the one the
 * scenario is about. The period's powers were not shopping for the softest
 * neighbour; they were pursuing specific claims on a specific timetable, and
 * they mostly did not move before that timetable said so.
 *
 * So intent is data. Each claim names a target, the earliest date the claimant
 * will act on it, and how: a `demand` is settled at the conference table when
 * the victim is isolated and hopelessly outmatched (Anschluss, Munich, the
 * Baltic ultimata), a `war` has to be fought for. Claims are pursued in order,
 * so the sequence is legible at a glance and can be retimed by editing a date.
 *
 * Nothing here is a script. A claim only matures if the claimant is actually
 * strong enough by then, victims can be swallowed by somebody else first, and
 * the readiness and winnability tests in ai.ts have the final word -- so the
 * same table produces a different war in every seed.
 */

export type ClaimMethod = 'demand' | 'war';

export interface Claim {
  /** Country tag being claimed. */
  target: string;
  /** Earliest date the claim may be acted on, 'YYYY-MM'. */
  from: string;
  method: ClaimMethod;
}

export interface Alignment {
  /** Tag of the faction leader whose bloc this nation gravitates to. */
  leader: string;
  /** Earliest date it will sign. */
  from: string;
}

export interface Protection {
  /** Country underwritten. */
  target: string;
  from: string;
}

export interface Doctrine {
  /**
   * Claims in the order they are pursued. The first one whose date has come
   * and whose target is still available is the one being worked on.
   */
  claims?: Claim[];
  /** The bloc this nation ends up in, if it is not already in one. */
  aligns?: Alignment;
  /** Neutrals this power underwrites; a guarantee drags it into their war. */
  protects?: Protection[];
  /**
   * Not the aggressor against another great power before this date, whatever
   * the arithmetic says. This is the single line that stops the Soviet Union
   * opening the campaign in Scandinavia.
   */
  majorWarFrom?: string;
  /**
   * Multiplies the army the nation wants before it will act. Above 1 is a
   * power that arms before it moves; below 1 is one that gambles.
   */
  patience?: number;
}

/**
 * The table.
 *
 * Dates are the historical ones where the event has an obvious date, and the
 * historically plausible ones where it does not. A nation absent from the table
 * has no claims: it arms, garrisons its borders, and waits to be attacked.
 */
export const DOCTRINE: Record<string, Doctrine> = {
  // Germany: the historical sequence. Austria and Czechoslovakia are taken at
  // the conference table because their neighbours will not fight for them;
  // Poland has to be invaded, and that is the war that becomes the World War.
  GER: {
    claims: [
      { target: 'AUS', from: '1938-03', method: 'demand' },
      { target: 'CZE', from: '1938-10', method: 'demand' },
      { target: 'POL', from: '1939-09', method: 'war' },
      { target: 'DEN', from: '1940-04', method: 'demand' },
      { target: 'NOR', from: '1940-04', method: 'war' },
      { target: 'LUX', from: '1940-05', method: 'demand' },
      { target: 'HOL', from: '1940-05', method: 'war' },
      { target: 'BEL', from: '1940-05', method: 'war' },
      { target: 'FRA', from: '1940-05', method: 'war' },
      { target: 'YUG', from: '1941-04', method: 'war' },
      { target: 'GRE', from: '1941-04', method: 'war' },
      { target: 'SOV', from: '1941-06', method: 'war' },
      { target: 'ENG', from: '1942-06', method: 'war' },
    ],
    majorWarFrom: '1939-09',
    patience: 1,
  },

  // Italy: the Mediterranean and the Balkans, and never before Germany has
  // moved first. Abyssinia is off this map, so Albania is the opening act.
  ITA: {
    claims: [
      { target: 'ALB', from: '1939-04', method: 'demand' },
      { target: 'GRE', from: '1940-10', method: 'war' },
      { target: 'YUG', from: '1941-04', method: 'war' },
      { target: 'TUR', from: '1942-06', method: 'war' },
    ],
    majorWarFrom: '1940-06',
    patience: 1.15,
  },

  // The Soviet Union: its own border marches, and not one of them before the
  // Pact. It will take its share of Poland once Poland is already fighting,
  // and it does not attack a great power until it is attacked or 1944.
  SOV: {
    claims: [
      { target: 'EST', from: '1939-09', method: 'demand' },
      { target: 'LAT', from: '1939-10', method: 'demand' },
      { target: 'LIT', from: '1939-10', method: 'demand' },
      { target: 'POL', from: '1939-09', method: 'war' },
      { target: 'FIN', from: '1939-11', method: 'war' },
      { target: 'ROM', from: '1940-06', method: 'demand' },
      { target: 'GER', from: '1944-01', method: 'war' },
    ],
    majorWarFrom: '1944-01',
    patience: 1.2,
  },

  // The democracies do not claim; they underwrite. Note what is missing:
  // nobody guarantees Austria or Czechoslovakia. That is appeasement, and it is
  // what lets Germany reach 1939 with an army and an industry worth having.
  ENG: {
    majorWarFrom: '1945-01',
    protects: [
      { target: 'POL', from: '1939-03' },
      { target: 'ROM', from: '1939-04' },
      { target: 'GRE', from: '1939-04' },
      { target: 'TUR', from: '1939-05' },
      { target: 'BEL', from: '1939-09' },
      { target: 'HOL', from: '1939-09' },
      { target: 'NOR', from: '1940-01' },
      { target: 'DEN', from: '1940-01' },
    ],
  },
  FRA: {
    majorWarFrom: '1945-01',
    protects: [
      { target: 'BEL', from: '1937-01' },
      { target: 'POL', from: '1939-03' },
      { target: 'YUG', from: '1939-04' },
      { target: 'ROM', from: '1939-04' },
      { target: 'HOL', from: '1939-09' },
      { target: 'SWI', from: '1939-09' },
    ],
  },

  // The Axis minors: they join late, once it is clear who is winning, and one
  // of them brings a grievance with it.
  HUN: {
    aligns: { leader: 'GER', from: '1940-11' },
    claims: [{ target: 'YUG', from: '1941-04', method: 'war' }],
    majorWarFrom: '1945-01',
    patience: 1.3,
  },
  ROM: { aligns: { leader: 'GER', from: '1940-11' }, majorWarFrom: '1945-01' },
  BUL: { aligns: { leader: 'GER', from: '1941-03' }, majorWarFrom: '1945-01' },
  FIN: { aligns: { leader: 'GER', from: '1941-06' }, majorWarFrom: '1945-01' },
};

/**
 * The disposition of everyone else, and of any country the table forgets.
 *
 * No claims at all. That is not an omission, it is the finding: the reason the
 * old AI produced a Soviet conquest of Scandinavia is that it gave every nation
 * in Europe the same appetite and let the arithmetic pick the victim. Sweden
 * had no war plan, so here it has none, and the date is the promise that it
 * will not acquire one by accident in 1941 either.
 */
export const DEFAULT_DOCTRINE: Doctrine = { majorWarFrom: '1945-01', patience: 1.5 };

/**
 * Nations that arm, garrison their borders, and wait to be attacked. Listed
 * rather than left to the fallback so the roster is visible at a glance and it
 * is obvious where a new claim would go.
 */
export const DEFENSIVE = [
  'POL', 'CZE', 'AUS', 'YUG', 'GRE', 'TUR', 'SPR', 'POR', 'SWE', 'NOR', 'DEN',
  'HOL', 'BEL', 'LUX', 'SWI', 'IRE', 'ICE', 'ALB', 'EST', 'LAT', 'LIT',
  'PER', 'SAU',
] as const;
for (const tag of DEFENSIVE) DOCTRINE[tag] = DEFAULT_DOCTRINE;

export function doctrineFor(tag: string): Doctrine {
  return DOCTRINE[tag] ?? DEFAULT_DOCTRINE;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Months since January 1936. Dates are written 'YYYY-MM' in the table because
 * that is what a reader can check against a history book; they are compared as
 * integers because that is what a simulation can do cheaply.
 */
export function monthIndex(year: number, month: number): number {
  return (year - 1936) * 12 + (month - 1);
}

const PARSED = new Map<string, number>();

export function monthIndexOf(date: string): number {
  const cached = PARSED.get(date);
  if (cached !== undefined) return cached;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const value = monthIndex(year, month);
  PARSED.set(date, value);
  return value;
}

export function nowIndex(clock: GameClock): number {
  return monthIndex(clock.year, clock.month);
}

/** Months by which the date has already passed; negative if it is still ahead. */
export function monthsSince(clock: GameClock, date: string): number {
  return nowIndex(clock) - monthIndexOf(date);
}

export function dateReached(clock: GameClock, date: string): boolean {
  return monthsSince(clock, date) >= 0;
}
