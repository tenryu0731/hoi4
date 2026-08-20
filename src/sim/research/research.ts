import { HOURS_PER_DAY, daysInYear, hoursFromDate } from '../time/calendar';
import type {
  Country, CountryId, DivisionTemplate, GameState, ResearchSlot, ResearchState, TechId,
} from '../core/types';
import {
  BLOCK_REASON_TEXT, BRANCH_NAME, IDLE_SLOT_NAME, MODIFIER_KEYS, MODIFIER_KIND,
  MODIFIER_LABEL, TECHS, TECH_BRANCHES, formatModifier, techDef, techsInBranch,
  type ModifierKey, type TechBlockReason, type TechBranch, type TechDef,
} from './techData';

/**
 * Research.
 *
 * A country has a small number of slots; each slot works one technology from
 * the dated trees in `techData.ts` and accumulates one research day per day,
 * scaled by whatever research-speed modifiers it has already earned. When a
 * slot fills, the technology joins the country's completed set, its modifiers
 * take effect everywhere at once, and the slot goes idle.
 *
 * The two decisions that make this a game rather than a timer:
 *
 *   - Slots are scarce. Four things can be in flight at most, so taking the
 *     tank line means not taking the aircraft line this year.
 *   - Time is dated. Every technology has a historical year, and taking one
 *     early costs extra days in proportion to how early (AHEAD_PENALTY_PER_YEAR
 *     per year, locked in when research starts). Rushing 1944 armour in 1937 is
 *     allowed and is usually a mistake.
 *
 * Everything here is deterministic: no clock, no randomness, and every
 * iteration walks an array in declaration order rather than an object's keys.
 */

/** Ceiling on slots however many a country earns from technology. */
export const MAX_RESEARCH_SLOTS = 5;

/**
 * Extra research time per year taken early, as a fraction of the base cost.
 *
 * At 0.7 a technology taken one year early costs 70% more days and one taken
 * three years early costs three times as much -- expensive enough that the
 * dates pace the tree, cheap enough that a deliberate rush on one line is a
 * real strategy rather than a trap.
 */
export const AHEAD_PENALTY_PER_YEAR = 0.7;

/** Research speed can be improved but never stopped. */
const MIN_RESEARCH_SPEED = 0.1;

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

export type TechModifiers = Readonly<Record<ModifierKey, number>>;

function baseModifiers(): Record<ModifierKey, number> {
  const out = {} as Record<ModifierKey, number>;
  for (const k of MODIFIER_KEYS) out[k] = MODIFIER_KIND[k] === 'mul' ? 1 : 0;
  return out;
}

/** What a country with no technology at all has. */
export const NO_MODIFIERS: TechModifiers = Object.freeze(baseModifiers());

const EMPTY_TECHS: readonly TechId[] = Object.freeze([]);

/**
 * Cache, keyed on the country's own research state.
 *
 * `techModifiers` is called from the combat loop, which runs every hour for
 * every battle, so recomputing a sum over fifty technologies each time would
 * be the most expensive thing in the simulation. The completed list only ever
 * grows, so its length is a sufficient version stamp.
 */
const modifierCache = new WeakMap<ResearchState, { n: number; mods: TechModifiers }>();

/**
 * The multipliers the rest of the simulation should apply for this country.
 *
 * `mul` keys are multipliers around 1 (softAttack 1.35 = +35%); `add` keys are
 * plain additions (buildingSlots 2 = two more slots). The returned record is
 * frozen and shared -- read it, never write it.
 */
export function techModifiers(state: GameState, country: CountryId): TechModifiers {
  const c = state.countries[country];
  if (!c) return NO_MODIFIERS;
  const research = c.research;
  const completed = research.completed ?? EMPTY_TECHS;
  if (completed.length === 0) return NO_MODIFIERS;

  const hit = modifierCache.get(research);
  if (hit && hit.n === completed.length) return hit.mods;

  const out = baseModifiers();
  for (const id of completed) {
    const def = techDef(id);
    if (!def) continue;
    for (const k of MODIFIER_KEYS) {
      const delta = def.effects[k];
      if (delta === undefined) continue;
      out[k] += delta;
    }
  }
  // Summing tenths in binary floating point produces 0.12000000000000001, which
  // is fine arithmetic and terrible to display. Six places is far more than any
  // effect needs and keeps saved games byte-comparable.
  for (const k of MODIFIER_KEYS) out[k] = Math.round(out[k] * 1e6) / 1e6;
  const mods = Object.freeze(out) as TechModifiers;
  modifierCache.set(research, { n: completed.length, mods });
  return mods;
}

/**
 * A division template with this country's technology folded in.
 *
 * Combat, movement and supply all want the same nine numbers scaled the same
 * way, so this is the one place that does it. Results are cached per template
 * object and invalidated whenever the country completes anything; templates are
 * replaced wholesale when the player edits one, so identity is a safe key.
 */
const templateCache = new WeakMap<
  DivisionTemplate, { country: CountryId; n: number; tpl: DivisionTemplate }
>();

export function effectiveTemplate(
  state: GameState, country: CountryId, tpl: DivisionTemplate,
): DivisionTemplate {
  const c = state.countries[country];
  const n = c?.research.completed?.length ?? 0;
  if (n === 0) return tpl;

  const hit = templateCache.get(tpl);
  if (hit && hit.country === country && hit.n === n) return hit.tpl;

  const m = techModifiers(state, country);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const out: DivisionTemplate = {
    ...tpl,
    maxOrg: r2(tpl.maxOrg * m.maxOrg),
    softAttack: r2(tpl.softAttack * m.softAttack),
    hardAttack: r2(tpl.hardAttack * m.hardAttack),
    defense: r2(tpl.defense * m.defense),
    breakthrough: r2(tpl.breakthrough * m.breakthrough),
    armor: r2(tpl.armor * m.armor),
    piercing: r2(tpl.piercing * m.piercing),
    speedKmh: r2(tpl.speedKmh * m.speedKmh),
    supplyUse: r2(tpl.supplyUse * m.supplyUse),
  };
  templateCache.set(tpl, { country, n, tpl: out });
  return out;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function idleSlot(): ResearchSlot {
  return { tech: null, progress: 0, required: 0 };
}

/** Slots this country actually has, base plus anything technology granted. */
export function effectiveSlotCount(state: GameState, country: CountryId): number {
  const c = state.countries[country];
  if (!c) return 0;
  const extra = techModifiers(state, country).researchSlots;
  return Math.max(0, Math.min(MAX_RESEARCH_SLOTS, Math.floor(c.research.slots + extra)));
}

/**
 * Brings a country's slot array in line with how many slots it has.
 *
 * The 1936 scenario table has no per-slot state at all, so this is also the
 * lazy initialiser: any country that has never researched anything gets its
 * slots here, on the first daily tick or the first command.
 */
export function ensureSlots(state: GameState, c: Country): ResearchSlot[] {
  const research = c.research;
  if (!research.completed) research.completed = [];
  if (!research.active) research.active = [];
  const active = research.active;
  const want = effectiveSlotCount(state, c.id);
  while (active.length < want) active.push(idleSlot());
  // Losing a slot (only possible if `slots` itself is reduced) drops the
  // last one; anything it had in flight is abandoned rather than silently
  // finishing in a slot that no longer exists.
  if (active.length > want) active.length = want;
  return active;
}

/** Per-slot state without mutating anything, for views. */
function readSlots(state: GameState, c: Country): readonly ResearchSlot[] {
  const active = c.research.active;
  if (active && active.length > 0) return active;
  const want = effectiveSlotCount(state, c.id);
  const out: ResearchSlot[] = [];
  for (let i = 0; i < want; i++) out.push(idleSlot());
  return out;
}

// ---------------------------------------------------------------------------
// Cost of a technology
// ---------------------------------------------------------------------------

/** The current date as a fractional year, e.g. 1938.5 at the end of June 1938. */
function yearFraction(state: GameState): number {
  const clock = state.clock;
  const yearStartDay = hoursFromDate(clock.year, 1, 1) / HOURS_PER_DAY;
  const into = clock.totalDays - yearStartDay;
  return clock.year + into / daysInYear(clock.year);
}

/** How many years early this technology would be, 0 once its year has come. */
export function yearsAhead(state: GameState, tech: TechDef): number {
  return Math.max(0, tech.year - yearFraction(state));
}

/** Multiplier on the base cost from researching before the historical year. */
export function aheadPenalty(state: GameState, tech: TechDef): number {
  return 1 + yearsAhead(state, tech) * AHEAD_PENALTY_PER_YEAR;
}

/** Research days a technology needs if started today, before speed modifiers. */
export function requiredDays(state: GameState, tech: TechDef): number {
  return Math.round(tech.days * aheadPenalty(state, tech));
}

/** Research days a country accumulates per day, in every slot. */
export function researchSpeed(state: GameState, country: CountryId): number {
  return Math.max(MIN_RESEARCH_SPEED, techModifiers(state, country).researchSpeed);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function isResearched(state: GameState, country: CountryId, tech: TechId): boolean {
  const c = state.countries[country];
  return !!c && (c.research.completed?.includes(tech) ?? false);
}

/** Slot index currently working this technology, or -1. */
export function slotResearching(state: GameState, country: CountryId, tech: TechId): number {
  const c = state.countries[country];
  if (!c) return -1;
  const slots = readSlots(state, c);
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].tech === tech) return i;
  }
  return -1;
}

/** Prerequisites this country has not finished yet. */
export function missingPrerequisites(
  state: GameState, country: CountryId, tech: TechDef,
): TechId[] {
  const out: TechId[] = [];
  for (const p of tech.prerequisites) {
    if (!isResearched(state, country, p)) out.push(p);
  }
  return out;
}

/** Whether a technology can be started right now, and if not, why not. */
export function researchBlock(
  state: GameState, country: CountryId, techId: TechId,
): { reason: TechBlockReason; missing: TechId[] } {
  const c = state.countries[country];
  const def = techDef(techId);
  if (!c || !def) return { reason: 'unknown', missing: [] };
  // What a country already has, it keeps: a finished technology reads as
  // finished even after the country has surrendered.
  if (isResearched(state, country, techId)) return { reason: 'completed', missing: [] };
  if (slotResearching(state, country, techId) >= 0) return { reason: 'inProgress', missing: [] };
  if (c.capitulated) return { reason: 'capitulated', missing: [] };
  const missing = missingPrerequisites(state, country, def);
  if (missing.length > 0) return { reason: 'prerequisites', missing };
  return { reason: 'ok', missing: [] };
}

export function canResearch(state: GameState, country: CountryId, techId: TechId): boolean {
  return researchBlock(state, country, techId).reason === 'ok';
}

/** Everything this country could start today, in tree order. */
export function availableTechs(state: GameState, country: CountryId): TechDef[] {
  const out: TechDef[] = [];
  for (const tech of TECHS) {
    if (canResearch(state, country, tech.id)) out.push(tech);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Puts a technology into a slot.
 *
 * Returns false and changes nothing if the slot does not exist, the technology
 * is not researchable, or that slot is already working on it. Starting
 * something new in a slot that is already busy abandons what was there:
 * progress is per-slot, not per-technology, so switching costs the slot
 * everything it had accumulated.
 */
export function startResearch(
  state: GameState, country: CountryId, slot: number, techId: TechId,
): boolean {
  const c = state.countries[country];
  if (!c) return false;
  const def = techDef(techId);
  if (!def) return false;
  const slots = ensureSlots(state, c);
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length) return false;
  if (slots[slot].tech === techId) return false;
  if (!canResearch(state, country, techId)) return false;

  slots[slot] = { tech: techId, progress: 0, required: requiredDays(state, def) };
  return true;
}

/** Empties a slot, losing its progress. */
export function cancelResearch(state: GameState, country: CountryId, slot: number): boolean {
  const c = state.countries[country];
  if (!c) return false;
  const slots = ensureSlots(state, c);
  if (slot < 0 || slot >= slots.length || slots[slot].tech === null) return false;
  slots[slot] = idleSlot();
  return true;
}

// ---------------------------------------------------------------------------
// Automatic selection
// ---------------------------------------------------------------------------

/**
 * How much a country wants each branch, before it is at war.
 *
 * Industry leads in peacetime because everything else is downstream of it, and
 * naval trails because most of the map is landlocked -- a country with a real
 * fleet raises it below.
 */
const PEACE_WEIGHT: Record<TechBranch, number> = {
  industry: 1.00,
  infantry: 0.92,
  artillery: 0.84,
  armor: 0.78,
  air: 0.70,
  electronics: 0.66,
  naval: 0.45,
};

/** At war the weapons lines come first; the factories are already built. */
const WAR_WEIGHT: Record<TechBranch, number> = {
  infantry: 1.00,
  artillery: 0.95,
  armor: 0.90,
  air: 0.85,
  industry: 0.80,
  electronics: 0.66,
  naval: 0.45,
};

/** Dockyards above this make a country take the naval line seriously. */
const NAVAL_POWER_DOCKYARDS = 8;

/** A slot leans toward one branch so a country does not put everything in one. */
const SLOT_AFFINITY = 1.4;

/** Years ahead a country will pay for without being desperate. */
const AUTO_AHEAD_TOLERANCE = 1;
const AUTO_AHEAD_MAX = 3;

/**
 * What this country should research next in this slot.
 *
 * Deterministic: the weights depend only on state the simulation already has,
 * and ties break on position in the tech table. Exported so the AI, or a
 * "recommend" button in the research panel, can ask the same question the
 * daily tick asks.
 */
export function autoSelectResearch(
  state: GameState, country: CountryId, slot: number,
): TechId | null {
  const c = state.countries[country];
  if (!c || c.capitulated) return null;
  const atWar = c.atWarWith.length > 0;
  const weights = atWar ? WAR_WEIGHT : PEACE_WEIGHT;
  const naval = c.economy.dockyards >= NAVAL_POWER_DOCKYARDS;
  // Every country leans a different way in a given slot, so two neighbours with
  // the same industry do not end the decade with the same army.
  const preferred = TECH_BRANCHES[(slot + country) % TECH_BRANCHES.length];

  let best: TechDef | null = null;
  let bestScore = -Infinity;
  let bestTolerance = Infinity;

  for (const tech of TECHS) {
    if (!canResearch(state, country, tech.id)) continue;
    const ahead = yearsAhead(state, tech);
    // Prefer anything at most a year early; only reach further ahead when
    // there is nothing sensible left on the shelf.
    const tolerance = ahead <= AUTO_AHEAD_TOLERANCE ? 0 : (ahead <= AUTO_AHEAD_MAX ? 1 : 2);

    let weight = weights[tech.branch];
    if (tech.branch === 'naval' && naval) weight = 0.80;
    if (tech.branch === preferred) weight *= SLOT_AFFINITY;

    // Value per day spent: a cheap technology in a wanted branch beats an
    // expensive one in the same branch, which is also what a player does.
    const score = (weight * 1000) / Math.max(1, requiredDays(state, tech));

    if (tolerance < bestTolerance
      || (tolerance === bestTolerance && score > bestScore)) {
      bestTolerance = tolerance;
      bestScore = score;
      best = tech;
    }
  }
  return best ? best.id : null;
}

// ---------------------------------------------------------------------------
// Daily tick
// ---------------------------------------------------------------------------

/**
 * One research day for every country.
 *
 * Idle slots are filled automatically for AI countries -- an AI that never
 * chose anything would leave the whole system switched off for thirty-odd
 * nations. The player's idle slots stay idle: choosing is the point.
 */
export function tickResearchDaily(state: GameState): void {
  for (const c of state.countries) {
    if (c.capitulated) continue;
    const slots = ensureSlots(state, c);
    // Fixed for the whole day, so a technology completing in slot 0 cannot
    // change how fast slot 1 moved on the same day.
    const speed = researchSpeed(state, c.id);

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.tech === null) {
        if (!c.isAI) continue;
        const pick = autoSelectResearch(state, c.id, i);
        if (pick === null) continue;
        if (!startResearch(state, c.id, i, pick)) continue;
      }
      const slotNow = slots[i];
      if (slotNow.tech === null) continue;

      slotNow.progress += speed;
      if (slotNow.progress < slotNow.required) continue;

      completeTech(state, c, i);
    }
    // A technology that granted a slot opens it for tomorrow.
    ensureSlots(state, c);
  }
}

function completeTech(state: GameState, c: Country, slot: number): void {
  const slots = c.research.active!;
  const techId = slots[slot].tech;
  if (techId === null) return;
  slots[slot] = idleSlot();
  (c.research.completed ??= []).push(techId);

  state.log.push({
    day: state.clock.totalDays,
    kind: 'research',
    // The simulation records the identifier; the UI looks up the name with
    // techDef(id).name, the same way it does for buildings and equipment.
    body: { k: 'itemCompleted', country: c.tag, item: techId },
    country: c.id,
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface EffectView {
  key: ModifierKey;
  /** Japanese label for the quantity. */
  label: string;
  /** Signed, formatted delta, e.g. "+6%" or "+1". */
  value: string;
  raw: number;
}

function effectViews(def: TechDef): EffectView[] {
  const out: EffectView[] = [];
  for (const k of MODIFIER_KEYS) {
    const delta = def.effects[k];
    if (delta === undefined || delta === 0) continue;
    out.push({ key: k, label: MODIFIER_LABEL[k], value: formatModifier(k, delta), raw: delta });
  }
  return out;
}

export interface SlotView {
  slot: number;
  techId: TechId | null;
  /** Technology name, or 研究なし for an empty slot. */
  name: string;
  branch: TechBranch | null;
  branchName: string;
  /** Historical year of the technology in the slot; 0 when idle. */
  year: number;
  /** Research days accumulated, and days the technology needs. */
  progress: number;
  required: number;
  /** 0..1. */
  percent: number;
  /** Calendar days left at the country's current research speed. */
  daysRemaining: number;
  /** Years early this technology was when it was started. */
  aheadYears: number;
  /** Days of that cost that are pure ahead-of-time penalty. */
  aheadPenaltyDays: number;
  effects: EffectView[];
  idle: boolean;
}

/** Every slot this country has, in slot order. */
export function researchView(state: GameState, country: CountryId): SlotView[] {
  const c = state.countries[country];
  if (!c) return [];
  const slots = readSlots(state, c);
  const speed = researchSpeed(state, country);
  const out: SlotView[] = [];

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const def = s.tech !== null ? techDef(s.tech) : undefined;
    if (!def) {
      out.push({
        slot: i, techId: null, name: IDLE_SLOT_NAME, branch: null, branchName: '',
        year: 0, progress: 0, required: 0, percent: 0, daysRemaining: 0,
        aheadYears: 0, aheadPenaltyDays: 0, effects: [], idle: true,
      });
      continue;
    }
    const remaining = Math.max(0, s.required - s.progress);
    // The penalty is whatever the locked-in cost carries above the base cost.
    const penaltyDays = Math.max(0, s.required - def.days);
    out.push({
      slot: i,
      techId: def.id,
      name: def.name,
      branch: def.branch,
      branchName: BRANCH_NAME[def.branch],
      year: def.year,
      progress: Math.round(s.progress * 10) / 10,
      required: s.required,
      percent: s.required > 0 ? Math.min(1, s.progress / s.required) : 0,
      daysRemaining: Math.ceil(remaining / speed),
      aheadYears: Math.round((penaltyDays / Math.max(1, def.days) / AHEAD_PENALTY_PER_YEAR) * 10) / 10,
      aheadPenaltyDays: penaltyDays,
      effects: effectViews(def),
      idle: false,
    });
  }
  return out;
}

export interface TechView {
  id: TechId;
  /** Japanese name. */
  name: string;
  branch: TechBranch;
  branchName: string;
  /** Historical year. Anything earlier costs the ahead-of-time penalty. */
  year: number;
  /** Base cost in research days, before penalty and speed. */
  baseDays: number;
  /** Days it would cost if started today, penalty included. */
  requiredDays: number;
  /** Calendar days that is, at this country's research speed. */
  daysRemaining: number;
  /** Years early it would be today, 0 once its year has come. */
  aheadYears: number;
  /** Of `requiredDays`, how many are the ahead-of-time penalty. */
  aheadPenaltyDays: number;
  prerequisites: TechId[];
  /** Names of the prerequisites, in the same order. */
  prerequisiteNames: string[];
  /** Prerequisites this country still lacks. */
  missing: TechId[];
  missingNames: string[];
  researchable: boolean;
  /** Why not, when `researchable` is false. */
  reason: TechBlockReason;
  /** The same, in Japanese. */
  reasonText: string;
  completed: boolean;
  /** Slot working on it, or null. */
  slot: number | null;
  effects: EffectView[];
}

/** One branch of the tree as the panel should draw it, earliest first. */
export function techTree(
  state: GameState, country: CountryId, branch: TechBranch,
): TechView[] {
  const c = state.countries[country];
  if (!c) return [];
  const speed = researchSpeed(state, country);
  const slots = readSlots(state, c);
  const out: TechView[] = [];

  for (const def of techsInBranch(branch)) {
    const block = researchBlock(state, country, def.id);
    const cost = requiredDays(state, def);

    let slot: number | null = null;
    let remaining = cost;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].tech !== def.id) continue;
      slot = i;
      remaining = Math.max(0, slots[i].required - slots[i].progress);
      break;
    }

    out.push({
      id: def.id,
      name: def.name,
      branch: def.branch,
      branchName: BRANCH_NAME[def.branch],
      year: def.year,
      baseDays: def.days,
      requiredDays: cost,
      daysRemaining: Math.ceil(remaining / speed),
      aheadYears: Math.round(yearsAhead(state, def) * 10) / 10,
      aheadPenaltyDays: Math.max(0, cost - def.days),
      prerequisites: [...def.prerequisites],
      prerequisiteNames: def.prerequisites.map((p) => techDef(p)?.name ?? p),
      missing: block.missing,
      missingNames: block.missing.map((p) => techDef(p)?.name ?? p),
      researchable: block.reason === 'ok',
      reason: block.reason,
      reasonText: BLOCK_REASON_TEXT[block.reason],
      completed: block.reason === 'completed',
      slot,
      effects: effectViews(def),
    });
  }
  return out;
}

/** Technologies this country has finished, in completion order. */
export function completedTechs(state: GameState, country: CountryId): TechDef[] {
  const c = state.countries[country];
  if (!c) return [];
  const out: TechDef[] = [];
  for (const id of c.research.completed ?? EMPTY_TECHS) {
    const def = techDef(id);
    if (def) out.push(def);
  }
  return out;
}

/** Header numbers for the research panel. */
export function researchSummary(state: GameState, country: CountryId): {
  slots: number; completed: number; total: number; speed: number;
} {
  return {
    slots: effectiveSlotCount(state, country),
    completed: state.countries[country]?.research.completed?.length ?? 0,
    total: TECHS.length,
    speed: researchSpeed(state, country),
  };
}
