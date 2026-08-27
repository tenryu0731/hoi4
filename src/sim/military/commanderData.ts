/**
 * The officer corps of 1936, as data.
 *
 * A commander is a bundle of multipliers hung on an army, so what this table is
 * really describing is the shape of each country's bench: who has ten usable
 * officers and who has one good man with nothing behind him. That difference is
 * a large part of what made the period feel the way it did, and it is cheaper
 * to express here than to model anywhere else.
 *
 * Three rules shape the numbers:
 *
 *   - `skill` is standing, the attributes are aptitude. A staff officer who ran
 *     an army group without ever winning a battle carries a high skill and a low
 *     attack; a divisional firebrand is the reverse. Keeping them separate is
 *     what lets Keitel and Rommel both be historically legible.
 *   - Nobody is good at everything. Zhukov comes closest and still gives ground
 *     on planning and logistics, because a commander with six across the board
 *     removes the reason to ever field a second one.
 *   - Rank is scarcity, not seniority in the abstract. A field marshal is the
 *     man a country would actually have put over an army group in 1936, which is
 *     why Germany's is Rundstedt and not Rommel, and why most of the continent
 *     has none at all.
 *
 * Names are stored twice on purpose. `name` is the katakana the Japanese UI
 * shows and is the only string a player reads; `latin` is what goes in the
 * accessible label and in log lines, because a transliteration is lossy and a
 * bug report that says 'ルクレール' is harder to act on than one that says
 * 'Leclerc'.
 */

export type CommanderRank = 'general' | 'field_marshal';

export type CommanderTrait =
  | 'organiser'          // +6 command limit
  | 'logistics_wizard'   // -20% supply use
  | 'defensive_doctrine' // +30% entrenchment
  | 'fast_planner'       // +10% planning speed
  | 'thorough_planner'   // +50% max planning bonus
  | 'panzer_leader'      // +10% armour division speed and breakthrough
  | 'infantry_leader'    // +10% infantry division attack and defence
  | 'trickster'          // +25% chance to counter an enemy plan
  | 'winter_specialist'  // -30% winter attrition
  | 'naval_invader';     // +30% naval invasion speed

export interface CommanderDef {
  /** Stable id, lower_snake_case, e.g. 'ger_rommel'. */
  id: string;
  /** Owning country tag, e.g. 'GER'. */
  tag: string;
  /** Name as it should read in a Japanese UI, e.g. 'エルヴィン・ロンメル'. */
  name: string;
  /** Latin name, for the accessible label and for debugging. */
  latin: string;
  rank: CommanderRank;
  /** Overall skill, 1..9. Drives experience gain and trait slots. */
  skill: number;
  /** Attribute levels, 1..6 each. */
  attack: number;
  defence: number;
  planning: number;
  logistics: number;
  traits: CommanderTrait[];
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/**
 * Every commander in the scenario, grouped by tag and ordered within a tag by
 * how prominently the country should present them. Nothing sorts this list at
 * runtime, so declaration order is roster order everywhere it is shown.
 */
export const COMMANDERS: readonly CommanderDef[] = [
  // --- GER ----------------------------------------------------------------
  // The deepest bench in the game, and deliberately lopsided: the armour men
  // are sharp and short of supply, the senior marshals are steady and slow.
  {
    id: 'ger_rundstedt', tag: 'GER', name: 'ゲルト・フォン・ルントシュテット',
    latin: 'Gerd von Rundstedt', rank: 'field_marshal',
    skill: 7, attack: 4, defence: 5, planning: 5, logistics: 3,
    traits: ['organiser', 'defensive_doctrine'],
  },
  {
    // Ran the high command for nine years without ever commanding in the field,
    // so he is a large command limit attached to very little else.
    id: 'ger_keitel', tag: 'GER', name: 'ヴィルヘルム・カイテル',
    latin: 'Wilhelm Keitel', rank: 'field_marshal',
    skill: 4, attack: 2, defence: 3, planning: 3, logistics: 4,
    traits: ['organiser'],
  },
  {
    id: 'ger_guderian', tag: 'GER', name: 'ハインツ・グデーリアン',
    latin: 'Heinz Guderian', rank: 'general',
    skill: 8, attack: 6, defence: 3, planning: 5, logistics: 3,
    traits: ['panzer_leader', 'fast_planner', 'trickster'],
  },
  {
    id: 'ger_manstein', tag: 'GER', name: 'エーリッヒ・フォン・マンシュタイン',
    latin: 'Erich von Manstein', rank: 'general',
    skill: 8, attack: 5, defence: 4, planning: 6, logistics: 3,
    traits: ['thorough_planner', 'trickster'],
  },
  {
    // Won on tempo and lived permanently at the end of a broken supply line.
    id: 'ger_rommel', tag: 'GER', name: 'エルヴィン・ロンメル',
    latin: 'Erwin Rommel', rank: 'general',
    skill: 7, attack: 6, defence: 3, planning: 4, logistics: 1,
    traits: ['panzer_leader', 'trickster'],
  },
  {
    id: 'ger_hoth', tag: 'GER', name: 'ヘルマン・ホト',
    latin: 'Hermann Hoth', rank: 'general',
    skill: 6, attack: 5, defence: 3, planning: 4, logistics: 3,
    traits: ['panzer_leader'],
  },
  {
    id: 'ger_model', tag: 'GER', name: 'ヴァルター・モーデル',
    latin: 'Walter Model', rank: 'general',
    skill: 7, attack: 4, defence: 6, planning: 3, logistics: 3,
    traits: ['defensive_doctrine', 'organiser'],
  },
  {
    id: 'ger_kesselring', tag: 'GER', name: 'アルベルト・ケッセルリンク',
    latin: 'Albert Kesselring', rank: 'general',
    skill: 6, attack: 3, defence: 5, planning: 5, logistics: 4,
    traits: ['defensive_doctrine', 'logistics_wizard'],
  },
  {
    id: 'ger_kleist', tag: 'GER', name: 'エーヴァルト・フォン・クライスト',
    latin: 'Ewald von Kleist', rank: 'general',
    skill: 6, attack: 5, defence: 3, planning: 4, logistics: 2,
    traits: ['panzer_leader'],
  },
  {
    // Put ashore at Narvik off Kriegsmarine destroyers and then four years
    // inside the Arctic Circle -- the only German here who is cheap to fight
    // with in the snow and the only one who has ever landed from the sea.
    id: 'ger_dietl', tag: 'GER', name: 'エドゥアルト・ディートル',
    latin: 'Eduard Dietl', rank: 'general',
    skill: 5, attack: 4, defence: 4, planning: 3, logistics: 2,
    traits: ['winter_specialist', 'naval_invader'],
  },

  // --- SOV ----------------------------------------------------------------
  // Enormous and uneven, which is the point: the two men wearing the marshal's
  // stars in 1936 are the theorist about to be shot and the commissar who never
  // should have had them, while the war-winners are still corps commanders.
  {
    id: 'sov_voroshilov', tag: 'SOV', name: 'クリメント・ヴォロシーロフ',
    latin: 'Kliment Voroshilov', rank: 'field_marshal',
    skill: 3, attack: 2, defence: 3, planning: 2, logistics: 3,
    traits: [],
  },
  {
    id: 'sov_tukhachevsky', tag: 'SOV', name: 'ミハイル・トゥハチェフスキー',
    latin: 'Mikhail Tukhachevsky', rank: 'field_marshal',
    skill: 8, attack: 5, defence: 4, planning: 6, logistics: 4,
    traits: ['thorough_planner', 'fast_planner'],
  },
  {
    id: 'sov_zhukov', tag: 'SOV', name: 'ゲオルギー・ジューコフ',
    latin: 'Georgy Zhukov', rank: 'general',
    skill: 9, attack: 6, defence: 6, planning: 5, logistics: 5,
    traits: ['organiser', 'winter_specialist', 'trickster'],
  },
  {
    id: 'sov_shaposhnikov', tag: 'SOV', name: 'ボリス・シャポシニコフ',
    latin: 'Boris Shaposhnikov', rank: 'general',
    skill: 7, attack: 2, defence: 4, planning: 6, logistics: 5,
    traits: ['thorough_planner', 'organiser'],
  },
  {
    id: 'sov_vasilevsky', tag: 'SOV', name: 'アレクサンドル・ワシレフスキー',
    latin: 'Aleksandr Vasilevsky', rank: 'general',
    skill: 8, attack: 4, defence: 4, planning: 6, logistics: 5,
    traits: ['thorough_planner', 'organiser'],
  },
  {
    id: 'sov_rokossovsky', tag: 'SOV', name: 'コンスタンチン・ロコソフスキー',
    latin: 'Konstantin Rokossovsky', rank: 'general',
    skill: 8, attack: 5, defence: 5, planning: 5, logistics: 4,
    traits: ['trickster', 'organiser'],
  },
  {
    id: 'sov_konev', tag: 'SOV', name: 'イワン・コーネフ',
    latin: 'Ivan Konev', rank: 'general',
    skill: 7, attack: 5, defence: 4, planning: 4, logistics: 3,
    traits: ['fast_planner'],
  },
  {
    // A city fighter, not a manoeuvrist: nothing to spend on attack, everything
    // spent on refusing to leave.
    id: 'sov_chuikov', tag: 'SOV', name: 'ワシーリー・チュイコフ',
    latin: 'Vasily Chuikov', rank: 'general',
    skill: 6, attack: 3, defence: 6, planning: 3, logistics: 2,
    traits: ['defensive_doctrine', 'winter_specialist'],
  },
  {
    id: 'sov_timoshenko', tag: 'SOV', name: 'セミョーン・チモシェンコ',
    latin: 'Semyon Timoshenko', rank: 'general',
    skill: 5, attack: 4, defence: 4, planning: 3, logistics: 4,
    traits: ['organiser'],
  },
  {
    id: 'sov_meretskov', tag: 'SOV', name: 'キリル・メレツコフ',
    latin: 'Kirill Meretskov', rank: 'general',
    skill: 5, attack: 3, defence: 4, planning: 4, logistics: 3,
    traits: ['winter_specialist'],
  },

  // --- ENG ----------------------------------------------------------------
  // Britain's strength was staff work and supply rather than shock, so the
  // roster leans hard on planning and logistics and is thin on attack.
  {
    id: 'eng_brooke', tag: 'ENG', name: 'アラン・ブルック',
    latin: 'Alan Brooke', rank: 'field_marshal',
    skill: 8, attack: 3, defence: 5, planning: 6, logistics: 5,
    traits: ['thorough_planner', 'organiser'],
  },
  {
    id: 'eng_gort', tag: 'ENG', name: 'ジョン・ゴート',
    latin: 'John Gort', rank: 'field_marshal',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'eng_montgomery', tag: 'ENG', name: 'バーナード・モントゴメリー',
    latin: 'Bernard Montgomery', rank: 'general',
    skill: 7, attack: 3, defence: 5, planning: 6, logistics: 5,
    traits: ['thorough_planner', 'organiser'],
  },
  {
    // Burma was won on the supply column before it was won on the map.
    id: 'eng_slim', tag: 'ENG', name: 'ウィリアム・スリム',
    latin: 'William Slim', rank: 'general',
    skill: 8, attack: 5, defence: 5, planning: 5, logistics: 5,
    traits: ['logistics_wizard', 'organiser', 'trickster'],
  },
  {
    id: 'eng_alexander', tag: 'ENG', name: 'ハロルド・アレクサンダー',
    latin: 'Harold Alexander', rank: 'general',
    skill: 7, attack: 4, defence: 5, planning: 5, logistics: 4,
    traits: ['organiser'],
  },
  {
    id: 'eng_wavell', tag: 'ENG', name: 'アーチボルド・ウェーヴェル',
    latin: 'Archibald Wavell', rank: 'general',
    skill: 6, attack: 4, defence: 4, planning: 5, logistics: 3,
    traits: ['trickster'],
  },
  {
    id: 'eng_oconnor', tag: 'ENG', name: 'リチャード・オコナー',
    latin: 'Richard O’Connor', rank: 'general',
    skill: 6, attack: 5, defence: 3, planning: 4, logistics: 2,
    traits: ['fast_planner', 'trickster'],
  },
  {
    id: 'eng_auchinleck', tag: 'ENG', name: 'クロード・オーキンレック',
    latin: 'Claude Auchinleck', rank: 'general',
    skill: 5, attack: 3, defence: 5, planning: 4, logistics: 4,
    traits: ['defensive_doctrine'],
  },
  {
    // Commandos and Combined Operations; the one man in Europe whose whole
    // career was getting an army onto a beach.
    id: 'eng_laycock', tag: 'ENG', name: 'ロバート・レイコック',
    latin: 'Robert Laycock', rank: 'general',
    skill: 4, attack: 4, defence: 2, planning: 3, logistics: 2,
    traits: ['naval_invader'],
  },
  {
    // Present so that a major power is not uniformly competent. Somebody has to
    // be the reason a strong garrison surrenders to a weaker force.
    id: 'eng_percival', tag: 'ENG', name: 'アーサー・パーシヴァル',
    latin: 'Arthur Percival', rank: 'general',
    skill: 2, attack: 2, defence: 2, planning: 2, logistics: 2,
    traits: [],
  },

  // --- FRA ----------------------------------------------------------------
  // A large army run by men who had already fought the war they were preparing
  // for. High defence, low tempo, and the two officers who disagreed with that
  // -- de Gaulle and Leclerc -- are junior and short of everything else.
  {
    id: 'fra_petain', tag: 'FRA', name: 'フィリップ・ペタン',
    latin: 'Philippe Pétain', rank: 'field_marshal',
    skill: 5, attack: 2, defence: 6, planning: 4, logistics: 4,
    traits: ['defensive_doctrine', 'organiser'],
  },
  {
    id: 'fra_weygand', tag: 'FRA', name: 'マクシム・ウェイガン',
    latin: 'Maxime Weygand', rank: 'field_marshal',
    skill: 4, attack: 2, defence: 4, planning: 3, logistics: 3,
    traits: ['defensive_doctrine'],
  },
  {
    // Commanded from a chateau without a radio. The numbers should make it a
    // mistake to leave him in charge of anything that has to react.
    id: 'fra_gamelin', tag: 'FRA', name: 'モーリス・ガムラン',
    latin: 'Maurice Gamelin', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 2, logistics: 3,
    traits: [],
  },
  {
    id: 'fra_de_gaulle', tag: 'FRA', name: 'シャルル・ド・ゴール',
    latin: 'Charles de Gaulle', rank: 'general',
    skill: 6, attack: 5, defence: 3, planning: 4, logistics: 2,
    traits: ['panzer_leader', 'fast_planner'],
  },
  {
    // The Corps Expéditionnaire took the Aurunci mountains with foot infantry
    // over ground the Allies had written off as impassable.
    id: 'fra_juin', tag: 'FRA', name: 'アルフォンス・ジュアン',
    latin: 'Alphonse Juin', rank: 'general',
    skill: 6, attack: 4, defence: 4, planning: 4, logistics: 3,
    traits: ['organiser', 'infantry_leader'],
  },
  {
    id: 'fra_de_lattre', tag: 'FRA', name: 'ジャン・ド・ラットル・ド・タシニー',
    latin: 'Jean de Lattre de Tassigny', rank: 'general',
    skill: 6, attack: 4, defence: 4, planning: 4, logistics: 3,
    traits: ['fast_planner'],
  },
  {
    id: 'fra_leclerc', tag: 'FRA', name: 'フィリップ・ルクレール',
    latin: 'Philippe Leclerc', rank: 'general',
    skill: 5, attack: 5, defence: 2, planning: 3, logistics: 2,
    traits: ['panzer_leader'],
  },
  {
    id: 'fra_georges', tag: 'FRA', name: 'アルフォンス・ジョルジュ',
    latin: 'Alphonse Georges', rank: 'general',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'fra_giraud', tag: 'FRA', name: 'アンリ・ジロー',
    latin: 'Henri Giraud', rank: 'general',
    skill: 4, attack: 4, defence: 3, planning: 2, logistics: 3,
    traits: [],
  },
  {
    id: 'fra_huntziger', tag: 'FRA', name: 'シャルル・アンツィジェ',
    latin: 'Charles Huntziger', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },

  // --- ITA ----------------------------------------------------------------
  // Italy's problem was never the number of officers, so the roster is full and
  // uniformly unimpressive apart from Messe, who is the exception that makes
  // the rest read as a choice rather than an oversight.
  {
    id: 'ita_badoglio', tag: 'ITA', name: 'ピエトロ・バドリオ',
    latin: 'Pietro Badoglio', rank: 'field_marshal',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },
  {
    id: 'ita_messe', tag: 'ITA', name: 'ジョヴァンニ・メッセ',
    latin: 'Giovanni Messe', rank: 'general',
    skill: 6, attack: 4, defence: 4, planning: 4, logistics: 3,
    traits: ['organiser', 'trickster'],
  },
  {
    id: 'ita_graziani', tag: 'ITA', name: 'ロドルフォ・グラツィアーニ',
    latin: 'Rodolfo Graziani', rank: 'general',
    skill: 3, attack: 3, defence: 2, planning: 2, logistics: 2,
    traits: [],
  },
  {
    id: 'ita_cavallero', tag: 'ITA', name: 'ウーゴ・カヴァッレロ',
    latin: 'Ugo Cavallero', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 4, logistics: 4,
    traits: ['logistics_wizard'],
  },
  {
    id: 'ita_balbo', tag: 'ITA', name: 'イタロ・バルボ',
    latin: 'Italo Balbo', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 4,
    traits: ['organiser'],
  },
  {
    id: 'ita_bastico', tag: 'ITA', name: 'エットーレ・バスティコ',
    latin: 'Ettore Bastico', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- POL ----------------------------------------------------------------
  // Six officers for a country that will be overrun in five weeks; most of them
  // did their best work afterwards, in somebody else's army.
  {
    id: 'pol_rydz_smigly', tag: 'POL', name: 'エドヴァルト・リッツ＝シミグウィ',
    latin: 'Edward Rydz-Śmigły', rank: 'field_marshal',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'pol_sikorski', tag: 'POL', name: 'ヴワディスワフ・シコルスキ',
    latin: 'Władysław Sikorski', rank: 'general',
    skill: 6, attack: 3, defence: 4, planning: 5, logistics: 4,
    traits: ['organiser'],
  },
  {
    id: 'pol_anders', tag: 'POL', name: 'ヴワディスワフ・アンデルス',
    latin: 'Władysław Anders', rank: 'general',
    skill: 6, attack: 4, defence: 4, planning: 4, logistics: 3,
    traits: ['organiser', 'infantry_leader'],
  },
  {
    id: 'pol_maczek', tag: 'POL', name: 'スタニスワフ・マチェク',
    latin: 'Stanisław Maczek', rank: 'general',
    skill: 6, attack: 5, defence: 3, planning: 4, logistics: 2,
    traits: ['panzer_leader'],
  },
  {
    // The Bzura counterattack: the only Polish operation of 1939 that forced the
    // Germans to change their plan.
    id: 'pol_kutrzeba', tag: 'POL', name: 'タデウシュ・クトシェバ',
    latin: 'Tadeusz Kutrzeba', rank: 'general',
    skill: 5, attack: 4, defence: 3, planning: 4, logistics: 2,
    traits: ['trickster'],
  },
  {
    id: 'pol_sosabowski', tag: 'POL', name: 'スタニスワフ・ソサボフスキ',
    latin: 'Stanisław Sosabowski', rank: 'general',
    skill: 5, attack: 4, defence: 3, planning: 4, logistics: 2,
    traits: ['fast_planner'],
  },

  // --- CZE ----------------------------------------------------------------
  // An army built entirely around a fortress line, which is what the traits say.
  {
    id: 'cze_krejci', tag: 'CZE', name: 'ルドヴィーク・クレイチー',
    latin: 'Ludvík Krejčí', rank: 'general',
    skill: 5, attack: 3, defence: 5, planning: 4, logistics: 3,
    traits: ['defensive_doctrine'],
  },
  {
    id: 'cze_vojcechovsky', tag: 'CZE', name: 'セルゲイ・ヴォイツェホフスキー',
    latin: 'Sergej Vojcechovský', rank: 'general',
    skill: 5, attack: 4, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'cze_syrovy', tag: 'CZE', name: 'ヤン・シロヴィー',
    latin: 'Jan Syrový', rank: 'general',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'cze_prchala', tag: 'CZE', name: 'レフ・プルハラ',
    latin: 'Lev Prchala', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },

  // --- YUG ----------------------------------------------------------------
  // Tito is in 1936 a party organiser and not a soldier at all, which is exactly
  // why he belongs here: the Yugoslav army of 1941 lasted eleven days and the
  // war in the mountains lasted four years.
  {
    id: 'yug_simovic', tag: 'YUG', name: 'ドゥシャン・シモヴィッチ',
    latin: 'Dušan Simović', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'yug_tito', tag: 'YUG', name: 'ヨシップ・ブロズ・チトー',
    latin: 'Josip Broz Tito', rank: 'general',
    skill: 6, attack: 4, defence: 4, planning: 4, logistics: 3,
    traits: ['trickster', 'organiser'],
  },
  {
    id: 'yug_mihailovic', tag: 'YUG', name: 'ドラジャ・ミハイロヴィッチ',
    latin: 'Draža Mihailović', rank: 'general',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 2,
    traits: ['trickster'],
  },
  {
    id: 'yug_nedic', tag: 'YUG', name: 'ミラン・ネディッチ',
    latin: 'Milan Nedić', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },

  // --- ROM ----------------------------------------------------------------
  {
    id: 'rom_antonescu', tag: 'ROM', name: 'イオン・アントネスク',
    latin: 'Ion Antonescu', rank: 'general',
    skill: 5, attack: 4, defence: 3, planning: 4, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'rom_dumitrescu', tag: 'ROM', name: 'ペトレ・ドゥミトレスク',
    latin: 'Petre Dumitrescu', rank: 'general',
    skill: 5, attack: 4, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },
  {
    // Career mountain-corps officer; the Carpathians are the one terrain
    // Romania can defend cheaply.
    id: 'rom_avramescu', tag: 'ROM', name: 'ゲオルゲ・アヴラメスク',
    latin: 'Gheorghe Avramescu', rank: 'general',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 2,
    traits: ['winter_specialist'],
  },
  {
    id: 'rom_racovita', tag: 'ROM', name: 'ミハイル・ラコヴィツァ',
    latin: 'Mihail Racoviță', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- HUN ----------------------------------------------------------------
  {
    id: 'hun_szombathelyi', tag: 'HUN', name: 'フェレンツ・ソンバトヘイ',
    latin: 'Ferenc Szombathelyi', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 4, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'hun_veress', tag: 'HUN', name: 'ラヨシュ・ヴェレシュ',
    latin: 'Lajos Veress', rank: 'general',
    skill: 4, attack: 4, defence: 3, planning: 3, logistics: 2,
    traits: ['panzer_leader'],
  },
  {
    id: 'hun_werth', tag: 'HUN', name: 'ヘンリク・ヴェルト',
    latin: 'Henrik Werth', rank: 'general',
    skill: 3, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },
  {
    // Lost an entire army on the Don and blamed the survivors for it.
    id: 'hun_jany', tag: 'HUN', name: 'グスターヴ・ヤーニ',
    latin: 'Gusztáv Jány', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 2, logistics: 2,
    traits: [],
  },

  // --- AUS ----------------------------------------------------------------
  // Austria had two years to write a plan for holding the Alps against Germany
  // and one officer who actually wrote it.
  {
    id: 'aus_jansa', tag: 'AUS', name: 'アルフレート・ヤンザ',
    latin: 'Alfred Jansa', rank: 'general',
    skill: 5, attack: 3, defence: 5, planning: 5, logistics: 3,
    traits: ['defensive_doctrine', 'thorough_planner'],
  },
  {
    id: 'aus_loehr', tag: 'AUS', name: 'アレクサンダー・レーア',
    latin: 'Alexander Löhr', rank: 'general',
    skill: 5, attack: 4, defence: 3, planning: 4, logistics: 3,
    traits: ['fast_planner'],
  },
  {
    id: 'aus_zehner', tag: 'AUS', name: 'ヴィルヘルム・ツェーナー',
    latin: 'Wilhelm Zehner', rank: 'general',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'aus_schilhawsky', tag: 'AUS', name: 'ジギスムント・シルハウスキー',
    latin: 'Sigismund Schilhawsky', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },

  // --- BUL ----------------------------------------------------------------
  {
    id: 'bul_lukov', tag: 'BUL', name: 'フリスト・ルコフ',
    latin: 'Hristo Lukov', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'bul_stoychev', tag: 'BUL', name: 'ヴラディミル・ストイチェフ',
    latin: 'Vladimir Stoychev', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },
  {
    id: 'bul_daskalov', tag: 'BUL', name: 'テオドシ・ダスカロフ',
    latin: 'Teodosi Daskalov', rank: 'general',
    skill: 3, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'bul_marinov', tag: 'BUL', name: 'イヴァン・マリノフ',
    latin: 'Ivan Marinov', rank: 'general',
    skill: 3, attack: 3, defence: 3, planning: 2, logistics: 2,
    traits: [],
  },

  // --- GRE ----------------------------------------------------------------
  // The one small army in Europe that beat a major power in the field, and it
  // did it by digging into mountains and refusing to be flanked.
  {
    id: 'gre_papagos', tag: 'GRE', name: 'アレクサンドロス・パパゴス',
    latin: 'Alexandros Papagos', rank: 'field_marshal',
    skill: 6, attack: 4, defence: 5, planning: 4, logistics: 3,
    traits: ['defensive_doctrine', 'organiser'],
  },
  {
    // Held the Kalamas with one infantry division against an army corps.
    id: 'gre_katsimitros', tag: 'GRE', name: 'ハラランボス・カツィミトロス',
    latin: 'Charalambos Katsimitros', rank: 'general',
    skill: 5, attack: 3, defence: 5, planning: 3, logistics: 2,
    traits: ['defensive_doctrine', 'infantry_leader'],
  },
  {
    id: 'gre_pitsikas', tag: 'GRE', name: 'イオアニス・ピツィカス',
    latin: 'Ioannis Pitsikas', rank: 'general',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 2,
    traits: [],
  },
  {
    id: 'gre_tsolakoglou', tag: 'GRE', name: 'ゲオルギオス・ツォラコグル',
    latin: 'Georgios Tsolakoglou', rank: 'general',
    skill: 3, attack: 3, defence: 3, planning: 2, logistics: 2,
    traits: [],
  },

  // --- TUR ----------------------------------------------------------------
  // Twenty years of the same chief of staff, and a doctrine that consisted of
  // fortifying the straits and staying out of it.
  {
    id: 'tur_cakmak', tag: 'TUR', name: 'フェヴズィ・チャクマク',
    latin: 'Fevzi Çakmak', rank: 'field_marshal',
    skill: 5, attack: 3, defence: 5, planning: 4, logistics: 3,
    traits: ['defensive_doctrine'],
  },
  {
    id: 'tur_karabekir', tag: 'TUR', name: 'キャーズム・カラベキル',
    latin: 'Kâzım Karabekir', rank: 'general',
    skill: 5, attack: 4, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'tur_orbay', tag: 'TUR', name: 'キャーズム・オルバイ',
    latin: 'Kâzım Orbay', rank: 'general',
    skill: 4, attack: 3, defence: 3, planning: 4, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'tur_altay', tag: 'TUR', name: 'ファフレッティン・アルタイ',
    latin: 'Fahrettin Altay', rank: 'general',
    skill: 4, attack: 4, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- SPR ----------------------------------------------------------------
  // Both sides of 1936 are in the same list, because whichever way the civil war
  // goes the survivors are the Spanish army.
  {
    id: 'spr_franco', tag: 'SPR', name: 'フランシスコ・フランコ',
    latin: 'Francisco Franco', rank: 'field_marshal',
    skill: 5, attack: 3, defence: 4, planning: 4, logistics: 4,
    traits: ['organiser'],
  },
  {
    // The Republic's chief of staff and the best operational mind in Spain,
    // spent entirely on holding Madrid with what was left.
    id: 'spr_rojo', tag: 'SPR', name: 'ビセンテ・ロホ',
    latin: 'Vicente Rojo', rank: 'general',
    skill: 6, attack: 3, defence: 5, planning: 5, logistics: 3,
    traits: ['thorough_planner', 'defensive_doctrine'],
  },
  {
    id: 'spr_mola', tag: 'SPR', name: 'エミリオ・モラ',
    latin: 'Emilio Mola', rank: 'general',
    skill: 4, attack: 4, defence: 3, planning: 3, logistics: 2,
    traits: ['trickster'],
  },
  {
    id: 'spr_yague', tag: 'SPR', name: 'フアン・ヤグエ',
    latin: 'Juan Yagüe', rank: 'general',
    skill: 4, attack: 5, defence: 2, planning: 2, logistics: 2,
    traits: [],
  },

  // --- FIN ----------------------------------------------------------------
  // Small, and the only roster where every single officer carries the winter
  // trait, because that is the entire Finnish theory of the war.
  {
    id: 'fin_mannerheim', tag: 'FIN', name: 'カール・グスタフ・エミール・マンネルヘイム',
    latin: 'Carl Gustaf Emil Mannerheim', rank: 'field_marshal',
    skill: 7, attack: 3, defence: 6, planning: 5, logistics: 4,
    traits: ['defensive_doctrine', 'winter_specialist', 'organiser'],
  },
  {
    // Suomussalmi: cut a road, cut the column into pieces, let the cold finish
    // them. Cheap attack, expensive to be attacked by.
    id: 'fin_siilasvuo', tag: 'FIN', name: 'ヤルマル・シイラスヴオ',
    latin: 'Hjalmar Siilasvuo', rank: 'general',
    skill: 6, attack: 4, defence: 5, planning: 4, logistics: 2,
    traits: ['winter_specialist', 'trickster'],
  },
  {
    id: 'fin_talvela', tag: 'FIN', name: 'パーヴォ・タルヴェラ',
    latin: 'Paavo Talvela', rank: 'general',
    skill: 5, attack: 4, defence: 4, planning: 3, logistics: 2,
    traits: ['winter_specialist', 'infantry_leader'],
  },
  {
    id: 'fin_osterman', tag: 'FIN', name: 'フーゴ・エステルマン',
    latin: 'Hugo Österman', rank: 'general',
    skill: 4, attack: 3, defence: 4, planning: 3, logistics: 3,
    traits: ['winter_specialist'],
  },

  // --- ALB ----------------------------------------------------------------
  // A gendarmerie with artillery. Two names, and the second one is a guerrilla.
  {
    id: 'alb_aranitasi', tag: 'ALB', name: 'ジェマル・アラニタシ',
    latin: 'Xhemal Aranitasi', rank: 'general',
    skill: 2, attack: 2, defence: 2, planning: 2, logistics: 2,
    traits: [],
  },
  {
    id: 'alb_kupi', tag: 'ALB', name: 'アバズ・クピ',
    latin: 'Abaz Kupi', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 2, logistics: 1,
    traits: ['trickster'],
  },

  // --- POR ----------------------------------------------------------------
  {
    id: 'por_carmona', tag: 'POR', name: 'オスカル・カルモナ',
    latin: 'Óscar Carmona', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'por_santos_costa', tag: 'POR', name: 'フェルナンド・サントス・コスタ',
    latin: 'Fernando Santos Costa', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- SWI ----------------------------------------------------------------
  // Switzerland's officers are junior by rank and expensive to attack: the
  // whole national plan was to make the Alps not worth the bill.
  {
    id: 'swi_guisan', tag: 'SWI', name: 'アンリ・ギザン',
    latin: 'Henri Guisan', rank: 'general',
    skill: 3, attack: 2, defence: 5, planning: 4, logistics: 3,
    traits: ['defensive_doctrine', 'organiser'],
  },
  {
    id: 'swi_wille', tag: 'SWI', name: 'ウルリッヒ・ヴィレ',
    latin: 'Ulrich Wille', rank: 'general',
    skill: 2, attack: 2, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },

  // --- BEL ----------------------------------------------------------------
  {
    id: 'bel_van_overstraeten', tag: 'BEL', name: 'ラウル・ヴァン・オーヴァーストラーテン',
    latin: 'Raoul Van Overstraeten', rank: 'general',
    skill: 3, attack: 2, defence: 4, planning: 3, logistics: 3,
    traits: [],
  },
  {
    id: 'bel_michiels', tag: 'BEL', name: 'オスカル・ミヒエルス',
    latin: 'Oscar Michiels', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: ['defensive_doctrine'],
  },

  // --- HOL ----------------------------------------------------------------
  {
    id: 'hol_winkelman', tag: 'HOL', name: 'ヘンリ・ウィンケルマン',
    latin: 'Henri Winkelman', rank: 'general',
    skill: 3, attack: 2, defence: 4, planning: 3, logistics: 3,
    traits: ['defensive_doctrine'],
  },
  {
    id: 'hol_reijnders', tag: 'HOL', name: 'イザーク・レインデルス',
    latin: 'Izaak Reijnders', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- LUX ----------------------------------------------------------------
  // The Corps des Gendarmes et Volontaires was four hundred men, so Luxembourg
  // gets one name and it is the man who commanded all of them.
  {
    id: 'lux_speller', tag: 'LUX', name: 'エミール・シュペラー',
    latin: 'Émile Speller', rank: 'general',
    skill: 1, attack: 1, defence: 2, planning: 1, logistics: 1,
    traits: [],
  },

  // --- DEN ----------------------------------------------------------------
  {
    id: 'den_prior', tag: 'DEN', name: 'ウィリアム・ヴァイン・プリオア',
    latin: 'William Wain Prior', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },
  {
    id: 'den_gortz', tag: 'DEN', name: 'エッベ・ゲアツ',
    latin: 'Ebbe Gørtz', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- NOR ----------------------------------------------------------------
  {
    id: 'nor_ruge', tag: 'NOR', name: 'オットー・ルーゲ',
    latin: 'Otto Ruge', rank: 'general',
    skill: 3, attack: 2, defence: 4, planning: 3, logistics: 2,
    traits: ['winter_specialist'],
  },
  {
    // Narvik was the first ground the Wehrmacht was pushed off in the war.
    id: 'nor_fleischer', tag: 'NOR', name: 'カール・グスタフ・フライシェル',
    latin: 'Carl Gustav Fleischer', rank: 'general',
    skill: 3, attack: 3, defence: 4, planning: 3, logistics: 2,
    traits: ['winter_specialist'],
  },

  // --- SWE ----------------------------------------------------------------
  {
    id: 'swe_thornell', tag: 'SWE', name: 'オーロフ・トルネル',
    latin: 'Olof Thörnell', rank: 'general',
    skill: 3, attack: 2, defence: 4, planning: 3, logistics: 4,
    traits: ['organiser'],
  },
  {
    id: 'swe_douglas', tag: 'SWE', name: 'アーチボルド・ダグラス',
    latin: 'Archibald Douglas', rank: 'general',
    skill: 3, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: ['winter_specialist'],
  },

  // --- EST ----------------------------------------------------------------
  {
    id: 'est_laidoner', tag: 'EST', name: 'ヨハン・ライドネル',
    latin: 'Johan Laidoner', rank: 'general',
    skill: 3, attack: 3, defence: 3, planning: 3, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'est_reek', tag: 'EST', name: 'ニコライ・レーク',
    latin: 'Nikolai Reek', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- LAT ----------------------------------------------------------------
  {
    id: 'lat_balodis', tag: 'LAT', name: 'ヤーニス・バロディス',
    latin: 'Jānis Balodis', rank: 'general',
    skill: 3, attack: 3, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },
  {
    id: 'lat_berkis', tag: 'LAT', name: 'クリシュヤーニス・ベルキス',
    latin: 'Krišjānis Berķis', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 2, logistics: 2,
    traits: [],
  },

  // --- LIT ----------------------------------------------------------------
  {
    id: 'lit_rastikis', tag: 'LIT', name: 'スタシス・ラシュティキス',
    latin: 'Stasys Raštikis', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'lit_vitkauskas', tag: 'LIT', name: 'ヴィンツァス・ヴィトカウスカス',
    latin: 'Vincas Vitkauskas', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 2, logistics: 2,
    traits: [],
  },

  // --- IRE ----------------------------------------------------------------
  {
    id: 'ire_mckenna', tag: 'IRE', name: 'ダニエル・マッケナ',
    latin: 'Daniel McKenna', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 3,
    traits: ['organiser'],
  },
  {
    id: 'ire_brennan', tag: 'IRE', name: 'マイケル・ブレナン',
    latin: 'Michael Brennan', rank: 'general',
    skill: 3, attack: 2, defence: 3, planning: 3, logistics: 2,
    traits: [],
  },

  // --- ICE ----------------------------------------------------------------
  // Iceland had no army at all in 1936. The nearest thing to a field commander
  // was the man who ran the state police, and the roster says so rather than
  // inventing a general who never existed.
  {
    id: 'ice_kofoed_hansen', tag: 'ICE', name: 'アグナル・コフォード＝ハンセン',
    latin: 'Agnar Kofoed-Hansen', rank: 'general',
    skill: 1, attack: 1, defence: 2, planning: 2, logistics: 2,
    traits: [],
  },

  // --- PER ----------------------------------------------------------------
  // Reza Shah's army was his own creation and he commanded it himself; Ahmadi
  // ran the Tehran garrison until the purge of 1939.
  {
    id: 'per_reza_pahlavi', tag: 'PER', name: 'レザー・シャー・パフラヴィー',
    latin: 'Reza Shah Pahlavi', rank: 'field_marshal',
    skill: 3, attack: 3, defence: 3, planning: 2, logistics: 2,
    traits: ['organiser'],
  },
  {
    id: 'per_ahmadi', tag: 'PER', name: 'アフマド・アフマディ',
    latin: 'Ahmad Ahmadi', rank: 'general',
    skill: 2, attack: 2, defence: 3, planning: 2, logistics: 2,
    traits: [],
  },

  // --- SAU ----------------------------------------------------------------
  // The kingdom fought its wars with tribal levies under the king's sons.
  {
    id: 'sau_saud', tag: 'SAU', name: 'サウード・ビン・アブドゥルアズィーズ',
    latin: 'Saud bin Abdulaziz', rank: 'field_marshal',
    skill: 2, attack: 3, defence: 2, planning: 1, logistics: 2,
    traits: ['infantry_leader'],
  },
  {
    id: 'sau_faisal', tag: 'SAU', name: 'ファイサル・ビン・アブドゥルアズィーズ',
    latin: 'Faisal bin Abdulaziz', rank: 'general',
    skill: 2, attack: 2, defence: 2, planning: 3, logistics: 2,
    traits: [],
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const BY_TAG = new Map<string, CommanderDef[]>();
const SEEN_IDS = new Set<string>();

/**
 * A duplicated id silently makes one of the two officers unreachable, and an
 * out-of-range attribute quietly hands somebody a bonus the balance was never
 * checked against. Neither would ever surface as a crash. The table is static,
 * so one pass at load costs nothing and is as good as a compile-time check.
 */
for (const c of COMMANDERS) {
  if (SEEN_IDS.has(c.id)) throw new Error(`duplicate commander id: ${c.id}`);
  SEEN_IDS.add(c.id);
  if (!Number.isInteger(c.skill) || c.skill < 1 || c.skill > 9) {
    throw new Error(`commander ${c.id} has skill outside 1..9: ${c.skill}`);
  }
  for (const level of [c.attack, c.defence, c.planning, c.logistics]) {
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw new Error(`commander ${c.id} has an attribute outside 1..6: ${level}`);
    }
  }
  const roster = BY_TAG.get(c.tag);
  if (roster) roster.push(c);
  else BY_TAG.set(c.tag, [c]);
}

/** Every commander belonging to a tag, in roster order. */
export function commandersFor(tag: string): readonly CommanderDef[] {
  return BY_TAG.get(tag) ?? [];
}
