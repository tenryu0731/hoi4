import type { TechId } from '../core/types';

/**
 * The technology trees, as data.
 *
 * A technology is a dated entry in a branch: it has a historical year, a base
 * research time in days, the technologies that must precede it, and a set of
 * modifier deltas. Nothing here executes -- `research.ts` is the only file that
 * knows what any of it means.
 *
 * Two rules shape the numbers:
 *
 *   - Every effect drives something the simulation already reads. There is no
 *     modifier here that no other system consumes; a technology that changes
 *     nothing is a technology the player is right to ignore.
 *   - The dates are the pacing. A country may research anything at any time,
 *     but a technology taken before its year costs extra days (see
 *     AHEAD_PENALTY_PER_YEAR in research.ts), so the tree paces itself without
 *     needing to lock anything.
 *
 * Display names live here because they are content, not presentation: what a
 * technology is called is part of the design of the tree, in the same way its
 * date and its cost are. The runtime never formats a sentence.
 */

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export const TECH_BRANCHES = [
  'infantry', 'artillery', 'armor', 'air', 'naval', 'industry', 'electronics',
] as const;
export type TechBranch = (typeof TECH_BRANCHES)[number];

export const BRANCH_NAME: Record<TechBranch, string> = {
  infantry: '歩兵',
  artillery: '砲兵',
  armor: '機甲',
  air: '航空',
  naval: '海軍',
  industry: '工業',
  electronics: '電子機械',
};

/** Branch list in tab order, ready for the UI. */
export const BRANCH_LIST: readonly { id: TechBranch; name: string }[] =
  TECH_BRANCHES.map((id) => ({ id, name: BRANCH_NAME[id] }));

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/**
 * Every quantity research can move.
 *
 * Each key names something that already exists somewhere in the simulation:
 * the first block is `DivisionTemplate` fields, then the combat and naval
 * layers, then the economy, then research itself.
 */
export const MODIFIER_KEYS = [
  'softAttack', 'hardAttack', 'defense', 'breakthrough', 'armor', 'piercing',
  'maxOrg', 'speedKmh', 'supplyUse',
  'airSupport', 'sealift', 'landingOrg',
  'factoryOutput', 'efficiencyCap', 'constructionSpeed', 'buildingSlots',
  'resourceOutput',
  'researchSpeed', 'researchSlots',
] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

/**
 * How a modifier accumulates.
 *
 * `mul` keys sum their deltas and are applied as `1 + sum`, so ten small
 * bonuses are predictable instead of compounding into a runaway. `add` keys are
 * plain sums: extra building slots, extra research slots, and the production
 * efficiency ceiling, which is already a fraction.
 */
export const MODIFIER_KIND: Record<ModifierKey, 'mul' | 'add'> = {
  softAttack: 'mul',
  hardAttack: 'mul',
  defense: 'mul',
  breakthrough: 'mul',
  armor: 'mul',
  piercing: 'mul',
  maxOrg: 'mul',
  speedKmh: 'mul',
  supplyUse: 'mul',
  airSupport: 'mul',
  sealift: 'mul',
  landingOrg: 'mul',
  factoryOutput: 'mul',
  efficiencyCap: 'add',
  constructionSpeed: 'mul',
  buildingSlots: 'add',
  resourceOutput: 'mul',
  researchSpeed: 'mul',
  researchSlots: 'add',
};

export const MODIFIER_LABEL: Record<ModifierKey, string> = {
  softAttack: 'ソフト攻撃',
  hardAttack: 'ハード攻撃',
  defense: '防御',
  breakthrough: '突破',
  armor: '装甲',
  piercing: '貫通',
  maxOrg: '組織率',
  speedKmh: '速度',
  supplyUse: '補給消費',
  airSupport: '航空支援',
  sealift: '海上輸送力',
  landingOrg: '上陸時組織率',
  factoryOutput: '工場生産量',
  efficiencyCap: '生産効率上限',
  constructionSpeed: '建設速度',
  buildingSlots: '建設スロット',
  resourceOutput: '資源産出',
  researchSpeed: '研究速度',
  researchSlots: '研究スロット',
};

/** Modifier deltas a technology grants. Absent key = no effect. */
export type TechEffects = Partial<Record<ModifierKey, number>>;

/** A signed, human-readable form of one effect, for the tooltip. */
export function formatModifier(key: ModifierKey, delta: number): string {
  if (key === 'buildingSlots' || key === 'researchSlots') {
    return `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}`;
  }
  const pct = Math.round(Math.abs(delta) * 1000) / 10;
  return `${delta >= 0 ? '+' : '−'}${pct}%`;
}

// ---------------------------------------------------------------------------
// Technologies
// ---------------------------------------------------------------------------

export interface TechDef {
  id: TechId;
  /** Display name, Japanese. */
  name: string;
  branch: TechBranch;
  /** The year it is expected to arrive. Earlier than this costs extra days. */
  year: number;
  /** Research days at or after `year`, before any speed modifier. */
  days: number;
  /** Technologies that must already be complete. */
  prerequisites: readonly TechId[];
  effects: TechEffects;
}

/**
 * The trees.
 *
 * Ordered by branch and then by year, which is the order the UI shows them in
 * and the order the automatic selector walks; nothing anywhere iterates this by
 * key, so the ordering here is the ordering everywhere.
 */
export const TECHS: readonly TechDef[] = [
  // --- 歩兵 ---------------------------------------------------------------
  {
    id: 'inf_weapons1', name: '歩兵装備 I', branch: 'infantry', year: 1936, days: 140,
    prerequisites: [], effects: { softAttack: 0.06, defense: 0.04 },
  },
  {
    id: 'inf_support_weapons', name: '支援火器', branch: 'infantry', year: 1937, days: 160,
    prerequisites: ['inf_weapons1'], effects: { softAttack: 0.05, breakthrough: 0.05 },
  },
  {
    id: 'inf_engineers', name: '工兵装備', branch: 'infantry', year: 1938, days: 170,
    prerequisites: ['inf_weapons1'], effects: { defense: 0.06, speedKmh: 0.03 },
  },
  {
    id: 'inf_weapons2', name: '歩兵装備 II', branch: 'infantry', year: 1939, days: 190,
    prerequisites: ['inf_support_weapons'], effects: { softAttack: 0.07, defense: 0.05 },
  },
  {
    id: 'inf_mountain', name: '山岳装備', branch: 'infantry', year: 1940, days: 180,
    prerequisites: ['inf_engineers'], effects: { defense: 0.05, speedKmh: 0.05, supplyUse: -0.03 },
  },
  {
    id: 'inf_squad_tactics', name: '分隊戦術', branch: 'infantry', year: 1941, days: 200,
    prerequisites: ['inf_weapons2'], effects: { breakthrough: 0.08, maxOrg: 0.04 },
  },
  {
    id: 'inf_weapons3', name: '歩兵装備 III', branch: 'infantry', year: 1942, days: 220,
    prerequisites: ['inf_squad_tactics'], effects: { softAttack: 0.08, defense: 0.06 },
  },
  {
    id: 'inf_at_infantry', name: '携行対戦車兵器', branch: 'infantry', year: 1943, days: 230,
    prerequisites: ['inf_weapons3'], effects: { hardAttack: 0.25, piercing: 0.10 },
  },
  {
    id: 'inf_assault_rifle', name: '突撃銃', branch: 'infantry', year: 1944, days: 250,
    prerequisites: ['inf_weapons3'], effects: { softAttack: 0.10, breakthrough: 0.05 },
  },

  // --- 砲兵 ---------------------------------------------------------------
  {
    id: 'art_gun1', name: '野砲 I', branch: 'artillery', year: 1936, days: 150,
    prerequisites: [], effects: { softAttack: 0.06, breakthrough: 0.03 },
  },
  {
    id: 'art_at1', name: '対戦車砲 I', branch: 'artillery', year: 1936, days: 150,
    prerequisites: [], effects: { hardAttack: 0.15, piercing: 0.08 },
  },
  {
    id: 'art_aa1', name: '高射砲', branch: 'artillery', year: 1937, days: 160,
    prerequisites: ['art_at1'], effects: { hardAttack: 0.08, defense: 0.04 },
  },
  {
    id: 'art_gun2', name: '野砲 II', branch: 'artillery', year: 1939, days: 190,
    prerequisites: ['art_gun1'], effects: { softAttack: 0.07, breakthrough: 0.04 },
  },
  {
    id: 'art_at2', name: '対戦車砲 II', branch: 'artillery', year: 1940, days: 200,
    prerequisites: ['art_at1'], effects: { hardAttack: 0.18, piercing: 0.10 },
  },
  {
    id: 'art_rocket', name: 'ロケット砲', branch: 'artillery', year: 1942, days: 220,
    prerequisites: ['art_gun2'], effects: { softAttack: 0.09, breakthrough: 0.06 },
  },
  {
    id: 'art_gun3', name: '野砲 III', branch: 'artillery', year: 1943, days: 230,
    prerequisites: ['art_gun2'], effects: { softAttack: 0.08, defense: 0.04 },
  },
  {
    id: 'art_at3', name: '対戦車砲 III', branch: 'artillery', year: 1944, days: 240,
    prerequisites: ['art_at2'], effects: { hardAttack: 0.18, piercing: 0.12 },
  },

  // --- 機甲 ---------------------------------------------------------------
  {
    id: 'arm_light1', name: '軽戦車 I', branch: 'armor', year: 1936, days: 160,
    prerequisites: [], effects: { armor: 0.05, breakthrough: 0.05 },
  },
  {
    id: 'arm_light2', name: '軽戦車 II', branch: 'armor', year: 1938, days: 180,
    prerequisites: ['arm_light1'], effects: { armor: 0.06, breakthrough: 0.06, speedKmh: 0.03 },
  },
  {
    id: 'arm_medium1', name: '中戦車 I', branch: 'armor', year: 1939, days: 210,
    prerequisites: ['arm_light2'],
    effects: { armor: 0.10, piercing: 0.10, hardAttack: 0.10, breakthrough: 0.08 },
  },
  {
    id: 'arm_mech', name: '装甲擲弾兵', branch: 'armor', year: 1940, days: 190,
    prerequisites: ['arm_light2'], effects: { speedKmh: 0.06, defense: 0.05, maxOrg: 0.03 },
  },
  {
    id: 'arm_medium2', name: '中戦車 II', branch: 'armor', year: 1941, days: 230,
    prerequisites: ['arm_medium1'], effects: { armor: 0.10, piercing: 0.10, hardAttack: 0.10 },
  },
  {
    id: 'arm_td', name: '駆逐戦車', branch: 'armor', year: 1942, days: 210,
    prerequisites: ['arm_medium1'], effects: { hardAttack: 0.20, piercing: 0.12 },
  },
  {
    id: 'arm_medium3', name: '中戦車 III', branch: 'armor', year: 1943, days: 250,
    prerequisites: ['arm_medium2'], effects: { armor: 0.12, breakthrough: 0.08, hardAttack: 0.08 },
  },
  {
    id: 'arm_heavy', name: '重戦車', branch: 'armor', year: 1944, days: 270,
    prerequisites: ['arm_medium3'],
    effects: { armor: 0.15, piercing: 0.10, breakthrough: 0.06, speedKmh: -0.03 },
  },

  // --- 航空 ---------------------------------------------------------------
  {
    id: 'air_fighter1', name: '戦闘機 I', branch: 'air', year: 1936, days: 150,
    prerequisites: [], effects: { airSupport: 0.05 },
  },
  {
    id: 'air_cas1', name: '近接航空支援 I', branch: 'air', year: 1937, days: 170,
    prerequisites: ['air_fighter1'], effects: { softAttack: 0.04, airSupport: 0.05 },
  },
  {
    id: 'air_bomber1', name: '戦術爆撃機', branch: 'air', year: 1938, days: 200,
    prerequisites: ['air_fighter1'], effects: { airSupport: 0.06, hardAttack: 0.04 },
  },
  {
    id: 'air_fighter2', name: '戦闘機 II', branch: 'air', year: 1940, days: 210,
    prerequisites: ['air_fighter1'], effects: { airSupport: 0.07 },
  },
  {
    id: 'air_cas2', name: '近接航空支援 II', branch: 'air', year: 1941, days: 220,
    prerequisites: ['air_cas1'], effects: { softAttack: 0.05, hardAttack: 0.10, airSupport: 0.05 },
  },
  {
    id: 'air_naval_bomber', name: '雷撃機', branch: 'air', year: 1942, days: 210,
    prerequisites: ['air_bomber1'], effects: { airSupport: 0.04, sealift: 0.08 },
  },
  {
    id: 'air_fighter3', name: '戦闘機 III', branch: 'air', year: 1943, days: 240,
    prerequisites: ['air_fighter2'], effects: { airSupport: 0.08 },
  },
  {
    id: 'air_jet', name: 'ジェット機関', branch: 'air', year: 1945, days: 280,
    prerequisites: ['air_fighter3'], effects: { airSupport: 0.12 },
  },

  // --- 海軍 ---------------------------------------------------------------
  {
    id: 'nav_convoy1', name: '船団護衛', branch: 'naval', year: 1936, days: 140,
    prerequisites: [], effects: { sealift: 0.10 },
  },
  {
    id: 'nav_dockyard', name: '造船所近代化', branch: 'naval', year: 1937, days: 170,
    prerequisites: ['nav_convoy1'], effects: { sealift: 0.08, constructionSpeed: 0.05 },
  },
  {
    id: 'nav_landing_craft', name: '揚陸艇', branch: 'naval', year: 1938, days: 180,
    prerequisites: ['nav_convoy1'], effects: { landingOrg: 0.15, sealift: 0.05 },
  },
  {
    id: 'nav_destroyer', name: '駆逐艦', branch: 'naval', year: 1939, days: 190,
    prerequisites: ['nav_dockyard'], effects: { sealift: 0.08 },
  },
  {
    id: 'nav_asw', name: '対潜哨戒', branch: 'naval', year: 1940, days: 190,
    prerequisites: ['nav_destroyer'], effects: { sealift: 0.10 },
  },
  {
    id: 'nav_transport_ship', name: '大型輸送船', branch: 'naval', year: 1941, days: 210,
    prerequisites: ['nav_landing_craft'], effects: { sealift: 0.12 },
  },
  {
    id: 'nav_amphibious', name: '上陸戦術', branch: 'naval', year: 1943, days: 230,
    prerequisites: ['nav_transport_ship'], effects: { landingOrg: 0.20, sealift: 0.05 },
  },
  {
    id: 'nav_escort_carrier', name: '護衛空母', branch: 'naval', year: 1944, days: 250,
    prerequisites: ['nav_asw'], effects: { sealift: 0.10, airSupport: 0.03 },
  },

  // --- 工業 ---------------------------------------------------------------
  {
    id: 'ind_construction1', name: '建設技術 I', branch: 'industry', year: 1936, days: 150,
    prerequisites: [], effects: { constructionSpeed: 0.10 },
  },
  {
    id: 'ind_tools1', name: '工作機械 I', branch: 'industry', year: 1936, days: 160,
    prerequisites: [], effects: { factoryOutput: 0.05, efficiencyCap: 0.03 },
  },
  {
    id: 'ind_research_lab', name: '研究施設', branch: 'industry', year: 1937, days: 220,
    prerequisites: ['ind_tools1'], effects: { researchSlots: 1 },
  },
  {
    id: 'ind_concentrated1', name: '集中工業', branch: 'industry', year: 1938, days: 190,
    prerequisites: ['ind_tools1'], effects: { factoryOutput: 0.08 },
  },
  {
    id: 'ind_construction2', name: '建設技術 II', branch: 'industry', year: 1939, days: 200,
    prerequisites: ['ind_construction1'], effects: { constructionSpeed: 0.10, buildingSlots: 1 },
  },
  {
    id: 'ind_excavation', name: '資源採掘', branch: 'industry', year: 1940, days: 190,
    prerequisites: ['ind_construction1'], effects: { resourceOutput: 0.10 },
  },
  {
    id: 'ind_tools2', name: '工作機械 II', branch: 'industry', year: 1941, days: 220,
    prerequisites: ['ind_concentrated1'], effects: { factoryOutput: 0.07, efficiencyCap: 0.04 },
  },
  {
    id: 'ind_synthetic', name: '合成石油', branch: 'industry', year: 1942, days: 230,
    prerequisites: ['ind_excavation'], effects: { resourceOutput: 0.12 },
  },
  {
    id: 'ind_construction3', name: '建設技術 III', branch: 'industry', year: 1943, days: 240,
    prerequisites: ['ind_construction2'], effects: { constructionSpeed: 0.10, buildingSlots: 1 },
  },
  {
    id: 'ind_dispersed', name: '分散工業', branch: 'industry', year: 1944, days: 260,
    prerequisites: ['ind_tools2'], effects: { factoryOutput: 0.05, efficiencyCap: 0.05 },
  },

  // --- 電子機械 -----------------------------------------------------------
  {
    id: 'ele_radio', name: '無線機', branch: 'electronics', year: 1936, days: 150,
    prerequisites: [], effects: { maxOrg: 0.05 },
  },
  {
    id: 'ele_computing1', name: '機械式計算機', branch: 'electronics', year: 1936, days: 170,
    prerequisites: [], effects: { researchSpeed: 0.05 },
  },
  {
    id: 'ele_radar1', name: '電波探知機 I', branch: 'electronics', year: 1938, days: 190,
    prerequisites: ['ele_radio'], effects: { airSupport: 0.06, defense: 0.03 },
  },
  {
    id: 'ele_radio2', name: '無線機 II', branch: 'electronics', year: 1939, days: 200,
    prerequisites: ['ele_radio'], effects: { maxOrg: 0.05, speedKmh: 0.03, supplyUse: -0.04 },
  },
  {
    id: 'ele_decryption', name: '暗号解読', branch: 'electronics', year: 1940, days: 210,
    prerequisites: ['ele_computing1'], effects: { researchSpeed: 0.06, defense: 0.03 },
  },
  {
    id: 'ele_radar2', name: '電波探知機 II', branch: 'electronics', year: 1941, days: 220,
    prerequisites: ['ele_radar1'], effects: { airSupport: 0.06, defense: 0.03 },
  },
  {
    id: 'ele_computing2', name: '電子計算機', branch: 'electronics', year: 1943, days: 250,
    prerequisites: ['ele_decryption'], effects: { researchSpeed: 0.08, researchSlots: 1 },
  },
  {
    id: 'ele_guidance', name: '誘導装置', branch: 'electronics', year: 1944, days: 260,
    prerequisites: ['ele_computing2'],
    effects: { softAttack: 0.05, hardAttack: 0.05, airSupport: 0.04 },
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const BY_ID = new Map<TechId, TechDef>();
const BY_BRANCH = new Map<TechBranch, TechDef[]>();
for (const b of TECH_BRANCHES) BY_BRANCH.set(b, []);

for (const tech of TECHS) {
  if (BY_ID.has(tech.id)) throw new Error(`duplicate technology id: ${tech.id}`);
  BY_ID.set(tech.id, tech);
  BY_BRANCH.get(tech.branch)!.push(tech);
}
// A mistyped prerequisite is a technology nobody can ever research, and it
// would fail silently for the whole campaign. The table is static, so checking
// it once at load is as good as checking it at compile time.
for (const tech of TECHS) {
  for (const p of tech.prerequisites) {
    if (!BY_ID.has(p)) throw new Error(`technology ${tech.id} requires unknown ${p}`);
  }
}

export function techDef(id: TechId): TechDef | undefined {
  return BY_ID.get(id);
}

/** Every technology in a branch, in tree order (year, then declaration). */
export function techsInBranch(branch: TechBranch): readonly TechDef[] {
  return BY_BRANCH.get(branch) ?? [];
}

/** Position of a technology in `TECHS`; the deterministic tie-break everywhere. */
const ORDER = new Map<TechId, number>(TECHS.map((t, i) => [t.id, i]));
export function techOrder(id: TechId): number {
  return ORDER.get(id) ?? Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Why a technology cannot be researched
// ---------------------------------------------------------------------------

export type TechBlockReason =
  /** Researchable right now. */
  | 'ok'
  /** Already finished. */
  | 'completed'
  /** Occupying one of this country's slots already. */
  | 'inProgress'
  /** One or more prerequisites are missing. */
  | 'prerequisites'
  /** The country has surrendered. */
  | 'capitulated'
  /** No such technology. */
  | 'unknown';

export const BLOCK_REASON_TEXT: Record<TechBlockReason, string> = {
  ok: '研究可能',
  completed: '研究済み',
  inProgress: '研究中',
  prerequisites: '前提技術が未完了',
  capitulated: '降伏済み',
  unknown: '不明な技術',
};

/** Shown in place of a technology name for an empty research slot. */
export const IDLE_SLOT_NAME = '研究なし';
