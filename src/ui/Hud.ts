import type { Game } from '../app/Game';
import type { MapMode } from '../render/palette';
import { formatDateLong } from '../sim/time/calendar';
import { RESOURCE_TYPES, type ResourceType } from '../sim/core/types';

/**
 * The heads-up display.
 *
 * Plain DOM rather than a framework, for two reasons: the canvas already owns
 * the frame budget, and every DOM write here is guarded by a value comparison
 * so a paused game does zero layout work. Anything that changes every frame
 * belongs on the canvas, not here.
 */

const MAP_MODES: [MapMode, string][] = [
  ['political', 'Political'],
  ['terrain', 'Terrain'],
  ['resource', 'Resources'],
  ['supply', 'Supply'],
  ['victory', 'Victory'],
];

const RESOURCE_LABEL: Record<ResourceType, string> = {
  oil: 'Oil',
  steel: 'Steel',
  aluminium: 'Alu',
  tungsten: 'Tung',
  rubber: 'Rub',
  chromium: 'Chr',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Writes only when the value actually changed, to avoid needless reflow. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export function mountHud(game: Game, root: HTMLElement): () => void {
  root.innerHTML = '';
  injectStyles();

  // --- top bar -------------------------------------------------------------
  const top = el('div', 'hud-top');
  const flag = el('div', 'hud-flag');
  const nameBox = el('div', 'hud-country');
  const countryName = el('div', 'hud-country-name');
  const countryTag = el('div', 'hud-country-tag');
  nameBox.append(countryName, countryTag);

  const stats = el('div', 'hud-stats');
  const statNodes: Record<string, HTMLElement> = {};
  const addStat = (key: string, label: string) => {
    const box = el('div', 'hud-stat');
    const v = el('span', 'hud-stat-v', '0');
    const l = el('span', 'hud-stat-l', label);
    box.append(v, l);
    stats.append(box);
    statNodes[key] = v;
  };
  addStat('pp', 'PP');
  addStat('mp', 'MANPOWER');
  addStat('civ', 'CIV');
  addStat('mil', 'MIL');

  const clock = el('div', 'hud-clock');
  const dateNode = el('div', 'hud-date', '');
  const speedRow = el('div', 'hud-speed');
  const pauseBtn = el('button', 'hud-btn hud-pause', '▶');
  pauseBtn.setAttribute('aria-label', 'Play or pause');
  const speedPips = el('div', 'hud-pips');
  const pips: HTMLElement[] = [];
  for (let i = 1; i <= 5; i++) {
    const pip = el('button', 'hud-pip');
    pip.dataset.speed = String(i);
    pip.setAttribute('aria-label', `Speed ${i}`);
    pips.push(pip);
    speedPips.append(pip);
  }
  speedRow.append(pauseBtn, speedPips);
  clock.append(dateNode, speedRow);
  top.append(flag, nameBox, stats, clock);

  // --- resource strip ------------------------------------------------------
  const resStrip = el('div', 'hud-resources');
  const resNodes: Partial<Record<ResourceType, HTMLElement>> = {};
  for (const r of RESOURCE_TYPES) {
    const chip = el('div', 'hud-res');
    const dot = el('i', `hud-res-dot res-${r}`);
    const v = el('span', 'hud-res-v', '0');
    const l = el('span', 'hud-res-l', RESOURCE_LABEL[r]);
    chip.append(dot, v, l);
    resStrip.append(chip);
    resNodes[r] = v;
  }

  // --- map mode selector ---------------------------------------------------
  const modeBar = el('div', 'hud-modes');
  const modeButtons: HTMLElement[] = [];
  for (const [mode, label] of MAP_MODES) {
    const b = el('button', 'hud-mode', label);
    b.dataset.mode = mode;
    b.addEventListener('click', () => {
      game.setMapMode(mode);
      syncModes();
    });
    modeButtons.push(b);
    modeBar.append(b);
  }

  // --- province sheet ------------------------------------------------------
  const sheet = el('div', 'hud-sheet');
  const sheetGrip = el('div', 'hud-sheet-grip');
  const sheetTitle = el('div', 'hud-sheet-title', '');
  const sheetSub = el('div', 'hud-sheet-sub', '');
  const sheetGrid = el('div', 'hud-sheet-grid');
  const sheetClose = el('button', 'hud-sheet-close', '×');
  sheetClose.setAttribute('aria-label', 'Close');
  sheet.append(sheetGrip, sheetClose, sheetTitle, sheetSub, sheetGrid);
  sheetClose.addEventListener('click', () => game.selectProvince(null));

  root.append(top, resStrip, modeBar, sheet);

  // --- interactions --------------------------------------------------------
  pauseBtn.addEventListener('click', () => {
    game.togglePause();
    syncSpeed();
  });
  for (const pip of pips) {
    pip.addEventListener('click', () => {
      game.setSpeed(Number(pip.dataset.speed) as 1 | 2 | 3 | 4 | 5);
      syncSpeed();
    });
  }

  function syncModes(): void {
    for (const b of modeButtons) {
      b.classList.toggle('is-active', b.dataset.mode === game.renderer.mapMode);
    }
  }

  function syncSpeed(): void {
    const s = game.speed;
    setText(pauseBtn, s === 0 ? '▶' : '⏸');
    pauseBtn.classList.toggle('is-paused', s === 0);
    pips.forEach((pip, i) => pip.classList.toggle('is-on', s > i));
  }

  // --- per-frame refresh ---------------------------------------------------
  let lastProvince: number | null | undefined;
  let lastSpeed = -1;

  const unsubscribe = game.onFrame(() => {
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];

    setText(countryName, me.name);
    setText(countryTag, me.tag);
    const col = `rgb(${me.color[0]},${me.color[1]},${me.color[2]})`;
    if (flag.style.background !== col) flag.style.background = col;

    setText(statNodes.pp, formatNumber(me.economy.politicalPower));
    setText(statNodes.mp, formatNumber(me.economy.manpower * 1000));
    setText(statNodes.civ, String(me.economy.civilianFactories));
    setText(statNodes.mil, String(me.economy.militaryFactories));

    for (const r of RESOURCE_TYPES) {
      const flow = me.economy.resources[r];
      const node = resNodes[r]!;
      const net = Math.round(flow.produced - flow.consumed);
      setText(node, net > 0 ? `+${net}` : String(net));
      node.classList.toggle('is-short', flow.deficit > 0.001);
    }

    setText(dateNode, formatDateLong(state.clock));
    if (game.speed !== lastSpeed) {
      lastSpeed = game.speed;
      syncSpeed();
    }

    const sel = game.selection.province;
    if (sel !== lastProvince) {
      lastProvince = sel;
      renderSheet(sel);
    }
  });

  function renderSheet(id: number | null): void {
    if (id === null) {
      sheet.classList.remove('is-open');
      return;
    }
    const geo = game.index.get(id);
    const st = game.state.provinces[id];
    const owner = game.state.countries[st.owner];
    const controller = game.state.countries[st.controller];
    setText(sheetTitle, geo.name);
    setText(
      sheetSub,
      st.owner === st.controller
        ? `${owner.name} · ${capitalise(geo.terrain)}`
        : `${owner.name} — occupied by ${controller.name}`,
    );

    const stateData = game.index.data.states[geo.stateId];
    const resources = Object.entries(stateData.resources)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([k, v]) => `${RESOURCE_LABEL[k as ResourceType]} ${v}`)
      .join('  ') || '—';

    const divisions = st.divisions.filter((d) => !game.state.divisions[d]?.dead).length;

    sheetGrid.innerHTML = '';
    const rows: [string, string][] = [
      ['Victory points', String(geo.vp)],
      ['Infrastructure', String(stateData.infrastructure)],
      ['Manpower', formatNumber(stateData.manpower * 1000)],
      ['Supply', `${Math.round(st.supply * 100)}%`],
      ['Divisions', String(divisions)],
      ['Resources', resources],
    ];
    for (const [k, v] of rows) {
      const row = el('div', 'hud-kv');
      row.append(el('span', 'hud-k', k), el('span', 'hud-v', v));
      sheetGrid.append(row);
    }
    sheet.classList.add('is-open');
  }

  syncModes();
  syncSpeed();

  return () => {
    unsubscribe();
    root.innerHTML = '';
  };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatNumber(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  document.head.appendChild(style);
}

const HUD_CSS = `
.hud-top {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; align-items: center; gap: 10px;
  padding: calc(var(--safe-top) + 8px) 12px 8px;
  background: linear-gradient(180deg, rgba(12,16,22,0.94) 0%, rgba(12,16,22,0.78) 70%, rgba(12,16,22,0) 100%);
  pointer-events: auto;
}
.hud-flag {
  width: 34px; height: 23px; border-radius: 2px;
  border: 1px solid rgba(0,0,0,0.6);
  box-shadow: 0 1px 3px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.12);
  flex: 0 0 auto;
}
.hud-country { min-width: 0; flex: 0 0 auto; }
.hud-country-name {
  font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 92px;
}
.hud-country-tag { font-size: 9px; color: var(--ink-dim); letter-spacing: 1.5px; }

.hud-stats { display: flex; gap: 10px; flex: 1 1 auto; justify-content: center; }
.hud-stat { display: flex; flex-direction: column; align-items: center; line-height: 1.15; }
.hud-stat-v { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.hud-stat-l { font-size: 8px; color: var(--ink-dim); letter-spacing: 1px; }

.hud-clock { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: 0 0 auto; }
.hud-date { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hud-speed { display: flex; align-items: center; gap: 6px; }
.hud-btn {
  min-width: 44px; min-height: 30px;
  background: var(--panel-2); color: var(--ink);
  border: 1px solid var(--line); border-radius: 4px;
  font-size: 13px; line-height: 1; cursor: pointer;
}
.hud-btn.is-paused { color: var(--accent); border-color: var(--accent); }
.hud-pips { display: flex; gap: 2px; }
.hud-pip {
  width: 9px; height: 26px; padding: 0;
  background: #2b2e34; border: 1px solid var(--line); border-radius: 2px; cursor: pointer;
}
.hud-pip.is-on { background: var(--accent); border-color: var(--accent); }

.hud-resources {
  position: absolute; top: calc(var(--safe-top) + 52px); left: 0; right: 0;
  display: flex; gap: 6px; padding: 0 12px; overflow-x: auto;
  scrollbar-width: none; pointer-events: auto;
}
.hud-resources::-webkit-scrollbar { display: none; }
.hud-res {
  display: flex; align-items: center; gap: 4px;
  background: rgba(18,21,27,0.82); border: 1px solid rgba(58,61,69,0.8);
  border-radius: 3px; padding: 3px 6px; white-space: nowrap;
}
.hud-res-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.res-oil { background: #4a4a52; } .res-steel { background: #8a9099; }
.res-aluminium { background: #cfd6dd; } .res-tungsten { background: #6b7f8c; }
.res-rubber { background: #3f3a35; } .res-chromium { background: #b0c4c9; }
.hud-res-v { font-size: 10px; font-variant-numeric: tabular-nums; }
.hud-res-v.is-short { color: var(--danger); }
.hud-res-l { font-size: 8px; color: var(--ink-dim); letter-spacing: 0.5px; }

.hud-modes {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  display: flex; flex-direction: column; gap: 4px; pointer-events: auto;
}
.hud-mode {
  min-width: 62px; min-height: 30px; padding: 0 8px;
  font-size: 9px; letter-spacing: 0.6px; text-transform: uppercase;
  background: rgba(18,21,27,0.8); color: var(--ink-dim);
  border: 1px solid rgba(58,61,69,0.9); border-radius: 3px; cursor: pointer;
}
.hud-mode.is-active { color: #12151b; background: var(--accent); border-color: var(--accent); font-weight: 700; }

.hud-sheet {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 6px 14px calc(var(--safe-bottom) + 14px);
  background: linear-gradient(180deg, rgba(20,23,29,0.97) 0%, rgba(14,16,21,0.99) 100%);
  border-top: 1px solid var(--line);
  transform: translateY(100%); transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: auto; max-height: 46vh; overflow-y: auto;
}
.hud-sheet.is-open { transform: translateY(0); }
.hud-sheet-grip {
  width: 36px; height: 4px; border-radius: 2px; background: #4a4e57; margin: 0 auto 8px;
}
.hud-sheet-close {
  position: absolute; top: 8px; right: 10px;
  width: 32px; height: 32px; font-size: 18px; line-height: 1;
  background: transparent; color: var(--ink-dim); border: none; cursor: pointer;
}
.hud-sheet-title { font-size: 16px; font-weight: 600; }
.hud-sheet-sub { font-size: 11px; color: var(--ink-dim); margin-top: 2px; margin-bottom: 8px; }
.hud-sheet-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 14px; }
.hud-kv { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; padding: 2px 0; border-bottom: 1px solid rgba(58,61,69,0.4); }
.hud-k { color: var(--ink-dim); }
.hud-v { font-variant-numeric: tabular-nums; }

@media (max-width: 380px) {
  .hud-stats { gap: 6px; }
  .hud-sheet-grid { grid-template-columns: 1fr; }
}
`;
