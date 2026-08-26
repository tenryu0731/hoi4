import type {
  BattalionType, BuildingType, EquipmentType, GameEventBody, Ideology,
  OutcomeReason, ResourceType, SupportType, TerrainType,
} from '../sim/core/types';
import { ARMY_GROUP_NAME, ARMY_ORDINALS, ARMY_SUFFIX } from '../sim/military/command';

/**
 * Everything the player reads, in Japanese.
 *
 * The simulation deals in stable identifiers and never in prose, so this is the
 * only file that knows what language the game is played in. Country names are
 * keyed by tag rather than by the English name in the scenario table, so
 * renaming a nation for gameplay reasons cannot silently break its label.
 */

export const UI = {
  // Boot
  bootTitle: 'IRON FRONT',
  bootSubtitle: 'ヨーロッパ 1936',

  // Top bar
  politicalPower: '政治力',
  manpower: '人的資源',
  civFactories: '民需',
  milFactories: '軍需',
  divisions: '師団',
  playPause: '再生 / 一時停止',
  speed: '速度',

  // Map modes
  modePolitical: '政治',
  modeState: '州',
  modeTerrain: '地形',
  modeResource: '資源',
  modeSupply: '補給',
  modeVictory: '勝利点',

  // Bottom navigation
  navFocus: '国家方針',
  navResearch: '研究',
  navProduction: '生産',
  navConstruction: '建設',
  navArmy: '徴兵',
  recruitAndDeploy: '徴兵と配備',
  deployTo: '配備先',
  deployHint: '新しい師団が現れる州',
  navDiplomacy: '外交',
  closePanel: 'パネルを閉じる',
  navPolitics: '政治',
  fuel: '燃料',
  priority: '優先度',
  mapMode: '地図モード',
  // --- the market --------------------------------------------------------
  navTrade: '貿易',
  // --- the two administrative tiers ---------------------------------------
  tierProvince: 'プロヴィンス',
  tierState: 'ステート',
  provinceCount: 'プロヴィンス',
  provincesHere: '含まれるプロヴィンス',
  divisionsHere: '個師団',
  population: '人口',
  dockyards: '造船所',
  terrainLabel: '地形',
  fortLevel: '要塞',
  coastal: '海に面する',
  yes: 'はい',
  no: 'いいえ',
  selectAllHere: 'ここの全師団を選択',
  commandArmy: 'この軍を指揮する（地図で移動先をタップ）',
  assignTo: 'へ編成',
  // --- the technology grid ------------------------------------------------
  pickTech: '技術を選ぶと、ここに内容が出ます。',
  year: '年',
  researchedAlready: '研究済み',
  researchHere: 'で研究する',
  tradeLaw: '貿易法',
  tradeExportShare: '輸出割合',
  researchSpeedLabel: '研究速度',
  tradeFree: '空き民需',
  tradeBuying: '購入中',
  tradeSelling: '売却中',
  tradeBuy: '購入を増やす',
  tradeSell: '購入を減らす',
  tradeNoSellers: '売り手がいません',
  /** Production, imports, exports and the day's shortfall, in one line. */
  tradeBalance: (own: number, imported: number, exported: number, short: number): string => {
    const parts = [`自国 ${own}`];
    if (imported > 0) parts.push(`輸入 +${imported}`);
    if (exported > 0) parts.push(`輸出 −${exported}`);
    if (short > 0) parts.push(`不足 ${short}`);
    return parts.join(' · ');
  },
  tradeOffer: (spare: number, bought: number): string =>
    bought > 0 ? `売却可能 ${spare}／日 · 工場 ${bought} 基で購入中` : `売却可能 ${spare}／日`,
  tradeLawLine: (law: string, share: number, perFactory: number): string =>
    `${law} · 産出の ${share}% を市場へ · 民需工場 1 基につき ${perFactory}／日`,
  /* Production, as the reference lays it out: what a line makes a day, how
     efficient it has become, and the depot against what the army is short. */
  lines: '生産ライン',
  /* Equipment marks. The reference calls the window Create Variant; here it is
     one mark per type, so 「改良」 rather than 「バリアント」. */
  armyExperience: '陸軍経験',
  variantOpen: '改良',
  variantTitle: '装備の改良',
  variantMark: '改良段階',
  moduleArmor: '装甲',
  moduleGun: '主砲',
  moduleReliability: '信頼性',
  moduleEngine: '機関',
  variantLevel: (level: number, max: number): string => `${level} / ${max}`,
  variantNoExperience: (cost: number): string =>
    `改良には陸軍経験が ${cost} 必要です。経験は戦闘中の師団からしか得られません。`,
  noFactories: '工場未割当',
  closeLine: 'ラインを閉じる',
  stockHeld: (held: string): string => `在庫 ${held}`,
  stockShort: (held: string, short: string): string => `在庫 ${held} · 不足 ${short}`,
  cancel: '選択解除',
  /**
   * The tag on a front line, as the reference screenshot writes it:
   * "17 Divs - 4. Armee". A standing order the player cannot see on the map
   * is a standing order they have to remember they gave.
   */
  planLabel: (army: string, divisions: number): string => `${army} · ${divisions}個師団`,
  planOffensive: (army: string, divisions: number): string =>
    `${army} · ${divisions}個師団 進攻`,
  /** Shown while a stack is under orders and the next tap sets its objective. */
  orderHint: (n: number): string => `${n}個師団 — 移動先をタップ`,
  /* The order bar's own buttons, on the map rather than in a panel. Two
     characters each: the bar hangs over the map band, and every row it grows
     is a row of counters the player can no longer press. The chips that open
     underneath say the rest, and the aria-labels carry the full wording. */
  orderStop: '停止',
  orderStopLabel: '移動を中止する',
  orderAssign: '編成',
  orderAssignLabel: '軍へ編成',
  orderDrawFront: '戦線',
  orderDrawFrontLabel: '戦線を引く',
  orderNewArmy: '＋新しい軍',
  orderNeedsArmy: 'まず軍に編成してください',
  orderNoEnemy: '接する国がありません',
  /** The marquee tool: a button, because a phone has no modifier key. */
  boxSelectTool: '範囲',
  boxSelectToolLabel: '範囲選択',
  boxSelectArmed: '地図をなぞると、その範囲の師団をまとめて選びます',
  boxSelectHint: '「範囲選択」を押してから地図をなぞると、師団をまとめて選べます',
  airStrength: '航空戦力',
  resistance: '抵抗運動',
  priorityNames: ['低', '並', '高', '最'] as const,
  alertFuel: '燃料が不足しています。機甲・自動車化部隊が動けません',
  alertIdleFactories: '民需工場が遊んでいます。建設を指示してください',
  alertIdleResearch: '研究枠が空いています',
  alertNoFocus: '国家方針を選んでいません',
  alertIdleProduction: '軍需工場が生産ラインに割り当てられていません',
  alertUnderEquipped: '装備の足りない師団があります',
  alertNoCommander: '指揮官のいない軍があります',
  /* Captions for the top bar. Two to four characters: they sit under a figure
     in a chip 45 to 72px wide, and the point of them is that a number with a
     symbol over it says nothing about what it counts. */
  alertShortFuel: '燃料不足',
  alertShortIdleFactories: '遊休工場',
  alertShortIdleResearch: '研究枠',
  alertShortNoFocus: '国家方針',
  alertShortIdleProduction: '軍需遊休',
  alertShortUnderEquipped: '装備不足',
  alertShortNoCommander: '指揮官',
  effects: '現在の効果',
  stability: '安定度',
  warSupport: '戦争支持率',
  /** Five characters do not fit under a 56px chip; four do. */
  warSupportShort: '戦争支持',
  conscriptionLaw: '徴兵法',
  economyLaw: '経済法',
  lawMobilise: '強化',
  lawRelax: '緩和',
  lawCost: '政治力',
  lawBlockedCost: '政治力が足りません',
  lawBlockedWarSupport: '戦争支持率が足りません',
  lawBlockedTension: '世界緊張度が足りません',
  lawBlockedNeedsWar: '戦争中でなければ移行できません',
  lawBlockedDemocracy: '民主国家は開戦するまでこれ以上動員できません',
  lawBlockedEnd: 'これ以上はありません',
  recruitable: '徴兵可能人口',
  consumerGoodsShare: '消費財',
  constructionSpeed: '建設速度',
  factoryOutputLabel: '工場出力',
  zoomIn: '表示を拡大',
  zoomOut: '表示を縮小',
  panelHeight: 'パネルの高さ',

  // National focus
  focusTree: '方針ツリー',
  // --- chain of command ---
  navCommand: '軍',
  armies: '編制',
  armyGroup: '軍集団',
  noCommander: '司令官 空席',
  appointCommander: '司令官を任命',
  commanderPool: '待機中の将官',
  fieldMarshal: '元帥',
  general: '将軍',
  skill: '練度',
  attrAttack: '攻撃',
  attrDefence: '防御',
  attrPlanning: '計画',
  attrLogistics: '兵站',
  commandLoad: '指揮下',
  overloaded: '指揮過多',
  planningBonus: '準備',
  orderNone: '命令なし',
  orderFront: '戦線を保持',
  orderOffensive: '進攻',
  orderGarrison: '駐屯',
  setOrderFront: '戦線',
  setOrderAttack: '進攻',
  setOrderClear: '解除',
  pickEnemy: '対象',
  divisionsInArmy: '個師団',
  /** A division's name: the 12 in 第12歩兵師団. */
  divisionName: (ordinal: number, template: string): string => `第${ordinal}${template}`,
  orderOfBattle: '隷下師団',
  onTheMove: '移動中',
  divisionState: (org: number, hp: number): string => `組織率 ${org}% · 兵力 ${hp}%`,
  armyGroupAssign: '軍集団へ',
  renameArmy: '名称変更',
  armyGroupLeave: '軍集団から外す',
  newArmy: '＋軍を編成',
  newArmyGroup: '＋軍集団',
  disband: '解隊',
  unassigned: '未編入',
  focusAvailable: '着手できる方針',
  focusLocked: '前提を満たしていない方針',
  focusCompleted: '完了した方針',
  currentFocus: '進行中の方針',
  startFocus: '開始',
  cancelFocus: '中止',
  focusDone: '完了',
  inProgress: '残り',
  days: '日',
  locked: '選択できません',

  // Research
  researchSlots: '研究スロット',
  researched: '研究済み',
  slot: 'スロット',
  chooseTech: '技術を選択',
  changeTech: '変更',
  remaining: '残り',
  aheadPenalty: '先行研究',
  autoResearch: 'おまかせ',

  // Production panel
  militaryFactories: '軍需工場',
  assigned: '割当',
  noProductionLines: '生産ラインがありません。',
  addFactory: '工場を追加',
  removeFactory: '工場を削除',
  perDay: '/日',
  efficiency: '効率',
  addLine: '生産ラインを追加',
  allLinesOpen: '全ての装備が生産中です。',
  stockpile: '備蓄',

  // Construction panel
  civilianFactories: '民需工場',
  free: '空き',
  consumerGoods: '消費財',
  queue: '建設キュー',
  selectProvinceToBuild: '建設する州を選択してください',
  buildSlots: '建設スロット',
  noSlots: '空きなし',
  chooseBuilding: '建設する建物',
  chooseState: '建設地',
  cost: '建設コスト',
  noStates: '所有する州がありません。',
  nothingUnderConstruction: '建設中のものはありません。',
  queueWaiting: '順番待ち',
  complete: '完了',

  // Army panel
  totalDivisions: '総師団数',
  deployed: '展開中',
  inCombat: '交戦中',
  organisation: '組織率',
  strength: '兵力',
  supplyLevel: '補給',
  entrenched: '塹壕',
  winter: '厳冬',
  noDivisions: '師団がありません。',
  templates: '師団テンプレート',
  recruit: '編成',
  equipmentShortage: '装備不足',

  // Division designer
  designer: '師団編集',
  newTemplate: '新編師団',
  battalions: '大隊',
  supportCompanies: '支援中隊',
  equipmentPerDivision: '1個師団あたりの装備',
  saveTemplate: '保存',
  /* The three-column table the real designer puts beside the battalion grid.
     HOI4 splits them because they answer different questions: what the
     division is, what it does in a fight, and what it costs to raise. */
  statsBase: '基本性能',
  statsCombat: '戦闘性能',
  statsCost: '装備コスト',
  statHp: '耐久',
  statOrg: '組織率',
  statSpeed: '最高速度',
  statSupply: '補給消費',
  statFuel: '燃料消費',
  statWeight: '編成規模',
  statSoftAttack: '対人攻撃',
  statHardAttack: '対甲攻撃',
  statDefence: '防御',
  statBreakthrough: '突破',
  statArmor: '装甲',
  statPiercing: '貫通',
  statHardness: '硬度',
  statWidth: '戦闘正面',
  statManpower: '必要人的資源',
  statCost: '生産コスト',
  /* The Adjusters box. Every one of these numbers is already in the fight and
     none of them was on screen. */
  terrainAdjusters: '地形補正',
  terrainAttack: '攻',
  terrainDefence: '防',
  terrainSpeed: '速',
  terrainFits: '同時投入',
  /** How many of this division the ground lets into one battle. */
  divisionsFit: (n: number): string => `${n}個`,
  battalionAdd: '大隊を追加',
  supportAdd: '支援中隊を追加',
  slotEmpty: '＋',
  designerReset: 'リセット',
  designerDuplicate: '複製',
  estimatedCost: '推定生産コスト',
  pickBattalion: '追加する大隊',
  pickSupport: '追加する支援中隊',
  back: '戻る',
  edit: '編集',
  softAttack: '攻撃',
  defence: '防御',
  breakthrough: '突破',
  combatWidth: '戦闘幅',
  shortage: '不足',
  ready: '編成可能',

  // Diplomacy panel
  worldTension: '世界緊張度',
  faction: '陣営',
  atWarWith: '交戦国',
  atPeace: '平和',
  guarantees: '独立保障',
  justifying: '宣戦布告理由を作成中',
  justifyWar: '宣戦布告理由',
  declareWar: '宣戦布告',
  demand: '要求',
  joinFaction: '陣営に加入',
  noRelations: '特筆すべき関係なし',
  improveRelations: '関係改善',
  guaranteeIndependence: '独立保障',
  inviteToFaction: '陣営に招待',
  leaveFaction: '陣営から脱退',
  opinion: '好感度',
  diplomaticActions: '外交行動',
  relationsWith: (name: string): string => `${name}との関係`,
  powerCost: (n: number): string => `政治力 ${n}`,
  alreadyGuaranteed: '保障済み',
  alreadyJustifying: '作成中',
  blockNotLeader: '盟主のみ',
  blockAlreadyIn: '加入済み',
  blockOtherFaction: '他陣営所属',
  blockTargetAtWar: '交戦中',
  blockOpinion: (now: number, need: number): string => `好感度 ${now}/${need}`,
  blockPower: '政治力不足',
  blockAtWarWith: '交戦中',
  blockAllied: '同盟国',
  blockMajorsOnly: '大国から小国へのみ',
  blockGuaranteed: '独立を保障されている',
  leaderCannotLeave: '盟主は自陣営から脱退できない',
  noFactionActions: '陣営に関してできることはない',

  // Province info sheet
  owner: '所有国',
  controller: '支配国',
  terrain: '地形',
  victoryPoints: '勝利点',
  garrison: '駐留部隊',
  infrastructure: 'インフラ',
  resources: '資源',
  encircled: '包囲下',
  outOfSupply: '補給切れ',

  // Outcome
  victory: '勝利',
  defeat: '敗北',
  restart: 'もう一度',

  // Orders
  orderIssued: '移動命令を発令',
  noPath: '経路がありません',
} as const;

export const COUNTRY: Record<string, string> = {
  GER: 'ドイツ', SOV: 'ソビエト連邦', ENG: 'イギリス', FRA: 'フランス',
  ITA: 'イタリア', POL: 'ポーランド', CZE: 'チェコスロバキア', YUG: 'ユーゴスラビア',
  ROM: 'ルーマニア', HUN: 'ハンガリー', AUS: 'オーストリア', BUL: 'ブルガリア',
  GRE: 'ギリシャ', ALB: 'アルバニア', TUR: 'トルコ', SPR: 'スペイン',
  POR: 'ポルトガル', SWI: 'スイス', BEL: 'ベルギー', HOL: 'オランダ',
  LUX: 'ルクセンブルク', DEN: 'デンマーク', NOR: 'ノルウェー', SWE: 'スウェーデン',
  FIN: 'フィンランド', EST: 'エストニア', LAT: 'ラトビア', LIT: 'リトアニア',
  IRE: 'アイルランド', ICE: 'アイスランド',
};

export const EQUIPMENT: Record<EquipmentType, string> = {
  infantry_equipment: '歩兵装備',
  support_equipment: '支援装備',
  artillery: '火砲',
  motorized: '自動車化装備',
  light_armor: '軽戦車',
  medium_armor: '中戦車',
  fighter: '戦闘機',
  cas: '近接航空支援機',
  convoy: '輸送船団',
};

export const RESOURCE: Record<ResourceType, string> = {
  oil: '石油', steel: '鋼鉄', aluminium: 'アルミ',
  tungsten: 'タングステン', rubber: 'ゴム', chromium: 'クロム',
};

/** Two-character forms for the resource strip, which is very tight on a phone. */
export const RESOURCE_SHORT: Record<ResourceType, string> = {
  oil: '石油', steel: '鋼鉄', aluminium: 'アルミ',
  tungsten: 'タング', rubber: 'ゴム', chromium: 'クロム',
};

export const BUILDING: Record<BuildingType, string> = {
  civilian_factory: '民需工場',
  military_factory: '軍需工場',
  dockyard: '造船所',
  infrastructure: 'インフラ',
  fort: '要塞',
};

export const TERRAIN: Record<TerrainType, string> = {
  plains: '平地', forest: '森林', hills: '丘陵', mountain: '山岳',
  urban: '市街地', marsh: '湿地', desert: '砂漠',
};

/**
 * Commander traits.
 *
 * Named for what the officer is known for rather than translated literally --
 * "logistics wizard" is a joke in English and reads as nonsense in Japanese,
 * where the military register wants a noun.
 */
export const TRAIT: Record<string, string> = {
  organiser: '組織家',
  logistics_wizard: '兵站の達人',
  defensive_doctrine: '防勢ドクトリン',
  fast_planner: '迅速な立案',
  thorough_planner: '周到な立案',
  panzer_leader: '装甲部隊指揮官',
  infantry_leader: '歩兵指揮官',
  trickster: '謀略家',
  winter_specialist: '冬季戦の専門家',
  naval_invader: '上陸戦の専門家',
};

export const BATTALION: Record<BattalionType, string> = {
  infantry: '歩兵', motorized: '自動車化歩兵', artillery: '砲兵',
  light_armor: '軽戦車', medium_armor: '中戦車', mountaineers: '山岳兵',
};

export const SUPPORT: Record<SupportType, string> = {
  engineer: '工兵中隊', recon: '偵察中隊',
  artillery_support: '砲兵中隊', logistics: '兵站中隊',
};

/**
 * Every character a front-line tag can contain.
 *
 * A bitmap font rasterises its glyphs at install time and has no fallback, so
 * the atlas has to be told. Built from the pieces the tag is built from --
 * the ordinal army names, the suffixes, and the words around them -- so that
 * renaming an army can never leave its tag rendering as blanks.
 */
export const PLAN_GLYPHS = [...new Set(
  ARMY_ORDINALS.join('') + ARMY_SUFFIX + ARMY_GROUP_NAME + '個師団 · 進攻',
)].join('');

export const IDEOLOGY: Record<Ideology, string> = {
  fascist: 'ファシズム', democratic: '民主主義',
  communist: '共産主義', neutral: '中道',
};

const OUTCOME_REASON: Record<OutcomeReason, string> = {
  capitulated: '本国が降伏した',
  allEnemiesCapitulated: '全ての敵国が降伏した',
  aheadOnPoints: '1948年時点で勝利点が優勢',
  behindOnPoints: '1948年時点で勝利点が劣勢',
};

export const country = (tag: string): string => COUNTRY[tag] ?? tag;
export const outcomeReason = (r: OutcomeReason): string => OUTCOME_REASON[r];

/**
 * Renders an event as a sentence. Province names stay in their cartographic
 * (Latin) form so a toast and the label on the map always read the same.
 */
export function eventText(
  body: GameEventBody,
  provinceName: (id: number) => string,
): string {
  switch (body.k) {
    case 'warDeclared':
      return `${country(body.attacker)}が${country(body.defender)}に宣戦布告`;
    case 'joinedFaction':
      return `${country(body.country)}が${body.faction}に加入`;
    case 'ceded':
      return `${country(body.country)}が${country(body.by)}に${body.states}ステートを割譲`;
    case 'capitulated':
      return `${country(body.country)}が降伏 (占領率 ${Math.round(body.occupation * 100)}%)`;
    case 'annexed':
      return `${country(body.by)}が${country(body.country)}を併合`;
    case 'itemCompleted':
      return `${country(body.country)}: ${BUILDING[body.item as BuildingType] ?? body.item}が完成`;
    case 'divisionLost':
      return `${country(body.country)}: 退路を断たれた師団が壊滅`;
    case 'attack':
      return `${country(body.attacker)}が${provinceName(body.province)}で${country(body.defender)}を攻撃`;
    case 'outcome':
      return body.status === 'victory'
        ? `勝利: ${outcomeReason(body.reason)}`
        : `敗北: ${outcomeReason(body.reason)}`;
  }
}
