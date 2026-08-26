import { availableFocuses } from '../sim/focus';
import { equipmentRatio } from '../sim/military/combat';
import { freeCivilianFactories } from '../sim/economy/production';
import { researchView } from '../sim/research';
import { UI } from './strings';
import type { Game } from '../app/Game';
import type { PanelId } from './panels';

/**
 * The alert row.
 *
 * Hearts of Iron puts a line of warnings across the top of the screen, and
 * this had none. Measured on a passive campaign: a player who takes Germany
 * and touches nothing sits at 26 civilian factories, 18 military and 24
 * divisions from 1936 to 1942 while the Soviet AI goes from 40 to 158 -- and
 * nothing anywhere on screen says why, or that anything is wrong. On a phone
 * that matters more than on a desktop, because there is no room to show the
 * whole state at once and no habit of scanning it.
 *
 * Every alert is a condition the player can actually fix, and every one is a
 * button that opens the panel where they fix it. Anything that cannot be acted
 * on does not belong here.
 */

export interface Alert {
  id: string;
  /** Icon asset under assets/icons. */
  icon: string;
  /** Short label; a count when there is one to give. */
  text: string;
  /** Two to four characters naming the problem, shown under the figure. */
  caption: string;
  /** Accessible description of the problem. */
  title: string;
  /** Where tapping it takes the player. */
  panel: PanelId;
  /** True for things that are actively costing the player, not just idle. */
  urgent: boolean;
}

/** Divisions below this equipment ratio are reported as under-strength. */
const UNDER_EQUIPPED = 0.8;

export function collectAlerts(game: Game): Alert[] {
  const state = game.state;
  const me = state.countries[state.meta.playerCountry];
  if (!me || me.capitulated) return [];
  const out: Alert[] = [];

  const idleFactories = freeCivilianFactories(me);
  if (me.constructionQueue.length === 0 && idleFactories > 0) {
    out.push({
      id: 'construction', icon: 'ui-construction',
      text: String(Math.round(idleFactories)), caption: UI.alertShortIdleFactories,
      title: UI.alertIdleFactories,
      panel: 'construction', urgent: true,
    });
  }

  const idleSlots = researchView(state, me.id).filter((s) => s.idle).length;
  if (idleSlots > 0) {
    out.push({
      id: 'research', icon: 'ui-research',
      text: String(idleSlots), caption: UI.alertShortIdleResearch,
      title: UI.alertIdleResearch,
      panel: 'research', urgent: true,
    });
  }

  const focuses = availableFocuses(state, me.id);
  if (!focuses.some((f) => f.current) && focuses.some((f) => f.selectable)) {
    out.push({
      id: 'focus', icon: 'ui-political_power',
      text: '', caption: UI.alertShortNoFocus,
      title: UI.alertNoFocus, panel: 'focus', urgent: false,
    });
  }

  // Idle military factories are a different failure from idle civilian ones:
  // the plant exists and nothing is being built with it.
  const assigned = me.productionLines.reduce((n, l) => n + l.assignedFactories, 0);
  const idleMil = me.economy.militaryFactories - assigned;
  if (idleMil > 0) {
    out.push({
      id: 'production', icon: 'ui-military_factory',
      text: String(idleMil), caption: UI.alertShortIdleProduction,
      title: UI.alertIdleProduction,
      panel: 'production', urgent: true,
    });
  }

  // Fuel is the one shortage that stops equipment already in the field from
  // working, so it outranks anything merely idle.
  if (me.economy.fuelRatio < 0.95) {
    out.push({
      id: 'fuel', icon: 'ui-fuel',
      text: `${Math.round(me.economy.fuelRatio * 100)}%`, caption: UI.alertShortFuel,
      title: UI.alertFuel,
      panel: 'production', urgent: true,
    });
  }

  let short = 0;
  for (const d of state.divisions) {
    if (d.dead || d.owner !== me.id) continue;
    if (equipmentRatio(state, d) < UNDER_EQUIPPED) short++;
  }
  if (short > 0) {
    out.push({
      id: 'equipment', icon: 'ui-warning',
      text: String(short), caption: UI.alertShortUnderEquipped,
      title: UI.alertUnderEquipped,
      panel: 'army', urgent: false,
    });
  }

  const leaderless = (state.armies ?? []).filter(
    (a) => a.owner === me.id && a.commander === null && a.divisions.length > 0,
  ).length;
  if (leaderless > 0) {
    out.push({
      id: 'command', icon: 'ui-army',
      text: String(leaderless), caption: UI.alertShortNoCommander,
      title: UI.alertNoCommander,
      panel: 'command', urgent: false,
    });
  }

  return out;
}
