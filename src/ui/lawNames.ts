import type { ConscriptionLaw, EconomyLaw } from '../sim/politics/lawData';

/**
 * Japanese names for the two law ladders.
 *
 * Kept beside the other strings rather than in the data table so the
 * simulation stays free of any language, which is the rule the rest of
 * sim/ follows.
 */
export const CONSCRIPTION_NAME: Record<ConscriptionLaw, string> = {
  disarmed: '武装解除',
  volunteer: '志願兵のみ',
  limited: '限定徴兵',
  extensive: '拡大徴兵',
  service_by_requirement: '義務兵役',
  all_adults: '成人総動員',
  scraping_the_barrel: '根こそぎ動員',
};

export const ECONOMY_NAME: Record<EconomyLaw, string> = {
  undisturbed_isolation: '完全孤立',
  isolation: '孤立主義',
  civilian: '民需経済',
  early_mobilisation: '初期動員',
  partial_mobilisation: '部分動員',
  war_economy: '戦時経済',
  total_mobilisation: '総力戦経済',
};
