import type { Command } from './core/commands';
import { tickFuelDaily } from './economy/fuel';
import { tickAirDaily } from './military/air';
import { tickOccupationDaily } from './economy/occupation';
import { changeLaw, tickPoliticsDaily } from './politics/politics';
import { deriveTemplate, recomputeCountryStats, spawnDivision } from './scenario/europe1936';
import type { EquipmentType, GameState } from './core/types';

/**
 * Division size limits.
 *
 * The cap exists because combat width is what makes composition a decision: an
 * unbounded division is always better than a bounded one, and the designer
 * stops being a choice. Twenty-four line battalions is a little above the
 * largest historical division, which leaves room to be wrong on purpose.
 */
import type { ProvinceIndex } from './map/ProvinceIndex';
import type { TickContext } from './time/TimeEngine';
import {
  addProductionLine, queueBuilding, removeProductionLine, setLineFactories,
  tickEconomyDaily,
} from './economy/production';
import {
  declareWar, demandSubmission, guarantee, improveRelations,
  joinFaction, leaveFaction, startJustification, tickCapitulationDaily,
  tickJustificationsDaily, tickTensionMonthly, occupationRatio,
} from './diplomacy/diplomacy';
import {
  orderMove, stopDivision, tickConditionsDaily, tickMilitaryHourly, tickReinforcementDaily,
} from './military/movement';
import { tickSupplyDaily } from './military/supply';
import {
  MAX_ARMIES, appointCommander, armiesOf, armyById, assignDivisions, createArmy, disbandArmy,
  setArmyParent, tickCommandReinforcementDaily, tickCommanderExperienceDaily,
} from './military/command';
import { tickBattlePlansDaily } from './military/frontline';
import { MAX_BATTALIONS, MAX_SUPPORTS } from './core/data';
import { tickArmyExperienceDaily, upgradeVariant } from './economy/variants';
import { tickAIDaily } from './ai/ai';
import { cancelResearch, startResearch, tickResearchDaily } from './research';
import { closeTrade, openTrade, tickTradeDaily } from './economy/trade';
import { cancelFocus, startFocus, tickFocusDaily } from './focus';
import { tickVictoryCheck } from './scenario/victory';

/**
 * The simulation composition root.
 *
 * This is where the tick cascade defined in ARCHITECTURE.md is actually wired.
 * Order within a tick matters and is fixed:
 *
 *   hourly   commands, then combat and movement
 *   daily    supply, economy, reinforcement, justifications, AI, capitulation
 *   monthly  statistics, world tension, victory check
 *
 * Supply is computed before the economy so a cut-off industrial region is
 * already reflected in the day's output, and capitulation runs after the AI so
 * a country that lost its last province this tick does not also get a turn.
 */

export class Simulation {
  constructor(
    readonly state: GameState,
    readonly index: ProvinceIndex,
  ) {}

  private get ctx() {
    return { index: this.index };
  }

  /** Applies one command. Player and AI both come through here. */
  execute(cmd: Command): void {
    const state = this.state;
    switch (cmd.t) {
      // --- production -----------------------------------------------------
      case 'addProductionLine': {
        addProductionLine(state, state.countries[cmd.country], cmd.equipment);
        return;
      }
      case 'removeProductionLine': {
        removeProductionLine(state.countries[cmd.country], cmd.line);
        return;
      }
      case 'setLineFactories': {
        setLineFactories(state.countries[cmd.country], cmd.line, cmd.factories);
        return;
      }
      case 'setLinePriority': {
        const line = state.countries[cmd.country].productionLines.find((l) => l.id === cmd.line);
        if (line) line.priority = cmd.priority;
        return;
      }
      case 'queueConstruction': {
        queueBuilding(state, state.countries[cmd.country], cmd.state, cmd.kind);
        return;
      }
      case 'cancelConstruction': {
        const q = state.countries[cmd.country].constructionQueue;
        const i = q.findIndex((x) => x.id === cmd.item);
        if (i >= 0) q.splice(i, 1);
        return;
      }
      case 'reorderConstruction': {
        const q = state.countries[cmd.country].constructionQueue;
        const i = q.findIndex((x) => x.id === cmd.item);
        if (i < 0) return;
        const [item] = q.splice(i, 1);
        q.splice(Math.max(0, Math.min(q.length, cmd.toIndex)), 0, item);
        return;
      }

      // --- military -------------------------------------------------------
      case 'recruitDivision': {
        const c = state.countries[cmd.country];
        const tpl = c.templates.find((t) => t.id === cmd.template);
        if (!tpl) return;
        if (state.provinces[cmd.province]?.controller !== c.id) return;
        if (c.economy.manpower < tpl.manpowerNeed / 1000) return;
        let ratio = 1;
        for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [EquipmentType, number][]) {
          ratio = Math.min(ratio, (c.economy.stockpile[eq] ?? 0) / need);
        }
        if (ratio < 0.5) return;
        const equipped = Math.min(1, ratio);
        for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [EquipmentType, number][]) {
          c.economy.stockpile[eq] = Math.max(0, (c.economy.stockpile[eq] ?? 0) - need * equipped);
        }
        c.economy.manpower -= tpl.manpowerNeed / 1000;
        spawnDivision(state, c.id, cmd.template, cmd.province, equipped);
        return;
      }
      case 'moveDivisions': {
        for (const id of cmd.divisions) {
          const d = state.divisions[id];
          if (!d || d.dead) continue;
          // A division locked in a battle cannot walk away from it.
          if (d.combatId !== null) continue;
          orderMove(state, this.ctx, d, cmd.target);
        }
        return;
      }
      case 'stopDivisions': {
        for (const id of cmd.divisions) {
          const d = state.divisions[id];
          if (d && !d.dead) stopDivision(d);
        }
        return;
      }
      case 'setDivisionOrder': {
        for (const id of cmd.divisions) {
          const d = state.divisions[id];
          if (!d || d.dead) continue;
          if (cmd.order === 'attack' && cmd.target !== undefined) {
            orderMove(state, this.ctx, d, cmd.target);
          } else {
            stopDivision(d);
          }
        }
        return;
      }
      // --- chain of command -------------------------------------------------
      case 'createArmy': {
        // Capped here as well as in the two places the UI offers it. The
        // ceiling exists because every army ticks a battle plan, and a rail
        // that only one of the entry points respects is not a rail.
        const group = cmd.isArmyGroup ?? false;
        const held = armiesOf(state, cmd.country).filter((a) => a.isArmyGroup === group);
        if (held.length >= MAX_ARMIES) return;
        createArmy(state, cmd.country, cmd.name, group);
        return;
      }
      case 'upgradeVariant': {
        upgradeVariant(state, cmd.country, cmd.equipment, cmd.module, cmd.step);
        return;
      }
      case 'changeLaw': {
        // Guarded here as well as in the panel: a command that arrives while
        // the requirements have lapsed must not slip through.
        changeLaw(state, cmd.country, cmd.kind, cmd.step);
        return;
      }
      case 'disbandArmy': {
        if (armyById(state, cmd.army)?.owner !== cmd.country) return;
        disbandArmy(state, cmd.army);
        return;
      }
      case 'renameArmy': {
        const army = armyById(state, cmd.army);
        if (!army || army.owner !== cmd.country) return;
        army.name = cmd.name.slice(0, 40);
        return;
      }
      case 'assignDivisions': {
        if (cmd.army !== null && armyById(state, cmd.army)?.owner !== cmd.country) return;
        assignDivisions(state, cmd.army, cmd.divisions);
        return;
      }
      case 'appointCommander': {
        if (armyById(state, cmd.army)?.owner !== cmd.country) return;
        appointCommander(state, cmd.army, cmd.commander);
        return;
      }
      case 'setArmyParent': {
        if (armyById(state, cmd.army)?.owner !== cmd.country) return;
        setArmyParent(state, cmd.army, cmd.group);
        return;
      }
      case 'setArmyOrder': {
        const army = armyById(state, cmd.army);
        if (!army || army.owner !== cmd.country) return;
        // A new order throws the old preparation away. Planning is preparation
        // for one thing; it does not transfer to another.
        if (JSON.stringify(army.order) !== JSON.stringify(cmd.order)) army.planning = 0;
        army.order = cmd.order;
        return;
      }
      case 'createTemplate': {
        const c = state.countries[cmd.country];
        if (!c || c.capitulated) return;
        const battalions = cmd.battalions.slice(0, MAX_BATTALIONS);
        if (battalions.length === 0) return;
        // Support companies are one of each at most: they are a modifier on the
        // division, not a way to stack the same bonus.
        const supports = [...new Set(cmd.supports)].slice(0, MAX_SUPPORTS);
        const name = cmd.name.trim().slice(0, 24) || '新編師団';

        const existing = c.templates.findIndex((t) => t.name === name);
        const id = existing >= 0 ? c.templates[existing].id : state.nextIds.template++;
        const tpl = deriveTemplate(id, name, battalions, supports);
        if (existing >= 0) c.templates[existing] = tpl;
        else c.templates.push(tpl);
        return;
      }

      // --- diplomacy ------------------------------------------------------
      case 'justifyWar': {
        startJustification(state, cmd.country, cmd.target);
        return;
      }
      case 'openTrade': {
        openTrade(state, this.ctx, cmd.country, cmd.seller, cmd.resource, cmd.factories);
        break;
      }
      case 'closeTrade': {
        closeTrade(state, cmd.country, cmd.seller, cmd.resource, cmd.factories);
        break;
      }
      case 'demandSubmission': {
        demandSubmission(state, this.ctx, cmd.country, cmd.target);
        return;
      }
      case 'declareWar': {
        declareWar(state, cmd.country, cmd.target);
        return;
      }
      case 'guarantee': {
        guarantee(state, cmd.country, cmd.target);
        return;
      }
      case 'improveRelations': {
        improveRelations(state, cmd.country, cmd.target);
        return;
      }
      case 'inviteToFaction': {
        const inviter = state.countries[cmd.country];
        if (inviter.factionId === null) return;
        joinFaction(state, cmd.target, inviter.factionId);
        return;
      }
      case 'joinFaction': {
        joinFaction(state, cmd.country, cmd.faction);
        return;
      }
      case 'leaveFaction': {
        leaveFaction(state, cmd.country);
        return;
      }

      // --- research -------------------------------------------------------
      case 'startResearch': {
        startResearch(state, cmd.country, cmd.slot, cmd.tech);
        return;
      }
      case 'cancelResearch': {
        cancelResearch(state, cmd.country, cmd.slot);
        return;
      }

      // --- national focus ---------------------------------------------------
      case 'startFocus': {
        startFocus(state, this.ctx, cmd.country, cmd.focus);
        return;
      }
      case 'cancelFocus': {
        cancelFocus(state, cmd.country);
        return;
      }
    }
  }

  /** One simulated hour. */
  tick(ctx: TickContext): void {
    const state = this.state;
    state.clock = ctx.clock;
    if (state.outcome.status !== 'playing') return;

    tickMilitaryHourly(state, this.ctx);

    if (ctx.newDay) {
      // Before supply and before the AI: a front that re-forms today should be
      // fed today, and the AI should see where its armies have been sent.
      // Before the plans run, so a division that joined an army today is
      // included in today's spread rather than standing where it was built.
      tickCommandReinforcementDaily(state);
      tickBattlePlansDaily(state, this.ctx);
      tickCommanderExperienceDaily(state);
      tickArmyExperienceDaily(state);
      tickSupplyDaily(state, this.index);
      // Before the economy, so a deal broken by yesterday's declaration of war
      // is already gone when today's resource supply is added up.
      tickTradeDaily(state, this.ctx);
      tickEconomyDaily(state, this.ctx);
      tickPoliticsDaily(state, (id) => occupationRatio(state, id));
      tickFuelDaily(state);
      tickAirDaily(state);
      tickOccupationDaily(state);
      tickConditionsDaily(state, this.index);
      tickReinforcementDaily(state);
      tickResearchDaily(state);
      // After the economy so the consumer-goods ceiling clamps the drift rather
      // than being overwritten by it, and before the AI so a war goal granted
      // today is visible to the power that was granted it.
      tickFocusDaily(state, this.ctx);
      tickJustificationsDaily(state);
      recomputeCountryStats(state);
      tickAIDaily(state, this.ctx);
      tickCapitulationDaily(state, this.ctx);
      // A second sweep, because recruitment happens inside the AI pass and the
      // first sweep ran before it: a division built today would otherwise
      // stand uncommanded until tomorrow, and any observer looking at the
      // state between the two ticks sees an army with no general. Returns
      // immediately when nothing is loose, which is almost every day.
      tickCommandReinforcementDaily(state);
      recomputeCountryStats(state);
    }

    if (ctx.newMonth) {
      tickTensionMonthly(state);
      tickVictoryCheck(state);
      pruneLog(state);
    }
    // The clock reaching the scenario end must resolve even mid-month.
    if (ctx.newDay) tickVictoryCheck(state);
  }
}

/** Keeps the event log bounded; it is a UI feed, not a historical record. */
function pruneLog(state: GameState): void {
  const MAX = 300;
  if (state.log.length > MAX) state.log.splice(0, state.log.length - MAX);
}
