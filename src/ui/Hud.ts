import type { Game } from '../app/Game';
import type { MapMode } from '../render/palette';
import { formatDateLong } from '../sim/time/calendar';
import { RESOURCE_TYPES, type GameEvent, type ResourceType } from '../sim/core/types';
import { PANELS, formatNumber, type PanelId } from './panels';
import { HUD_CSS } from './hud.css';
import { createSheetView } from './sheetView';
import { RESOURCE_SHORT, UI, country, eventText, outcomeReason } from './strings';

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

/**
 * The button row, in the order the real game's is: what the nation intends,
 * what it is learning, what it is building, what it is manufacturing, what it
 * is raising, and who it is talking to.
 */
const NAV: [PanelId, string, string][] = [
  ['focus', UI.navFocus, 'ui-political_power'],
  ['research', UI.navResearch, 'ui-research'],
  ['construction', UI.navConstruction, 'ui-construction'],
  ['production', UI.navProduction, 'ui-production'],
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

/**
 * Eases a displayed number toward its true value and flashes it on change.
 *
 * Resources and factory counts used to rewrite instantly, which reads as a
 * spreadsheet recalculating rather than as a country running. The tween is
 * display-only -- the simulation value is never what is shown mid-flight -- and
 * it snaps rather than creeping once it is within a whole unit, so a settled
 * figure always matches the state exactly.
 */
class NumberTween {
  private shown = NaN;

  constructor(private node: HTMLElement, private format: (v: number) => string) {}

  set(target: number, dtMs: number): void {
    if (!Number.isFinite(this.shown)) {
      this.shown = target;
      setText(this.node, this.format(target));
      return;
    }
    if (this.shown === target) return;
    const k = 1 - Math.pow(0.004, Math.min(0.05, dtMs / 1000));
    const next = this.shown + (target - this.shown) * k;
    this.shown = Math.abs(target - next) < 1 ? target : next;
    setText(this.node, this.format(this.shown));
    this.node.classList.remove('is-changing');
    // Reading offsetWidth restarts the animation; without it a value that
    // changes every frame never re-triggers the flash.
    void this.node.offsetWidth;
    this.node.classList.add('is-changing');
  }
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}assets/${path}`;
}

/**
 * An icon that takes its colour from the surrounding text.
 *
 * Not an `<img>`: `stroke="currentColor"` inside an image-referenced SVG
 * resolves against that SVG document's own `color`, which defaults to black
 * and does not inherit from the host page. Every icon in the HUD was therefore
 * rendering pure black on a near-black chrome -- 1.09:1 against a 3:1 floor.
 * Masking a `currentColor` fill makes the icon inherit properly, and gets
 * hover and active states for free.
 */
function iconNode(cls: string, path: string): HTMLElement {
  const node = el('i', cls);
  node.style.setProperty('--icon', `url("${assetUrl(path)}")`);
  return node;
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

  // One strip of icon-and-number chips, the way HOI4's top bar reads: the
  // icon identifies the figure and the name is the accessible label. Stacked
  // value-over-label boxes needed 30px of height each and still could not fit
  // five figures plus six resources across 412px.
  const stats = el('div', 'hud-stats');
  const statNodes: Record<string, HTMLElement> = {};
  const addStat = (key: string, label: string, icon: string) => {
    const box = el('div', 'hud-stat');
    const v = el('span', 'hud-stat-v', '0');
    box.title = label;
    box.setAttribute('aria-label', label);
    box.append(iconNode('hud-res-icon', `icons/${icon}.svg`), v);
    stats.append(box);
    statNodes[key] = v;
  };
  addStat('pp', UI.politicalPower, 'ui-political_power');
  addStat('mp', UI.manpower, 'ui-manpower');
  addStat('civ', UI.civFactories, 'ui-factory');
  addStat('mil', UI.milFactories, 'ui-military_factory');
  addStat('div', UI.divisions, 'ui-army');

  // The clock is a cluster of real buttons, not a row of hairlines. The speed
  // used to be five 8px pips two pixels apart: a target no thumb can hit, in a
  // corner where it collided with the resource strip below it. Slower and
  // faster are steppers now, with the step shown between them.
  const clock = el('div', 'hud-clock');
  const dateNode = el('div', 'hud-date', '');
  const speedRow = el('div', 'hud-speed');
  const slower = el('button', 'hud-btn hud-step', '−');
  slower.setAttribute('aria-label', `${UI.speed} −`);
  const pauseBtn = el('button', 'hud-btn hud-pause', '▶');
  pauseBtn.setAttribute('aria-label', UI.playPause);
  const speedNode = el('span', 'hud-speed-v', '2');
  const faster = el('button', 'hud-btn hud-step', '＋');
  faster.setAttribute('aria-label', `${UI.speed} ＋`);
  speedRow.append(slower, pauseBtn, speedNode, faster);
  clock.append(dateNode, speedRow);

  // Two rows: identity and clock above, the figures below. One row cannot hold
  // a flag, a name, five figures and a clock on a 412px screen without one of
  // them being pushed off, which is what was happening.
  const topRow = el('div', 'hud-top-row');
  topRow.append(flag, nameBox, el('div', 'hud-spacer'), clock);

  // --- resource strip ------------------------------------------------------
  // Its own row under the figures, not absolutely positioned 48px down: that
  // offset was measured against a one-row top bar and left the strip lying
  // across the figures the moment the bar needed two rows.
  const resStrip = el('div', 'hud-resources');
  const resNodes: Partial<Record<ResourceType, HTMLElement>> = {};
  for (const r of RESOURCE_TYPES) {
    const chip = el('div', 'hud-res');
    const icon = iconNode('hud-res-icon', `icons/resource-${r}.svg`);
    const v = el('span', 'hud-res-v', '0');
    // Icon and number only. Six labelled chips need 493px on a 412px screen,
    // so the last resource was simply cut off by the screen edge; the icon
    // already identifies the resource, and the name stays as the accessible
    // label for anyone who needs it.
    chip.title = RESOURCE_SHORT[r];
    chip.setAttribute('aria-label', RESOURCE_SHORT[r]);
    chip.append(icon, v);
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
  // The zoom cluster sits in the panel header, where HOI4 puts its own: a
  // phone panel has to serve a 320px screen and a 480px one, and no single
  // type size does that.
  const zoomOut = el('button', 'hud-sheet-zoom', '−');
  zoomOut.setAttribute('aria-label', UI.zoomOut);
  const zoomLabel = el('span', 'hud-sheet-zoom-v', '100%');
  const zoomIn = el('button', 'hud-sheet-zoom', '＋');
  zoomIn.setAttribute('aria-label', UI.zoomIn);
  const sheetClose = el('button', 'hud-sheet-close', '×');
  sheetClose.setAttribute('aria-label', UI.closePanel);
  sheetHeader.append(sheetTitle, zoomOut, zoomLabel, zoomIn, sheetClose);
  const sheetBody = el('div', 'hud-sheet-body');
  sheet.append(sheetGrip, sheetHeader, sheetBody);

  const sheetView = createSheetView(sheet, (z) => {
    setText(zoomLabel, `${Math.round(z * 100)}%`);
  });
  zoomOut.addEventListener('click', () => sheetView.stepZoom(-1));
  zoomIn.addEventListener('click', () => sheetView.stepZoom(1));
  const unbindPinch = sheetView.bindPinch(sheetBody);

  // --- bottom navigation ---------------------------------------------------
  const nav = el('div', 'hud-nav');
  const navButtons: HTMLElement[] = [];
  for (const [id, label, icon] of NAV) {
    const b = el('button', 'hud-nav-btn');
    b.dataset.panel = id;
    b.append(iconNode('hud-nav-icon', `icons/${icon}.svg`), el('span', 'hud-nav-label', label));
    b.addEventListener('click', () => togglePanel(id));
    navButtons.push(b);
    nav.append(b);
  }

  // --- alerts --------------------------------------------------------------
  const toasts = el('div', 'hud-toasts');

  // --- outcome -------------------------------------------------------------
  const outcome = el('div', 'hud-outcome');
  // One child, not two: `place-items: center` on a two-child grid builds an
  // implicit two-row track and centres each child in its own row, which put
  // the title and its reason four hundred pixels apart.
  const outcomeCard = el('div', 'hud-outcome-card');
  const outcomeTitle = el('div', 'hud-outcome-title', '');
  const outcomeSub = el('div', 'hud-outcome-sub', '');
  const outcomeAgain = el('button', 'hud-outcome-again', UI.restart);
  outcomeAgain.addEventListener('click', () => location.reload());
  outcomeCard.append(outcomeTitle, outcomeSub, outcomeAgain);
  outcome.append(outcomeCard);

  // Two rows of chips, not one scrolling row. Eleven chips need 610px and the
  // screen is 412: a third of the strip -- four of the six strategic resources
  // -- was parked behind the fade with nothing to say it was there. Split by
  // kind, each row fits, and the whole national position is visible at once
  // the way it is in the real game.
  top.append(topRow, stats, resStrip);

  root.append(top, modeBar, toasts, sheet, nav, outcome);

  // Everything below the top bar is placed against its measured height rather
  // than a constant. The constant was 78px, chosen when the bar was one row;
  // the bar grows with the safe-area inset and with the text size the player
  // has chosen, and the map-mode buttons were landing on top of it.
  const measureTop = () => {
    root.style.setProperty('--hud-top-h', `${Math.round(top.getBoundingClientRect().height)}px`);
  };
  const topObserver = new ResizeObserver(measureTop);
  topObserver.observe(top);
  measureTop();

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

  // Panels that are not nav destinations open from inside another panel: the
  // designer from the army list, the province sheet from a tap on the map.
  game.openPanel = (id) => togglePanel(id as PanelId | null);

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
  // The grip both resizes and dismisses, which is what the shape invites: drag
  // up for more of the panel, drag down for less, drag down past the smallest
  // size to put it away. A sheet fixed at 52vh is too short for the research
  // list and too tall for the province card.
  let gripStartY = 0;
  let gripStartH = 0;
  let gripDragging = false;
  sheetGrip.addEventListener('pointerdown', (e) => {
    gripStartY = e.clientY;
    gripStartH = sheet.getBoundingClientRect().height;
    gripDragging = true;
    sheetGrip.setPointerCapture(e.pointerId);
    sheet.classList.add('is-dragging');
  });
  sheetGrip.addEventListener('pointermove', (e) => {
    if (!gripDragging) return;
    sheetView.setHeight((gripStartH + (gripStartY - e.clientY)) / window.innerHeight);
  });
  const endGrip = (e: PointerEvent): void => {
    if (!gripDragging) return;
    gripDragging = false;
    sheet.classList.remove('is-dragging');
    if (e.clientY - gripStartY > 48) {
      if (openPanel === 'province') game.selectProvince(null);
      togglePanel(null);
    }
  };
  sheetGrip.addEventListener('pointerup', endGrip);
  sheetGrip.addEventListener('pointercancel', endGrip);

  // The steppers move the chosen speed, which is remembered across a pause, so
  // pressing + while paused sets the speed you will resume at rather than
  // silently unpausing.
  const step = (delta: number) => {
    const next = Math.min(5, Math.max(1, game.chosenSpeed + delta)) as 1 | 2 | 3 | 4 | 5;
    if (game.speed === 0) game.pauseAt(next);
    else game.setSpeed(next);
    syncSpeed();
  };
  slower.addEventListener('click', () => step(-1));
  faster.addEventListener('click', () => step(1));
  pauseBtn.addEventListener('click', () => {
    game.togglePause();
    syncSpeed();
  });

  function syncModes(): void {
    for (const b of modeButtons) {
      b.classList.toggle('is-active', b.dataset.mode === game.renderer.mapMode);
    }
  }

  function syncSpeed(): void {
    const s = game.speed;
    setText(pauseBtn, s === 0 ? '▶' : '⏸');
    pauseBtn.classList.toggle('is-paused', s === 0);
    // The stepper shows the speed the clock will run at, which is the stored
    // speed even while paused: pausing is not the same as choosing speed 0,
    // and a player who pauses at 5 expects 5 back when they resume.
    setText(speedNode, String(game.chosenSpeed));
    speedNode.classList.toggle('is-paused', s === 0);
    slower.classList.toggle('is-off', game.chosenSpeed <= 1);
    faster.classList.toggle('is-off', game.chosenSpeed >= 5);
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

  const tweens = {
    pp: new NumberTween(statNodes.pp, formatNumber),
    mp: new NumberTween(statNodes.mp, formatNumber),
    civ: new NumberTween(statNodes.civ, (v) => String(Math.round(v))),
    mil: new NumberTween(statNodes.mil, (v) => String(Math.round(v))),
    div: new NumberTween(statNodes.div, (v) => String(Math.round(v))),
  };

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

    const dt = game.lastFrameMs;
    tweens.pp.set(me.economy.politicalPower, dt);
    tweens.mp.set(me.economy.manpower * 1000, dt);
    tweens.civ.set(me.economy.civilianFactories, dt);
    tweens.mil.set(me.economy.militaryFactories, dt);
    tweens.div.set(me.stats.divisionCount, dt);

    for (const r of RESOURCE_TYPES) {
      const flow = me.economy.resources[r];
      const node = resNodes[r]!;
      // The shortfall, not the balance. A shortage used to render as a red
      // zero -- production and consumption net out at the point supply is
      // capped -- and a red nought tells the player nothing about how short
      // they are or whether it is getting worse.
      const short = flow.deficit > 0.001;
      const net = Math.round(short ? -flow.deficit : flow.produced - flow.consumed);
      setText(node, net > 0 ? `+${net}` : String(net));
      node.classList.toggle('is-short', short);
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
        setText(outcomeTitle, status === 'victory' ? UI.victory : UI.defeat);
        setText(outcomeSub,
          'reason' in state.outcome ? outcomeReason(state.outcome.reason) : '');
        outcome.classList.add('is-shown');
        outcome.classList.toggle('is-defeat', status === 'defeat');
      }
    }
  });

  syncModes();
  syncSpeed();

  return () => {
    unsubscribe();
    topObserver.disconnect();
    unbindPinch();
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
