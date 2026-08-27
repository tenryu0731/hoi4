import type { Game } from '../app/Game';
import type { VariantModule } from '../sim/core/types';
import {
  BUILDING_COST, EQUIPMENT, FACTORY_OUTPUT,
} from '../sim/core/data';
import {
  BATTALION_TYPES, EQUIPMENT_TYPES, RESOURCE_TYPES, SUPPORT_TYPES,
  type Army, type BattalionType, type BuildingType, type Commander, type Country,
  type CountryId, type DivisionTemplate, type EquipmentType, type ResourceType,
  type StateRuntime, type SupportType,
} from '../sim/core/types';
import { deriveTemplate } from '../sim/scenario/europe1936';
import {
  canQueueBuilding, computeResourceOutput, constructionAllocation,
} from '../sim/economy/production';
import {
  availableFrom, canTradeWith, dealUnits, exportShare, factoriesCommitted, factoriesEarned,
  maxPurchase, MIN_TRADE_LOAD, RESOURCE_PER_FACTORY, tradeFlow, tradeLawOf,
} from '../sim/economy/trade';
import { LAW_COST, TRADE } from '../sim/politics/lawData';
import {
  canChangeLaw, lawEffects, lawIndex, lawLadder, type LawCheck, type LawKind,
} from '../sim/politics/politics';
import { CONSCRIPTION_NAME, ECONOMY_NAME } from './lawNames';
import { ENTRENCHMENT_PER_LEVEL } from '../sim/military/movement';
import { winterSeverity } from '../sim/military/weather';
import { airStrength } from '../sim/military/air';
import {
  DEMAND_COST, GUARANTEE_COST, IMPROVE_COST, INVITE_COST, INVITE_OPINION, JUSTIFY_COST,
  areAllied, atWar, canDemand, canLeaveFaction, inviteBlock, joinableFactions,
  occupationRatio, opinionOf, type InviteBlock,
} from '../sim/diplomacy/diplomacy';
import { availableFocuses } from '../sim/focus';
import {
  BRANCH_LIST, researchSummary, researchView, techTree,
} from '../sim/research';
import {
  ARMY_GROUP_LIMIT, COMMAND_LIMIT, MAX_ARMIES, armyById, commandLimit, commanderById,
  idleCommanders, nextArmyName,
} from '../sim/military/command';
import { maxPlanning } from '../sim/military/frontline';
import {
  divisionsPerBattle, equipmentShortfall, terrainProfile,
} from '../sim/military/combat';
import {
  MAX_VARIANT_LEVEL, VARIANT_LEVEL_XP, VARIANT_MODULES, baseStats, canUpgrade, variantMark,
  variantOf, variantStats,
} from '../sim/economy/variants';
import { MAX_BATTALIONS, MAX_SUPPORTS } from '../sim/core/data';
import {
  BATTALION, BUILDING, EQUIPMENT as EQUIPMENT_NAME, IDEOLOGY, RESOURCE,
  SUPPORT, TERRAIN, TRAIT, UI, country,
} from './strings';

/**
 * The bottom-sheet panels.
 *
 * Each panel rebuilds its own DOM when opened and refreshes only the numbers
 * afterwards. Rebuilding a list every frame is what makes a DOM HUD feel
 * sluggish next to a canvas that is already using most of the budget.
 */

export type PanelId =
  | 'focus' | 'research' | 'production' | 'construction' | 'army' | 'command'
  | 'diplomacy' | 'nation' | 'province' | 'designer' | 'politics' | 'trade' | 'variant';

export interface Panel {
  id: PanelId;
  title: string;
  /** Builds the panel body from scratch. */
  build(game: Game, root: HTMLElement): void;
  /** Cheap per-frame refresh; may be a no-op. */
  refresh?(game: Game, root: HTMLElement): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Collapses repeats into counts.
 *
 * A motorised division listing its six identical battalions in full wrapped to
 * four lines and broke mid-compound, which is not a thing anyone ships.
 */
function tally(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join('・');
}

/**
 * Shuts the bottom sheet, set by the HUD that owns it.
 *
 * A panel occasionally has to get out of the player's way -- putting an army
 * under orders is the case: what happens next is a tap on the map, and the
 * sheet is sitting on the map.
 */
let closeSheetImpl: () => void = () => {};

export function setSheetCloser(fn: () => void): void {
  closeSheetImpl = fn;
}

function closeSheet(): void {
  closeSheetImpl();
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Assets are served from the base path, which is not "/" on GitHub Pages. */
function flagUrl(tag: string): string {
  return `${import.meta.env.BASE_URL}assets/flags/${tag}.svg`;
}

function iconUrl(name: string): string {
  return `${import.meta.env.BASE_URL}assets/icons/${name}.svg`;
}

/** One decimal, without a trailing .0 -- resource flows are fractional. */
function round1(n: number): string {
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function formatNumber(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

const EQUIPMENT_LABEL = EQUIPMENT_NAME;
const RESOURCE_LABEL = RESOURCE;

const BUILDABLE: BuildingType[] = [
  'civilian_factory', 'military_factory', 'dockyard', 'infrastructure', 'fort',
];

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

/** Factory blocks past this many collapse into a count. */
const FACTORY_BLOCK_CAP = 24;

/**
 * The assigned factories, drawn as blocks.
 *
 * The reference gives every production line a little field of them, and it is
 * the one part of that panel that is read without being read: two lines
 * side by side say which is the bigger effort before either number is
 * looked at. A bare integer does not do that.
 */
function factoryBlocks(n: number): HTMLElement {
  const box = el('div', 'panel-blocks');
  const shown = Math.min(n, FACTORY_BLOCK_CAP);
  for (let i = 0; i < shown; i++) box.append(el('i', 'panel-block'));
  if (n > FACTORY_BLOCK_CAP) box.append(el('span', 'panel-blocks-more', `+${n - FACTORY_BLOCK_CAP}`));
  if (n === 0) box.append(el('span', 'panel-blocks-more', UI.noFactories));
  return box;
}

/**
 * Production, laid out the way the real panel lays it out.
 *
 * One row per line, and each row carries the silhouette of what is being
 * built, its output a day, an efficiency bar, the depot against what the army
 * is short of, and a field of blocks for the factories on it. This was a name
 * and a plus and minus, with everything else crushed into one grey subtitle
 * that changed every frame -- which is a status line, not a panel a decision
 * gets made in.
 */
export const productionPanel: Panel = {
  id: 'production',
  title: UI.navProduction,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const assigned = me.productionLines.reduce((s2, l) => s2 + l.assignedFactories, 0);

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.militaryFactories, `${assigned}/${me.economy.militaryFactories}`),
      stat(UI.dockyards, String(me.economy.dockyards)),
      stat(UI.lines, String(me.productionLines.length)),
      stat(UI.armyExperience, String(Math.floor(me.armyExperience ?? 0))),
    );
    root.append(head);

    const list = el('div', 'panel-list');
    list.dataset.role = 'lines';
    root.append(list);

    const shortfall = equipmentShortfall(state, me.id);

    for (let i = 0; i < me.productionLines.length; i++) {
      const line = me.productionLines[i];
      const row = el('div', 'panel-line');
      row.dataset.line = String(line.id);

      // --- header: rank, name, priority, and the way off the line ----------
      const top = el('div', 'panel-line-top');
      top.append(el('span', 'panel-line-rank', String(i + 1)));
      top.append(el('span', 'panel-line-name', EQUIPMENT_LABEL[line.equipment]));

      const prio = el('button', 'panel-btn prio');
      const paintPrio = (): void => {
        setText(prio, UI.priorityNames[line.priority]);
        prio.classList.toggle('is-high', line.priority >= 2);
        prio.setAttribute(
          'aria-label',
          `${EQUIPMENT_LABEL[line.equipment]}: ${UI.priority} ${UI.priorityNames[line.priority]}`,
        );
      };
      paintPrio();
      // Priority decides which line gets scarce steel and tungsten first. It
      // was a four-step mechanic with no control anywhere: measured over a
      // campaign, 316,806 line-days carried one distinct value, so the
      // allocator's priority sort degenerated to a sort by line id.
      prio.addEventListener('click', () => {
        const next = ((line.priority + 1) % 4) as 0 | 1 | 2 | 3;
        game.issue({ t: 'setLinePriority', country: me.id, line: line.id, priority: next });
        line.priority = next;
        paintPrio();
      });
      top.append(prio);

      // The command has existed since the command bus was written and nothing
      // has ever sent it: a line, once opened, could only be starved to zero
      // factories and left sitting in the list.
      const drop = el('button', 'panel-btn danger');
      drop.textContent = '×';
      drop.setAttribute('aria-label', `${EQUIPMENT_LABEL[line.equipment]}: ${UI.closeLine}`);
      drop.addEventListener('click', () => {
        game.issue({ t: 'removeProductionLine', country: me.id, line: line.id });
        productionPanel.build(game, root);
      });
      top.append(drop);
      row.append(top);

      // The way to the mark. On the row rather than in a menu because the row
      // is where a player is already looking at what this line produces.
      const upgrade = el('button', 'panel-btn', UI.variantOpen);
      upgrade.setAttribute('aria-label', `${EQUIPMENT_LABEL[line.equipment]}: ${UI.variantTitle}`);
      upgrade.addEventListener('click', () => {
        openVariant = line.equipment;
        game.openPanel?.('variant');
      });
      top.insertBefore(upgrade, prio);

      // --- body: silhouette, figures, blocks -------------------------------
      const body = el('div', 'panel-line-body');

      const art = el('div', 'panel-line-art');
      const icon = el('img', 'panel-line-icon');
      icon.alt = '';
      icon.src = iconUrl(`equipment-${line.equipment}`);
      icon.addEventListener('error', () => { icon.removeAttribute('src'); });
      art.append(icon);
      body.append(art);

      const figures = el('div', 'panel-line-figures');

      const rate = el('div', 'panel-line-rate');
      rate.dataset.role = 'rate';
      figures.append(rate);

      const bar = el('div', 'panel-bar');
      const fill = el('i', 'panel-bar-fill');
      fill.dataset.role = 'eff';
      bar.append(fill);
      const effRow = el('div', 'panel-line-eff');
      effRow.append(bar, el('span', 'panel-line-effv', ''));
      figures.append(effRow);

      figures.append(el('div', 'panel-line-stock'));
      body.append(figures);
      row.append(body);

      // --- factories --------------------------------------------------------
      const foot = el('div', 'panel-line-foot');
      const blocks = factoryBlocks(line.assignedFactories);
      foot.append(blocks);
      const controls = el('div', 'panel-row-controls');
      const minus = el('button', 'panel-btn', '−');
      const count = el('span', 'panel-count', String(line.assignedFactories));
      const plus = el('button', 'panel-btn', '+');
      minus.setAttribute('aria-label', `${EQUIPMENT_LABEL[line.equipment]}: ${UI.removeFactory}`);
      plus.setAttribute('aria-label', `${EQUIPMENT_LABEL[line.equipment]}: ${UI.addFactory}`);
      // The blocks and the count are repainted where they stand rather than by
      // rebuilding the panel. Rebuilding scrolls a list of ten lines back to
      // the top under the finger that is still pressing the plus button.
      const repaint = (): void => {
        setText(count, String(line.assignedFactories));
        blocks.replaceChildren(...factoryBlocks(line.assignedFactories).childNodes);
      };
      minus.addEventListener('click', () => {
        game.issue({
          t: 'setLineFactories', country: me.id, line: line.id,
          factories: Math.max(0, line.assignedFactories - 1),
        });
        repaint();
      });
      plus.addEventListener('click', () => {
        game.issue({
          t: 'setLineFactories', country: me.id, line: line.id,
          factories: line.assignedFactories + 1,
        });
        repaint();
      });
      controls.append(minus, count, plus);
      foot.append(controls);
      row.append(foot);

      list.append(row);
    }

    if (me.productionLines.length === 0) {
      list.append(el('div', 'panel-empty', UI.noProductionLines));
    }

    // Without this the player is stuck with whatever lines the scenario dealt
    // them: a template needing equipment nobody is building can never be
    // recruited, and there was no way to start building it.
    root.append(el('div', 'panel-label', UI.addLine));
    const add = el('div', 'panel-grid');
    for (const eq of EQUIPMENT_TYPES) {
      if (me.productionLines.some((l) => l.equipment === eq)) continue;
      const b = el('button', 'panel-build');
      const badge = el('img', 'panel-build-icon');
      badge.alt = '';
      badge.src = iconUrl(`equipment-${eq}`);
      badge.addEventListener('error', () => { badge.removeAttribute('src'); });
      b.append(badge, el('span', 'panel-build-title', EQUIPMENT_LABEL[eq]));
      // A type the army is already short of is the one worth opening.
      if ((shortfall[eq] ?? 0) > 0) b.classList.add('is-wanted');
      b.addEventListener('click', () => {
        game.issue({ t: 'addProductionLine', country: me.id, equipment: eq });
        productionPanel.build(game, root);
      });
      add.append(b);
    }
    if (add.children.length === 0) add.append(el('div', 'panel-empty', UI.allLinesOpen));
    root.append(add);

    productionPanel.refresh?.(game, root);
  },
  refresh(game, root) {
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const list = root.querySelector<HTMLElement>('[data-role="lines"]');
    if (!list) return;
    const shortfall = equipmentShortfall(state, me.id);
    for (const line of me.productionLines) {
      const row = list.querySelector<HTMLElement>(`[data-line="${line.id}"]`);
      if (!row) continue;
      const perDay = line.assignedFactories * FACTORY_OUTPUT * line.efficiency
        / EQUIPMENT[line.equipment].cost;
      const rate = row.querySelector<HTMLElement>('[data-role="rate"]');
      if (rate) setText(rate, `${perDay.toFixed(1)}${UI.perDay}`);

      const eff = row.querySelector<HTMLElement>('[data-role="eff"]');
      if (eff) {
        const pct = Math.min(100, line.efficiency * 100);
        if (eff.style.width !== `${pct.toFixed(1)}%`) eff.style.width = `${pct.toFixed(1)}%`;
      }
      const effv = row.querySelector<HTMLElement>('.panel-line-effv');
      if (effv) setText(effv, `${Math.round(line.efficiency * 100)}%`);

      const stock = row.querySelector<HTMLElement>('.panel-line-stock');
      if (stock) {
        const short = Math.round(shortfall[line.equipment] ?? 0);
        setText(stock, short > 0
          ? UI.stockShort(
            formatNumber(Math.round(me.economy.stockpile[line.equipment])), formatNumber(short))
          : UI.stockHeld(formatNumber(Math.round(me.economy.stockpile[line.equipment]))));
        stock.classList.toggle('is-short', short > 0);
      }
    }
  },
};

/** Which equipment the variant sheet is showing. */
let openVariant: EquipmentType = 'infantry_equipment';

/** Opens the variant sheet on a particular type. */
export function editVariant(eq: EquipmentType): void {
  openVariant = eq;
}

const MODULE_LABEL: Record<VariantModule, string> = {
  armor: UI.moduleArmor,
  gun: UI.moduleGun,
  reliability: UI.moduleReliability,
  engine: UI.moduleEngine,
};

/**
 * One stat line with what the mark has done to it.
 *
 * `lowerIsBetter` is not a nicety. Two of these seven rows are supply
 * consumption and production cost, and on both of them the number going down
 * is the good news; colouring by the sign of the change alone would paint a
 * reliability upgrade red and a cost increase green.
 */
function variantStat(
  label: string, base: number, now: number, digits: number, lowerIsBetter = false,
): HTMLElement | null {
  // A rifle has no armour and never will: a row reading 装甲 0.0 says the
  // design space has something in it that it does not.
  if (base === 0 && now === 0) return null;
  const row = el('div', 'panel-statline');
  row.append(el('span', 'panel-statline-k', label));
  row.append(el('span', 'panel-statline-v', now.toFixed(digits)));
  const change = now - base;
  if (Math.abs(change) > 0.0005) {
    const arrow = change > 0 ? '▲' : '▼';
    const mark = el('span', 'panel-delta', `${arrow}${Math.abs(change).toFixed(digits)}`);
    const better = lowerIsBetter ? change < 0 : change > 0;
    mark.classList.add(better ? 'is-up' : 'is-down');
    row.append(mark);
  }
  return row;
}

/**
 * The variant sheet: what this country's factories have been told to build.
 *
 * The reference's Create Variant window, with its four steppers, its
 * silhouette and its readout of what each change costs. The numbers shown are
 * the equipment's own rather than a division's, as the reference shows them:
 * a mark is a decision about a machine, and it is the same machine whichever
 * formation ends up holding it.
 */
export const variantPanel: Panel = {
  id: 'variant',
  title: UI.variantTitle,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const eq = openVariant;
    const rebuild = (): void => { variantPanel.build(game, root); };

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.armyExperience, String(Math.floor(me.armyExperience ?? 0))),
      stat(UI.variantMark, String(variantMark(me, eq))),
      stat(UI.statCost, variantStats(me, eq).cost.toFixed(1)),
    );
    root.append(head);

    const title = el('div', 'panel-line-top');
    const art = el('div', 'panel-line-art');
    const icon = el('img', 'panel-line-icon');
    icon.alt = '';
    icon.src = iconUrl(`equipment-${eq}`);
    icon.addEventListener('error', () => { icon.removeAttribute('src'); });
    art.append(icon);
    title.append(art, el('span', 'panel-line-name', EQUIPMENT_LABEL[eq]));
    root.append(title);

    // Experience is only earned in combat, so at peace this whole sheet is
    // read-only. Saying so once is better than four disabled buttons.
    if ((me.armyExperience ?? 0) < VARIANT_LEVEL_XP) {
      root.append(el('div', 'panel-note', UI.variantNoExperience(VARIANT_LEVEL_XP)));
    }

    for (const module of VARIANT_MODULES[eq]) {
      const level = variantOf(me, eq)[module];
      const row = el('div', 'panel-row');
      const main = el('div', 'panel-row-main');
      main.append(el('div', 'panel-row-title', MODULE_LABEL[module]));
      main.append(el('div', 'panel-row-sub', UI.variantLevel(level, MAX_VARIANT_LEVEL)));
      const controls = el('div', 'panel-row-controls');
      const minus = el('button', 'panel-btn', '−');
      minus.disabled = !canUpgrade(me, eq, module, -1);
      minus.setAttribute('aria-label', `${MODULE_LABEL[module]} −`);
      minus.addEventListener('click', () => {
        game.issue({ t: 'upgradeVariant', country: me.id, equipment: eq, module, step: -1 });
        rebuild();
      });
      const count = el('span', 'panel-count', String(level));
      const plus = el('button', 'panel-btn', '+');
      plus.disabled = !canUpgrade(me, eq, module, 1);
      plus.setAttribute('aria-label', `${MODULE_LABEL[module]} +`);
      plus.addEventListener('click', () => {
        game.issue({ t: 'upgradeVariant', country: me.id, equipment: eq, module, step: 1 });
        rebuild();
      });
      controls.append(minus, count, plus);
      row.append(main, controls);
      root.append(row);
    }

    const now = variantStats(me, eq);
    const base = baseStats(eq);
    const table = el('div', 'panel-statcol');
    table.append(el('div', 'panel-statcol-h', UI.statsCombat));
    const rows = [
      variantStat(UI.statSoftAttack, base.softAttack, now.softAttack, 1),
      variantStat(UI.statHardAttack, base.hardAttack, now.hardAttack, 1),
      variantStat(UI.statArmor, base.armor, now.armor, 1),
      variantStat(UI.statPiercing, base.piercing, now.piercing, 1),
      variantStat(UI.statSpeed, base.maxSpeedKmh, now.maxSpeedKmh, 1),
      variantStat(UI.statSupply, base.supplyUse, now.supplyUse, 3, true),
      variantStat(UI.statCost, base.cost, now.cost, 1, true),
    ].filter((r): r is HTMLElement => r !== null);
    table.append(...rows);
    root.append(table);

    const back = el('button', 'panel-btn wide', UI.back);
    back.addEventListener('click', () => game.openPanel?.('production'));
    root.append(back);
  },
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Construction, in the order the real game does it: choose what to build, then
 * choose where.
 *
 * This used to run the other way round -- select a province on the map, and the
 * panel offered whatever that province's state could take. That put a map
 * hunt in front of every build order and hid the decision that actually
 * matters, which is where the empire has slots free.
 */
let buildKind: BuildingType = 'civilian_factory';

export const constructionPanel: Panel = {
  id: 'construction',
  title: UI.navConstruction,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.civilianFactories, String(me.economy.civilianFactories)),
      stat(UI.free, String(me.economy.freeCivilianFactories)),
      stat(UI.consumerGoods, `${Math.round(me.economy.consumerGoodsRatio * 100)}%`),
    );
    root.append(head);

    // --- what to build ---
    root.append(el('div', 'panel-label', UI.chooseBuilding));
    const kinds = el('div', 'panel-chips');
    for (const kind of BUILDABLE) {
      const b = el('button', 'panel-chip', BUILDING[kind]);
      b.dataset.kind = kind;
      b.classList.toggle('is-on', kind === buildKind);
      b.addEventListener('click', () => {
        buildKind = kind;
        constructionPanel.build(game, root);
      });
      kinds.append(b);
    }
    root.append(kinds);
    root.append(el('div', 'panel-note',
      `${BUILDING[buildKind]} · ${UI.cost} ${formatNumber(BUILDING_COST[buildKind])}`));

    // --- where ---
    root.append(el('div', 'panel-label', UI.chooseState));
    const list = el('div', 'panel-list');
    const owned = state.states
      .map((st, id) => ({ st, id }))
      .filter((x) => x.st && x.st.controller === me.id)
      .sort((a, b) => slotsFree(b.st) - slotsFree(a.st));

    if (owned.length === 0) {
      list.append(el('div', 'panel-empty', UI.noStates));
    }
    for (const { st, id } of owned) {
      const row = el('button', 'panel-row wide-row');
      const allowed = canQueueBuilding(state, me, id, buildKind);
      row.disabled = !allowed;
      row.classList.toggle('is-blocked', !allowed);

      const main = el('div', 'panel-row-main');
      const name = game.index.data.states[id]?.name ?? `#${id}`;
      main.append(
        el('div', 'panel-row-title', name),
        el('div', 'panel-row-sub',
          `${UI.buildSlots} ${slotsUsed(st)}/${st.buildingSlots}` +
          ` · ${UI.infrastructure} ${st.infrastructure}` +
          ` · ${BUILDING[buildKind]} ${levelOf(st, buildKind)}`),
      );
      row.append(main, el('span', 'panel-row-tag', allowed ? '＋' : UI.noSlots));
      row.addEventListener('click', () => {
        game.issue({ t: 'queueConstruction', country: me.id, kind: buildKind, state: id });
        constructionPanel.build(game, root);
      });
      list.append(row);
    }
    root.append(list);

    // --- what is already under way ---
    const queue = el('div', 'panel-list');
    queue.dataset.role = 'queue';
    root.append(el('div', 'panel-label', UI.queue), queue);
    renderQueue(game, queue);
  },
  refresh(game, root) {
    const queue = root.querySelector<HTMLElement>('[data-role="queue"]');
    if (queue) renderQueue(game, queue);
  },
};

function levelOf(st: StateRuntime, kind: BuildingType): number {
  switch (kind) {
    case 'civilian_factory': return st.civilianFactories;
    case 'military_factory': return st.militaryFactories;
    case 'dockyard': return st.dockyards;
    case 'infrastructure': return st.infrastructure;
    default: return 0;
  }
}

/** Factory slots a state has spent; infrastructure and forts do not use them. */
function slotsUsed(st: StateRuntime): number {
  return st.civilianFactories + st.militaryFactories + st.dockyards;
}

function slotsFree(st: StateRuntime): number {
  return st.buildingSlots - slotsUsed(st);
}

/**
 * The queue, in the order the factories work down it.
 *
 * Position in this list is the only lever the player has over what gets built
 * first, and until now there was no way to pull one -- `reorderConstruction`
 * had existed in the command bus since the beginning with nothing anywhere
 * that could send it. So a project queued behind four others waited for all
 * four, and the panel did not even say that was what was happening: every row
 * carried the same progress bar whether it was being built or not.
 */
function renderQueue(game: Game, host: HTMLElement): void {
  const state = game.state;
  const me = state.countries[state.meta.playerCountry];
  const items = me.constructionQueue;
  // Rebuilt on any change of order, not only of length: a reorder leaves the
  // count alone, and a list that reorders itself without redrawing is a list
  // that lies.
  const order = items.map((i) => i.id).join(',');
  if (host.dataset.order !== order) {
    host.dataset.order = order;
    host.innerHTML = '';
    if (items.length === 0) {
      host.append(el('div', 'panel-empty', UI.nothingUnderConstruction));
      return;
    }
    items.forEach((item, index) => {
      const row = el('div', 'panel-row');
      row.dataset.item = String(item.id);
      const main = el('div', 'panel-row-main');
      const stateName = game.index.data.states[item.stateId]?.name ?? '';
      main.append(
        el('div', 'panel-row-title', `${BUILDING[item.kind]} — ${stateName}`),
        el('div', 'panel-row-sub', ''),
      );
      const bar = el('div', 'panel-bar');
      bar.append(el('i', 'panel-bar-fill'));
      main.append(bar);

      const controls = el('div', 'panel-row-controls');
      const up = el('button', 'panel-btn', '▲');
      up.disabled = index === 0;
      up.setAttribute('aria-label', `${BUILDING[item.kind]}を優先する`);
      up.addEventListener('click', () => {
        game.issue({
          t: 'reorderConstruction', country: me.id, item: item.id, toIndex: index - 1,
        });
        renderQueue(game, host);
      });
      const cancel = el('button', 'panel-btn', '×');
      cancel.setAttribute('aria-label', '建設を中止');
      cancel.addEventListener('click', () => {
        game.issue({ t: 'cancelConstruction', country: me.id, item: item.id });
        renderQueue(game, host);
      });
      controls.append(up, cancel);
      row.append(main, controls);
      host.append(row);
    });
  }
  const allocation = constructionAllocation(state, me);
  for (const item of items) {
    const row = host.querySelector<HTMLElement>(`[data-item="${item.id}"]`);
    if (!row) continue;
    const pct = Math.min(1, item.progress / item.cost);
    const fill = row.querySelector<HTMLElement>('.panel-bar-fill');
    if (fill) fill.style.width = `${(pct * 100).toFixed(1)}%`;
    const sub = row.querySelector<HTMLElement>('.panel-row-sub');
    const factories = allocation.get(item.id) ?? 0;
    if (sub) {
      setText(sub, `${Math.round(pct * 100)}% ${UI.complete} · `
        + (factories > 0 ? `${UI.civFactories} ${factories}` : UI.queueWaiting));
    }
    // A row nothing is working on says so by going quiet, which is what makes
    // the arrow beside it worth pressing.
    row.classList.toggle('is-idle', factories === 0);
  }
}

// ---------------------------------------------------------------------------
// Recruit and deploy
// ---------------------------------------------------------------------------

/** State new divisions are sent to; -1 until the panel picks the capital. */
let deployState = -1;

/** A province inside the chosen deployment state that the player controls. */
function deployProvince(game: Game, owner: number): number {
  const inState = game.index.data.states[deployState]?.provinces ?? [];
  for (const id of inState) {
    if (game.state.provinces[id]?.controller === owner) return id;
  }
  return game.state.countries[owner].capital;
}

export const armyPanel: Panel = {
  id: 'army',
  title: UI.recruitAndDeploy,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];

    const head = el('div', 'panel-head');
    head.dataset.role = 'army-head';
    root.append(head);

    // Where new divisions appear. The real game lets you pick; sending every
    // formation to the capital and marching it out is the thing this replaces.
    root.append(el('div', 'panel-label', UI.deployTo));
    const deploy = el('div', 'panel-chips');
    const homeStates = state.states
      .map((st, id) => ({ st, id }))
      .filter((x) => x.st && x.st.controller === me.id)
      .slice(0, 8);
    if (deployState === -1 || state.states[deployState]?.controller !== me.id) {
      deployState = game.index.get(me.capital).stateId;
    }
    for (const { id } of homeStates) {
      const chip = el('button', 'panel-chip', game.index.data.states[id]?.name ?? `#${id}`);
      chip.classList.toggle('is-on', id === deployState);
      chip.addEventListener('click', () => {
        deployState = id;
        armyPanel.build(game, root);
      });
      deploy.append(chip);
    }
    root.append(deploy);
    root.append(el('div', 'panel-note', UI.deployHint));

    root.append(el('div', 'panel-label', UI.recruit));
    const grid = el('div', 'panel-grid');
    grid.dataset.role = 'templates';
    for (const tpl of me.templates) {
      const b = el('button', 'panel-build');
      b.dataset.tpl = String(tpl.id);
      b.append(
        el('span', 'panel-build-title', tpl.name),
        el('span', 'panel-build-sub',
          `${tally(tpl.battalions.map((x) => BATTALION[x]))}` +
          (tpl.supports.length > 0
            ? `\n${tpl.supports.map((x) => SUPPORT[x]).join('・')}`
            : '') +
          `\n${formatNumber(tpl.manpowerNeed)}名`),
        // Refreshed every tick with the equipment that is holding this template
        // back. A recruit button that silently does nothing is the worst
        // possible answer to "why can I not build an army".
        el('span', 'panel-build-note', ''),
      );
      b.addEventListener('click', () => {
        game.issue({
          t: 'recruitDivision', country: me.id, template: tpl.id,
          province: deployProvince(game, me.id),
        });
      });
      const edit = el('button', 'panel-edit', UI.edit);
      edit.setAttribute('aria-label', `${tpl.name}: ${UI.designer}`);
      edit.addEventListener('click', (e) => {
        // The recruit button fills the tile, so the edit affordance sits on top
        // of it and has to stop the tile firing underneath.
        e.stopPropagation();
        editTemplate(tpl);
        game.openPanel?.('designer');
      });
      b.append(edit);
      grid.append(b);
    }
    const fresh = el('button', 'panel-btn wide', `+ ${UI.newTemplate}`);
    fresh.addEventListener('click', () => {
      editTemplate(deriveTemplate(-1, '', ['infantry', 'infantry', 'infantry'], ['engineer']));
      game.openPanel?.('designer');
    });
    root.append(grid, fresh);

    root.append(el('div', 'panel-label', UI.stockpile));
    const stock = el('div', 'panel-list');
    stock.dataset.role = 'stock';
    root.append(stock);
    for (const eq of EQUIPMENT_TYPES) {
      const row = el('div', 'panel-kv');
      row.dataset.eq = eq;
      row.append(el('span', 'panel-k', EQUIPMENT_LABEL[eq]), el('span', 'panel-v', '0'));
      stock.append(row);
    }
  },
  refresh(game, root) {
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];

    const templates = root.querySelector<HTMLElement>('[data-role="templates"]');
    if (templates) {
      for (const tpl of me.templates) {
        const b = templates.querySelector<HTMLButtonElement>(`[data-tpl="${tpl.id}"]`);
        const note = b?.querySelector<HTMLElement>('.panel-build-note');
        if (!b || !note) continue;
        // Mirrors the gate in the simulation: half the equipment, and the
        // manpower, or the order is refused.
        let worst = 1;
        let worstEq: EquipmentType | null = null;
        for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [EquipmentType, number][]) {
          const r = (me.economy.stockpile[eq] ?? 0) / Math.max(1, need);
          if (r < worst) { worst = r; worstEq = eq; }
        }
        const noManpower = me.economy.manpower < tpl.manpowerNeed / 1000;
        const blocked = noManpower || worst < 0.5;
        b.disabled = blocked;
        b.classList.toggle('is-blocked', blocked);
        setText(note, noManpower
          ? `${UI.manpower}${UI.shortage}`
          : worst < 0.5 && worstEq
            ? `${EQUIPMENT_LABEL[worstEq]} ${Math.round(worst * 100)}%`
            : UI.ready);
      }
    }

    const head = root.querySelector<HTMLElement>('[data-role="army-head"]');
    if (head) {
      let inCombat = 0;
      let lowSupply = 0;
      for (const d of state.divisions) {
        if (d.dead || d.owner !== me.id) continue;
        if (d.combatId !== null) inCombat++;
        if (d.supplyLevel < 0.4) lowSupply++;
      }
      if (head.childElementCount !== 4) {
        head.innerHTML = '';
        head.append(stat(UI.totalDivisions, '0'), stat(UI.inCombat, '0'),
          stat(UI.outOfSupply, '0'), stat(UI.manpower, '0'));
      }
      const values = head.querySelectorAll<HTMLElement>('.hud-stat-v');
      setText(values[0], String(me.stats.divisionCount));
      setText(values[1], String(inCombat));
      setText(values[2], String(lowSupply));
      setText(values[3], formatNumber(me.economy.manpower * 1000));
    }
    const stock = root.querySelector<HTMLElement>('[data-role="stock"]');
    if (!stock) return;
    for (const eq of EQUIPMENT_TYPES) {
      const row = stock.querySelector<HTMLElement>(`[data-eq="${eq}"] .panel-v`);
      if (row) setText(row, formatNumber(me.economy.stockpile[eq]));
    }
  },
};

// ---------------------------------------------------------------------------
// Diplomacy
// ---------------------------------------------------------------------------

/** The country whose relations sheet is open. */
let openNation: CountryId = 0;

/** The HUD titles the nation sheet with the country it is showing. */
export function openNationId(): CountryId {
  return openNation;
}

/**
 * One diplomatic action, as a row.
 *
 * `block` is the reason the action cannot be taken, shown where an available
 * action shows its price. A greyed control that will not say what is wrong
 * with it is the worst of both -- and every one of these reasons is something
 * the player can do something about, which is the entire point of having the
 * relations sheet at all.
 */
function diploAction(
  label: string, cost: number, block: string | null, onTap: () => void,
): HTMLElement {
  const row = el('button', 'panel-row wide-row');
  row.disabled = block !== null;
  row.classList.toggle('is-blocked', block !== null);
  const main = el('div', 'panel-row-main');
  main.append(el('div', 'panel-row-title', label));
  // Declaring war is the one action with no price, and an empty subtitle is a
  // blank line rather than a missing one.
  if (cost > 0) main.append(el('div', 'panel-row-sub', UI.powerCost(cost)));
  row.append(main, el('span', 'panel-row-tag', block ?? '›'));
  row.addEventListener('click', onTap);
  return row;
}

/**
 * Why an invitation is refused, in words.
 *
 * `opinion` is missing on purpose and the type says so: that one reason has a
 * number in it, so it is built at the call site, and leaving it out here means
 * the compiler catches anyone who drops the special case rather than the
 * player finding a blank tag where the reason should be.
 */
const INVITE_REASON: Record<Exclude<InviteBlock, 'opinion'>, string> = {
  gone: '降伏',
  notLeader: UI.blockNotLeader,
  alreadyIn: UI.blockAlreadyIn,
  otherFaction: UI.blockOtherFaction,
  targetAtWar: UI.blockTargetAtWar,
  power: UI.blockPower,
};

/** The relation words a country's row and its sheet both carry. */
function relationParts(game: Game, c: Country): string[] {
  const state = game.state;
  const me = state.countries[state.meta.playerCountry];
  const parts: string[] = [IDEOLOGY[c.ideology]];
  if (c.capitulated) parts.push('降伏');
  else if (me.atWarWith.includes(c.id)) parts.push('交戦中');
  else if (c.factionId !== null && c.factionId === me.factionId) parts.push('同盟');
  if (me.diplomacy.guarantees.includes(c.id)) parts.push(UI.guarantees);
  const just = me.diplomacy.justifications.find((j) => j.target === c.id);
  if (just) {
    parts.push(just.progress >= just.required
      ? '開戦事由 準備完了'
      : `${UI.justifying} ${Math.round((just.progress / just.required) * 100)}%`);
  }
  return parts;
}

export const diplomacyPanel: Panel = {
  id: 'diplomacy',
  title: UI.navDiplomacy,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const rebuild = (): void => { diplomacyPanel.build(game, root); };

    const head = el('div', 'panel-head');
    head.dataset.role = 'dip-head';
    head.append(
      stat(UI.worldTension, '0%'),
      stat(UI.politicalPower, '0'),
      stat(UI.faction, me.factionId !== null ? state.factions[me.factionId].name : UI.atPeace),
    );
    root.append(head);

    // --- the bloc ------------------------------------------------------------
    // Membership was a word in the header and nothing else: a player could see
    // that Germany led the Axis and could neither see who was in it nor do
    // anything about it.
    root.append(el('div', 'panel-label', UI.faction));
    if (me.factionId !== null) {
      const faction = state.factions[me.factionId];
      const members = el('div', 'panel-chips');
      for (const id of faction.members) {
        const chip = el('span', 'panel-chip');
        if (faction.leader === id) chip.classList.add('is-on');
        chip.textContent = country(state.countries[id].tag);
        members.append(chip);
      }
      root.append(members);
      const leave = el('button', 'panel-btn wide danger', UI.leaveFaction);
      leave.disabled = !canLeaveFaction(state, me.id);
      leave.addEventListener('click', () => {
        game.issue({ t: 'leaveFaction', country: me.id });
        rebuild();
      });
      root.append(leave);
      if (!canLeaveFaction(state, me.id)) {
        root.append(el('div', 'panel-note', UI.leaderCannotLeave));
      }
    } else {
      const joinable = joinableFactions(state, me.id);
      if (joinable.length === 0) {
        root.append(el('div', 'panel-empty', UI.noFactionActions));
      }
      for (const id of joinable) {
        const row = diploAction(`${UI.joinFaction} — ${state.factions[id].name}`, 0, null, () => {
          game.issue({ t: 'joinFaction', country: me.id, faction: id });
          rebuild();
        });
        root.append(row);
      }
    }

    root.append(el('div', 'panel-label', '国家'));
    const list = el('div', 'panel-list');
    list.dataset.role = 'nations';
    root.append(list);

    // Neighbours and great powers first: those are the ones worth acting on.
    const ordered = state.countries
      .filter((c) => c.id !== me.id)
      .sort((a, b) => Number(b.major) - Number(a.major)
        || b.stats.victoryPoints - a.stats.victoryPoints);

    for (const c of ordered) {
      // The row is the way in to everything that can be done to this country,
      // rather than carrying two of six actions itself. Six buttons do not fit
      // beside a name on a 360px phone, which is why four of them did not
      // exist -- and the two that did were both ways of starting a war.
      const row = el('button', 'panel-row wide-row');
      row.dataset.country = String(c.id);

      // A framed flag, as HOI4 puts on every country row. Thirty flags ship
      // with the game and exactly one of them was being used -- the player's
      // own, in the top bar -- while this list identified twenty-nine nations
      // by a 12px square of their map colour.
      const swatch = el('img', 'panel-flag');
      swatch.alt = '';
      swatch.src = flagUrl(c.tag);
      // The map colour is the fallback, so a country without artwork still
      // reads rather than leaving a hole in the row.
      swatch.style.background = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;
      swatch.addEventListener('error', () => { swatch.removeAttribute('src'); });

      // The ideology belongs on the detail line, not welded to the name. On one
      // nowrap line beside three 44px buttons, 27 of 30 rows were clipped at
      // 360px -- worst case 171px of text in a 52px box, cutting
      // チェコスロバキア to チェコス.
      const main = el('div', 'panel-row-main');
      main.append(
        el('div', 'panel-row-title', country(c.tag)),
        el('div', 'panel-row-sub', ''),
      );

      row.append(swatch, main, el('span', 'panel-row-tag', '›'));
      row.addEventListener('click', () => {
        openNation = c.id;
        game.openPanel?.('nation');
      });
      list.append(row);
    }
  },
  refresh(game, root) {
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const head = root.querySelector<HTMLElement>('[data-role="dip-head"]');
    if (head) {
      const values = head.querySelectorAll<HTMLElement>('.hud-stat-v');
      setText(values[0], `${Math.round(state.worldTension)}%`);
      setText(values[1], String(Math.round(me.economy.politicalPower)));
      setText(values[2], me.factionId !== null ? state.factions[me.factionId].name : UI.atPeace);
    }
    const list = root.querySelector<HTMLElement>('[data-role="nations"]');
    if (!list) return;
    for (const c of state.countries) {
      const row = list.querySelector<HTMLElement>(`[data-country="${c.id}"]`);
      if (!row) continue;
      const sub = row.querySelector<HTMLElement>('.panel-row-sub');
      if (!sub) continue;
      const parts = relationParts(game, c);
      // Opinion is on the row because it is the number every remaining action
      // is gated on, and because improving it is now something the player does
      // on purpose rather than a stat that only the AI could read.
      parts.push(`${UI.opinion} ${Math.round(opinionOf(state, c.id, me.id))}`);
      parts.push(`${c.stats.divisionCount}個師団`);
      setText(sub, parts.join(' · '));
      row.classList.toggle('is-hostile', me.atWarWith.includes(c.id));
      row.classList.toggle('is-dead', c.capitulated);
    }
  },
};

/**
 * One country's relations sheet: everything that can be done to it, and the
 * reason for each thing that cannot.
 *
 * Five of the six commands the diplomacy layer has always accepted --
 * improving relations, guaranteeing independence, inviting into a faction,
 * joining one, leaving one -- had nothing that could send them. The panel
 * offered a war goal and a declaration of war, so the only diplomacy the game
 * had was the kind that ends in an invasion.
 */
/**
 * Everything the action rows are drawn from, as one string.
 *
 * Only the flips matter, not the numbers: political power crossing a price,
 * an invitation becoming possible, a war starting. Comparing those means the
 * sheet can be rebuilt exactly when it would otherwise start lying, and never
 * while the player is reading it.
 */
function nationSignature(game: Game): string {
  const state = game.state;
  const me = state.countries[state.meta.playerCountry];
  const c = state.countries[openNation];
  if (!c) return '';
  const pp = me.economy.politicalPower;
  return [
    openNation,
    pp >= IMPROVE_COST, pp >= GUARANTEE_COST, pp >= INVITE_COST,
    pp >= JUSTIFY_COST, pp >= DEMAND_COST,
    inviteBlock(state, me.id, c.id) ?? '-',
    canDemand(state, me.id, c.id),
    atWar(state, me.id, c.id),
    areAllied(state, me.id, c.id),
    c.capitulated,
    me.diplomacy.guarantees.includes(c.id),
    me.diplomacy.justifications.some((j) => j.target === c.id),
  ].join('|');
}

export const nationPanel: Panel = {
  id: 'nation',
  title: UI.navDiplomacy,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const c = state.countries[openNation] ?? state.countries[0];
    const rebuild = (): void => { nationPanel.build(game, root); };

    const head = el('div', 'panel-head');
    head.dataset.role = 'nation-head';
    head.append(
      stat(UI.politicalPower, String(Math.round(me.economy.politicalPower))),
      stat(UI.opinion, String(Math.round(opinionOf(state, c.id, me.id)))),
      stat(UI.victoryPoints, String(c.stats.victoryPointsHeld)),
      stat(UI.faction, c.factionId !== null ? state.factions[c.factionId].name : UI.atPeace),
    );
    root.append(head);

    const card = el('div', 'panel-nation');
    const flag = el('img', 'panel-nation-flag');
    flag.alt = '';
    flag.src = flagUrl(c.tag);
    flag.style.background = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;
    flag.addEventListener('error', () => { flag.removeAttribute('src'); });
    const body = el('div', 'panel-nation-body');
    body.append(
      el('div', 'panel-nation-name', country(c.tag)),
      el('div', 'panel-row-sub', relationParts(game, c).join(' · ')),
      el('div', 'panel-row-sub',
        `${c.stats.divisionCount}個師団 · ${UI.civFactories} ${c.economy.civilianFactories}`
        + ` · ${UI.milFactories} ${c.economy.militaryFactories}`),
    );
    card.append(flag, body);
    root.append(card);

    root.append(el('div', 'panel-label', UI.diplomaticActions));

    const hostile = atWar(state, me.id, c.id);
    const allied = areAllied(state, me.id, c.id);
    const dead = c.capitulated;
    const poor = (cost: number): string | null =>
      (me.economy.politicalPower < cost ? UI.blockPower : null);
    const reach = dead ? '降伏' : null;

    root.append(diploAction(
      UI.improveRelations, IMPROVE_COST,
      reach ?? (hostile ? UI.blockAtWarWith : null) ?? poor(IMPROVE_COST),
      () => { game.issue({ t: 'improveRelations', country: me.id, target: c.id }); rebuild(); },
    ));

    const guaranteed = me.diplomacy.guarantees.includes(c.id);
    root.append(diploAction(
      UI.guaranteeIndependence, GUARANTEE_COST,
      reach ?? (guaranteed ? UI.alreadyGuaranteed : null)
        ?? (hostile ? UI.blockAtWarWith : null) ?? poor(GUARANTEE_COST),
      () => { game.issue({ t: 'guarantee', country: me.id, target: c.id }); rebuild(); },
    ));

    const invite = inviteBlock(state, me.id, c.id);
    root.append(diploAction(
      UI.inviteToFaction, INVITE_COST,
      invite === null ? null
        : invite === 'opinion'
          ? UI.blockOpinion(Math.round(opinionOf(state, c.id, me.id)), INVITE_OPINION)
          : INVITE_REASON[invite],
      () => { game.issue({ t: 'inviteToFaction', country: me.id, target: c.id }); rebuild(); },
    ));

    const just = me.diplomacy.justifications.find((j) => j.target === c.id);
    root.append(diploAction(
      UI.justifyWar, JUSTIFY_COST,
      reach ?? (just ? UI.alreadyJustifying : null) ?? (hostile ? UI.blockAtWarWith : null)
        ?? (allied ? UI.blockAllied : null) ?? poor(JUSTIFY_COST),
      () => { game.issue({ t: 'justifyWar', country: me.id, target: c.id }); rebuild(); },
    ));

    // An ultimatum has five separate conditions on it, and the panel has to
    // name the one that is actually in the way: "cannot" is not a reason, and
    // the wrong reason is worse than none.
    const demandBlock = canDemand(state, me.id, c.id) ? poor(DEMAND_COST)
      : reach
        ?? (hostile ? UI.blockAtWarWith : null)
        ?? (allied ? UI.blockAllied : null)
        ?? (c.factionId !== null ? UI.blockOtherFaction : null)
        ?? (!me.major || c.major ? UI.blockMajorsOnly : null)
        ?? (c.atWarWith.length > 0 || me.atWarWith.length > 0 ? UI.blockAtWarWith : null)
        ?? UI.blockGuaranteed;
    root.append(diploAction(
      UI.demand, DEMAND_COST, demandBlock,
      () => { game.issue({ t: 'demandSubmission', country: me.id, target: c.id }); rebuild(); },
    ));

    const war = diploAction(
      UI.declareWar, 0,
      reach ?? (hostile ? UI.blockAtWarWith : null) ?? (allied ? UI.blockAllied : null),
      () => { game.issue({ t: 'declareWar', country: me.id, target: c.id }); rebuild(); },
    );
    war.classList.add('is-danger');
    root.append(war);

    const back = el('button', 'panel-btn wide', UI.back);
    back.addEventListener('click', () => game.openPanel?.('diplomacy'));
    root.append(back);
    root.dataset.signature = nationSignature(game);
  },
  refresh(game, root) {
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const c = state.countries[openNation];
    const head = root.querySelector<HTMLElement>('[data-role="nation-head"]');
    if (!head || !c) return;
    const values = head.querySelectorAll<HTMLElement>('.hud-stat-v');
    setText(values[0], String(Math.round(me.economy.politicalPower)));
    setText(values[1], String(Math.round(opinionOf(state, c.id, me.id))));
    setText(values[2], String(c.stats.victoryPointsHeld));

    // Every row's reason can go stale while the sheet is open -- political
    // power accrues past a price, a justification finishes, the country is
    // invaded -- and a sheet that says 政治力不足 over an amount the player now
    // has is worse than one that says nothing. Rebuilt only when one of those
    // actually flips, so the DOM does not churn under a finger.
    const signature = nationSignature(game);
    if (root.dataset.signature !== signature) nationPanel.build(game, root);
  },
};

// ---------------------------------------------------------------------------
// Province
// ---------------------------------------------------------------------------

/**
 * The two tiers, told apart.
 *
 * A province is where a division stands and what it marches through; a state
 * is what holds the factories, the population and the building slots, and
 * several provinces share one. Reading both off a single undifferentiated card
 * meant a player could never tell which tier a number belonged to -- 「今ステ
 * ートしかない」 was about the map, and this is the same complaint about the
 * panel. The switch changes what the card says *and* what the map outlines.
 */
export const provincePanel: Panel = {
  id: 'province',
  title: '州',
  build(game, root) {
    root.innerHTML = '';
    const id = game.selection.province;
    if (id === null) {
      root.append(el('div', 'panel-empty', 'プロヴィンスが選択されていません。'));
      return;
    }
    const state = game.state;
    const geo = game.index.get(id);
    const p = state.provinces[id];
    const stateData = game.index.data.states[geo.stateId];
    const st = state.states[geo.stateId];
    const owner = state.countries[p.owner];
    const controller = state.countries[p.controller];
    const scope = game.selection.scope;
    const rebuild = (): void => provincePanel.build(game, root);

    // --- which tier -------------------------------------------------------
    const tabs = el('div', 'panel-chips');
    // Just the tier. The names went in the labels first and wrapped the pair
    // onto two lines on a 412px screen; the sheet title already says which
    // place is selected.
    for (const [value, label] of [
      ['province', UI.tierProvince],
      ['state', UI.tierState],
    ] as const) {
      const chip = el('button', 'panel-chip', label);
      chip.classList.toggle('is-on', scope === value);
      chip.addEventListener('click', () => {
        game.setSelectionScope(value);
        rebuild();
      });
      tabs.append(chip);
    }
    root.append(tabs);

    if (scope === 'state') {
      const head = el('div', 'panel-head');
      head.append(
        stat(UI.civFactories, String(stateData.civilianFactories)),
        stat(UI.milFactories, String(stateData.militaryFactories)),
        stat(UI.buildSlots, String(stateData.buildingSlots)),
        stat(UI.infrastructure, String(stateData.infrastructure)),
      );
      if (st.owner !== st.controller) {
        head.append(stat(UI.resistance, `${Math.round(st.resistance * 100)}%`));
      }
      root.append(head);

      root.append(el('div', 'panel-sub',
        `${country(state.countries[st.owner].tag)} · ${stateData.provinces.length}${UI.provinceCount}`
        + (st.owner === st.controller
          ? '' : ` · ${country(state.countries[st.controller].tag)}が占領中`)));

      const resources = Object.entries(stateData.resources)
        .filter(([, v]) => (v ?? 0) > 0)
        .map(([k, v]) => `${RESOURCE_LABEL[k as ResourceType]} ${v}`)
        .join('、') || 'なし';
      const grid = el('div', 'panel-kvs');
      for (const [k, v] of [
        [UI.population, formatNumber(stateData.manpower * 1000)],
        [UI.dockyards, String(stateData.dockyards)],
        [UI.resources, resources],
      ] as [string, string][]) {
        const row = el('div', 'panel-kv');
        row.append(el('span', 'panel-k', k), el('span', 'panel-v', v));
        grid.append(row);
      }
      root.append(grid);

      // The provinces as rows, not as a sentence. Eight names joined by 、 in
      // a key/value cell is a wall of text in a 180px column, and the one
      // thing a player wants from that list is to go to one of them.
      root.append(el('div', 'panel-label', UI.provincesHere));
      const members = el('div', 'panel-list');
      for (const q of stateData.provinces) {
        const g2 = game.index.get(q);
        const row = el('button', 'panel-row wide-row');
        row.classList.toggle('is-picked', q === id);
        const main = el('div', 'panel-row-main');
        const held = state.provinces[q];
        main.append(
          el('div', 'panel-row-title', g2.name),
          el('div', 'panel-row-sub',
            `${TERRAIN[g2.terrain]} · ${UI.victoryPoints} ${g2.vp}`
            + (held.divisions.length > 0 ? ` · ${held.divisions.length}${UI.divisionsHere}` : '')),
        );
        row.append(main);
        row.addEventListener('click', () => {
          game.selectProvince(q);
          game.setSelectionScope('province');
          rebuild();
        });
        members.append(row);
      }
      root.append(members);
      return;
    }

    // --- the province -----------------------------------------------------
    const head = el('div', 'panel-head');
    head.dataset.role = 'prov-head';
    head.append(stat(UI.victoryPoints, String(geo.vp)), stat(UI.supplyLevel, '—'),
      stat(UI.totalDivisions, '0'));
    root.append(head);

    const sub = el('div', 'panel-sub');
    sub.textContent = p.owner === p.controller
      ? `${country(owner.tag)} · ${TERRAIN[geo.terrain]} · ${stateData.name}`
      : `${country(owner.tag)}領 / ${country(controller.tag)}が占領中 · ${TERRAIN[geo.terrain]}`;
    root.append(sub);

    const grid = el('div', 'panel-kvs');
    for (const [k, v] of [
      [UI.terrainLabel, TERRAIN[geo.terrain]],
      [UI.fortLevel, String(p.fortLevel)],
      [UI.coastal, geo.coastal ? UI.yes : UI.no],
      ['占領率', `${country(owner.tag)}の${Math.round(occupationRatio(state, p.owner) * 100)}%`],
    ] as [string, string][]) {
      const row = el('div', 'panel-kv');
      row.append(el('span', 'panel-k', k), el('span', 'panel-v', v));
      grid.append(row);
    }
    root.append(grid);

    // --- the garrison, as something you can pick from ---------------------
    const divisions = p.divisions
      .map((d) => state.divisions[d])
      .filter((d) => d && !d.dead);
    if (divisions.length === 0) return;

    const me = state.meta.playerCountry;
    const mine = divisions.filter((d) => d.owner === me);
    root.append(el('div', 'panel-label', UI.garrison));

    if (mine.length > 0) {
      const picked = new Set(game.selection.divisions);
      const tools = el('div', 'panel-chips');
      const all = el('button', 'panel-chip', UI.selectAllHere);
      all.addEventListener('click', () => {
        game.selectDivisions(mine.map((d) => d.id), { centre: false });
        rebuild();
      });
      tools.append(all);
      // Putting a division into a formation is what turns a garrison into an
      // army, so it belongs beside the garrison rather than three panels away.
      for (const army of (state.armies ?? []).filter((a) => a.owner === me && !a.isArmyGroup)) {
        const chip = el('button', 'panel-chip', `${army.name}${UI.assignTo}`);
        chip.disabled = picked.size === 0;
        chip.addEventListener('click', () => {
          game.issue({
            t: 'assignDivisions', country: me, army: army.id,
            divisions: [...game.selection.divisions],
          });
          rebuild();
        });
        tools.append(chip);
      }
      root.append(tools);
    }

    const list = el('div', 'panel-list');
    list.dataset.role = 'garrison';
    for (const d of divisions) {
      const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
      const own = d.owner === me;
      const row = el(own ? 'button' : 'div', 'panel-row');
      row.dataset.div = String(d.id);
      if (own) {
        row.classList.add('wide-row');
        row.classList.toggle('is-picked', game.selection.divisions.includes(d.id));
      }
      const army = d.armyId === null ? null : (state.armies ?? []).find((a) => a.id === d.armyId);
      const main = el('div', 'panel-row-main');
      main.append(
        el('div', 'panel-row-title',
          `${country(state.countries[d.owner].tag)} ${tpl?.name ?? '師団'}`),
        el('div', 'panel-row-sub', own ? (army?.name ?? UI.unassigned) : ''),
      );
      row.append(main);
      if (own) {
        // One division at a time: a stack tap takes the whole province, and
        // splitting one formation off it was impossible from anywhere.
        row.addEventListener('click', () => {
          const now = new Set(game.selection.divisions);
          if (now.has(d.id)) now.delete(d.id);
          else now.add(d.id);
          game.selectDivisions([...now], { centre: false });
          rebuild();
        });
      }
      list.append(row);
    }
    root.append(list);
  },
  refresh(game, root) {
    const id = game.selection.province;
    if (id === null) return;
    const state = game.state;
    const p = state.provinces[id];
    const head = root.querySelector<HTMLElement>('[data-role="prov-head"]');
    if (head) {
      const values = head.querySelectorAll<HTMLElement>('.hud-stat-v');
      const live = p.divisions.filter((d) => state.divisions[d] && !state.divisions[d].dead);
      setText(values[1], `${Math.round(p.supply * 100)}%`);
      setText(values[2], String(live.length));
    }
    const list = root.querySelector<HTMLElement>('[data-role="garrison"]');
    if (!list) return;
    for (const divId of p.divisions) {
      const d = state.divisions[divId];
      if (!d) continue;
      const row = list.querySelector<HTMLElement>(`[data-div="${divId}"] .panel-row-sub`);
      if (!row) continue;
      const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
      const org = tpl ? Math.round((d.org / tpl.maxOrg) * 100) : 0;
      const str = tpl ? Math.round((d.hp / tpl.maxHp) * 100) : 0;
      const parts = [
        `${UI.organisation} ${org}%`,
        `${UI.strength} ${str}%`,
        `${UI.supplyLevel} ${Math.round(d.supplyLevel * 100)}%`,
      ];
      // Only when they apply. A line of zeroes for conditions that are not in
      // force is noise on a phone; a division that has dug in, or one standing
      // in the snow, is worth a word.
      if (d.entrenchment > 0) {
        const bonus = Math.round(d.entrenchment * ENTRENCHMENT_PER_LEVEL * 100);
        parts.push(`${UI.entrenched} +${bonus}%`);
      }
      const cold = winterSeverity(state, game.index, d.provinceId);
      if (cold > 0.15) parts.push(`${UI.winter} ${Math.round(cold * 100)}%`);
      setText(row, parts.join(' · '));
    }
  },
};

/**
 * A collapsible section.
 *
 * The focus panel opened six and a half screens deep, because it listed every
 * focus in the tree as a full card and at the 1936 start all but one of them
 * is locked. What a player needs on opening is what is running and what can be
 * started; the rest is reference, and reference belongs behind a heading you
 * can open. The count is on the heading so the section says how much is inside
 * without being opened.
 *
 * Open state is keyed by section so it survives the rebuild that every command
 * triggers -- collapsing a section and having it spring back open on the next
 * tick would be worse than not collapsing at all.
 */
const sectionOpen = new Map<string, boolean>();

function section(key: string, label: string, count: number, openByDefault: boolean): {
  head: HTMLElement;
  body: HTMLElement;
} {
  const open = sectionOpen.get(key) ?? openByDefault;
  const head = el('button', 'panel-section', '');
  const caret = el('i', 'panel-caret', '');
  head.append(caret, el('span', 'panel-section-l', label), el('span', 'panel-section-n', String(count)));
  const body = el('div', 'panel-list');
  const apply = (v: boolean) => {
    head.classList.toggle('is-open', v);
    body.style.display = v ? '' : 'none';
  };
  apply(open);
  head.addEventListener('click', () => {
    const next = !(sectionOpen.get(key) ?? openByDefault);
    sectionOpen.set(key, next);
    apply(next);
  });
  return { head, body };
}

function stat(label: string, value: string): HTMLElement {
  const box = el('div', 'hud-stat');
  box.append(el('span', 'hud-stat-v', value), el('span', 'hud-stat-l', label.toUpperCase()));
  return box;
}



// ---------------------------------------------------------------------------
// Division designer
// ---------------------------------------------------------------------------

/**
 * Composition of the division being edited.
 *
 * Held outside the panel because `build` runs again on every change: the panel
 * is rebuilt from this, not the other way round, so there is one source of
 * truth for what the player is looking at.
 */
let draft: { name: string; battalions: BattalionType[]; supports: SupportType[] } = {
  name: '', battalions: [], supports: [],
};

/** Loads a template into the draft. Called when the designer is opened. */
export function editTemplate(tpl: DivisionTemplate): void {
  draft = {
    name: tpl.name,
    battalions: [...tpl.battalions],
    supports: [...tpl.supports],
  };
}

/**
 * The silhouette a battalion or support company shows.
 *
 * Its principal equipment, which is what the unit is: a battalion of
 * mountaineers carries the same rifles as the infantry, and a reconnaissance
 * company is the trucks it drives. Taken from the equipment bill rather than
 * invented, so it cannot say one thing while the template needs another.
 */
const BATTALION_ART: Record<BattalionType, EquipmentType> = {
  infantry: 'infantry_equipment',
  mountaineers: 'infantry_equipment',
  motorized: 'motorized',
  artillery: 'artillery',
  light_armor: 'light_armor',
  medium_armor: 'medium_armor',
};

const SUPPORT_ART: Record<SupportType, EquipmentType> = {
  engineer: 'support_equipment',
  logistics: 'support_equipment',
  recon: 'motorized',
  artillery_support: 'artillery',
};

/** Slots the battalion grid draws, whether or not they are filled. */
const GRID_COLS = 4;
const GRID_ROWS = 6;
const SUPPORT_SLOTS = 4;

/** The picker that is open under the grid, or null. */
let slotPicker: 'battalion' | 'support' | null = null;

/**
 * One battalion or support slot.
 *
 * Three states, not the reference's four. HOI4 draws a padlock on slots its
 * special-forces and doctrine rules have not opened yet; nothing in this game
 * gates a battalion type, so a padlock here would be an ornament that says
 * something untrue. What is left is the part that is real: a filled slot shows
 * what is in it and empties when pressed, the next free slot is the plus that
 * opens the picker, and the rest are the empty establishment behind it.
 */
function slot(
  label: string | null, next: boolean, onPick: () => void, icon?: EquipmentType,
): HTMLElement {
  const b = el('button', 'panel-slot');
  if (label !== null) {
    if (icon) {
      const art = el('img', 'panel-slot-icon');
      art.alt = '';
      art.src = iconUrl(`equipment-${icon}`);
      art.addEventListener('error', () => { art.removeAttribute('src'); });
      b.append(art);
    }
    b.append(el('span', 'panel-slot-name', label));
    b.addEventListener('click', onPick);
    return b;
  }
  b.classList.add('is-empty');
  if (!next) {
    // Room the division has and has not used. Inert: pressing the twentieth
    // slot cannot mean anything the ninth does not already mean.
    b.classList.add('is-spare');
    b.disabled = true;
    return b;
  }
  b.textContent = UI.slotEmpty;
  b.addEventListener('click', onPick);
  return b;
}

/** The small silhouette a picker chip carries. */
function chipArt(eq: EquipmentType): HTMLElement {
  const art = el('img', 'panel-chip-icon');
  art.alt = '';
  art.src = iconUrl(`equipment-${eq}`);
  art.addEventListener('error', () => { art.removeAttribute('src'); });
  return art;
}

/** A row of the three-column stat table. */
function statLine(k: string, v: string, short = false): HTMLElement {
  const row = el('div', 'panel-statline');
  row.append(el('span', 'panel-statline-k', k),
    el('span', `panel-statline-v${short ? ' is-short' : ''}`, v));
  return row;
}

/**
 * The division designer, laid out the way the real one is.
 *
 * The reference screenshot puts a grid of battalions on the left and three
 * columns of numbers on the right -- base, combat, cost -- with the terrain
 * adjusters underneath and the estimated production cost along the bottom.
 * This was a list of counters with plus and minus buttons and two rows of
 * chips: it could build the same division, and it could not show you what one
 * was. A phone cannot put the grid beside the table, so they stack; the
 * grouping and the reading order are the reference's.
 */
export const designerPanel: Panel = {
  id: 'designer',
  title: UI.designer,
  build(game, root) {
    root.innerHTML = '';
    const me = game.state.countries[game.state.meta.playerCountry];
    // Stats come from the same function the scenario uses, so what the panel
    // previews is exactly what the simulation will fight with.
    const preview = deriveTemplate(-1, draft.name || UI.newTemplate,
      draft.battalions.length > 0 ? draft.battalions : ['infantry'], draft.supports);

    const rebuild = (): void => {
      designerPanel.build(game, root);
      designerPanel.refresh?.(game, root);
    };

    // --- name ---------------------------------------------------------------
    const nameRow = el('div', 'panel-row');
    const nameInput = el('input', 'panel-input') as HTMLInputElement;
    nameInput.value = draft.name;
    nameInput.placeholder = UI.newTemplate;
    nameInput.maxLength = 24;
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
    nameRow.append(nameInput);
    root.append(nameRow);

    // --- the grid -----------------------------------------------------------
    root.append(el('div', 'panel-label',
      `${UI.battalions} ${draft.battalions.length}/${MAX_BATTALIONS}`
      + ` · ${UI.supportCompanies} ${draft.supports.length}/${MAX_SUPPORTS}`));

    const board = el('div', 'panel-board');

    // Support companies down the left, as they are in the real designer: they
    // are a different kind of thing from a line battalion and the layout says
    // so before any label does.
    const supportCol = el('div', 'panel-board-support');
    for (let i = 0; i < SUPPORT_SLOTS; i++) {
      const held = draft.supports[i];
      supportCol.append(slot(
        held ? SUPPORT[held] : null,
        i === draft.supports.length && draft.supports.length < MAX_SUPPORTS,
        () => {
          if (held) {
            draft.supports = draft.supports.filter((x) => x !== held);
            slotPicker = null;
          } else {
            slotPicker = slotPicker === 'support' ? null : 'support';
          }
          rebuild();
        },
        held ? SUPPORT_ART[held] : undefined,
      ));
    }

    const combat = el('div', 'panel-board-combat');
    const cells = GRID_COLS * GRID_ROWS;
    for (let i = 0; i < cells; i++) {
      const held = draft.battalions[i];
      combat.append(slot(
        held ? BATTALION[held] : null,
        i === draft.battalions.length && draft.battalions.length < MAX_BATTALIONS,
        () => {
          if (held !== undefined) {
            draft.battalions.splice(i, 1);
            slotPicker = null;
          } else {
            slotPicker = slotPicker === 'battalion' ? null : 'battalion';
          }
          rebuild();
        },
        held ? BATTALION_ART[held] : undefined,
      ));
    }
    board.append(supportCol, combat);
    root.append(board);

    // The picker, opened by an empty slot. A phone has no room for a grid and
    // a permanent palette of six types, and the palette is only wanted for the
    // moment after a slot has been pressed.
    if (slotPicker !== null) {
      root.append(el('div', 'panel-label',
        slotPicker === 'battalion' ? UI.pickBattalion : UI.pickSupport));
      const chips = el('div', 'panel-chips');
      if (slotPicker === 'battalion') {
        for (const b of BATTALION_TYPES) {
          const chip = el('button', 'panel-chip');
          chip.append(chipArt(BATTALION_ART[b]), document.createTextNode(BATTALION[b]));
          chip.disabled = draft.battalions.length >= MAX_BATTALIONS;
          chip.addEventListener('click', () => {
            draft.battalions.push(b);
            slotPicker = null;
            rebuild();
          });
          chips.append(chip);
        }
      } else {
        for (const sc of SUPPORT_TYPES) {
          const chip = el('button', 'panel-chip');
          chip.append(chipArt(SUPPORT_ART[sc]), document.createTextNode(SUPPORT[sc]));
          chip.disabled = draft.supports.includes(sc) || draft.supports.length >= MAX_SUPPORTS;
          chip.addEventListener('click', () => {
            draft.supports = [...draft.supports, sc];
            slotPicker = null;
            rebuild();
          });
          chips.append(chip);
        }
      }
      root.append(chips);
    }

    // --- the three columns --------------------------------------------------
    const table = el('div', 'panel-stattable');

    const base = el('div', 'panel-statcol');
    base.append(el('div', 'panel-statcol-h', UI.statsBase));
    base.append(
      statLine(UI.statHp, preview.maxHp.toFixed(1)),
      statLine(UI.statOrg, preview.maxOrg.toFixed(1)),
      statLine(UI.statSpeed, `${preview.speedKmh.toFixed(0)} km/h`),
      statLine(UI.statWeight, String(preview.battalions.length + preview.supports.length)),
      statLine(UI.statSupply, preview.supplyUse.toFixed(2)),
      statLine(UI.statFuel, preview.fuelUse.toFixed(1)),
    );

    const fight = el('div', 'panel-statcol');
    fight.append(el('div', 'panel-statcol-h', UI.statsCombat));
    fight.append(
      statLine(UI.statSoftAttack, preview.softAttack.toFixed(1)),
      statLine(UI.statHardAttack, preview.hardAttack.toFixed(1)),
      statLine(UI.statDefence, preview.defense.toFixed(1)),
      statLine(UI.statBreakthrough, preview.breakthrough.toFixed(1)),
      statLine(UI.statArmor, preview.armor.toFixed(0)),
      statLine(UI.statPiercing, preview.piercing.toFixed(0)),
      statLine(UI.statHardness, `${(preview.hardness * 100).toFixed(0)}%`),
      statLine(UI.statWidth, String(preview.width)),
    );

    const cost = el('div', 'panel-statcol');
    cost.append(el('div', 'panel-statcol-h', UI.statsCost));
    cost.append(
      statLine(UI.statManpower, formatNumber(preview.manpowerNeed)),
      statLine(UI.statCost, formatNumber(preview.buildCost)),
    );
    // The equipment bill belongs in this column, against what is in the depot:
    // it is the part of the cost that can actually stop a division being
    // raised, and it was in a separate block at the bottom of the panel.
    for (const [eq, need] of Object.entries(preview.equipmentNeed) as [EquipmentType, number][]) {
      const have = me.economy.stockpile[eq] ?? 0;
      cost.append(statLine(
        EQUIPMENT_LABEL[eq],
        `${Math.round(need)} / ${formatNumber(have)}`,
        have < need,
      ));
    }

    table.append(base, fight, cost);
    root.append(table);

    // --- terrain adjusters --------------------------------------------------
    root.append(el('div', 'panel-label', UI.terrainAdjusters));
    const adj = el('div', 'panel-adjusters');
    for (const row of terrainProfile(preview)) {
      const cell = el('div', 'panel-adjuster');
      cell.append(el('div', 'panel-adjuster-h', TERRAIN[row.terrain]));
      const nums = el('div', 'panel-adjuster-nums');
      const pct = (v: number): string => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
      const mark = (label: string, v: number): HTMLElement => {
        const n = el('span', 'panel-adjuster-n', `${label}${pct(v)}`);
        n.classList.toggle('is-good', v > 1.001);
        n.classList.toggle('is-bad', v < 0.999);
        return n;
      };
      nums.append(
        mark(UI.terrainAttack, row.attack),
        mark(UI.terrainDefence, row.defence),
        mark(UI.terrainSpeed, row.speed),
      );
      cell.append(nums);
      // What the ground actually lets in. This is the number that decides
      // whether a wide division is worth building, and it has never been shown.
      cell.append(el('div', 'panel-adjuster-fit',
        `${UI.terrainFits} ${UI.divisionsFit(divisionsPerBattle(preview, row.width))}`));
      adj.append(cell);
    }
    root.append(adj);

    // --- actions ------------------------------------------------------------
    root.append(el('div', 'panel-row-sub',
      `${UI.estimatedCost} ${formatNumber(preview.buildCost)}`));
    const actions = el('div', 'panel-row');
    const reset = el('button', 'panel-btn', UI.designerReset);
    reset.addEventListener('click', () => {
      draft.battalions = [];
      draft.supports = [];
      slotPicker = null;
      rebuild();
    });
    const save = el('button', 'panel-btn wide primary', UI.saveTemplate);
    save.disabled = draft.battalions.length === 0;
    save.addEventListener('click', () => {
      game.issue({
        t: 'createTemplate', country: me.id,
        name: draft.name || UI.newTemplate,
        battalions: draft.battalions, supports: draft.supports,
      });
      slotPicker = null;
      game.openPanel?.('army');
    });
    const back = el('button', 'panel-btn', UI.back);
    back.addEventListener('click', () => {
      slotPicker = null;
      game.openPanel?.('army');
    });
    actions.append(back, reset, save);
    root.append(actions);
  },
};

/**
 * Built lazily: the focus and research panels are declared below this point,
 * and a `const` table would capture them before they are assigned.
 */
export const PANELS: Record<PanelId, Panel> = {
  get focus() { return focusPanel; },
  get research() { return researchPanel; },
  get command() { return commandPanel; },
  production: productionPanel,
  construction: constructionPanel,
  army: armyPanel,
  diplomacy: diplomacyPanel,
  province: provincePanel,
  designer: designerPanel,
  variant: variantPanel,
  nation: nationPanel,
  get politics() { return politicsPanel; },
  get trade() { return tradePanel; },
} as Record<PanelId, Panel>;

export { RESOURCE_LABEL, EQUIPMENT_LABEL, RESOURCE_TYPES };


// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

/**
 * The market.
 *
 * Reached by tapping the resource you are short of, which is the whole design:
 * the chip in the top bar that has gone red is the button that opens the place
 * where it is fixed. A player who can see a shortage and cannot act on it is
 * being told off rather than given a decision.
 */
export const tradePanel: Panel = {
  id: 'trade',
  title: UI.navTrade,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const ctx = { index: game.index };

    const head = el('div', 'panel-head');
    head.dataset.role = 'trade-head';
    head.append(
      stat(UI.tradeFree, String(Math.floor(me.economy.freeCivilianFactories))),
      stat(UI.tradeBuying, String(factoriesCommitted(state, me.id))),
      stat(UI.tradeSelling, String(factoriesEarned(state, me.id))),
    );
    root.append(head);

    const law = el('div', 'panel-sub');
    law.dataset.role = 'trade-law';
    root.append(law);

    const body = el('div', 'panel-list');
    body.dataset.role = 'trade-body';
    root.append(body);

    const rebuild = (): void => { tradePanel.build(game, root); };

    // What the ground yields, read directly rather than backed out of the
    // day's supply: the economy tick runs once a day, so a purchase made this
    // frame would otherwise show as negative home production until midnight.
    const home = computeResourceOutput(state, game.index, me.id);
    const traffic = tradeFlow(state, ctx, me.id);
    const shipped = dealUnits(state, ctx);

    for (const r of RESOURCE_TYPES) {
      const flow = me.economy.resources[r];
      const sellers = state.countries
        .filter((c) => canTradeWith(state, me.id, c.id))
        .map((c) => ({ c, spare: availableFrom(state, ctx, c.id, r) }))
        // A quarter-load rather than a whole one: a factory now takes a
        // seller's remainder instead of needing an exact multiple of the rate,
        // so the small producers -- which on this map is all of the tungsten
        // and all of the rubber -- belong in the list.
        .filter((x) => x.spare >= RESOURCE_PER_FACTORY * MIN_TRADE_LOAD
          || state.trades?.some((d) => d.buyer === me.id && d.seller === x.c.id && d.resource === r))
        .sort((a, b) => b.spare - a.spare)
        .slice(0, 6);

      const short = flow.deficit > 0.5;
      const { head: shead, body: sbody } = section(
        `trade:${r}`, RESOURCE_LABEL[r], sellers.length, short,
      );
      if (short) shead.classList.add('is-short');
      const balance = el('div', 'panel-row-sub');
      balance.textContent = UI.tradeBalance(
        Math.round(home[r]),
        Math.round(traffic.imports[r]),
        Math.round(traffic.exports[r]),
        Math.round(flow.deficit),
      );
      sbody.append(balance);

      for (const { c, spare } of sellers) {
        const deal = state.trades?.find(
          (d) => d.buyer === me.id && d.seller === c.id && d.resource === r,
        );
        const row = el('div', 'panel-row');

        const swatch = el('img', 'panel-flag');
        swatch.alt = '';
        swatch.src = flagUrl(c.tag);
        swatch.style.background = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;
        swatch.addEventListener('error', () => { swatch.removeAttribute('src'); });

        const main = el('div', 'panel-row-main');
        main.append(
          el('div', 'panel-row-title', country(c.tag)),
          // What is on offer and what is actually arriving, which are not the
          // same number once a factory can take a seller's remainder: three
          // factories against a mine with 9 a day left bring 9, not 24, and
          // the row has to say so or the arithmetic in the header looks wrong.
          el('div', 'panel-row-sub', UI.tradeOffer(
            round1(spare),
            deal?.factories ?? 0,
            round1(deal ? (shipped.get(deal.id) ?? 0) : 0),
          )),
        );

        const controls = el('div', 'panel-row-controls');
        const minus = el('button', 'panel-btn', '−');
        minus.setAttribute('aria-label', `${country(c.tag)}: ${UI.tradeSell}`);
        minus.disabled = !deal;
        minus.addEventListener('click', () => {
          game.issue({ t: 'closeTrade', country: me.id, seller: c.id, resource: r, factories: 1 });
          rebuild();
        });
        const count = el('span', 'panel-count', String(deal?.factories ?? 0));
        const plus = el('button', 'panel-btn', '+');
        plus.setAttribute('aria-label', `${country(c.tag)}: ${UI.tradeBuy}`);
        plus.disabled = maxPurchase(state, ctx, me.id, c.id, r) < 1;
        plus.addEventListener('click', () => {
          game.issue({ t: 'openTrade', country: me.id, seller: c.id, resource: r, factories: 1 });
          rebuild();
        });
        controls.append(minus, count, plus);

        row.append(swatch, main, controls);
        sbody.append(row);
      }

      if (sellers.length === 0) {
        sbody.append(el('div', 'panel-empty', UI.tradeNoSellers));
      }
      body.append(shead, sbody);
    }

    tradePanel.refresh?.(game, root);
  },
  refresh(game, root) {
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const head = root.querySelector<HTMLElement>('[data-role="trade-head"]');
    if (head) {
      const values = head.querySelectorAll<HTMLElement>('.hud-stat-v');
      setText(values[0], String(Math.floor(me.economy.freeCivilianFactories)));
      setText(values[1], String(factoriesCommitted(state, me.id)));
      setText(values[2], String(factoriesEarned(state, me.id)));
    }
    const law = root.querySelector<HTMLElement>('[data-role="trade-law"]');
    if (law) {
      setText(law, UI.tradeLawLine(
        TRADE[tradeLawOf(me)].name, Math.round(exportShare(me) * 100), RESOURCE_PER_FACTORY,
      ));
    }
  },
};

// ---------------------------------------------------------------------------
// Chain of command
// ---------------------------------------------------------------------------

/** The army whose detail is expanded; -1 while the list is collapsed. */
let openArmy = -1;

function attributeRow(c: Commander): HTMLElement {
  const row = el('div', 'panel-attrs');
  const pairs: [string, number][] = [
    [UI.attrAttack, c.attack],
    [UI.attrDefence, c.defence],
    [UI.attrPlanning, c.planning],
    [UI.attrLogistics, c.logistics],
  ];
  for (const [label, value] of pairs) {
    const box = el('div', 'panel-attr');
    box.append(el('span', 'panel-attr-l', label), el('span', 'panel-attr-v', String(value)));
    row.append(box);
  }
  return row;
}

/**
 * The two buttons that start and stop a plan.
 *
 * These are the reference's 「計画実行ボタン」 and the red button to its left,
 * and they are the reason a plan is worth drawing early: an army that moved the
 * moment it was given an order could never bank the preparation bonus, because
 * the bonus is paid for by standing still. Stopping keeps the plan and what it
 * has banked; only replacing the order throws that away.
 */
function planControls(game: Game, army: Army, rebuild: () => void): HTMLElement {
  const me = game.state.meta.playerCountry;
  const running = army.executing === true;
  const row = el('div', 'panel-chips');

  const stop = el('button', 'panel-chip is-stop', `■ ${UI.planStop}`);
  stop.disabled = !running;
  stop.addEventListener('click', () => {
    game.issue({ t: 'setPlanExecution', country: me, army: army.id, executing: false });
    rebuild();
  });

  const go = el('button', 'panel-chip is-go', `▶ ${UI.planExecute}`);
  go.disabled = running;
  go.classList.toggle('is-on', running);
  go.addEventListener('click', () => {
    game.issue({ t: 'setPlanExecution', country: me, army: army.id, executing: true });
    rebuild();
  });

  row.append(stop, go);
  return row;
}

/**
 * The order line for one army.
 *
 * A front is picked by naming an enemy rather than by drawing on the map: a
 * finger cannot trace a line along a border on a 412px screen with any
 * precision, and the enemy is what the player is actually thinking about.
 */
function orderControls(game: Game, army: Army, rebuild: () => void): HTMLElement {
  const me = game.state.countries[game.state.meta.playerCountry];
  const box = el('div', 'panel-chips');

  for (const enemy of frontCandidates(game).slice(0, 5)) {
    const chip = el('button', 'panel-chip', `${UI.setOrderFront}: ${country(enemy.tag)}`);
    chip.classList.toggle(
      'is-on', army.order?.kind === 'front' && army.order.against === enemy.id,
    );
    chip.addEventListener('click', () => {
      game.issue({
        t: 'setArmyOrder', country: me.id, army: army.id,
        order: { kind: 'front', against: enemy.id },
      });
      rebuild();
    });
    box.append(chip);

    // An offensive needs objectives, and picking them province by province is
    // not something a thumb can do. Naming the enemy aims the army at what it
    // would actually be sent to take: the places worth victory points.
    const targets = objectivesAgainst(game, enemy.id);
    if (targets.length === 0) continue;
    const push = el('button', 'panel-chip', `${UI.setOrderAttack}: ${country(enemy.tag)}`);
    push.classList.toggle(
      'is-on',
      army.order?.kind === 'offensive'
      && army.order.targets.length === targets.length
      && army.order.targets[0] === targets[0],
    );
    push.addEventListener('click', () => {
      game.issue({
        t: 'setArmyOrder', country: me.id, army: army.id,
        order: { kind: 'offensive', targets },
      });
      rebuild();
    });
    box.append(push);

    // The same push down one corridor instead of across a face -- 「1プロヴィンス
    // のみの前線から先鋒の目標を設定した場合。目標のワルシャワまでの経路のみ
    // 進攻する計画になる」. Aimed at the single most valuable thing the enemy
    // holds, because that is the objective a player draws a spearhead at.
    const tip = targets[0];
    const drive = el('button', 'panel-chip',
      `${UI.setOrderSpearhead}: ${game.index.get(tip).name}`);
    drive.classList.toggle(
      'is-on', army.order?.kind === 'spearhead' && army.order.target === tip,
    );
    drive.addEventListener('click', () => {
      game.issue({
        t: 'setArmyOrder', country: me.id, army: army.id,
        order: { kind: 'spearhead', target: tip },
      });
      rebuild();
    });
    box.append(drive);
  }

  const clear = el('button', 'panel-chip', UI.setOrderClear);
  clear.classList.toggle('is-on', army.order === null);
  clear.addEventListener('click', () => {
    game.issue({ t: 'setArmyOrder', country: me.id, army: army.id, order: null });
    rebuild();
  });
  box.append(clear);

  // Divisions sent somewhere by hand stop following the plan, and the way back
  // is to give the army its orders again. Re-issuing the order it already has
  // does exactly that and keeps the preparation it has banked, so this is that
  // button rather than a command of its own.
  const loose = army.divisions.filter((id) => game.state.divisions[id]?.detached).length;
  if (loose > 0 && army.order !== null) {
    const rejoin = el('button', 'panel-chip', UI.rejoinPlan);
    rejoin.addEventListener('click', () => {
      game.issue({ t: 'setArmyOrder', country: me.id, army: army.id, order: army.order });
      rebuild();
    });
    box.append(rejoin);
  }
  return box;
}

/**
 * The divisions in an army, which is what an army is.
 *
 * The card carried a count and a preparation bar and no way to see what was
 * under the general -- a formation you cannot open is a number, not an order
 * of battle. Each row is tappable and puts that one division under orders on
 * the map, so a single division can be pulled out of a front without
 * dissolving the formation around it.
 */
function orderOfBattle(game: Game, army: Army): HTMLElement {
  const state = game.state;
  const box = el('div', 'panel-oob');
  box.append(el('div', 'panel-label', `${UI.orderOfBattle} ${army.divisions.length}`));
  const live = army.divisions
    .map((id) => state.divisions[id])
    .filter((d) => d && !d.dead);
  if (live.length === 0) {
    box.append(el('div', 'panel-empty', UI.unassigned));
    return box;
  }
  for (const d of live) {
    const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
    const row = el('button', 'panel-oob-row');
    const main = el('div', 'panel-row-main');
    main.append(el('div', 'panel-row-title',
      UI.divisionName(d.ordinal, tpl?.name ?? UI.newTemplate)));
    const org = Math.round((d.org / Math.max(1, tpl?.maxOrg ?? 1)) * 100);
    const hp = Math.round((d.hp / Math.max(1, tpl?.maxHp ?? 1)) * 100);
    const where = game.index.get(d.provinceId).name;
    // A division under a hand-given order is not where the plan put it, and
    // the order of battle is the one place that can say so.
    const tag = d.combatId !== null ? ` · ${UI.inCombat}`
      : d.detached ? ` · ${UI.detached}`
        : d.path.length > 0 ? ` · ${UI.onTheMove}` : '';
    main.append(el('div', 'panel-row-sub',
      `${where} · ${UI.divisionState(org, hp)}${tag}`));
    row.append(main);
    if (d.combatId !== null) row.classList.add('is-fighting');
    if (d.detached) row.classList.add('is-detached');
    row.addEventListener('click', () => {
      game.selectDivisions([d.id], { army: army.id });
      closeSheet();
    });
    box.append(row);
  }
  return box;
}

/** An enemy's most valuable provinces: what an offensive is actually for. */
export function objectivesAgainst(game: Game, enemy: CountryId): number[] {
  return game.index.provinces
    .filter((p) => game.state.provinces[p.id]?.controller === enemy)
    .sort((a, b) => b.vp - a.vp || a.id - b.id)
    .slice(0, 4)
    .map((p) => p.id);
}

/**
 * Who an army could be told to face.
 *
 * Whoever we are already at war with, and failing that whoever we touch: a
 * front drawn before the war is the whole point of drawing one early, and an
 * empty list would leave the control a dead end in peacetime. Exported
 * because the order bar on the map asks the same question the panel does.
 */
export function frontCandidates(game: Game): Country[] {
  const me = game.state.countries[game.state.meta.playerCountry];
  const enemies = me.atWarWith
    .map((id) => game.state.countries[id])
    .filter((c) => c && !c.capitulated);
  return enemies.length > 0 ? enemies : borderingCountries(game, me.id);
}

/** Countries whose territory touches ours; the ones a front could face. */
function borderingCountries(game: Game, me: CountryId): Country[] {
  const seen = new Set<CountryId>();
  for (const province of game.index.provinces) {
    if (game.state.provinces[province.id]?.controller !== me) continue;
    for (const nb of province.neighbors) {
      const other = game.state.provinces[nb]?.controller;
      if (other !== undefined && other !== me) seen.add(other);
    }
  }
  return [...seen]
    .sort((a, b) => a - b)
    .map((id) => game.state.countries[id])
    .filter((c) => c && !c.capitulated);
}

function orderLabel(game: Game, army: Army): string {
  if (!army.order) return UI.orderNone;
  switch (army.order.kind) {
    // eslint-disable-next-line no-fallthrough
    case 'front': {
      const enemy = game.state.countries[army.order.against];
      return `${UI.orderFront} · ${enemy ? country(enemy.tag) : '—'}`;
    }
    case 'offensive': return UI.orderOffensive;
    case 'spearhead': {
      const target = army.order.target;
      return `${UI.orderSpearhead} · ${game.index.get(target).name}`;
    }
    case 'garrison': return UI.orderGarrison;
  }
}

export const commandPanel: Panel = {
  id: 'command',
  title: UI.navCommand,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const rebuild = () => commandPanel.build(game, root);

    const mine = (state.armies ?? []).filter((a) => a.owner === me.id);
    const groups = mine.filter((a) => a.isArmyGroup);
    const armies = mine.filter((a) => !a.isArmyGroup);
    const loose = state.divisions.filter(
      (d) => d.owner === me.id && !d.dead && d.armyId === null,
    ).length;

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.armies, String(armies.length)),
      stat(UI.armyGroup, String(groups.length)),
      stat(UI.divisions, String(state.divisions.filter(
        (d) => d.owner === me.id && !d.dead).length)),
      stat(UI.unassigned, String(loose)),
      stat(UI.airStrength, formatNumber(Math.round(airStrength(state, me.id)))),
    );
    root.append(head);

    // The marquee tool is a two-character button in a corner of the map, and
    // this panel is what it is for.
    root.append(el('div', 'panel-row-sub', UI.boxSelectHint));

    const label = el('div', 'panel-label', UI.armies);
    root.append(label);

    // Raising a formation by hand matters even though reinforcements find a
    // home on their own: splitting a front in two is a decision, and the
    // automatic pass will only ever balance what already exists.
    const tools = el('div', 'panel-chips');
    if (armies.length < MAX_ARMIES) {
      const add = el('button', 'panel-chip', UI.newArmy);
      add.addEventListener('click', () => {
        game.issue({ t: 'createArmy', country: me.id, name: nextArmyName(state, me.id) });
        rebuild();
      });
      tools.append(add);
    }
    if (groups.length === 0) {
      const marshal = idleCommanders(state, me.id).find((c) => c.rank === 'field_marshal');
      if (marshal) {
        const add = el('button', 'panel-chip', UI.newArmyGroup);
        add.addEventListener('click', () => {
          game.issue({ t: 'createArmy', country: me.id, name: UI.armyGroup, isArmyGroup: true });
          rebuild();
        });
        tools.append(add);
      }
    }
    if (tools.childElementCount > 0) root.append(tools);

    for (const army of armies) {
      const commander = commanderById(state, army.commander);
      const limit = commander ? commandLimit(commander) : COMMAND_LIMIT;
      const over = army.divisions.length > limit;

      const card = el('div', 'panel-focus');
      card.dataset.army = String(army.id);
      card.classList.toggle('is-current', openArmy === army.id);

      const title = el('button', 'panel-army-head');
      const group = armyById(state, army.parent);
      title.append(
        el('span', 'panel-focus-name', army.name + (group ? ` · ${group.name}` : '')),
        el('span', 'panel-army-count',
          `${army.divisions.length}/${limit}${UI.divisionsInArmy}`),
      );
      if (over) title.classList.add('is-over');
      title.addEventListener('click', () => {
        openArmy = openArmy === army.id ? -1 : army.id;
        rebuild();
      });
      card.append(title);

      card.append(el('div', 'panel-row-sub',
        commander
          ? `${commander.name}（${UI.skill} ${commander.skill}）`
          : UI.noCommander));
      if (over) card.append(el('div', 'panel-focus-block', UI.overloaded));

      // Preparation, as a bar: it is a number that only means anything as a
      // proportion of what it could be.
      const ceiling = maxPlanning(state, army);
      const bar = el('div', 'panel-bar');
      const fill = el('i', 'panel-bar-fill');
      fill.style.width = `${Math.min(100, (army.planning / Math.max(0.01, ceiling)) * 100).toFixed(1)}%`;
      bar.append(fill);
      const phase = army.order === null
        ? ''
        : ` · ${army.executing === true ? UI.planExecuting : UI.planPreparing}`;
      card.append(el('div', 'panel-focus-meta',
        `${orderLabel(game, army)} · ${UI.planningBonus} `
        + `${(army.planning * 100).toFixed(0)}%${phase}`));
      bar.classList.toggle('is-live', army.executing === true);
      card.append(bar);
      if (army.order !== null) card.append(planControls(game, army, rebuild));

      if (openArmy === army.id) {
        if (commander) {
          card.append(attributeRow(commander));
          if (commander.traits.length > 0) {
            card.append(el('div', 'panel-focus-effect',
              commander.traits.map((t) => TRAIT[t] ?? t).join('・')));
          }
        }
        card.append(orderControls(game, army, rebuild));

        // The formation's name. HOI4 puts an editable field on the card and
        // this had an auto-generated 「第N軍」 that could never be changed --
        // `renameArmy` was the last of the commands nothing had ever sent.
        // A name is how a player keeps four armies apart at a glance, and
        // 「南方軍集団」 does that in a way that 「第3軍」 cannot.
        const naming = el('div', 'panel-rename');
        const field = el('input', 'panel-input');
        field.type = 'text';
        field.value = army.name;
        field.maxLength = 40;
        field.setAttribute('aria-label', UI.renameArmy);
        const apply = (): void => {
          const name = field.value.trim();
          if (name === '' || name === army.name) return;
          game.issue({ t: 'renameArmy', country: me.id, army: army.id, name });
          rebuild();
        };
        // Enter commits from the on-screen keyboard, which is the only way a
        // phone offers to say "done" without dismissing the field first.
        field.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter') {
            e.preventDefault();
            apply();
          }
        });
        const rename = el('button', 'panel-btn', UI.renameArmy);
        rename.addEventListener('click', apply);
        naming.append(field, rename);
        card.append(naming);

        // Putting an army under an army group. `setArmyParent` has been in the
        // command bus since the chain of command was written and no button has
        // ever sent it: a field marshal could be appointed to a group that
        // could never be given anything to command, so half of the hierarchy
        // -- and the half of his attributes that reaches his generals -- was
        // unreachable.
        const parents = mine.filter((a) => a.isArmyGroup);
        if (parents.length > 0) {
          const chips = el('div', 'panel-chips');
          for (const group of parents) {
            const inIt = army.parent === group.id;
            const chip = el('button', 'panel-chip',
              inIt ? UI.armyGroupLeave : `${UI.armyGroupAssign}: ${group.name}`);
            chip.classList.toggle('is-on', inIt);
            // A group holds ARMY_GROUP_LIMIT armies and no more.
            chip.disabled = !inIt && group.children.length >= ARMY_GROUP_LIMIT;
            chip.addEventListener('click', () => {
              game.issue({
                t: 'setArmyParent', country: me.id, army: army.id,
                group: inIt ? null : group.id,
              });
              rebuild();
            });
            chips.append(chip);
          }
          card.append(chips);
        }

        card.append(orderOfBattle(game, army));

        // What turns a formation into something you can move. Without this an
        // army was a note in a panel: the map only ever knew about whatever
        // happened to be standing in one province, which is a garrison, not an
        // order of battle.
        const take = el('button', 'panel-btn wide primary', UI.commandArmy);
        take.disabled = army.divisions.length === 0;
        take.addEventListener('click', () => {
          game.selectDivisions([...army.divisions], { army: army.id });
          // Close the sheet rather than open another: the next thing the
          // player does is tap the ground, and the sheet is over the ground.
          closeSheet();
        });
        card.append(take);

        const drop = el('button', 'panel-btn wide danger', UI.disband);
        drop.addEventListener('click', () => {
          game.issue({ t: 'disbandArmy', country: me.id, army: army.id });
          openArmy = -1;
          rebuild();
        });
        card.append(drop);

        const bench = idleCommanders(state, me.id).filter((c) => c.rank === 'general');
        if (bench.length > 0) {
          card.append(el('div', 'panel-label', UI.appointCommander));
          const chips = el('div', 'panel-chips');
          for (const candidate of bench.slice(0, 8)) {
            const chip = el('button', 'panel-chip',
              `${candidate.name}（${candidate.skill}）`);
            chip.addEventListener('click', () => {
              game.issue({
                t: 'appointCommander', country: me.id, army: army.id, commander: candidate.id,
              });
              rebuild();
            });
            chips.append(chip);
          }
          card.append(chips);
        }
      }
      root.append(card);
    }

    if (groups.length > 0) {
      root.append(el('div', 'panel-label', UI.armyGroup));
      for (const group of groups) {
        const marshal = commanderById(state, group.commander);
        const row = el('div', 'panel-row');
        const main = el('div', 'panel-row-main');
        main.append(
          el('div', 'panel-row-title', group.name),
          el('div', 'panel-row-sub',
            marshal
              ? `${UI.fieldMarshal} ${marshal.name}（${UI.skill} ${marshal.skill}）`
              : UI.noCommander),
        );
        row.append(main);
        row.append(el('div', 'panel-army-count',
          `${group.children.length}/${ARMY_GROUP_LIMIT}`));
        root.append(row);
      }
    }

    // The bench. An officer nobody has given a post to is doing nothing at all,
    // and the player has no other way to find out he exists.
    const bench = idleCommanders(state, me.id);
    if (bench.length > 0) {
      root.append(el('div', 'panel-label', UI.commanderPool));
      for (const c of bench.slice(0, 12)) {
        const row = el('div', 'panel-row');
        const main = el('div', 'panel-row-main');
        main.append(
          el('div', 'panel-row-title',
            `${c.name}${c.rank === 'field_marshal' ? ` · ${UI.fieldMarshal}` : ''}`),
          el('div', 'panel-row-sub',
            `${UI.skill} ${c.skill} · ${UI.attrAttack}${c.attack} ${UI.attrDefence}${c.defence}`
            + ` ${UI.attrPlanning}${c.planning} ${UI.attrLogistics}${c.logistics}`
            + (c.traits.length > 0
              ? ` · ${c.traits.map((t) => TRAIT[t] ?? t).join('・')}`
              : '')),
        );
        row.append(main);
        root.append(row);
      }
    }
  },
  refresh(game, root) {
    // Only the preparation bars move between commands, so only they are
    // rewritten; rebuilding the panel every tick would close the open army
    // under the player's finger.
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const armies = (state.armies ?? []).filter((a) => a.owner === me.id && !a.isArmyGroup);
    const bars = root.querySelectorAll<HTMLElement>('.panel-bar-fill');
    armies.forEach((army, i) => {
      const bar = bars[i];
      if (!bar) return;
      const ceiling = maxPlanning(state, army);
      bar.style.width =
        `${Math.min(100, (army.planning / Math.max(0.01, ceiling)) * 100).toFixed(1)}%`;
    });
  },
};

// ---------------------------------------------------------------------------
// National focus
// ---------------------------------------------------------------------------

/**
 * The focus tree, as a vertical timeline rather than the desktop game's grid.
 *
 * A 412px phone cannot show a branching lattice legibly, and pinch-zooming a
 * second surface inside a bottom sheet is miserable. The tree is already in
 * historical order, so a column reads as a chronology: what is running, what
 * can be started now, and what is waiting and on what.
 */
/**
 * The focus tree.
 *
 * HOI4's national focus screen is a tree: icons on a grid, joined by lines
 * that show what unlocks what. This was three collapsible lists -- available,
 * locked, done -- which is the same information with the shape taken out of
 * it, and the shape is the whole point. A player cannot plan two focuses ahead
 * from a list, because a list does not say which of the sixteen locked entries
 * the one available entry leads to.
 *
 * `FocusView` already carried `x`, `y`, `prerequisites` and `exclusive`; the
 * panel simply was not reading them.
 */

/** Node box and grid pitch, in CSS pixels. */
const FOCUS_W = 84;
const FOCUS_H = 72;
const FOCUS_COL = 96;
const FOCUS_ROW = 86;
const FOCUS_PAD = 10;

/**
 * Which icon a focus wears.
 *
 * HOI4 draws a bespoke illustration for every focus; there are 82 here and
 * bespoke art for each is not on the table. The next most useful thing an
 * icon can say is what the focus *does*, so it is chosen from the effect that
 * dominates it -- and that is information the list form never showed at all.
 */
const FOCUS_EFFECT_ICON: Record<string, string> = {
  annex: 'ui-annex',
  cede: 'ui-annex',
  wargoal: 'ui-wargoal',
  guarantee: 'ui-diplomacy',
  opinion: 'ui-diplomacy',
  factory: 'ui-factory',
  warEconomy: 'ui-factory',
  buildingSlots: 'ui-construction',
  infrastructure: 'ui-construction',
  constructionSpeed: 'ui-construction',
  fort: 'ui-construction',
  research: 'ui-research',
  researchSpeed: 'ui-research',
  researchSlot: 'ui-research',
  equipment: 'ui-production',
  manpower: 'ui-manpower',
  worldTension: 'ui-warning',
  politicalPower: 'ui-political_power',
  dailyPoliticalPower: 'ui-political_power',
};

/** Effects in the order they best describe a focus, most telling first. */
const FOCUS_ICON_ORDER = [
  'annex', 'cede', 'wargoal', 'guarantee', 'factory', 'equipment', 'research',
  'researchSlot', 'researchSpeed', 'manpower', 'buildingSlots', 'infrastructure',
  'constructionSpeed', 'fort', 'warEconomy', 'opinion', 'worldTension',
  'politicalPower', 'dailyPoliticalPower',
];

function focusIcon(v: { effects: { k: string }[] }): string {
  for (const kind of FOCUS_ICON_ORDER) {
    if (v.effects.some((e) => e.k === kind)) return FOCUS_EFFECT_ICON[kind];
  }
  return 'ui-political_power';
}

/** The focus the detail card is showing, remembered across rebuilds. */
let focusSelected: string | null = null;

export const focusPanel: Panel = {
  id: 'focus',
  title: UI.navFocus,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const views = availableFocuses(state, me.id);
    const current = views.find((v) => v.current) ?? null;
    const byId = new Map(views.map((v) => [v.id, v] as const));

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.politicalPower, String(Math.round(me.economy.politicalPower))),
      stat(UI.focusDone, `${views.filter((v) => v.completed).length}/${views.length}`),
      stat(UI.inProgress, current ? `${current.daysRemaining}${UI.days}` : '—'),
    );
    root.append(head);

    // Default to whatever the player is most likely to want to read: the focus
    // under way, else the first one they could start.
    if (focusSelected === null || !byId.has(focusSelected)) {
      focusSelected = current?.id
        ?? views.find((v) => v.selectable && !v.completed)?.id
        ?? views[0]?.id
        ?? null;
    }

    const cols = Math.max(1, ...views.map((v) => v.x + 1));
    const rows = Math.max(1, ...views.map((v) => v.y + 1));
    const width = FOCUS_PAD * 2 + (cols - 1) * FOCUS_COL + FOCUS_W;
    const height = FOCUS_PAD * 2 + (rows - 1) * FOCUS_ROW + FOCUS_H;

    const scroller = el('div', 'panel-tree-scroll');
    const tree = el('div', 'panel-tree');
    tree.style.width = `${width}px`;
    tree.style.height = `${height}px`;

    const cx = (v: { x: number }): number => FOCUS_PAD + v.x * FOCUS_COL + FOCUS_W / 2;
    const top = (v: { y: number }): number => FOCUS_PAD + v.y * FOCUS_ROW;
    const bottom = (v: { y: number }): number => top(v) + FOCUS_H;

    // --- the lines ---------------------------------------------------------
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'panel-tree-links');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const line = (d: string, cls: string): void => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      svg.append(path);
    };

    for (const v of views) {
      for (const group of v.prerequisites) {
        for (const id of group) {
          const from = byId.get(id);
          if (!from) continue;
          // An elbow, as the real tree draws it: down out of the parent, across
          // at the midpoint, then down into the child.
          const y0 = bottom(from);
          const y1 = top(v);
          const mid = y0 + (y1 - y0) / 2;
          const done = from.completed;
          line(
            `M${cx(from)} ${y0} V${mid} H${cx(v)} V${y1}`,
            `panel-tree-link${done ? ' is-open' : ''}`,
          );
        }
      }
      // Exclusives are drawn once, from the lower id, so the pair gets one line.
      for (const other of v.exclusive) {
        if (other <= v.id) continue;
        const o = byId.get(other);
        if (!o) continue;
        line(`M${cx(v)} ${top(v) + FOCUS_H / 2} H${cx(o)}`, 'panel-tree-link is-exclusive');
      }
    }
    tree.append(svg);

    // --- the nodes ---------------------------------------------------------
    const detail = el('div', 'panel-focus-detail');

    const drawDetail = (): void => {
      detail.innerHTML = '';
      const v = focusSelected === null ? null : byId.get(focusSelected);
      if (!v) return;
      detail.append(el('div', 'panel-focus-name', v.name));
      detail.append(el('div', 'panel-focus-desc', v.desc));
      if (v.effectText.length > 0) {
        detail.append(el('div', 'panel-focus-effect', v.effectText.join(' · ')));
      }
      if (v.current) {
        const bar = el('div', 'panel-bar');
        const fill = el('i', 'panel-bar-fill');
        fill.style.width = `${(v.fraction * 100).toFixed(1)}%`;
        bar.append(fill);
        detail.append(bar);
        detail.append(el('div', 'panel-focus-meta',
          `${Math.round(v.progress)} / ${v.days}${UI.days}`));
        const stop = el('button', 'panel-btn wide', UI.cancelFocus);
        stop.addEventListener('click', () => {
          game.issue({ t: 'cancelFocus', country: me.id });
          focusPanel.build(game, root);
        });
        detail.append(stop);
      } else if (v.completed) {
        detail.append(el('div', 'panel-focus-meta', UI.focusCompleted));
      } else if (v.selectable) {
        const go = el('button', 'panel-btn wide primary',
          `${UI.startFocus}（${v.days}${UI.days}）`);
        go.addEventListener('click', () => {
          game.issue({ t: 'startFocus', country: me.id, focus: v.id });
          focusPanel.build(game, root);
        });
        detail.append(go);
      } else {
        detail.append(el('div', 'panel-focus-block', v.blockText ?? UI.locked));
      }
    };

    const nodes = new Map<string, HTMLElement>();
    for (const v of views) {
      const node = el('button', 'panel-focus-node');
      node.dataset.focus = v.id;
      node.style.left = `${FOCUS_PAD + v.x * FOCUS_COL}px`;
      node.style.top = `${top(v)}px`;
      node.classList.toggle('is-done', v.completed);
      node.classList.toggle('is-current', v.current);
      node.classList.toggle('is-locked', !v.selectable && !v.completed && !v.current);
      const icon = el('i', 'panel-focus-node-icon');
      icon.style.setProperty('--icon', `url("${iconUrl(focusIcon(v))}")`);
      node.append(icon, el('span', 'panel-focus-node-name', v.name));
      if (v.current) {
        const bar = el('i', 'panel-focus-node-bar');
        const fill = el('i', '');
        fill.style.width = `${(v.fraction * 100).toFixed(1)}%`;
        bar.append(fill);
        node.append(bar);
      }
      node.addEventListener('click', () => {
        focusSelected = v.id;
        for (const [id, n] of nodes) n.classList.toggle('is-picked', id === v.id);
        drawDetail();
      });
      nodes.set(v.id, node);
      tree.append(node);
    }
    if (focusSelected !== null) nodes.get(focusSelected)?.classList.add('is-picked');

    scroller.append(tree);
    // The card goes above the tree, not below it. Below, reading a focus meant
    // scrolling past all six rows to reach the text describing the node you
    // had just tapped -- and then scrolling back to tap the next one.
    drawDetail();
    root.append(detail, scroller);

    // Bring the interesting part of the tree into view rather than the corner:
    // on a 412px screen a six-column tree is 590px wide, and the focus that
    // matters is rarely the top-left one. Snapped to the column pitch, so the
    // left edge never lands halfway through a node.
    const focusNode = focusSelected === null ? null : nodes.get(focusSelected);
    if (focusNode) {
      const want = focusNode.offsetLeft - scroller.clientWidth / 2 + FOCUS_W / 2;
      scroller.scrollLeft = Math.max(0, Math.round(want / FOCUS_COL) * FOCUS_COL);
    }
  },
  refresh(game, root) {
    // The tree only changes on a completion or a command, both of which rebuild.
    const me = game.state.countries[game.state.meta.playerCountry];
    const cur = availableFocuses(game.state, me.id).find((v) => v.current);
    const nodeBar = root.querySelector<HTMLElement>('.panel-focus-node.is-current > .panel-focus-node-bar > i');
    const detailBar = root.querySelector<HTMLElement>('.panel-focus-detail .panel-bar-fill');
    if (!cur) {
      if (nodeBar || detailBar) focusPanel.build(game, root);
      return;
    }
    const width = `${(cur.fraction * 100).toFixed(1)}%`;
    if (nodeBar) nodeBar.style.width = width;
    if (detailBar) detailBar.style.width = width;
  },
};

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

let researchSlot = 0;
/** The technology the detail card is showing, remembered across rebuilds. */
let researchPicked: string | null = null;

/** Grid metrics for the technology tree, in CSS pixels. */
const TECH_W = 88;
const TECH_H = 50;
const TECH_COL = 98;
const TECH_ROW = 58;
/** Room for the year headings across the top of the grid. */
const TECH_HEAD_H = 20;

export const researchPanel: Panel = {
  id: 'research',
  title: UI.navResearch,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const slots = researchView(state, me.id);
    if (researchSlot >= slots.length) researchSlot = 0;

    const done = researchSummary(state, me.id);
    const head = el('div', 'panel-head');
    head.append(
      stat(UI.researchSlots, String(slots.length)),
      stat(UI.researched, String(done.completed)),
    );
    root.append(head);

    // --- the slots themselves ---
    root.append(el('div', 'panel-label', UI.researchSlots));
    for (const s of slots) {
      const row = el('div', 'panel-focus');
      row.classList.toggle('is-current', s.slot === researchSlot);
      row.append(el('div', 'panel-focus-name',
        `${UI.slot}${s.slot + 1}: ${s.name}${s.idle ? '' : ` · ${s.branchName}`}`));
      if (!s.idle) {
        const bar = el('div', 'panel-bar');
        const fill = el('i', 'panel-bar-fill');
        fill.style.width = `${(s.percent * 100).toFixed(1)}%`;
        bar.append(fill);
        row.append(bar);
        row.append(el('div', 'panel-focus-meta',
          `${UI.remaining} ${s.daysRemaining}${UI.days}` +
          (s.aheadPenaltyDays > 0 ? ` · ${UI.aheadPenalty} +${s.aheadPenaltyDays}${UI.days}` : '')));
        if (s.effects.length > 0) {
          row.append(el('div', 'panel-focus-effect',
            s.effects.map((e) => `${e.label} ${e.value}`).join(' · ')));
        }
      }
      const pick = el('button', 'panel-btn wide', s.idle ? UI.chooseTech : UI.changeTech);
      pick.addEventListener('click', () => {
        researchSlot = s.slot;
        researchPanel.build(game, root);
      });
      row.append(pick);
      if (s.idle) {
        // An empty slot researches nothing, and a player who never opens this
        // panel would spend the war a decade behind without ever being told.
        const auto = el('button', 'panel-btn wide', UI.autoResearch);
        auto.addEventListener('click', () => {
          const best = cheapestResearchable(game, me.id);
          if (best) {
            game.issue({
              t: 'startResearch', country: me.id, slot: s.slot, tech: best,
            });
          }
          researchPanel.build(game, root);
        });
        row.append(auto);
      }
      list_append(root, row);
    }

    // --- the tree for the selected slot ---
    //
    // A grid, the way HOI4 draws one: the year across, the branch down, the
    // generations of one weapon joined by a line. This was a branch chooser
    // over a flat list, which tells a player what a technology costs but not
    // that it is three steps down a chain they have not started, nor that the
    // 1944 entries are a decade of research away.
    root.append(el('div', 'panel-label', `${UI.slot}${researchSlot + 1} — ${UI.chooseTech}`));

    const rows = BRANCH_LIST.map((b) => ({ branch: b, techs: techTree(state, me.id, b.id) }))
      .filter((r) => r.techs.length > 0);
    const allTechs = rows.flatMap((r) => r.techs);
    const years = [...new Set(allTechs.map((t) => t.year))].sort((a, b) => a - b);
    const yearAt = new Map(years.map((y, i) => [y, i] as const));
    const byId = new Map(allTechs.map((t) => [t.id, t] as const));

    // Where every technology sits, and how deep each branch band has to be.
    const place = new Map<string, { x: number; y: number }>();
    const bandTop: number[] = [];
    let cursor = TECH_HEAD_H;
    for (const r of rows) {
      const cells = new Map<number, number>();
      let depth = 1;
      for (const t of r.techs) {
        const n = cells.get(t.year) ?? 0;
        cells.set(t.year, n + 1);
        depth = Math.max(depth, n + 1);
        place.set(t.id, {
          x: (yearAt.get(t.year) ?? 0) * TECH_COL,
          y: cursor + n * TECH_ROW,
        });
      }
      bandTop.push(cursor);
      cursor += depth * TECH_ROW;
    }
    const gridW = Math.max(1, years.length) * TECH_COL;
    const gridH = cursor;

    const scroller = el('div', 'panel-tree-scroll');
    const grid = el('div', 'panel-tree');
    grid.style.width = `${gridW}px`;
    grid.style.height = `${gridH}px`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'panel-tree-links');
    svg.setAttribute('width', String(gridW));
    svg.setAttribute('height', String(gridH));
    for (const t of allTechs) {
      const to = place.get(t.id);
      if (!to) continue;
      for (const pid of t.prerequisites) {
        const from = place.get(pid);
        if (!from) continue;
        // Generations run left to right along a row, so the elbow goes out of
        // the parent's right edge and into the child's left.
        const x0 = from.x + TECH_W;
        const x1 = to.x;
        const y0 = from.y + TECH_H / 2;
        const y1 = to.y + TECH_H / 2;
        const mid = x0 + (x1 - x0) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M${x0} ${y0} H${mid} V${y1} H${x1}`);
        path.setAttribute(
          'class',
          `panel-tree-link${byId.get(pid)?.completed ? ' is-open' : ''}`,
        );
        svg.append(path);
      }
    }
    grid.append(svg);

    for (const y of years) {
      const head = el('div', 'panel-tech-year', String(y));
      head.style.left = `${(yearAt.get(y) ?? 0) * TECH_COL}px`;
      grid.append(head);
    }
    // The branch names sit outside the scroller, on a rail that does not pan.
    // Inside it they slid off the left edge the moment the player looked at
    // 1940, which is the one place a row label is actually needed.
    const rail = el('div', 'panel-tech-rail');
    rail.style.height = `${gridH}px`;
    rows.forEach((r, i) => {
      const head = el('div', 'panel-tech-branch', r.branch.name);
      head.style.top = `${bandTop[i]}px`;
      rail.append(head);
    });

    const detail = el('div', 'panel-focus-detail');
    const drawDetail = (): void => {
      detail.innerHTML = '';
      const t = researchPicked === null ? null : byId.get(researchPicked);
      if (!t) {
        detail.append(el('div', 'panel-focus-desc', UI.pickTech));
        return;
      }
      detail.append(el('div', 'panel-focus-name', t.name));
      detail.append(el('div', 'panel-focus-desc',
        `${t.branchName} · ${t.year}${UI.year} · ${t.requiredDays}${UI.days}`
        + (t.aheadPenaltyDays > 0 ? ` (${UI.aheadPenalty} +${t.aheadPenaltyDays}${UI.days})` : '')));
      if (t.effects.length > 0) {
        detail.append(el('div', 'panel-focus-effect',
          t.effects.map((e) => `${e.label} ${e.value}`).join(' · ')));
      }
      if (t.completed) {
        detail.append(el('div', 'panel-focus-meta', UI.researchedAlready));
      } else if (t.researchable) {
        const go = el('button', 'panel-btn wide primary',
          `${UI.slot}${researchSlot + 1}${UI.researchHere}`);
        go.addEventListener('click', () => {
          game.issue({ t: 'startResearch', country: me.id, slot: researchSlot, tech: t.id });
          researchPanel.build(game, root);
        });
        detail.append(go);
      } else {
        detail.append(el('div', 'panel-focus-block', t.reasonText));
      }
    };

    const nodes = new Map<string, HTMLElement>();
    for (const t of allTechs) {
      const at = place.get(t.id);
      if (!at) continue;
      const node = el('button', 'panel-tech-node');
      node.style.left = `${at.x}px`;
      node.style.top = `${at.y}px`;
      node.classList.toggle('is-done', t.completed);
      node.classList.toggle('is-current', t.slot !== null);
      node.classList.toggle('is-locked', !t.researchable && !t.completed && t.slot === null);
      node.append(el('span', 'panel-tech-node-name', t.name));
      if (t.slot !== null) {
        const bar = el('i', 'panel-focus-node-bar');
        const fill = el('i', '');
        fill.style.width = `${((slots[t.slot]?.percent ?? 0) * 100).toFixed(1)}%`;
        bar.append(fill);
        node.append(bar);
      }
      node.addEventListener('click', () => {
        researchPicked = t.id;
        for (const [id, n] of nodes) n.classList.toggle('is-picked', id === t.id);
        drawDetail();
      });
      nodes.set(t.id, node);
      grid.append(node);
    }
    if (researchPicked !== null) nodes.get(researchPicked)?.classList.add('is-picked');

    scroller.append(grid);
    const frame = el('div', 'panel-tech-frame');
    frame.append(rail, scroller);
    drawDetail();
    root.append(detail, frame);

    // Open on the year the country is actually working in, not on 1936.
    const now = state.clock.year;
    const col = yearAt.get(years.find((y) => y >= now) ?? years[0]) ?? 0;
    scroller.scrollLeft = Math.max(0, col * TECH_COL - TECH_COL);
  },
  refresh(game, root) {
    const bars = root.querySelectorAll<HTMLElement>('.panel-bar-fill');
    if (bars.length === 0) return;
    const me = game.state.countries[game.state.meta.playerCountry];
    const slots = researchView(game.state, me.id).filter((s) => !s.idle);
    slots.forEach((s, i) => {
      if (bars[i]) bars[i].style.width = `${(s.percent * 100).toFixed(1)}%`;
    });
  },
};

/**
 * The shortest researchable technology across every branch.
 *
 * Deliberately cheapest-first rather than cleverest: it exists so a slot is
 * never idle by accident, not to play the research game for the player.
 */
function cheapestResearchable(game: Game, owner: number): string | null {
  let best: { id: string; days: number } | null = null;
  for (const b of BRANCH_LIST) {
    for (const t of techTree(game.state, owner, b.id)) {
      if (!t.researchable) continue;
      if (!best || t.requiredDays < best.days) best = { id: t.id, days: t.requiredDays };
    }
  }
  return best?.id ?? null;
}

/** Appends into the panel body; kept separate so the slot loop reads cleanly. */
function list_append(root: HTMLElement, row: HTMLElement): void {
  root.append(row);
}


// ---------------------------------------------------------------------------
// Politics
// ---------------------------------------------------------------------------

/** One rung of a law ladder, with the two buttons that move it. */
function lawRow(
  game: Game, kind: LawKind, label: string, current: string, rebuild: () => void,
): HTMLElement {
  const me = game.state.countries[game.state.meta.playerCountry];
  const card = el('div', 'panel-focus');
  card.append(el('div', 'panel-label', label));
  card.append(el('div', 'panel-focus-name', current));

  const rung = lawIndex(me, kind);
  const total = lawLadder(kind).length;
  const bar = el('div', 'panel-bar');
  const fill = el('i', 'panel-bar-fill');
  fill.style.width = `${((rung + 1) / total * 100).toFixed(1)}%`;
  bar.append(fill);
  card.append(bar);

  const row = el('div', 'panel-chips');
  for (const [step, text] of [[-1, UI.lawRelax], [1, UI.lawMobilise]] as const) {
    const check = canChangeLaw(game.state, me, kind, step);
    const btn = el('button', 'panel-btn wide', `${text}（${LAW_COST} ${UI.lawCost}）`);
    btn.disabled = !check.allowed;
    if (step === 1 && check.allowed) btn.classList.add('primary');
    btn.addEventListener('click', () => {
      game.issue({ t: 'changeLaw', country: me.id, kind, step });
      rebuild();
    });
    row.append(btn);
    if (!check.allowed && check.reason !== '' && step === 1) {
      card.append(el('div', 'panel-focus-block', lawBlockReason(check.reason)));
    }
  }
  card.append(row);
  return card;
}

function lawBlockReason(reason: LawCheck['reason']): string {
  switch (reason) {
    case 'cost': return UI.lawBlockedCost;
    case 'war_support': return UI.lawBlockedWarSupport;
    case 'tension': return UI.lawBlockedTension;
    case 'needs_war': return UI.lawBlockedNeedsWar;
    case 'democracy': return UI.lawBlockedDemocracy;
    default: return UI.lawBlockedEnd;
  }
}

/**
 * The politics screen, reached by tapping your own flag, which is where the
 * real game keeps it.
 */
export const politicsPanel: Panel = {
  id: 'politics',
  title: UI.navPolitics,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const effects = lawEffects(me);
    const rebuild = () => politicsPanel.build(game, root);

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.politicalPower, String(Math.round(me.economy.politicalPower))),
      stat(UI.stability, `${Math.round(me.stability * 100)}%`),
      stat(UI.warSupport, `${Math.round(me.warSupport * 100)}%`),
      stat(UI.worldTension, `${Math.round(state.worldTension)}%`),
    );
    root.append(head);

    root.append(lawRow(
      game, 'economy', UI.economyLaw, ECONOMY_NAME[me.laws.economy], rebuild,
    ));
    root.append(lawRow(
      game, 'conscription', UI.conscriptionLaw,
      CONSCRIPTION_NAME[me.laws.conscription], rebuild,
    ));
    root.append(lawRow(
      game, 'trade', UI.tradeLaw, TRADE[tradeLawOf(me)].name, rebuild,
    ));

    // What the ladders are currently worth, so the cost of a step is legible
    // before it is paid rather than after.
    root.append(el('div', 'panel-label', UI.effects));
    const kvs = el('div', 'panel-kvs');
    const kv = (k: string, v: string) => {
      const box = el('div', 'panel-kv');
      box.append(el('span', 'panel-k', k), el('span', 'panel-v', v));
      kvs.append(box);
    };
    kv(UI.recruitable, `${(effects.conscriptionFraction * 100).toFixed(1)}%`);
    kv(UI.consumerGoodsShare, `${Math.round(effects.consumerGoods * 100)}%`);
    kv(UI.constructionSpeed, `${Math.round(effects.construction * 100)}%`);
    kv(UI.factoryOutputLabel, `${Math.round(effects.output * effects.factoryStaffing * 100)}%`);
    kv(UI.researchSpeedLabel, `${Math.round(effects.research * 100)}%`);
    kv(UI.tradeExportShare, `${Math.round(exportShare(me) * 100)}%`);
    root.append(kvs);
  },
};
