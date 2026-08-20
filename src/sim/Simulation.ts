import type { Command } from './core/commands';
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
const MAX_BATTALIONS = 24;
const MAX_SUPPORTS = 4;
import type { ProvinceIndex } from './map/ProvinceIndex';
import type { TickContext } from './time/TimeEngine';
import {
  addProductionLine, queueBuilding, removeProductionLine, setLineFactories,
  tickEconomyDaily,
} from './economy/production';
import {
  declareWar, demandSubmission, guarantee, improveRelations,
  joinFaction, leaveFaction, startJustification, tickCapitulationDaily,
  tickJustificationsDaily, tickTensionMonthly,
} from './diplomacy/diplomacy';
import {
  orderMove, stopDivision, tickMilitaryHourly, tickReinforcementDaily,
} from './military/movement';
import { tickSupplyDaily } from './military/supply';
import { tickAIDaily } from './ai/ai';
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
      case 'setResearch': {
        const c = state.countries[cmd.country];
        c.research.progress[cmd.branch] += 0;   // selection only; progress ticks daily
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
      tickSupplyDaily(state, this.index);
      tickEconomyDaily(state, this.ctx);
      tickReinforcementDaily(state);
      tickResearchDaily(state);
      tickJustificationsDaily(state);
      recomputeCountryStats(state);
      tickAIDaily(state, this.ctx);
      tickCapitulationDaily(state, this.ctx);
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

/** Research is a slow, automatic drip: one level per branch every ~200 days. */
function tickResearchDaily(state: GameState): void {
  for (const c of state.countries) {
    if (c.capitulated) continue;
    // Industry leads: it is the branch the economy actually reads, and behind
    // 'air' it sat at index 3 while no country has more than 3 slots -- so it
    // was never researched by anyone, in any campaign.
    const branches = ['industry', 'infantry', 'armor', 'air'] as const;
    // A country researches as many branches at once as it has slots.
    for (let i = 0; i < Math.min(c.research.slots, branches.length); i++) {
      const b = branches[i];
      c.research.progress[b] += 1;
      const needed = 180 + c.research.levels[b] * 60;
      if (c.research.progress[b] >= needed) {
        c.research.progress[b] = 0;
        c.research.levels[b]++;
      }
    }
  }
}

/** Keeps the event log bounded; it is a UI feed, not a historical record. */
function pruneLog(state: GameState): void {
  const MAX = 300;
  if (state.log.length > MAX) state.log.splice(0, state.log.length - MAX);
}
