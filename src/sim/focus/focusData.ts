import type { BuildingType, EquipmentType } from '../core/types';

/**
 * The national focus trees, as data.
 *
 * A focus is a decision a government takes and then lives with: it occupies the
 * cabinet for seventy days (thirty-five for the cheap ones), it cannot be
 * swapped halfway through without throwing the work away, and the branches are
 * mutually exclusive where history offered a real fork -- purge the Red Army or
 * modernise it, build the tanks or build the forts.
 *
 * Everything here is content, including the Japanese names and descriptions.
 * The simulation elsewhere is language-free because an event is a fact and the
 * UI writes the sentence; a focus is the other case -- 「ダンツィヒか、戦争か」
 * *is* the focus, not a rendering of it -- so the text belongs with the data.
 *
 * The timetable agrees with `sim/ai/doctrine.ts` deliberately. That table says
 * when a power acts on a claim; this one says when its government starts
 * arguing about it, which is a little earlier. Where the two disagree the
 * doctrine wins, because the doctrine is what actually declares the war.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ResearchBranch = 'infantry' | 'armor' | 'air' | 'industry';

/** The buildings a focus may hand over outright. Forts are placed separately. */
export type FactoryKind = Extract<
  BuildingType, 'civilian_factory' | 'military_factory' | 'dockyard'
>;

/** The default length of a focus, in days, and the length of a cheap one. */
export const FOCUS_DAYS = 70;
export const FOCUS_DAYS_SHORT = 35;

/**
 * Gates beyond the shape of the tree itself.
 *
 * Conditions are data rather than predicates so that `availableFocuses` can
 * explain a locked focus to the player instead of merely greying it out, and
 * so that the whole tree stays serialisable.
 */
export type FocusCondition =
  /** Not before this month, written 'YYYY-MM' as in the doctrine table. */
  | { k: 'date'; from: string }
  | { k: 'worldTension'; min: number }
  | { k: 'divisions'; min: number }
  /** Political power that must be in hand. It is not spent. */
  | { k: 'politicalPower'; min: number }
  | { k: 'dockyards'; min: number }
  | { k: 'atWar' }
  | { k: 'atPeace' }
  /** The named country must still be on the map. */
  | { k: 'countryAlive'; tag: string }
  | { k: 'atWarWith'; tag: string };

/**
 * What a focus does when it completes.
 *
 * Every variant lands on a system that already exists: political power,
 * factories and building slots, infrastructure, forts, the research drip, the
 * construction queue, the consumer-goods share, equipment stockpiles, war
 * goals, guarantees, opinion and world tension. Nothing here invents a
 * modifier that only the focus system can read.
 */
export type FocusEffect =
  | { k: 'politicalPower'; amount: number }
  /** A permanent addition to the daily political power drip. */
  | { k: 'dailyPoliticalPower'; amount: number }
  | { k: 'manpower'; amount: number }
  | { k: 'factory'; building: FactoryKind; count: number }
  | { k: 'buildingSlots'; count: number }
  /** +1 infrastructure in this many of the country's least-developed states. */
  | { k: 'infrastructure'; states: number }
  /** Fortifies the country's own provinces along a border, or its coastline. */
  | { k: 'fort'; level: number; borderWith?: string; coastal?: boolean }
  /** Days of research progress handed over at once; negative takes them away. */
  | { k: 'research'; branch: ResearchBranch; days: number }
  /** A permanent addition to the daily research drip in one branch. */
  | { k: 'researchSpeed'; branch: ResearchBranch; amount: number }
  | { k: 'researchSlot'; count: number }
  /** A permanent addition to construction output, in factory-equivalents. */
  | { k: 'constructionSpeed'; amount: number }
  /** A ceiling held on the consumer-goods share: an economy law, in effect. */
  | { k: 'warEconomy'; consumerGoods: number }
  | { k: 'equipment'; equipment: EquipmentType; amount: number }
  /** A matured war goal, handed over without the usual justification wait. */
  | { k: 'wargoal'; target: string }
  /**
   * An ultimatum the whole government is behind: the Anschluss, not a bought
   * demand. The target is annexed outright if it folds; if it is protected --
   * in a faction, guaranteed, or simply too strong -- a war goal is handed
   * over instead, which is what a refused demand historically left behind.
   */
  | { k: 'annex'; target: string }
  /** The same pressure for a border strip: `states` of the target's, ceded. */
  | { k: 'cede'; target: string; states: number }
  | { k: 'guarantee'; target: string }
  | { k: 'opinion'; target: string; amount: number; direction?: 'ours' | 'theirs' | 'both' }
  | { k: 'worldTension'; amount: number };

export interface FocusDef {
  id: string;
  /** Display name, Japanese. This is the focus, not a translation of it. */
  name: string;
  /** One or two sentences in the government's own voice. */
  desc: string;
  days: number;
  /** Layout for the UI: column and row in the tree. */
  x: number;
  y: number;
  /**
   * Prerequisites: OR within a group, AND between groups. Absent means a root
   * of the tree, available from the first day.
   */
  prereq?: string[][];
  /** Focuses this one locks out, and which lock this one out in turn. */
  exclusive?: string[];
  requires?: FocusCondition[];
  effects: FocusEffect[];
}

export interface FocusTree {
  /** Country tag, or 'GEN' for the tree everyone else shares. */
  tag: string;
  name: string;
  /**
   * Definition order is historical order. The AI walks the tree by taking the
   * first focus it can take, so the order here is the timeline it follows, and
   * every focus must appear after its prerequisites.
   */
  focuses: FocusDef[];
}

// ---------------------------------------------------------------------------
// Germany -- Rhineland, Anschluss, Sudetenland, Danzig
// ---------------------------------------------------------------------------

const GERMANY: FocusTree = {
  tag: 'GER',
  name: 'ドイツ国家方針',
  focuses: [
    {
      id: 'GER_rhineland',
      name: 'ラインラント進駐',
      desc: 'ヴェルサイユ条約が非武装地帯と定めた地へ、三個大隊を進める。列強が動かなければ条約は死文と化し、主導権はこちらに移る。',
      days: FOCUS_DAYS, x: 2, y: 0,
      effects: [
        { k: 'politicalPower', amount: 50 },
        { k: 'worldTension', amount: 3 },
        { k: 'opinion', target: 'FRA', amount: -10, direction: 'theirs' },
        { k: 'opinion', target: 'ENG', amount: -10, direction: 'theirs' },
      ],
    },
    {
      id: 'GER_rearmament',
      name: '再軍備の宣言',
      desc: '徴兵制を復活させ、軍需工場の拡張を公然と進める。もはや隠す必要はない。',
      days: FOCUS_DAYS, x: 0, y: 1,
      prereq: [['GER_rhineland']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 2 },
        { k: 'research', branch: 'infantry', days: 60 },
      ],
    },
    {
      id: 'GER_four_year_plan',
      name: '四カ年計画',
      desc: '四年の後、ドイツ経済と国防軍は戦争に耐えうる状態になければならない。総統はそう指示した。',
      days: FOCUS_DAYS, x: 2, y: 1,
      prereq: [['GER_rhineland']],
      effects: [
        { k: 'factory', building: 'civilian_factory', count: 2 },
        { k: 'constructionSpeed', amount: 1.5 },
        { k: 'research', branch: 'industry', days: 80 },
      ],
    },
    {
      id: 'GER_wehrmacht',
      name: '国防軍の再建',
      desc: '十万人の軍隊から、大陸最強の陸軍へ。将校団を拡充し、新編師団に近代的装備を行き渡らせる。',
      days: FOCUS_DAYS, x: 0, y: 2,
      prereq: [['GER_rearmament']],
      effects: [
        { k: 'research', branch: 'infantry', days: 110 },
        { k: 'manpower', amount: 800 },
        { k: 'equipment', equipment: 'infantry_equipment', amount: 600 },
      ],
    },
    {
      id: 'GER_autarky',
      name: '自給自足経済',
      desc: '合成ゴムと合成燃料に投資し、海上封鎖に屈しない経済を築く。採算は問わない。',
      days: FOCUS_DAYS, x: 2, y: 2,
      prereq: [['GER_four_year_plan']],
      effects: [
        { k: 'researchSpeed', branch: 'industry', amount: 0.4 },
        { k: 'buildingSlots', count: 2 },
        { k: 'factory', building: 'military_factory', count: 1 },
      ],
    },
    {
      id: 'GER_panzerwaffe',
      name: '装甲部隊の創設',
      desc: 'グデーリアンの構想を容れ、戦車を歩兵に分散させず一個の拳として集中運用する。',
      days: FOCUS_DAYS, x: 0, y: 3,
      prereq: [['GER_wehrmacht']],
      effects: [
        { k: 'research', branch: 'armor', days: 120 },
        { k: 'researchSpeed', branch: 'armor', amount: 0.3 },
        { k: 'equipment', equipment: 'medium_armor', amount: 40 },
      ],
    },
    {
      id: 'GER_goering_werke',
      name: 'ヘルマン・ゲーリング工場',
      desc: '採算の取れない国内鉄鉱石を国家の手で掘る。軍需の論理は市場の論理に優先する。',
      days: FOCUS_DAYS, x: 2, y: 3,
      prereq: [['GER_autarky']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 3 },
        { k: 'buildingSlots', count: 2 },
      ],
    },
    {
      id: 'GER_luftwaffe',
      name: '空軍の再興',
      desc: '民間航空の名の下に温存してきた飛行隊を、正式な航空艦隊として編成する。',
      days: FOCUS_DAYS, x: 4, y: 2,
      prereq: [['GER_rearmament']],
      effects: [
        { k: 'research', branch: 'air', days: 110 },
        { k: 'equipment', equipment: 'fighter', amount: 60 },
      ],
    },
    {
      id: 'GER_anschluss',
      name: 'オーストリア併合',
      desc: '一つの民族、一つの国家。ウィーンに圧力をかけ、銃火を交えることなく合邦を実現する。',
      days: FOCUS_DAYS_SHORT, x: 3, y: 1,
      prereq: [['GER_rhineland']],
      requires: [{ k: 'date', from: '1938-01' }, { k: 'countryAlive', tag: 'AUS' }],
      effects: [
        { k: 'opinion', target: 'AUS', amount: 45, direction: 'theirs' },
        { k: 'annex', target: 'AUS' },
        { k: 'politicalPower', amount: 60 },
        { k: 'worldTension', amount: 2 },
      ],
    },
    {
      id: 'GER_sudetenland',
      name: 'ズデーテン地方の割譲要求',
      desc: '国境地帯のドイツ系住民の保護を掲げ、割譲を迫る。西欧は戦争を望んでいない — それが我々の最大の武器である。',
      days: FOCUS_DAYS_SHORT, x: 3, y: 2,
      prereq: [['GER_anschluss']],
      requires: [{ k: 'date', from: '1938-08' }, { k: 'countryAlive', tag: 'CZE' }],
      effects: [
        { k: 'opinion', target: 'CZE', amount: 30, direction: 'theirs' },
        { k: 'cede', target: 'CZE', states: 3 },
        { k: 'politicalPower', amount: 60 },
        { k: 'worldTension', amount: 4 },
      ],
    },
    {
      id: 'GER_prague',
      name: 'チェコスロヴァキアの残余',
      desc: '国境の要塞線を手放した国に、拒む手立てはもう残っていない。プラハへ入城し、残りを片づける。',
      days: FOCUS_DAYS_SHORT, x: 4, y: 3,
      prereq: [['GER_sudetenland']],
      requires: [{ k: 'date', from: '1939-03' }, { k: 'countryAlive', tag: 'CZE' }],
      effects: [
        { k: 'annex', target: 'CZE' },
        { k: 'politicalPower', amount: 40 },
        { k: 'worldTension', amount: 6 },
      ],
    },
    {
      id: 'GER_danzig',
      name: 'ダンツィヒか、戦争か',
      desc: '回廊とダンツィヒの返還を要求する。今度ばかりは、要求が通らない場合を勘定に入れておかねばならない。',
      days: FOCUS_DAYS, x: 3, y: 3,
      prereq: [['GER_sudetenland']],
      requires: [{ k: 'date', from: '1939-03' }, { k: 'countryAlive', tag: 'POL' }],
      effects: [
        { k: 'wargoal', target: 'POL' },
        { k: 'worldTension', amount: 8 },
        { k: 'politicalPower', amount: 25 },
        { k: 'manpower', amount: 1000 },
      ],
    },
    {
      id: 'GER_molotov_ribbentrop',
      name: '独ソ不可侵条約',
      desc: 'イデオロギーの敵と手を結び、東部の背中を確保する。付属の秘密議定書が東欧の運命を決める。',
      days: FOCUS_DAYS_SHORT, x: 4, y: 4,
      prereq: [['GER_danzig']],
      requires: [{ k: 'date', from: '1939-06' }, { k: 'countryAlive', tag: 'SOV' }],
      effects: [
        { k: 'opinion', target: 'SOV', amount: 55, direction: 'both' },
        { k: 'politicalPower', amount: 40 },
      ],
    },
    {
      id: 'GER_fall_gelb',
      name: '黄色作戦',
      desc: 'アルデンヌを抜け、海峡へ。西方の決着は一夏で付けねばならない。二正面戦争は繰り返さない。',
      days: FOCUS_DAYS, x: 2, y: 4,
      prereq: [['GER_danzig'], ['GER_panzerwaffe']],
      requires: [{ k: 'date', from: '1939-11' }],
      effects: [
        { k: 'wargoal', target: 'FRA' },
        { k: 'wargoal', target: 'BEL' },
        { k: 'wargoal', target: 'HOL' },
        { k: 'research', branch: 'armor', days: 80 },
        { k: 'worldTension', amount: 5 },
      ],
    },
    {
      id: 'GER_sealion',
      name: 'あしか作戦',
      desc: '英本土上陸のため、海峡の制空権と渡海用の船団を整える。二十六マイルの水路が最後の障害である。',
      days: FOCUS_DAYS, x: 1, y: 5,
      prereq: [['GER_fall_gelb']],
      exclusive: ['GER_atlantic_wall'],
      requires: [{ k: 'atWarWith', tag: 'ENG' }],
      effects: [
        { k: 'factory', building: 'dockyard', count: 2 },
        { k: 'research', branch: 'air', days: 90 },
        { k: 'equipment', equipment: 'convoy', amount: 60 },
      ],
    },
    {
      id: 'GER_atlantic_wall',
      name: '大西洋の壁',
      desc: '上陸を諦め、海岸線を要塞化する。海峡は渡るべき水路ではなく、守るべき壕となった。',
      days: FOCUS_DAYS, x: 3, y: 5,
      prereq: [['GER_fall_gelb']],
      exclusive: ['GER_sealion'],
      effects: [
        { k: 'fort', level: 1, coastal: true },
        { k: 'constructionSpeed', amount: 1 },
        { k: 'research', branch: 'industry', days: 60 },
      ],
    },
    {
      id: 'GER_barbarossa',
      name: 'バルバロッサ作戦',
      desc: '扉を蹴破れば、腐った建物全体が崩れ落ちる。東方に生存圏を求める、最後にして最大の賭け。',
      days: FOCUS_DAYS, x: 4, y: 5,
      prereq: [['GER_molotov_ribbentrop'], ['GER_fall_gelb']],
      requires: [{ k: 'date', from: '1940-12' }, { k: 'countryAlive', tag: 'SOV' }],
      effects: [
        { k: 'wargoal', target: 'SOV' },
        { k: 'manpower', amount: 2500 },
        { k: 'warEconomy', consumerGoods: 0.14 },
        { k: 'worldTension', amount: 6 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Soviet Union
// ---------------------------------------------------------------------------

const SOVIET: FocusTree = {
  tag: 'SOV',
  name: 'ソビエト連邦国家方針',
  focuses: [
    {
      id: 'SOV_second_five_year_plan',
      name: '第二次五カ年計画',
      desc: '重工業に全てを注ぐ。消費財は後回しだ — 我々には、先進国に追いつくための十年しか残されていない。',
      days: FOCUS_DAYS, x: 1, y: 0,
      effects: [
        { k: 'factory', building: 'civilian_factory', count: 3 },
        { k: 'constructionSpeed', amount: 1.5 },
      ],
    },
    {
      id: 'SOV_collectivisation',
      name: '農業集団化',
      desc: '農村から穀物と人手を都市へ吸い上げる。工業化の代償については、誰も口にしない。',
      days: FOCUS_DAYS, x: 0, y: 1,
      prereq: [['SOV_second_five_year_plan']],
      effects: [
        { k: 'manpower', amount: 3000 },
        { k: 'politicalPower', amount: 30 },
      ],
    },
    {
      id: 'SOV_stakhanovite',
      name: 'スタハノフ運動',
      desc: '一人の炭鉱夫の記録を全国民の規範とする。生産の限界は技術ではなく、意志の問題である。',
      days: FOCUS_DAYS, x: 2, y: 1,
      prereq: [['SOV_second_five_year_plan']],
      effects: [
        { k: 'researchSpeed', branch: 'industry', amount: 0.5 },
        { k: 'research', branch: 'industry', days: 90 },
      ],
    },
    {
      id: 'SOV_great_purge',
      name: '大粛清',
      desc: '軍と党から敵を一掃する。忠誠は保証されるが、赤軍は最も有能な将校たちを失う。',
      days: FOCUS_DAYS, x: 4, y: 1,
      exclusive: ['SOV_red_army_modernisation'],
      effects: [
        { k: 'politicalPower', amount: 150 },
        { k: 'dailyPoliticalPower', amount: 0.5 },
        { k: 'research', branch: 'infantry', days: -120 },
        { k: 'research', branch: 'armor', days: -60 },
      ],
    },
    {
      id: 'SOV_red_army_modernisation',
      name: '赤軍の近代化',
      desc: 'トゥハチェフスキーらの構想を生かし、機械化と将校教育に投資する。党への忠誠は、あとで確かめればよい。',
      days: FOCUS_DAYS, x: 5, y: 1,
      exclusive: ['SOV_great_purge'],
      effects: [
        { k: 'research', branch: 'infantry', days: 110 },
        { k: 'research', branch: 'armor', days: 110 },
        { k: 'manpower', amount: 1500 },
      ],
    },
    {
      id: 'SOV_ural_industry',
      name: 'ウラル工業地帯の開発',
      desc: '国境から遠く離れた山脈の東側に、第二の兵器廠を築く。いかなる敵の砲もそこには届かない。',
      days: FOCUS_DAYS, x: 2, y: 2,
      prereq: [['SOV_stakhanovite']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 3 },
        { k: 'buildingSlots', count: 3 },
        { k: 'infrastructure', states: 2 },
      ],
    },
    {
      id: 'SOV_deep_battle',
      name: '縦深作戦理論',
      desc: '敵の前線を破るのではなく、その全縦深を同時に打撃する。理論を書いた者たちの名は、もう誰も口にしない。',
      days: FOCUS_DAYS, x: 4, y: 2,
      prereq: [['SOV_great_purge', 'SOV_red_army_modernisation']],
      effects: [
        { k: 'research', branch: 'armor', days: 100 },
        { k: 'researchSpeed', branch: 'armor', amount: 0.3 },
      ],
    },
    {
      id: 'SOV_t34',
      name: '新型戦車の開発',
      desc: '傾斜装甲と広い履帯。泥濘と徹甲弾の双方に耐える戦車を、数千両単位で量産する。',
      days: FOCUS_DAYS, x: 4, y: 3,
      prereq: [['SOV_deep_battle']],
      effects: [
        { k: 'research', branch: 'armor', days: 110 },
        { k: 'equipment', equipment: 'medium_armor', amount: 50 },
      ],
    },
    {
      id: 'SOV_baltic_ultimatum',
      name: 'バルト三国への要求',
      desc: '相互援助条約の名の下に基地を置き、次いで政府そのものを置き換える。',
      days: FOCUS_DAYS_SHORT, x: 0, y: 3,
      prereq: [['SOV_great_purge', 'SOV_red_army_modernisation']],
      requires: [{ k: 'date', from: '1939-08' }],
      effects: [
        { k: 'opinion', target: 'EST', amount: 40, direction: 'theirs' },
        { k: 'opinion', target: 'LAT', amount: 40, direction: 'theirs' },
        { k: 'opinion', target: 'LIT', amount: 40, direction: 'theirs' },
        { k: 'annex', target: 'EST' },
        { k: 'annex', target: 'LAT' },
        { k: 'annex', target: 'LIT' },
        { k: 'politicalPower', amount: 55 },
        { k: 'worldTension', amount: 4 },
      ],
    },
    {
      id: 'SOV_eastern_poland',
      name: '東ポーランドへの進駐',
      desc: '崩壊しつつある隣国へ、同胞の保護を名目に軍を進める。国境は、地図の上で既に引き直されている。',
      days: FOCUS_DAYS_SHORT, x: 1, y: 4,
      prereq: [['SOV_baltic_ultimatum']],
      requires: [{ k: 'date', from: '1939-09' }, { k: 'countryAlive', tag: 'POL' }],
      effects: [
        { k: 'wargoal', target: 'POL' },
        { k: 'worldTension', amount: 5 },
        { k: 'politicalPower', amount: 25 },
      ],
    },
    {
      id: 'SOV_winter_war',
      name: 'フィンランドへの領土要求',
      desc: 'レニングラードは国境に近すぎる。カレリア地峡の交換を求め、拒まれれば力で取る。',
      days: FOCUS_DAYS_SHORT, x: 0, y: 4,
      prereq: [['SOV_baltic_ultimatum']],
      requires: [{ k: 'date', from: '1939-10' }, { k: 'countryAlive', tag: 'FIN' }],
      effects: [
        { k: 'wargoal', target: 'FIN' },
        { k: 'worldTension', amount: 5 },
        { k: 'research', branch: 'infantry', days: 60 },
      ],
    },
    {
      id: 'SOV_bessarabia',
      name: 'ベッサラビア回収',
      desc: '一九一八年に奪われた土地の返還を、七十二時間の期限を付して要求する。',
      days: FOCUS_DAYS_SHORT, x: 2, y: 4,
      prereq: [['SOV_baltic_ultimatum']],
      requires: [{ k: 'date', from: '1940-05' }, { k: 'countryAlive', tag: 'ROM' }],
      effects: [
        { k: 'opinion', target: 'ROM', amount: 25, direction: 'theirs' },
        { k: 'cede', target: 'ROM', states: 2 },
        { k: 'politicalPower', amount: 55 },
        { k: 'worldTension', amount: 3 },
      ],
    },
    {
      id: 'SOV_industry_evacuation',
      name: '工業の疎開',
      desc: '工場を丸ごと貨車に載せ、東へ運ぶ。屋根が架かる前に、雪の中で生産を再開させる。',
      days: FOCUS_DAYS, x: 3, y: 5,
      prereq: [['SOV_ural_industry']],
      requires: [{ k: 'atWar' }],
      effects: [
        { k: 'factory', building: 'civilian_factory', count: 2 },
        { k: 'factory', building: 'military_factory', count: 2 },
        { k: 'constructionSpeed', amount: 2 },
      ],
    },
    {
      id: 'SOV_great_patriotic_war',
      name: '大祖国戦争',
      desc: 'これは体制の戦争ではなく、祖国の戦争である。全ての予備を、全ての工場を、戦線へ。',
      days: FOCUS_DAYS, x: 4, y: 5,
      prereq: [['SOV_industry_evacuation']],
      requires: [{ k: 'atWar' }],
      effects: [
        { k: 'manpower', amount: 6000 },
        { k: 'warEconomy', consumerGoods: 0.12 },
        { k: 'research', branch: 'infantry', days: 120 },
        { k: 'equipment', equipment: 'infantry_equipment', amount: 800 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// United Kingdom
// ---------------------------------------------------------------------------

const BRITAIN: FocusTree = {
  tag: 'ENG',
  name: '英国国家方針',
  focuses: [
    {
      id: 'ENG_rearmament',
      name: '再軍備計画',
      desc: '十年間戦争は起こらないという前提を、正式に破棄する。議会は渋々ながら軍事予算の増額を認めた。',
      days: FOCUS_DAYS, x: 1, y: 0,
      effects: [
        { k: 'factory', building: 'military_factory', count: 2 },
        { k: 'research', branch: 'industry', days: 60 },
      ],
    },
    {
      id: 'ENG_home_fleet',
      name: '本国艦隊の増強',
      desc: '海軍は依然として帝国の生命線である。船台を埋め、老朽艦を置き換える。',
      days: FOCUS_DAYS, x: 4, y: 0,
      effects: [
        { k: 'factory', building: 'dockyard', count: 3 },
        { k: 'equipment', equipment: 'convoy', amount: 60 },
      ],
    },
    {
      id: 'ENG_appeasement',
      name: '宥和政策',
      desc: '戦争は避けねばならない。譲歩が時間を買い、その時間で軍備を整える — 少なくとも、そう説明されている。',
      days: FOCUS_DAYS_SHORT, x: 0, y: 1,
      effects: [
        { k: 'politicalPower', amount: 90 },
        { k: 'worldTension', amount: -4 },
        { k: 'opinion', target: 'GER', amount: 20, direction: 'both' },
      ],
    },
    {
      id: 'ENG_shadow_factories',
      name: 'シャドー・ファクトリー計画',
      desc: '自動車工場に航空機の生産準備をさせておく。有事にはそれが一夜で軍需工場となる。',
      days: FOCUS_DAYS, x: 1, y: 1,
      prereq: [['ENG_rearmament']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 3 },
        { k: 'constructionSpeed', amount: 1 },
      ],
    },
    {
      id: 'ENG_chain_home',
      name: 'チェーン・ホーム',
      desc: '海岸沿いに鉄塔を並べ、電波で空を見張る。迎撃が偶然に頼るものであってはならない。',
      days: FOCUS_DAYS, x: 2, y: 1,
      prereq: [['ENG_rearmament']],
      effects: [
        { k: 'research', branch: 'air', days: 110 },
        { k: 'researchSpeed', branch: 'air', amount: 0.3 },
      ],
    },
    {
      id: 'ENG_commonwealth',
      name: '帝国の総力',
      desc: '自治領と植民地から人と資源を動員する。帝国が意味を持つのは、まさにこういう時である。',
      days: FOCUS_DAYS, x: 5, y: 1,
      prereq: [['ENG_home_fleet']],
      effects: [
        { k: 'manpower', amount: 4000 },
        { k: 'factory', building: 'civilian_factory', count: 2 },
      ],
    },
    {
      id: 'ENG_raf_expansion',
      name: '空軍拡張計画',
      desc: '爆撃機は常に突破する — ならば、迎え撃つ戦闘機を揃えるほかない。',
      days: FOCUS_DAYS, x: 2, y: 2,
      prereq: [['ENG_chain_home']],
      effects: [
        { k: 'research', branch: 'air', days: 100 },
        { k: 'equipment', equipment: 'fighter', amount: 60 },
      ],
    },
    {
      id: 'ENG_atlantic_convoys',
      name: '大西洋航路の確保',
      desc: '船が沈めば島は飢える。護衛艦と船台に、惜しまず投資する。',
      days: FOCUS_DAYS, x: 4, y: 2,
      prereq: [['ENG_home_fleet']],
      effects: [
        { k: 'factory', building: 'dockyard', count: 2 },
        { k: 'equipment', equipment: 'convoy', amount: 120 },
      ],
    },
    {
      id: 'ENG_stand_firm',
      name: '対独強硬路線',
      desc: '譲歩は尽きた。次に要求が突きつけられたとき、答えは否である。',
      days: FOCUS_DAYS, x: 0, y: 2,
      prereq: [['ENG_appeasement']],
      requires: [{ k: 'worldTension', min: 20 }],
      effects: [
        { k: 'politicalPower', amount: 40 },
        { k: 'opinion', target: 'FRA', amount: 25, direction: 'both' },
        { k: 'worldTension', amount: 2 },
      ],
    },
    {
      id: 'ENG_guarantee_poland',
      name: 'ポーランドへの保証',
      desc: 'ポーランドの独立が脅かされた場合、英国政府は全力をもってこれを支援する。宥和の時代は終わった。',
      days: FOCUS_DAYS_SHORT, x: 0, y: 3,
      prereq: [['ENG_stand_firm']],
      requires: [{ k: 'date', from: '1939-02' }, { k: 'worldTension', min: 25 }],
      effects: [
        { k: 'guarantee', target: 'POL' },
        { k: 'guarantee', target: 'ROM' },
        { k: 'opinion', target: 'POL', amount: 40, direction: 'both' },
        { k: 'worldTension', amount: 3 },
      ],
    },
    {
      id: 'ENG_bef',
      name: '英国海外派遣軍',
      desc: '再び大陸へ軍を送る。規模は小さいが、これは兵力ではなく意思の表明である。',
      days: FOCUS_DAYS, x: 1, y: 3,
      prereq: [['ENG_stand_firm']],
      exclusive: ['ENG_imperial_defence'],
      effects: [
        { k: 'manpower', amount: 1500 },
        { k: 'research', branch: 'infantry', days: 100 },
        { k: 'equipment', equipment: 'infantry_equipment', amount: 500 },
      ],
    },
    {
      id: 'ENG_imperial_defence',
      name: '帝国防衛の優先',
      desc: '大陸の泥沼には踏み込まない。海路と自治領の力で、帝国そのものを守り抜く。',
      days: FOCUS_DAYS, x: 3, y: 3,
      prereq: [['ENG_stand_firm']],
      exclusive: ['ENG_bef'],
      effects: [
        { k: 'factory', building: 'dockyard', count: 3 },
        { k: 'manpower', amount: 2000 },
        { k: 'infrastructure', states: 2 },
      ],
    },
    {
      id: 'ENG_bomber_command',
      name: '爆撃機軍団',
      desc: '大陸に軍を送れぬ間も、敵の工業地帯を叩き続ける。それが唯一、こちらから振るえる拳である。',
      days: FOCUS_DAYS, x: 2, y: 3,
      prereq: [['ENG_raf_expansion']],
      effects: [
        { k: 'research', branch: 'air', days: 110 },
        { k: 'equipment', equipment: 'cas', amount: 40 },
      ],
    },
    {
      id: 'ENG_war_economy',
      name: '戦時経済',
      desc: '配給と統制。国民生活の回復は、勝利の後に回す。',
      days: FOCUS_DAYS, x: 1, y: 4,
      prereq: [['ENG_bef', 'ENG_imperial_defence']],
      requires: [{ k: 'atWar' }],
      effects: [
        { k: 'warEconomy', consumerGoods: 0.13 },
        { k: 'factory', building: 'military_factory', count: 2 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// France
// ---------------------------------------------------------------------------

const FRANCE: FocusTree = {
  tag: 'FRA',
  name: 'フランス国家方針',
  focuses: [
    {
      id: 'FRA_popular_front',
      name: '人民戦線',
      desc: '左派連立政権が発足した。労働者の要求に応えつつ、軍需産業を国家の管理下へ移していく。',
      days: FOCUS_DAYS, x: 1, y: 0,
      effects: [
        { k: 'politicalPower', amount: 60 },
        { k: 'manpower', amount: 1000 },
      ],
    },
    {
      id: 'FRA_maginot',
      name: 'マジノ線の完成',
      desc: '国境に鋼鉄とコンクリートの線を引く。二度と北東部の県を戦場にはしない。',
      days: FOCUS_DAYS, x: 3, y: 0,
      effects: [
        { k: 'fort', level: 2, borderWith: 'GER' },
        { k: 'research', branch: 'infantry', days: 60 },
      ],
    },
    {
      id: 'FRA_industrial_effort',
      name: '産業動員',
      desc: '航空機産業を再編し、生産の遅れを取り戻す。工場は稼働していなければ何の意味もない。',
      days: FOCUS_DAYS, x: 0, y: 1,
      prereq: [['FRA_popular_front']],
      effects: [
        { k: 'factory', building: 'civilian_factory', count: 3 },
        { k: 'constructionSpeed', amount: 1 },
      ],
    },
    {
      id: 'FRA_colonial_troops',
      name: '植民地部隊の動員',
      desc: '北アフリカと西アフリカから師団を本国へ呼び戻す。帝国は兵力の貯水池である。',
      days: FOCUS_DAYS, x: 1, y: 1,
      prereq: [['FRA_popular_front']],
      effects: [
        { k: 'manpower', amount: 2500 },
        { k: 'research', branch: 'infantry', days: 60 },
      ],
    },
    {
      id: 'FRA_maginot_extension',
      name: '要塞線の延伸',
      desc: 'アルデンヌは戦車の通れぬ森である — 参謀本部はそう言う。それでも予算の許す限り、線を北へ延ばす。',
      days: FOCUS_DAYS, x: 3, y: 1,
      prereq: [['FRA_maginot']],
      effects: [
        { k: 'fort', level: 1, borderWith: 'BEL' },
        { k: 'fort', level: 1, borderWith: 'ITA' },
        { k: 'constructionSpeed', amount: 0.5 },
      ],
    },
    {
      id: 'FRA_little_entente',
      name: '小協商の強化',
      desc: '中欧の同盟網を繋ぎ直す。ただし、誰のために血を流すのかは、いまだ明言しない。',
      days: FOCUS_DAYS, x: 5, y: 1,
      effects: [
        { k: 'opinion', target: 'CZE', amount: 30, direction: 'both' },
        { k: 'opinion', target: 'YUG', amount: 30, direction: 'both' },
        { k: 'opinion', target: 'ROM', amount: 30, direction: 'both' },
        { k: 'politicalPower', amount: 30 },
      ],
    },
    {
      id: 'FRA_rearmament',
      name: '再軍備計画',
      desc: '一九三六年計画。戦車と火砲を、今度こそ数で揃える。',
      days: FOCUS_DAYS, x: 0, y: 2,
      prereq: [['FRA_industrial_effort']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 3 },
        { k: 'equipment', equipment: 'artillery', amount: 200 },
      ],
    },
    {
      id: 'FRA_air_ministry',
      name: '航空省の再編',
      desc: '生産の混乱を収拾し、近代的な戦闘機を前線へ届ける。今のままでは空を明け渡すことになる。',
      days: FOCUS_DAYS, x: 2, y: 2,
      prereq: [['FRA_industrial_effort']],
      effects: [
        { k: 'research', branch: 'air', days: 110 },
        { k: 'equipment', equipment: 'fighter', amount: 50 },
      ],
    },
    {
      id: 'FRA_defensive_doctrine',
      name: '防勢ドクトリン',
      desc: '火力と要塞。前の戦争の教訓は、攻勢が人命を浪費するということだった。',
      days: FOCUS_DAYS, x: 3, y: 2,
      prereq: [['FRA_maginot']],
      exclusive: ['FRA_mechanisation'],
      effects: [
        { k: 'research', branch: 'infantry', days: 130 },
        { k: 'fort', level: 1, borderWith: 'GER' },
      ],
    },
    {
      id: 'FRA_mechanisation',
      name: '機械化部隊の創設',
      desc: 'ド・ゴール大佐の説く職業的機甲軍。参謀本部は懐疑的だが、時代は彼の側にある。',
      days: FOCUS_DAYS, x: 4, y: 2,
      prereq: [['FRA_maginot']],
      exclusive: ['FRA_defensive_doctrine'],
      effects: [
        { k: 'research', branch: 'armor', days: 130 },
        { k: 'equipment', equipment: 'light_armor', amount: 60 },
      ],
    },
    {
      id: 'FRA_alliance_poland',
      name: 'ポーランドとの同盟',
      desc: '東方の同盟国に、我々の保証は本物であると伝える。ドイツを二正面に立たせる唯一の手段である。',
      days: FOCUS_DAYS_SHORT, x: 5, y: 2,
      prereq: [['FRA_little_entente']],
      requires: [{ k: 'date', from: '1939-02' }, { k: 'countryAlive', tag: 'POL' }],
      effects: [
        { k: 'guarantee', target: 'POL' },
        { k: 'opinion', target: 'POL', amount: 40, direction: 'both' },
        { k: 'worldTension', amount: 2 },
      ],
    },
    {
      id: 'FRA_war_industry',
      name: '軍需産業の国有化',
      desc: '兵器工場を国家の管理下に置き、利潤ではなく生産計画で動かす。',
      days: FOCUS_DAYS, x: 0, y: 3,
      prereq: [['FRA_rearmament']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 2 },
        { k: 'constructionSpeed', amount: 1 },
        { k: 'research', branch: 'industry', days: 70 },
      ],
    },
    {
      id: 'FRA_general_mobilisation',
      name: '総動員令',
      desc: '予備役を招集する。動員は、始めることより止めることのほうが難しい。',
      days: FOCUS_DAYS, x: 2, y: 3,
      prereq: [['FRA_colonial_troops']],
      requires: [{ k: 'worldTension', min: 35 }],
      effects: [
        { k: 'manpower', amount: 3000 },
        { k: 'warEconomy', consumerGoods: 0.16 },
        { k: 'equipment', equipment: 'infantry_equipment', amount: 500 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Italy
// ---------------------------------------------------------------------------

const ITALY: FocusTree = {
  tag: 'ITA',
  name: 'イタリア国家方針',
  focuses: [
    {
      id: 'ITA_autarchia',
      name: '自給自足体制',
      desc: '制裁に屈しない経済を築く。代用品と国産化、そして忍耐が、我が国の兵站である。',
      days: FOCUS_DAYS, x: 1, y: 0,
      effects: [
        { k: 'factory', building: 'civilian_factory', count: 2 },
        { k: 'researchSpeed', branch: 'industry', amount: 0.3 },
      ],
    },
    {
      id: 'ITA_regia_marina',
      name: '王立海軍の再建',
      desc: '地中海に浮かぶ艦隊こそ、我が国の外交そのものである。',
      days: FOCUS_DAYS, x: 4, y: 0,
      effects: [
        { k: 'factory', building: 'dockyard', count: 3 },
      ],
    },
    {
      id: 'ITA_pontine_marshes',
      name: 'ポンティーノ湿地の干拓',
      desc: 'ローマ近郊の湿地を農地と新都市に変える。帝国は、まず足元から築かれる。',
      days: FOCUS_DAYS, x: 0, y: 1,
      prereq: [['ITA_autarchia']],
      effects: [
        { k: 'buildingSlots', count: 3 },
        { k: 'infrastructure', states: 2 },
      ],
    },
    {
      id: 'ITA_ansaldo',
      name: 'アンサルド社の拡張',
      desc: '造船と兵器の巨人に、国家の注文を集中させる。数を揃えられぬ工業に、質を語る資格はない。',
      days: FOCUS_DAYS, x: 1, y: 1,
      prereq: [['ITA_autarchia']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 3 },
      ],
    },
    {
      id: 'ITA_alpini',
      name: '山岳兵の伝統',
      desc: 'アルプスの猟兵たちは、我が軍で最も頼りになる部隊である。その数を増やす。',
      days: FOCUS_DAYS, x: 2, y: 1,
      effects: [
        { k: 'research', branch: 'infantry', days: 100 },
        { k: 'manpower', amount: 800 },
      ],
    },
    {
      id: 'ITA_mare_nostrum',
      name: '我らが海',
      desc: '地中海は英仏の湖ではない。ローマの海である。',
      days: FOCUS_DAYS, x: 4, y: 1,
      prereq: [['ITA_regia_marina']],
      requires: [{ k: 'worldTension', min: 15 }],
      effects: [
        { k: 'factory', building: 'dockyard', count: 2 },
        { k: 'opinion', target: 'ENG', amount: -20, direction: 'theirs' },
        { k: 'worldTension', amount: 3 },
      ],
    },
    {
      id: 'ITA_regia_aeronautica',
      name: '王立空軍の刷新',
      desc: '記録飛行の栄光を、実戦で通用する機体に置き換える。',
      days: FOCUS_DAYS, x: 2, y: 2,
      prereq: [['ITA_ansaldo']],
      effects: [
        { k: 'research', branch: 'air', days: 100 },
        { k: 'equipment', equipment: 'fighter', amount: 50 },
      ],
    },
    {
      id: 'ITA_north_africa',
      name: '北アフリカ軍団',
      desc: 'リビアの守備隊を近代化し、砂漠での機動に備える。あの海岸道路が、我々の主戦場になる。',
      days: FOCUS_DAYS, x: 0, y: 2,
      prereq: [['ITA_pontine_marshes']],
      effects: [
        { k: 'manpower', amount: 1200 },
        { k: 'infrastructure', states: 2 },
        { k: 'equipment', equipment: 'motorized', amount: 200 },
      ],
    },
    {
      id: 'ITA_albania',
      name: 'アルバニア保護領化',
      desc: 'アドリア海の対岸を、王冠のもう一つの宝石とする。抵抗する軍隊は、あの国にはない。',
      days: FOCUS_DAYS_SHORT, x: 3, y: 2,
      requires: [{ k: 'date', from: '1939-02' }, { k: 'countryAlive', tag: 'ALB' }],
      effects: [
        { k: 'opinion', target: 'ALB', amount: 45, direction: 'theirs' },
        { k: 'annex', target: 'ALB' },
        { k: 'politicalPower', amount: 55 },
        { k: 'worldTension', amount: 3 },
      ],
    },
    {
      id: 'ITA_pact_of_steel',
      name: '鋼鉄協約',
      desc: 'ベルリンとの同盟に署名する。これで中立という選択肢は、我が国から消えた。',
      days: FOCUS_DAYS_SHORT, x: 4, y: 2,
      requires: [{ k: 'date', from: '1939-04' }, { k: 'countryAlive', tag: 'GER' }],
      effects: [
        { k: 'opinion', target: 'GER', amount: 55, direction: 'both' },
        { k: 'politicalPower', amount: 40 },
      ],
    },
    {
      id: 'ITA_greece',
      name: 'ギリシャへの野心',
      desc: '総統に既成事実を突きつける。イタリアもまた、自前の勝利を持たねばならない。',
      days: FOCUS_DAYS, x: 3, y: 3,
      prereq: [['ITA_albania']],
      requires: [{ k: 'date', from: '1940-08' }, { k: 'countryAlive', tag: 'GRE' }],
      effects: [
        { k: 'wargoal', target: 'GRE' },
        { k: 'worldTension', amount: 5 },
        { k: 'research', branch: 'infantry', days: 60 },
      ],
    },
    {
      id: 'ITA_balkan_priority',
      name: 'バルカン優先',
      desc: '陸軍を東へ。アドリア海の対岸に、版図を押し広げる。',
      days: FOCUS_DAYS, x: 2, y: 4,
      prereq: [['ITA_greece']],
      exclusive: ['ITA_mediterranean_priority'],
      requires: [{ k: 'date', from: '1941-01' }],
      effects: [
        { k: 'wargoal', target: 'YUG' },
        { k: 'manpower', amount: 1200 },
        { k: 'research', branch: 'infantry', days: 80 },
      ],
    },
    {
      id: 'ITA_mediterranean_priority',
      name: '地中海優先',
      desc: '海軍と船団に投資し、シチリアからリビアへの航路を守り抜く。海を失えば、アフリカ軍も失う。',
      days: FOCUS_DAYS, x: 4, y: 4,
      prereq: [['ITA_greece']],
      exclusive: ['ITA_balkan_priority'],
      effects: [
        { k: 'factory', building: 'dockyard', count: 3 },
        { k: 'equipment', equipment: 'convoy', amount: 80 },
        { k: 'research', branch: 'industry', days: 60 },
      ],
    },
    {
      id: 'ITA_war_economy',
      name: '戦時体制',
      desc: '国民に犠牲を求める時が来た。帝国は、安価には手に入らない。',
      days: FOCUS_DAYS, x: 1, y: 4,
      prereq: [['ITA_ansaldo']],
      requires: [{ k: 'atWar' }],
      effects: [
        { k: 'warEconomy', consumerGoods: 0.16 },
        { k: 'factory', building: 'military_factory', count: 2 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Everyone else
// ---------------------------------------------------------------------------

/**
 * The shared tree.
 *
 * Short, domestic and entirely free of war goals. That is the same finding the
 * doctrine table records: the small nations of 1936 had no war plans, so their
 * focus tree must not hand them one. What it hands them is industry, roads and
 * the choice between staying out of it and getting ready for it.
 */
const GENERIC: FocusTree = {
  tag: 'GEN',
  name: '国家方針',
  focuses: [
    {
      id: 'GEN_political_effort',
      name: '政治的努力',
      desc: '内閣を掌握し、国政の主導権を握る。何を決めるにも、まずそこからである。',
      days: FOCUS_DAYS_SHORT, x: 1, y: 0,
      effects: [
        { k: 'politicalPower', amount: 80 },
      ],
    },
    {
      id: 'GEN_industrial_effort',
      name: '産業への注力',
      desc: '民需工場を増設し、国力の土台を広げる。',
      days: FOCUS_DAYS, x: 0, y: 1,
      prereq: [['GEN_political_effort']],
      effects: [
        { k: 'factory', building: 'civilian_factory', count: 2 },
        { k: 'constructionSpeed', amount: 1 },
      ],
    },
    {
      id: 'GEN_military_effort',
      name: '軍備への注力',
      desc: '軍需工場を増設し、装備の生産を軌道に乗せる。',
      days: FOCUS_DAYS, x: 2, y: 1,
      prereq: [['GEN_political_effort']],
      effects: [
        { k: 'factory', building: 'military_factory', count: 2 },
      ],
    },
    {
      id: 'GEN_infrastructure_effort',
      name: '交通網の整備',
      desc: '鉄道と道路を敷き直す。動員も生産も、まず輸送から始まる。',
      days: FOCUS_DAYS, x: 0, y: 2,
      prereq: [['GEN_industrial_effort']],
      effects: [
        { k: 'infrastructure', states: 3 },
        { k: 'constructionSpeed', amount: 0.5 },
      ],
    },
    {
      id: 'GEN_research_effort',
      name: '研究機関の拡充',
      desc: '大学と研究所に予算を回し、同時に取り組める課題を増やす。',
      days: FOCUS_DAYS, x: 1, y: 2,
      prereq: [['GEN_industrial_effort']],
      effects: [
        { k: 'researchSlot', count: 1 },
        { k: 'research', branch: 'industry', days: 50 },
      ],
    },
    {
      id: 'GEN_army_effort',
      name: '陸軍の増強',
      desc: '常備師団を増やし、予備役の訓練を強化する。',
      days: FOCUS_DAYS, x: 2, y: 2,
      prereq: [['GEN_military_effort']],
      effects: [
        { k: 'research', branch: 'infantry', days: 90 },
        { k: 'equipment', equipment: 'infantry_equipment', amount: 300 },
      ],
    },
    {
      id: 'GEN_naval_effort',
      name: '海軍への注力',
      desc: '造船所を拡張する。海に開かれた国は、海を守らねばならない。',
      days: FOCUS_DAYS, x: 3, y: 2,
      prereq: [['GEN_military_effort']],
      requires: [{ k: 'dockyards', min: 1 }],
      effects: [
        { k: 'factory', building: 'dockyard', count: 2 },
        { k: 'equipment', equipment: 'convoy', amount: 40 },
      ],
    },
    {
      id: 'GEN_air_effort',
      name: '航空戦力の整備',
      desc: '飛行学校と航空隊を整え、空を明け渡さぬ備えをする。',
      days: FOCUS_DAYS, x: 2, y: 3,
      prereq: [['GEN_army_effort']],
      effects: [
        { k: 'research', branch: 'air', days: 90 },
        { k: 'equipment', equipment: 'fighter', amount: 30 },
      ],
    },
    {
      id: 'GEN_mobilisation',
      name: '総動員体制',
      desc: '嵐は避けられない。予備役を招集し、経済を戦時に切り替える。',
      days: FOCUS_DAYS, x: 1, y: 3,
      prereq: [['GEN_political_effort']],
      exclusive: ['GEN_neutrality'],
      requires: [{ k: 'worldTension', min: 30 }],
      effects: [
        { k: 'manpower', amount: 800 },
        { k: 'warEconomy', consumerGoods: 0.2 },
        { k: 'equipment', equipment: 'infantry_equipment', amount: 200 },
      ],
    },
    {
      id: 'GEN_neutrality',
      name: '中立の堅持',
      desc: '大国の争いに巻き込まれてはならない。我が国の武器は外交である。',
      days: FOCUS_DAYS, x: 0, y: 3,
      prereq: [['GEN_political_effort']],
      exclusive: ['GEN_mobilisation'],
      effects: [
        { k: 'politicalPower', amount: 60 },
        { k: 'dailyPoliticalPower', amount: 0.5 },
        { k: 'worldTension', amount: -2 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Every national tree, in country order. */
export const NATIONAL_TREES: FocusTree[] = [GERMANY, SOVIET, BRITAIN, FRANCE, ITALY];

/** The tree every nation without one of its own shares. */
export const GENERIC_TREE: FocusTree = GENERIC;

const TREE_BY_TAG = new Map<string, FocusTree>(NATIONAL_TREES.map((t) => [t.tag, t]));

export function focusTreeFor(tag: string): FocusTree {
  return TREE_BY_TAG.get(tag) ?? GENERIC_TREE;
}

/** Focus lookup within a tree; ids are unique per tree, not globally. */
const DEF_BY_TAG = new Map<string, Map<string, FocusDef>>();

export function focusDef(tag: string, id: string): FocusDef | null {
  const treeTag = TREE_BY_TAG.has(tag) ? tag : GENERIC_TREE.tag;
  let table = DEF_BY_TAG.get(treeTag);
  if (!table) {
    table = new Map(focusTreeFor(treeTag).focuses.map((f) => [f.id, f]));
    DEF_BY_TAG.set(treeTag, table);
  }
  return table.get(id) ?? null;
}
