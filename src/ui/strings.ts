import type {
  BattalionType, BuildingType, EquipmentType, GameEventBody, Ideology,
  OutcomeReason, ResourceType, SupportType, TerrainType,
} from '../sim/core/types';

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
  alertFuel: '燃料が不足しています。機甲・自動車化部隊が動けません',
  alertIdleFactories: '民需工場が遊んでいます。建設を指示してください',
  alertIdleResearch: '研究枠が空いています',
  alertNoFocus: '国家方針を選んでいません',
  alertIdleProduction: '軍需工場が生産ラインに割り当てられていません',
  alertUnderEquipped: '装備の足りない師団があります',
  alertNoCommander: '指揮官のいない軍があります',
  effects: '現在の効果',
  stability: '安定度',
  warSupport: '戦争支持率',
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
