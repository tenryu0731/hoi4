import type { Game } from '../app/Game';
import type { MapMode } from '../render/palette';
import { formatDateLong } from '../sim/time/calendar';
import { RESOURCE_TYPES, type GameEvent, type ResourceType } from '../sim/core/types';
import { PANELS, formatNumber, type PanelId } from './panels';
import { HUD_CSS } from './hud.css';
import { RESOURCE_SHORT, UI, country, eventText } from './strings';

/**
 * The heads-up display.
 *
 * Plain DOM rather than a framework, for two reasons: the canvas already owns
 * the frame budget, and every write here is guarded by a value comparison so a
 * paused game does no layout work at all. Anything that changes every frame
 * belongs on the canvas, not in the document.
 *
 * Layout is mobile-first and thumb-first: status along the top under the safe
 * area, navigation along the bottom within thumb reach, and the middle of the
 * screen left clear so it belongs entirely to map gestures.
 */

const MAP_MODES: [MapMode, string][] = [
  ['political', UI.modePolitical],
  ['terrain', UI.modeTerrain],
  ['resource', UI.modeResource],
  ['supply', UI.modeSupply],
  ['victory', UI.modeVictory],
];

const NAV: [PanelId, string, string][] = [
  ['production', UI.navProduction, 'ui-production'],
  ['construction', UI.navConstruction, 'ui-construction'],
  ['army', UI.navArmy, 'ui-army'],
  ['diplomacy', UI.navDiplomacy, 'ui-diplomacy'],
];

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

function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}assets/${path}`;
}

export function mountHud(game: Game, root: HTMLElement): () => void {
  root.innerHTML = '';
  injectStyles();

  // --- top bar -------------------------------------------------------------
  const top = el('div', 'hud-top');
  const flag = el('img', 'hud-flag');
  flag.alt = '';
  const nameBox = el('div', 'hud-country');
  const countryName = el('div', 'hud-country-name');
  const countryTag = el('div', 'hud-country-tag');
  nameBox.append(countryName, countryTag);

  const stats = el('div', 'hud-stats');
  const statNodes: Record<string, HTMLElement> = {};
  const addStat = (key: string, label: string) => {
    const box = el('div', 'hud-stat');
    const v = el('span', 'hud-stat-v', '0');
    box.append(v, el('span', 'hud-stat-l', label));
    stats.append(box);
    statNodes[key] = v;
  };
  addStat('pp', UI.politicalPower);
  addStat('mp', UI.manpower);
  addStat('civ', UI.civFactories);
  addStat('mil', UI.milFactories);
  addStat('div', UI.divisions);

  const clock = el('div', 'hud-clock');
  const dateNode = el('div', 'hud-date', '');
  const speedRow = el('div', 'hud-speed');
  const pauseBtn = el('button', 'hud-btn hud-pause', '▶');
  pauseBtn.setAttribute('aria-label', UI.playPause);
  const speedPips = el('div', 'hud-pips');
  const pips: HTMLElement[] = [];
  for (let i = 1; i <= 5; i++) {
    const pip = el('button', 'hud-pip');
    pip.dataset.speed = String(i);
    pip.setAttribute('aria-label', `${UI.speed} ${i}`);
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
    const icon = el('img', 'hud-res-icon');
    icon.src = assetUrl(`icons/resource-${r}.svg`);
    icon.alt = '';
    const v = el('span', 'hud-res-v', '0');
    chip.append(icon, v, el('span', 'hud-res-l', RESOURCE_SHORT[r]));
    resStrip.append(chip);
    resNodes[r] = v;
  }

  // --- map modes -----------------------------------------------------------
  // Anchored top-right rather than floating over the middle of the map: a
  // control in the centre of the screen steals the pinch gestures that belong
  // to the map underneath it.
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

  // --- bottom sheet --------------------------------------------------------
  const sheet = el('div', 'hud-sheet');
  const sheetGrip = el('div', 'hud-sheet-grip');
  const sheetHeader = el('div', 'hud-sheet-header');
  const sheetTitle = el('div', 'hud-sheet-title', '');
  const sheetClose = el('button', 'hud-sheet-close', '×');
  sheetClose.setAttribute('aria-label', UI.closePanel);
  sheetHeader.append(sheetTitle, sheetClose);
  const sheetBody = el('div', 'hud-sheet-body');
  sheet.append(sheetGrip, sheetHeader, sheetBody);

  // --- bottom navigation ---------------------------------------------------
  const nav = el('div', 'hud-nav');
  const navButtons: HTMLElement[] = [];
  for (const [id, label, icon] of NAV) {
    const b = el('button', 'hud-nav-btn');
    b.dataset.panel = id;
    const img = el('img', 'hud-nav-icon');
    img.src = assetUrl(`icons/${icon}.svg`);
    img.alt = '';
    b.append(img, el('span', 'hud-nav-label', label));
    b.addEventListener('click', () => togglePanel(id));
    navButtons.push(b);
    nav.append(b);
  }

  // --- alerts --------------------------------------------------------------
  const toasts = el('div', 'hud-toasts');

  // --- outcome -------------------------------------------------------------
  const outcome = el('div', 'hud-outcome');
  const outcomeTitle = el('div', 'hud-outcome-title', '');
  const outcomeSub = el('div', 'hud-outcome-sub', '');
  outcome.append(outcomeTitle, outcomeSub);

  root.append(top, resStrip, modeBar, toasts, sheet, nav, outcome);

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  let openPanel: PanelId | null = null;

  function togglePanel(id: PanelId | null): void {
    if (id !== null && openPanel === id) {
      openPanel = null;
    } else {
      openPanel = id;
    }
    if (openPanel === null) {
      sheet.classList.remove('is-open');
    } else {
      const panel = PANELS[openPanel];
      setText(sheetTitle, panelTitle(panel.id));
      panel.build(game, sheetBody);
      panel.refresh?.(game, sheetBody);
      sheet.classList.add('is-open');
    }
    for (const b of navButtons) b.classList.toggle('is-active', b.dataset.panel === openPanel);
  }

  /** The province panel is titled with the place it is showing. */
  function panelTitle(id: PanelId): string {
    if (id !== 'province') return PANELS[id].title;
    const sel = game.selection.province;
    return sel === null ? PANELS.province.title : game.index.get(sel).name;
  }

  sheetClose.addEventListener('click', () => {
    if (openPanel === 'province') game.selectProvince(null);
    togglePanel(null);
  });
  // Swipe the grip down to dismiss, which is the gesture the shape invites.
  let gripStartY = 0;
  sheetGrip.addEventListener('pointerdown', (e) => { gripStartY = e.clientY; });
  sheetGrip.addEventListener('pointerup', (e) => {
    if (e.clientY - gripStartY > 24) {
      if (openPanel === 'province') game.selectProvince(null);
      togglePanel(null);
    }
  });

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

  // --- toasts --------------------------------------------------------------
  let lastLogLength = game.state.log.length;
  // Wars, capitulations and the outcome concern everyone; a finished factory
  // concerns only its owner. Without that filter the player's first five
  // minutes are a hundred and thirty toasts about Belgian construction.
  const TOAST_KINDS = new Set(['war', 'capitulation', 'construction', 'outcome']);
  const OWN_ONLY = new Set(['construction', 'production']);

  function pushToast(e: GameEvent): void {
    const node = el('div', `hud-toast kind-${e.kind}`,
      eventText(e.body, (id) => game.index.get(id).name));
    toasts.append(node);
    // Fade and remove; the log panel keeps the permanent record.
    setTimeout(() => node.classList.add('is-out'), 4200);
    setTimeout(() => node.remove(), 4800);
    while (toasts.childElementCount > 4) toasts.firstElementChild?.remove();
  }

  // --- per-frame refresh ---------------------------------------------------
  let lastSpeed = -1;
  let lastProvince: number | null | undefined;
  let lastOutcome = '';
  let lastFlagTag = '';

  const unsubscribe = game.onFrame(() => {
    const state = game.state;
    const me = state.countries[state.meta.playerCountry];

    if (lastFlagTag !== me.tag) {
      lastFlagTag = me.tag;
      flag.src = assetUrl(`flags/${me.tag}.svg`);
      flag.alt = me.name;
    }
    setText(countryName, country(me.tag));
    setText(countryTag, me.tag);

    setText(statNodes.pp, formatNumber(me.economy.politicalPower));
    setText(statNodes.mp, formatNumber(me.economy.manpower * 1000));
    setText(statNodes.civ, String(me.economy.civilianFactories));
    setText(statNodes.mil, String(me.economy.militaryFactories));
    setText(statNodes.div, String(me.stats.divisionCount));

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

    // Selecting a province opens its panel; clearing it closes.
    const sel = game.selection.province;
    if (sel !== lastProvince) {
      lastProvince = sel;
      if (sel === null) {
        if (openPanel === 'province') togglePanel(null);
      } else if (openPanel === null || openPanel === 'province') {
        openPanel = null;
        togglePanel('province');
        setText(sheetTitle, panelTitle('province'));
      } else if (openPanel === 'construction') {
        // The build panel is scoped to the selected state, so re-read it.
        PANELS.construction.build(game, sheetBody);
      }
    }

    if (openPanel !== null) PANELS[openPanel].refresh?.(game, sheetBody);

    // Alerts.
    if (state.log.length !== lastLogLength) {
      const fresh = state.log.slice(Math.max(0, lastLogLength));
      lastLogLength = state.log.length;
      for (const e of fresh) {
        if (!TOAST_KINDS.has(e.kind)) continue;
        if (OWN_ONLY.has(e.kind) && e.country !== state.meta.playerCountry) continue;
        pushToast(e);
      }
    }

    // Outcome overlay.
    const status = state.outcome.status;
    if (status !== lastOutcome) {
      lastOutcome = status;
      if (status === 'playing') {
        outcome.classList.remove('is-shown');
      } else {
        setText(outcomeTitle, status === 'victory' ? 'VICTORY' : 'DEFEAT');
        setText(outcomeSub, 'reason' in state.outcome ? state.outcome.reason : '');
        outcome.classList.add('is-shown');
        outcome.classList.toggle('is-defeat', status === 'defeat');
      }
    }
  });

  syncModes();
  syncSpeed();

  return () => {
    unsubscribe();
    root.innerHTML = '';
  };
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  document.head.appendChild(style);
}
