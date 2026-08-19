import type { Game } from '../app/Game';
import {
  BUILDING_COST, EQUIPMENT, FACTORY_OUTPUT,
} from '../sim/core/data';
import {
  EQUIPMENT_TYPES, RESOURCE_TYPES,
  type BuildingType, type EquipmentType, type ResourceType,
} from '../sim/core/types';
import { canQueueBuilding } from '../sim/economy/production';
import { occupationRatio } from '../sim/diplomacy/diplomacy';
import {
  BATTALION, BUILDING, EQUIPMENT as EQUIPMENT_NAME, IDEOLOGY, RESOURCE,
  SUPPORT, TERRAIN, UI, country,
} from './strings';

/**
 * The bottom-sheet panels.
 *
 * Each panel rebuilds its own DOM when opened and refreshes only the numbers
 * afterwards. Rebuilding a list every frame is what makes a DOM HUD feel
 * sluggish next to a canvas that is already using most of the budget.
 */

export type PanelId = 'production' | 'construction' | 'army' | 'diplomacy' | 'province';

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

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
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
  'civilian_factory', 'military_factory', 'dockyard', 'infrastructure',
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
      controls.append(minus, count, plus);

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

    // Queue.
    const queue = el('div', 'panel-list');
    queue.dataset.role = 'queue';
    root.append(el('div', 'panel-label', UI.queue), queue);
    renderQueue(game, queue);

    // What can be started, in the state the player has selected.
    const selected = game.selection.province;
    const stateId = selected !== null ? game.index.get(selected).stateId : -1;
    const stateName = stateId >= 0 ? game.index.data.states[stateId].name : null;
    root.append(el(
      'div', 'panel-label',
      stateName ? `${stateName}に建設` : UI.selectProvinceToBuild,
    ));

    if (stateId >= 0) {
      const grid = el('div', 'panel-grid');
      for (const kind of BUILDABLE) {
        const label = BUILDING[kind];
        const b = el('button', 'panel-build');
        const allowed = canQueueBuilding(state, me, stateId, kind);
        b.disabled = !allowed;
        b.append(
          el('span', 'panel-build-title', label),
          el('span', 'panel-build-sub', `${formatNumber(BUILDING_COST[kind])} pts`),
        );
        b.addEventListener('click', () => {
          game.issue({ t: 'queueConstruction', country: me.id, kind, state: stateId });
          // Rebuild after the command lands on the next tick.
          setTimeout(() => constructionPanel.build(game, root), 60);
        });
        grid.append(b);
      }
      root.append(grid);
    }
  },
  refresh(game, root) {
    const queue = root.querySelector<HTMLElement>('[data-role="queue"]');
    if (queue) renderQueue(game, queue);
  },
};

function renderQueue(game: Game, host: HTMLElement): void {
  const me = game.state.countries[game.state.meta.playerCountry];
  const items = me.constructionQueue;
  if (host.childElementCount !== items.length || items.length === 0) {
    host.innerHTML = '';
    if (items.length === 0) {
      host.append(el('div', 'panel-empty', 'Nothing under construction.'));
      return;
    }
    for (const item of items) {
      const row = el('div', 'panel-row');
      row.dataset.item = String(item.id);
      const main = el('div', 'panel-row-main');
      const stateName = game.index.data.states[item.stateId]?.name ?? '';
      main.append(
        el('div', 'panel-row-title', `${item.kind.replace('_', ' ')} — ${stateName}`),
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
    if (sub) setText(sub, `${Math.round(pct * 100)}% complete`);
  }
}

// ---------------------------------------------------------------------------
// Army
// ---------------------------------------------------------------------------

export const armyPanel: Panel = {
  id: 'army',
  title: UI.navArmy,
  build(game, root) {
    root.innerHTML = '';
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];

    const head = el('div', 'panel-head');
    head.dataset.role = 'army-head';
    root.append(head);

    root.append(el('div', 'panel-label', UI.recruit));
    const grid = el('div', 'panel-grid');
    grid.dataset.role = 'templates';
    for (const tpl of me.templates) {
      const b = el('button', 'panel-build');
      b.dataset.tpl = String(tpl.id);
      b.append(
        el('span', 'panel-build-title', tpl.name),
        el('span', 'panel-build-sub',
          `${tpl.battalions.map((x) => BATTALION[x]).join('・')}` +
          (tpl.supports.length > 0 ? ` + ${tpl.supports.map((x) => SUPPORT[x]).join('・')}` : '') +
          ` · ${formatNumber(tpl.manpowerNeed)}名`),
        // Refreshed every tick with the equipment that is holding this template
        // back. A recruit button that silently does nothing is the worst
        // possible answer to "why can I not build an army".
        el('span', 'panel-build-note', ''),
      );
      b.addEventListener('click', () => {
        game.issue({
          t: 'recruitDivision', country: me.id, template: tpl.id, province: me.capital,
        });
      });
      grid.append(b);
    }
    root.append(grid);

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

      const swatch = el('i', 'panel-swatch');
      swatch.style.background = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;

      const main = el('div', 'panel-row-main');
      main.append(
        el('div', 'panel-row-title', `${country(c.tag)}　${IDEOLOGY[c.ideology]}`),
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
      controls.append(justify, declare);

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
      const parts: string[] = [];
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
      root.append(el('div', 'panel-empty', '州が選択されていません。'));
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
    const rows: [string, string][] = [
      ['州', stateData.name],
      [UI.infrastructure, String(stateData.infrastructure)],
      ['人口', formatNumber(stateData.manpower * 1000)],
      ['工場', `民需 ${stateData.civilianFactories} / 軍需 ${stateData.militaryFactories}`],
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
      setText(row, `${UI.organisation} ${org}% · ${UI.strength} ${str}% · ${UI.supplyLevel} ${Math.round(d.supplyLevel * 100)}%`);
    }
  },
};

function stat(label: string, value: string): HTMLElement {
  const box = el('div', 'hud-stat');
  box.append(el('span', 'hud-stat-v', value), el('span', 'hud-stat-l', label.toUpperCase()));
  return box;
}


export const PANELS: Record<PanelId, Panel> = {
  production: productionPanel,
  construction: constructionPanel,
  army: armyPanel,
  diplomacy: diplomacyPanel,
  province: provincePanel,
};

export { RESOURCE_LABEL, EQUIPMENT_LABEL, RESOURCE_TYPES };
