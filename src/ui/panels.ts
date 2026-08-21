import type { Game } from '../app/Game';
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
import { canQueueBuilding } from '../sim/economy/production';
import {
  CONSCRIPTION_LAWS, ECONOMY_LAWS, LAW_COST,
} from '../sim/politics/lawData';
import {
  canChangeLaw, lawEffects, lawIndex, type LawCheck, type LawKind,
} from '../sim/politics/politics';
import { CONSCRIPTION_NAME, ECONOMY_NAME } from './lawNames';
import { ENTRENCHMENT_PER_LEVEL } from '../sim/military/movement';
import { winterSeverity } from '../sim/military/weather';
import { airStrength } from '../sim/military/air';
import { canDemand, occupationRatio } from '../sim/diplomacy/diplomacy';
import { availableFocuses } from '../sim/focus';
import {
  BRANCH_LIST, researchSummary, researchView, techTree, type TechBranch,
} from '../sim/research';
import {
  ARMY_GROUP_LIMIT, COMMAND_LIMIT, MAX_ARMIES, armyById, commandLimit, commanderById,
  idleCommanders, nextArmyName,
} from '../sim/military/command';
import { maxPlanning } from '../sim/military/frontline';
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
  | 'diplomacy' | 'province' | 'designer' | 'politics';

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

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Assets are served from the base path, which is not "/" on GitHub Pages. */
function flagUrl(tag: string): string {
  return `${import.meta.env.BASE_URL}assets/flags/${tag}.svg`;
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

export const productionPanel: Panel = {
  id: 'production',
  title: UI.navProduction,
  build(game, root) {
    root.innerHTML = '';
    const me = game.state.countries[game.state.meta.playerCountry];

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.militaryFactories, String(me.economy.militaryFactories)),
      stat(UI.assigned, String(me.productionLines.reduce((s, l) => s + l.assignedFactories, 0))),
    );
    root.append(head);

    const list = el('div', 'panel-list');
    list.dataset.role = 'lines';
    root.append(list);

    for (const line of me.productionLines) {
      const row = el('div', 'panel-row');
      row.dataset.line = String(line.id);

      const name = el('div', 'panel-row-main');
      name.append(
        el('div', 'panel-row-title', EQUIPMENT_LABEL[line.equipment]),
        el('div', 'panel-row-sub', ''),
      );

      const controls = el('div', 'panel-row-controls');
      const minus = el('button', 'panel-btn', '−');
      const count = el('span', 'panel-count', String(line.assignedFactories));
      const plus = el('button', 'panel-btn', '+');
      minus.setAttribute('aria-label', `${EQUIPMENT_LABEL[line.equipment]}: ${UI.removeFactory}`);
      plus.setAttribute('aria-label', `${EQUIPMENT_LABEL[line.equipment]}: ${UI.addFactory}`);
      minus.addEventListener('click', () => {
        game.issue({
          t: 'setLineFactories', country: me.id, line: line.id,
          factories: Math.max(0, line.assignedFactories - 1),
        });
      });
      plus.addEventListener('click', () => {
        game.issue({
          t: 'setLineFactories', country: me.id, line: line.id,
          factories: line.assignedFactories + 1,
        });
      });
      // Priority decides which line gets scarce steel and tungsten first. It
      // was a four-step mechanic with no control anywhere: measured over a
      // campaign, 316,806 line-days carried one distinct value, so the
      // allocator's priority sort degenerated to a sort by line id.
      const prio = el('button', 'panel-btn prio');
      const paintPrio = () => {
        setText(prio, UI.priorityNames[line.priority]);
        prio.classList.toggle('is-high', line.priority >= 2);
        prio.setAttribute(
          'aria-label',
          `${EQUIPMENT_LABEL[line.equipment]}: ${UI.priority} ${UI.priorityNames[line.priority]}`,
        );
      };
      paintPrio();
      prio.addEventListener('click', () => {
        const next = ((line.priority + 1) % 4) as 0 | 1 | 2 | 3;
        game.issue({ t: 'setLinePriority', country: me.id, line: line.id, priority: next });
        line.priority = next;
        paintPrio();
      });
      controls.append(prio, minus, count, plus);

      row.append(name, controls);
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
      b.append(el('span', 'panel-build-title', EQUIPMENT_LABEL[eq]));
      b.addEventListener('click', () => {
        game.issue({ t: 'addProductionLine', country: me.id, equipment: eq });
      });
      add.append(b);
    }
    if (add.children.length === 0) add.append(el('div', 'panel-empty', UI.allLinesOpen));
    root.append(add);
  },
  refresh(game, root) {
    const me = game.state.countries[game.state.meta.playerCountry];
    const list = root.querySelector<HTMLElement>('[data-role="lines"]');
    if (!list) return;
    for (const line of me.productionLines) {
      const row = list.querySelector<HTMLElement>(`[data-line="${line.id}"]`);
      if (!row) continue;
      const sub = row.querySelector<HTMLElement>('.panel-row-sub');
      const count = row.querySelector<HTMLElement>('.panel-count');
      if (count) setText(count, String(line.assignedFactories));
      if (!sub) continue;
      const perDay = line.assignedFactories * FACTORY_OUTPUT * line.efficiency
        / EQUIPMENT[line.equipment].cost;
      setText(
        sub,
        `${UI.efficiency} ${Math.round(line.efficiency * 100)}% · ` +
        `${perDay.toFixed(1)}${UI.perDay} · ${UI.stockpile} ` +
        `${formatNumber(me.economy.stockpile[line.equipment])}`,
      );
    }
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

function renderQueue(game: Game, host: HTMLElement): void {
  const me = game.state.countries[game.state.meta.playerCountry];
  const items = me.constructionQueue;
  if (host.childElementCount !== items.length || items.length === 0) {
    host.innerHTML = '';
    if (items.length === 0) {
      host.append(el('div', 'panel-empty', UI.nothingUnderConstruction));
      return;
    }
    for (const item of items) {
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

      const cancel = el('button', 'panel-btn', '×');
      cancel.setAttribute('aria-label', '建設を中止');
      cancel.addEventListener('click', () => {
        game.issue({ t: 'cancelConstruction', country: me.id, item: item.id });
      });
      row.append(main, cancel);
      host.append(row);
    }
  }
  for (const item of items) {
    const row = host.querySelector<HTMLElement>(`[data-item="${item.id}"]`);
    if (!row) continue;
    const pct = Math.min(1, item.progress / item.cost);
    const fill = row.querySelector<HTMLElement>('.panel-bar-fill');
    if (fill) fill.style.width = `${(pct * 100).toFixed(1)}%`;
    const sub = row.querySelector<HTMLElement>('.panel-row-sub');
    if (sub) setText(sub, `${Math.round(pct * 100)}% ${UI.complete}`);
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

export const diplomacyPanel: Panel = {
  id: 'diplomacy',
  title: UI.navDiplomacy,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];

    const head = el('div', 'panel-head');
    head.dataset.role = 'dip-head';
    head.append(
      stat(UI.worldTension, '0%'),
      stat(UI.politicalPower, '0'),
      stat(UI.faction, me.factionId !== null ? state.factions[me.factionId].name : UI.atPeace),
    );
    root.append(head);

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
      const row = el('div', 'panel-row');
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

      const controls = el('div', 'panel-row-controls');
      const justify = el('button', 'panel-btn wide', UI.justifyWar);
      justify.addEventListener('click', () => {
        game.issue({ t: 'justifyWar', country: me.id, target: c.id });
      });
      const declare = el('button', 'panel-btn wide danger', UI.declareWar);
      declare.addEventListener('click', () => {
        game.issue({ t: 'declareWar', country: me.id, target: c.id });
      });
      // Only offered where it could actually be accepted, so the button is not
      // a lottery ticket the player buys with political power every turn.
      const controlsList = [justify, declare];
      if (canDemand(game.state, me.id, c.id)) {
        const demand = el('button', 'panel-btn wide', UI.demand);
        demand.addEventListener('click', () => {
          game.issue({ t: 'demandSubmission', country: me.id, target: c.id });
        });
        controlsList.unshift(demand);
      }
      controls.append(...controlsList);

      row.append(swatch, main, controls);
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
      const parts: string[] = [IDEOLOGY[c.ideology]];
      if (c.capitulated) parts.push('降伏');
      else if (me.atWarWith.includes(c.id)) parts.push('交戦中');
      else if (c.factionId !== null && c.factionId === me.factionId) parts.push('同盟');
      const just = me.diplomacy.justifications.find((j) => j.target === c.id);
      if (just) {
        parts.push(just.progress >= just.required
          ? '開戦事由 準備完了'
          : `${UI.justifying} ${Math.round((just.progress / just.required) * 100)}%`);
      }
      parts.push(`${c.stats.divisionCount}個師団`);
      parts.push(`勝利点 ${c.stats.victoryPointsHeld}`);
      setText(sub, parts.join(' · '));
      row.classList.toggle('is-hostile', me.atWarWith.includes(c.id));
      row.classList.toggle('is-dead', c.capitulated);
    }
  },
};

// ---------------------------------------------------------------------------
// Province
// ---------------------------------------------------------------------------

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
    const owner = state.countries[p.owner];
    const controller = state.countries[p.controller];

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
    const resources = Object.entries(stateData.resources)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([k, v]) => `${RESOURCE_LABEL[k as ResourceType]} ${v}`)
      .join('、') || 'なし';
    // The two tiers, named and related. A province is what a division stands
    // in; the state is what the factories and the population belong to, and
    // several provinces share one -- which is invisible unless it is said.
    const rows: [string, string][] = [
      ['所属ステート', `${stateData.name}（${stateData.provinces.length}プロヴィンス）`],
      [UI.infrastructure, String(stateData.infrastructure)],
      ['人口', formatNumber(stateData.manpower * 1000)],
      ['工場（州全体）', `民需 ${stateData.civilianFactories} / 軍需 ${stateData.militaryFactories}`],
      ['建設枠（州全体）', String(stateData.buildingSlots)],
      [UI.resources, resources],
      ['占領率', `${country(owner.tag)}の${Math.round(occupationRatio(state, p.owner) * 100)}%`],
    ];
    for (const [k, v] of rows) {
      const row = el('div', 'panel-kv');
      row.append(el('span', 'panel-k', k), el('span', 'panel-v', v));
      grid.append(row);
    }
    root.append(grid);

    const divisions = p.divisions
      .map((d) => state.divisions[d])
      .filter((d) => d && !d.dead);
    if (divisions.length > 0) {
      root.append(el('div', 'panel-label', UI.garrison));
      const list = el('div', 'panel-list');
      list.dataset.role = 'garrison';
      for (const d of divisions) {
        const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
        const row = el('div', 'panel-row');
        row.dataset.div = String(d.id);
        const main = el('div', 'panel-row-main');
        main.append(
          el('div', 'panel-row-title', `${country(state.countries[d.owner].tag)} ${tpl?.name ?? '師団'}`),
          el('div', 'panel-row-sub', ''),
        );
        row.append(main);
        list.append(row);
      }
      root.append(list);
    }
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

const MAX_BATTALIONS = 24;

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

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.softAttack, preview.softAttack.toFixed(0)),
      stat(UI.defence, preview.defense.toFixed(0)),
      stat(UI.breakthrough, preview.breakthrough.toFixed(0)),
      stat(UI.combatWidth, String(preview.width)),
    );
    root.append(head);

    const head2 = el('div', 'panel-head');
    head2.append(
      stat(UI.organisation, preview.maxOrg.toFixed(0)),
      stat(UI.strength, preview.maxHp.toFixed(0)),
      stat(UI.speed, `${preview.speedKmh.toFixed(0)}`),
      stat(UI.manpower, formatNumber(preview.manpowerNeed)),
    );
    root.append(head2);

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

    // --- line battalions ----------------------------------------------------
    root.append(el('div', 'panel-label',
      `${UI.battalions} ${draft.battalions.length}/${MAX_BATTALIONS}`));
    const bnCounts = el('div', 'panel-list');
    for (const b of BATTALION_TYPES) {
      const n = draft.battalions.filter((x) => x === b).length;
      const row = el('div', 'panel-row');
      const main = el('div', 'panel-row-main');
      main.append(el('div', 'panel-row-title', BATTALION[b]));
      const controls = el('div', 'panel-row-controls');
      const minus = el('button', 'panel-btn', '−');
      const count = el('span', 'panel-count', String(n));
      const plus = el('button', 'panel-btn', '+');
      minus.disabled = n === 0;
      plus.disabled = draft.battalions.length >= MAX_BATTALIONS;
      minus.addEventListener('click', () => {
        const i = draft.battalions.lastIndexOf(b);
        if (i >= 0) draft.battalions.splice(i, 1);
        rebuild();
      });
      plus.addEventListener('click', () => {
        if (draft.battalions.length < MAX_BATTALIONS) draft.battalions.push(b);
        rebuild();
      });
      controls.append(minus, count, plus);
      row.append(main, controls);
      bnCounts.append(row);
    }
    root.append(bnCounts);

    // --- support companies --------------------------------------------------
    root.append(el('div', 'panel-label', UI.supportCompanies));
    const sup = el('div', 'panel-grid');
    for (const sc of SUPPORT_TYPES) {
      const on = draft.supports.includes(sc);
      const b = el('button', `panel-build${on ? ' is-on' : ''}`);
      b.append(el('span', 'panel-build-title', SUPPORT[sc]));
      b.addEventListener('click', () => {
        draft.supports = on
          ? draft.supports.filter((x) => x !== sc)
          : [...draft.supports, sc];
        rebuild();
      });
      sup.append(b);
    }
    root.append(sup);

    // --- equipment bill -----------------------------------------------------
    root.append(el('div', 'panel-label', UI.equipmentPerDivision));
    const bill = el('div', 'panel-kvs');
    for (const [eq, need] of Object.entries(preview.equipmentNeed) as [EquipmentType, number][]) {
      const row = el('div', 'panel-kv');
      const have = me.economy.stockpile[eq] ?? 0;
      row.append(
        el('span', 'panel-k', EQUIPMENT_LABEL[eq]),
        el('span', `panel-v${have < need ? ' is-short' : ''}`,
          `${Math.round(need)} / ${formatNumber(have)}`),
      );
      bill.append(row);
    }
    root.append(bill);

    // --- actions ------------------------------------------------------------
    const actions = el('div', 'panel-row');
    const save = el('button', 'panel-btn wide primary', UI.saveTemplate);
    save.disabled = draft.battalions.length === 0;
    save.addEventListener('click', () => {
      game.issue({
        t: 'createTemplate', country: me.id,
        name: draft.name || UI.newTemplate,
        battalions: draft.battalions, supports: draft.supports,
      });
      game.openPanel?.('army');
    });
    const back = el('button', 'panel-btn wide', UI.back);
    back.addEventListener('click', () => game.openPanel?.('army'));
    actions.append(back, save);
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
  get politics() { return politicsPanel; },
} as Record<PanelId, Panel>;

export { RESOURCE_LABEL, EQUIPMENT_LABEL, RESOURCE_TYPES };

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
 * The order line for one army.
 *
 * A front is picked by naming an enemy rather than by drawing on the map: a
 * finger cannot trace a line along a border on a 412px screen with any
 * precision, and the enemy is what the player is actually thinking about.
 */
function orderControls(game: Game, army: Army, rebuild: () => void): HTMLElement {
  const me = game.state.countries[game.state.meta.playerCountry];
  const box = el('div', 'panel-chips');

  const enemies = me.atWarWith
    .map((id) => game.state.countries[id])
    .filter((c) => c && !c.capitulated);
  const neighbours = enemies.length > 0 ? enemies : borderingCountries(game, me.id);

  for (const enemy of neighbours.slice(0, 5)) {
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
  }

  const clear = el('button', 'panel-chip', UI.setOrderClear);
  clear.classList.toggle('is-on', army.order === null);
  clear.addEventListener('click', () => {
    game.issue({ t: 'setArmyOrder', country: me.id, army: army.id, order: null });
    rebuild();
  });
  box.append(clear);
  return box;
}

/** An enemy's most valuable provinces: what an offensive is actually for. */
function objectivesAgainst(game: Game, enemy: CountryId): number[] {
  return game.index.provinces
    .filter((p) => game.state.provinces[p.id]?.controller === enemy)
    .sort((a, b) => b.vp - a.vp || a.id - b.id)
    .slice(0, 4)
    .map((p) => p.id);
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
      card.append(el('div', 'panel-focus-meta',
        `${orderLabel(game, army)} · ${UI.planningBonus} ${(army.planning * 100).toFixed(0)}%`));
      card.append(bar);

      if (openArmy === army.id) {
        if (commander) {
          card.append(attributeRow(commander));
          if (commander.traits.length > 0) {
            card.append(el('div', 'panel-focus-effect',
              commander.traits.map((t) => TRAIT[t] ?? t).join('・')));
          }
        }
        card.append(orderControls(game, army, rebuild));

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
export const focusPanel: Panel = {
  id: 'focus',
  title: UI.navFocus,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];
    const views = availableFocuses(state, me.id);
    const current = views.find((v) => v.current) ?? null;

    const head = el('div', 'panel-head');
    head.append(
      stat(UI.politicalPower, String(Math.round(me.economy.politicalPower))),
      stat(UI.focusDone, `${views.filter((v) => v.completed).length}/${views.length}`),
      stat(UI.inProgress, current ? `${current.daysRemaining}${UI.days}` : '—'),
    );
    root.append(head);

    if (current) {
      root.append(el('div', 'panel-label', UI.currentFocus));
      const row = el('div', 'panel-focus is-current');
      row.append(
        el('div', 'panel-focus-name', current.name),
        el('div', 'panel-focus-desc', current.desc),
      );
      const bar = el('div', 'panel-bar');
      const fill = el('i', 'panel-bar-fill');
      fill.style.width = `${(current.fraction * 100).toFixed(1)}%`;
      bar.append(fill);
      row.append(bar);
      row.append(el('div', 'panel-focus-meta',
        `${Math.round(current.progress)} / ${current.days}${UI.days}`));
      const stop = el('button', 'panel-btn wide', UI.cancelFocus);
      stop.addEventListener('click', () => {
        game.issue({ t: 'cancelFocus', country: me.id });
        focusPanel.build(game, root);
      });
      row.append(stop);
      root.append(row);
    }

    const open = views.filter((v) => !v.current && !v.completed && v.selectable);
    const locked = views.filter((v) => !v.current && !v.completed && !v.selectable);
    const done = views.filter((v) => v.completed);

    const card = (v: (typeof views)[number]): HTMLElement => {
      const row = el('div', 'panel-focus');
      row.classList.toggle('is-done', v.completed);
      row.classList.toggle('is-locked', !v.selectable && !v.completed);
      row.append(
        el('div', 'panel-focus-name', `${v.completed ? '✔ ' : ''}${v.name}`),
        el('div', 'panel-focus-desc', v.desc),
      );
      if (v.effectText.length > 0) {
        row.append(el('div', 'panel-focus-effect', v.effectText.join(' · ')));
      }
      if (v.completed) {
        // Nothing more to say; the tick and the effect line are the record.
      } else if (v.selectable) {
        const go = el('button', 'panel-btn wide', `${UI.startFocus}（${v.days}${UI.days}）`);
        go.addEventListener('click', () => {
          game.issue({ t: 'startFocus', country: me.id, focus: v.id });
          focusPanel.build(game, root);
        });
        row.append(go);
      } else {
        row.append(el('div', 'panel-focus-block', v.blockText ?? UI.locked));
      }
      return row;
    };

    for (const [key, label, items, byDefault] of [
      ['focus.open', UI.focusAvailable, open, true],
      ['focus.locked', UI.focusLocked, locked, false],
      ['focus.done', UI.focusCompleted, done, false],
    ] as const) {
      if (items.length === 0) continue;
      const sec = section(key, label, items.length, byDefault);
      for (const v of items) sec.body.append(card(v));
      root.append(sec.head, sec.body);
    }
  },
  refresh(game, root) {
    // The tree only changes on a completion or a command, both of which rebuild.
    const bar = root.querySelector<HTMLElement>('.panel-focus.is-current .panel-bar-fill');
    if (!bar) return;
    const me = game.state.countries[game.state.meta.playerCountry];
    const cur = availableFocuses(game.state, me.id).find((v) => v.current);
    if (!cur) { focusPanel.build(game, root); return; }
    bar.style.width = `${(cur.fraction * 100).toFixed(1)}%`;
  },
};

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

let researchBranch: TechBranch = 'industry';
let researchSlot = 0;

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
    root.append(el('div', 'panel-label', `${UI.slot}${researchSlot + 1} — ${UI.chooseTech}`));
    const chips = el('div', 'panel-chips');
    for (const b of BRANCH_LIST) {
      const chip = el('button', 'panel-chip', b.name);
      chip.classList.toggle('is-on', b.id === researchBranch);
      chip.addEventListener('click', () => {
        researchBranch = b.id;
        researchPanel.build(game, root);
      });
      chips.append(chip);
    }
    root.append(chips);

    const list = el('div', 'panel-list');
    for (const t of techTree(state, me.id, researchBranch)) {
      const row = el('button', 'panel-row wide-row');
      row.disabled = !t.researchable;
      row.classList.toggle('is-blocked', !t.researchable);
      const main = el('div', 'panel-row-main');
      main.append(
        el('div', 'panel-row-title', `${t.completed ? '✔ ' : ''}${t.name}`),
        el('div', 'panel-row-sub',
          `${t.year}年 · ${t.requiredDays}${UI.days}` +
          (t.researchable ? '' : ` · ${t.reasonText}`)),
      );
      row.append(main, el('span', 'panel-row-tag', t.researchable ? '▶' : ''));
      row.addEventListener('click', () => {
        game.issue({
          t: 'startResearch', country: me.id, slot: researchSlot, tech: t.id,
        });
        researchPanel.build(game, root);
      });
      list.append(row);
    }
    root.append(list);
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
  const total = kind === 'conscription' ? CONSCRIPTION_LAWS.length : ECONOMY_LAWS.length;
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

    // What the two ladders are currently worth, so the cost of a step is
    // legible before it is paid rather than after.
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
    root.append(kvs);
  },
};
