import type { Game, PlanTool } from '../app/Game';
import type { TransportBlock } from '../sim/military/movement';
import type { MapMode } from '../render/palette';
import { formatDateLong } from '../sim/time/calendar';
import { RESOURCE_TYPES, type GameEvent, type ResourceType } from '../sim/core/types';
import {
  PANELS, formatNumber, openNationId, setSheetCloser, type PanelId,
} from './panels';
import { HUD_CSS } from './hud.css';
import { PHOTOGRAPHED } from './portraitIndex';
import { collectAlerts } from './alerts';
import { createSheetView } from './sheetView';
import { RESOURCE, RESOURCE_SHORT, UI, country, eventText, outcomeReason } from './strings';
import {
  COMMAND_LIMIT, MAX_ARMIES, armyById, commandLimit, commanderById,
} from '../sim/military/command';

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
  ['state', UI.modeState],
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
  ['trade', UI.navTrade, 'ui-trade'],
  ['command', UI.navCommand, 'ui-command'],
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

/**
 * Why a sea transfer did not happen, in words the player can act on.
 *
 * Typed against the union rather than a plain record, so adding a reason to
 * the simulation and forgetting to explain it here is a compile error.
 */
const TRANSPORT_WHY: Record<Exclude<TransportBlock, 'ok'>, string> = {
  noPortHere: UI.transportNoPortHere,
  noPortThere: UI.transportNoPortThere,
  sameCoast: UI.transportSameCoast,
  noShipping: UI.transportNoShipping,
  noRoad: UI.transportNoRoad,
};

/**
 * The NATO symbol a division is drawn with.
 *
 * The same reading the counters on the map use, so a division is the same
 * shape in the list as it is on the ground. Armour wins, because armour is
 * what a player needs to pick out of a line.
 */
function symbolOf(battalions: readonly string[]): string {
  if (battalions.includes('medium_armor') || battalions.includes('light_armor')) return 'armor';
  if (battalions.includes('mountaineers')) return 'mountaineers';
  if (battalions.includes('motorized')) return 'motorized';
  if (battalions.includes('artillery') && !battalions.includes('infantry')) return 'artillery';
  return 'infantry';
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
  const addStat = (key: string, label: string, icon: string, caption = label) => {
    const box = el('div', 'hud-stat');
    const v = el('span', 'hud-stat-v', '0');
    box.title = label;
    box.setAttribute('aria-label', label);
    const line = el('span', 'hud-chip-line');
    line.append(iconNode('hud-res-icon', `icons/${icon}.svg`), v);
    // The caption is the point of this row. A symbol over a number says what
    // kind of thing it is at best -- 「記号しかなく何か分からない」 -- and two
    // of these icons are a bank and a pair of scales, which is not a reading
    // anyone can be expected to arrive at.
    box.append(line, el('span', 'hud-chip-c', caption));
    stats.append(box);
    statNodes[key] = v;
  };
  addStat('pp', UI.politicalPower, 'ui-political_power');
  // Stability and war support sit next to political power in the real game's
  // top bar, because all three are the same decision seen from three sides.
  addStat('stab', UI.stability, 'ui-stability');
  addStat('ws', UI.warSupport, 'ui-war_support', UI.warSupportShort);
  addStat('mp', UI.manpower, 'ui-manpower');
  addStat('fuel', UI.fuel, 'ui-fuel');
  addStat('civ', UI.civFactories, 'ui-factory');
  addStat('mil', UI.milFactories, 'ui-military_factory');
  // No division count. HOI4's top bar does not carry one, the army panel does,
  // and with the captions on it was the eighth chip in seven chips of room --
  // measured at 446px of content in a 396px strip.

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
  // Tapping your own flag opens politics, which is where the real game puts
  // it: there is no room for a seventh tab on a 412px screen, and the flag is
  // already the thing that means "my country".
  const identity = el('button', 'hud-identity');
  identity.setAttribute('aria-label', UI.navPolitics);
  identity.append(flag, nameBox);
  identity.addEventListener('click', () => togglePanel('politics'));

  const topRow = el('div', 'hud-top-row');
  topRow.append(identity, el('div', 'hud-spacer'), clock);

  // --- resource strip ------------------------------------------------------
  // Its own row under the figures, not absolutely positioned 48px down: that
  // offset was measured against a one-row top bar and left the strip lying
  // across the figures the moment the bar needed two rows.
  const resStrip = el('div', 'hud-resources');
  const resNodes: Partial<Record<ResourceType, HTMLElement>> = {};
  for (const r of RESOURCE_TYPES) {
    // A button, not a label. The chip that has gone red is the most direct
    // route to the panel where the shortage is fixed, and on a phone there is
    // no hover to explain what a number means or what to do about it.
    const chip = el('button', 'hud-res');
    chip.addEventListener('click', () => togglePanel('trade'));
    const icon = iconNode('hud-res-icon', `icons/resource-${r}.svg`);
    const v = el('span', 'hud-res-v', '0');
    // Icon and number only. Six labelled chips need 493px on a 412px screen,
    // so the last resource was simply cut off by the screen edge; the icon
    // already identifies the resource, and the name stays as the accessible
    // label for anyone who needs it.
    chip.title = RESOURCE[r];
    chip.setAttribute('aria-label', RESOURCE[r]);
    const line = el('span', 'hud-chip-line');
    line.append(icon, v);
    // The short form under the icon: タングステン widens its chip past what the
    // row can carry, and the full name stays as the accessible label.
    chip.append(line, el('span', 'hud-chip-c', RESOURCE_SHORT[r]));
    resStrip.append(chip);
    resNodes[r] = v;
  }

  // --- map modes -----------------------------------------------------------
  // Anchored top-right rather than floating over the middle of the map: a
  // control in the centre of the screen steals the pinch gestures that belong
  // to the map underneath it.
  const modeBar = el('div', 'hud-modes');
  // Shown only while a panel is open, when the column has nowhere to go: it
  // opens the list on demand rather than the list standing over the map.
  const modeToggle = el('button', 'hud-modes-toggle', '⊞');
  modeToggle.setAttribute('aria-label', UI.mapMode);
  modeToggle.addEventListener('click', () => modeBar.classList.toggle('is-open'));
  modeBar.append(modeToggle);
  const modeButtons: HTMLElement[] = [];
  for (const [mode, label] of MAP_MODES) {
    const b = el('button', 'hud-mode', label);
    b.dataset.mode = mode;
    b.addEventListener('click', () => {
      game.setMapMode(mode);
      modeBar.classList.remove('is-open');
      syncModes();
    });
    modeButtons.push(b);
    modeBar.append(b);
  }

  // --- the marquee tool ----------------------------------------------------
  // At the foot of the map-mode column, because it is the same kind of thing:
  // something that changes what the next touch on the map means. Its own
  // class, so the collapse rule that hides the mode buttons behind one button
  // when a panel is open leaves it alone -- it is not a mode, and a tool the
  // player cannot reach with a panel open is a tool for a screen they are not
  // looking at.
  const selectTool = el('button', 'hud-select-tool', UI.boxSelectTool);
  selectTool.setAttribute('aria-label', UI.boxSelectToolLabel);
  selectTool.addEventListener('click', () => {
    game.boxSelectArmed = !game.boxSelectArmed;
    syncSelectTool();
  });
  modeBar.append(selectTool);

  function syncSelectTool(): void {
    selectTool.classList.toggle('is-active', game.boxSelectArmed);
    selectTool.setAttribute('aria-pressed', String(game.boxSelectArmed));
    armedHint.classList.toggle('is-on', game.boxSelectArmed);
    if (!game.boxRaisesArmy) setText(armedHint, UI.boxSelectArmed);
  }

  // Says what the armed tool will do. The button alone cannot: two Japanese
  // characters in a corner do not explain a gesture nobody has made yet.
  const armedHint = el('div', 'hud-armed', UI.boxSelectArmed);

  // --- order bar -----------------------------------------------------------
  // One gesture has to do two jobs on a touch screen: reading the map and
  // commanding the army. This says which job the next tap will do, and gives
  // the player a way out that is not "tap the counter again and hope".
  //
  // It is also where a selection becomes a formation. The chain of command
  // was reachable only from the 軍 panel, which is a list of armies -- so the
  // player could put divisions in an army they had already made, and had no
  // way at all to point at some divisions on the map and say "these are an
  // army". The two buttons here close that loop without leaving the map.
  const orderHint = el('div', 'hud-order');
  const orderRow = el('div', 'hud-order-row');
  const orderText = el('span', 'hud-order-text', '');
  // Calling off a march. `stopDivisions` has been in the command bus since it
  // was written and nothing had ever sent it: an order, once given, could not
  // be taken back -- the only way to stop a division was to order it somewhere
  // else. It appears only while something is actually moving, so the bar stays
  // as narrow as it can.
  const orderStop = el('button', 'hud-order-btn', UI.orderStop);
  orderStop.setAttribute('aria-label', UI.orderStopLabel);
  orderStop.addEventListener('click', () => {
    game.issue({ t: 'stopDivisions', divisions: [...game.selection.divisions] });
    syncOrder();
  });
  const orderAssign = el('button', 'hud-order-btn', UI.orderAssign);
  orderAssign.setAttribute('aria-label', UI.orderAssignLabel);
  // No 戦線 or 進攻 button here. Both used to live on this bar and both named
  // a country to aim at; the reference draws a plan on the ground instead --
  // 「前線は国ごとの選択じゃなくて自分で国境などに引く」 -- and that is what the
  // battle-plan bar below does now. Two ways to give the same order is one way
  // too many on a 412px screen, and the one that survives is the one that lets
  // the player put the line where they want it.
  const orderCancel = el('button', 'hud-order-cancel', '✕');
  orderCancel.setAttribute('aria-label', UI.cancel);
  orderCancel.addEventListener('click', () => {
    game.unitSelected = false;
    game.selectProvince(null);
    syncOrder();
  });
  // One row, 40px, exactly as tall as the banner it replaces. A second row of
  // buttons was tried and it put the bar 84px down the map band -- and the
  // top bar grows a chip during play, so --hud-top-h pushes the whole thing
  // lower as the game runs. Measured: a tap aimed at a counter at y=266
  // landed on the second row's 軍へ編成 button and opened its menu, while
  // elementFromPoint checked a moment earlier had said CANVAS.
  orderRow.append(orderText, orderStop, orderAssign, orderCancel);
  const orderMenu = el('div', 'hud-order-menu');
  orderHint.append(orderRow, orderMenu);

  /** Which button opened the chip row, so pressing it again closes it. */
  let orderMenuMode: 'army' | null = null;
  let lastOrderSignature = '';

  function closeOrderMenu(): void {
    orderMenuMode = null;
    orderMenu.innerHTML = '';
    orderMenu.classList.remove('is-on');
    orderAssign.classList.remove('is-on');
  }

  function orderChip(label: string, onPick: () => void): HTMLElement {
    const chip = el('button', 'hud-order-chip', label);
    chip.addEventListener('click', () => {
      onPick();
      closeOrderMenu();
      syncOrder();
    });
    return chip;
  }

  orderAssign.addEventListener('click', () => {
    if (orderMenuMode === 'army') { closeOrderMenu(); return; }
    closeOrderMenu();
    orderMenuMode = 'army';
    orderAssign.classList.add('is-on');
    const state = game.state;
    const me = state.meta.playerCountry;
    const divisions = [...game.selection.divisions];
    for (const army of (state.armies ?? []).filter((a) => a.owner === me && !a.isArmyGroup)) {
      orderMenu.append(orderChip(
        `${army.name} · ${army.divisions.length}${UI.divisionsInArmy}`,
        () => {
          game.issue({ t: 'assignDivisions', country: me, army: army.id, divisions });
          game.selectDivisions(divisions, { army: army.id, centre: false });
        },
      ));
    }
    const ownArmies = (): number[] => (game.state.armies ?? [])
      .filter((a) => a.owner === me && !a.isArmyGroup)
      .map((a) => a.id);
    if (ownArmies().length < MAX_ARMIES) {
      orderMenu.append(orderChip(UI.orderNewArmy, () => { game.raiseArmy(divisions); }));
    }
    orderMenu.classList.add('is-on');
  });

  function syncOrder(): void {
    // Counted live rather than from the selection array: the divisions in it
    // were alive when the counter was tapped, and a stack that has since been
    // destroyed must not leave the map in ordering mode.
    let live = 0;
    if (game.unitSelected) {
      for (const id of game.selection.divisions) {
        const d = game.state.divisions[id];
        if (d && !d.dead) live++;
      }
      if (live === 0) game.unitSelected = false;
    }
    const on = live > 0;
    orderHint.classList.toggle('is-on', on);
    if (!on) { closeOrderMenu(); return; }
    setText(orderText, UI.orderHint(live));


    let marching = 0;
    for (const id of game.selection.divisions) {
      const d = game.state.divisions[id];
      if (d && !d.dead && d.path.length > 0) marching++;
    }
    orderStop.style.display = marching > 0 ? '' : 'none';

    // An open chip row covers the map. Anything that changes what is selected
    // means the player has gone back to the ground, so it stops standing over
    // the place they are about to press.
    const signature = `${game.selection.province}:${live}:${game.selection.army}`;
    if (signature !== lastOrderSignature) {
      lastOrderSignature = signature;
      if (orderMenuMode !== null) closeOrderMenu();
    }
  }

  let marqueeOn = false;
  function syncMarquee(): void {
    const box = game.boxSelect;
    if (!box) {
      if (marqueeOn) { marqueeOn = false; marquee.classList.remove('is-on'); }
      return;
    }
    marqueeOn = true;
    marquee.classList.add('is-on');
    marquee.style.left = `${Math.min(box.x0, box.x1)}px`;
    marquee.style.top = `${Math.min(box.y0, box.y1)}px`;
    marquee.style.width = `${Math.abs(box.x1 - box.x0)}px`;
    marquee.style.height = `${Math.abs(box.y1 - box.y0)}px`;
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

  // --- the tab strip -------------------------------------------------------
  //
  // At the top, under the national figures, which is where the reference puts
  // it: HOI4's tabs are a row of icons directly beneath the resource line, and
  // the bottom of its screen belongs to the officers. This used to be a
  // bottom bar of icon-plus-label, which is the phone convention and not this
  // game's -- and it was standing where the commander strip goes.
  //
  // Icons without labels, because eight labelled tabs do not fit across 412px
  // and the labels were already clipped: 徴兵 and 国家方針 in the same 51px
  // slot. The label survives as the accessible name.
  const nav = el('div', 'hud-nav');
  const navButtons: HTMLElement[] = [];
  for (const [id, label, icon] of NAV) {
    const b = el('button', 'hud-nav-btn');
    b.dataset.panel = id;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(iconNode('hud-nav-icon', `icons/${icon}.svg`));
    b.addEventListener('click', () => togglePanel(id));
    navButtons.push(b);
    nav.append(b);
  }

  // --- the officer strip ---------------------------------------------------
  //
  // The row of generals along the foot of the screen, which is the shape of
  // the reference and the one part of its chrome this had nothing at all
  // standing in for. Each card is an army: its commander, its name, and the
  // divisions it holds against what its general can actually command.
  //
  // It is not decoration. Until now the only way to find out that the 3rd
  // Army was nineteen divisions over its general's limit -- which costs every
  // one of them a share of his bonuses -- was to open the command panel and
  // expand the card. Here it is on screen the whole time, and tapping it puts
  // that army under orders on the map.
  const officers = el('div', 'hud-officers');
  let lastOfficerKey = '';

  function syncOfficers(): void {
    const state = game.state;
    const me = state.meta.playerCountry;
    const mine = (state.armies ?? []).filter((a) => a.owner === me && !a.isArmyGroup);
    // Keyed on everything drawn, so the strip is rebuilt when it changes and
    // left alone the rest of the time -- it sits under the player's thumb and
    // a row that rebuilds every frame cannot be tapped.
    const key = mine
      .map((a) => `${a.id}:${a.name}:${a.commander}:${a.divisions.length}`
        + `:${a.order?.kind ?? '-'}:${a.executing === true ? 'x' : '-'}`)
      .join('|');
    if (key === lastOfficerKey) return;
    lastOfficerKey = key;

    officers.innerHTML = '';
    officers.classList.toggle('is-empty', mine.length === 0);
    for (const army of mine) {
      const commander = commanderById(state, army.commander);
      const limit = commander ? commandLimit(commander) : COMMAND_LIMIT;
      const over = army.divisions.length > limit;

      // A div rather than a button: the execute pair above the portrait are
      // buttons of their own and HTML will not nest one inside another. The
      // card still takes a tap anywhere that is not one of them.
      const card = el('div', 'hud-officer');
      card.dataset.army = String(army.id);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.classList.toggle('is-over', over);
      card.title = commander ? `${commander.name} — ${army.name}` : army.name;

      // 「将軍のアイコンの上の計画実行ボタン（矢印のあるボタン）をクリックして
      // 軍や軍集団ごとに実行し、停止する場合は計画実行ボタン左側の赤いボタンを
      // クリック」 -- the stop on the left, the arrow on the right, both above
      // the portrait, and both dead until the army has a plan to run.
      const planned = army.order !== null;
      const running = army.executing === true;
      const planRow = el('div', 'hud-officer-plan');
      const stop = el('button', 'hud-plan-btn is-stop', '■');
      stop.setAttribute('aria-label', UI.planStop);
      stop.title = UI.planStop;
      stop.disabled = !planned || !running;
      const go = el('button', 'hud-plan-btn is-go', '▶');
      go.setAttribute('aria-label', UI.planExecute);
      go.title = UI.planExecute;
      go.disabled = !planned || running;
      go.classList.toggle('is-live', running);
      for (const [btn, executing] of [[stop, false], [go, true]] as [HTMLButtonElement, boolean][]) {
        btn.addEventListener('click', (e) => {
          // The card beneath takes a tap as "select this army"; the buttons
          // are not that.
          e.stopPropagation();
          game.issue({ t: 'setPlanExecution', country: me, army: army.id, executing });
          syncOfficers();
        });
      }
      planRow.append(stop, go);
      card.append(planRow);
      card.classList.toggle('is-executing', running);

      const plate = el('div', 'hud-officer-plate');
      if (commander) {
        const face = el('img', 'hud-officer-face');
        face.alt = '';
        // His own photograph where there is one -- these are real men and the
        // reference's painted officers are painted from the same pictures --
        // and a drawn silhouette where there is not. Asked from a generated
        // index rather than by requesting the file and reading the 404, which
        // is a thing the asset test counts.
        face.src = assetUrl(PHOTOGRAPHED.has(commander.defId)
          ? `portraits/${commander.defId}.webp`
          : `portraits/fallback-${commander.id % 8}.svg`);
        face.addEventListener('error', () => { face.removeAttribute('src'); });
        plate.append(face);
        if (commander.rank === 'field_marshal') plate.classList.add('is-marshal');
      } else {
        // An empty frame, which is what the reference puts either side of its
        // officers and what this actually is: a formation with nobody in
        // charge of it. Giving it a portrait anyway made five armies with no
        // general into five copies of the same man.
        plate.classList.add('is-vacant');
      }

      card.append(
        plate,
        el('span', 'hud-officer-name', commander?.name ?? army.name),
        el('span', 'hud-officer-count', `${army.divisions.length}/${limit}`),
      );
      card.addEventListener('click', () => {
        if (army.divisions.length === 0) { game.openPanel?.('command'); return; }
        game.selectDivisions([...army.divisions], { army: army.id });
      });
      officers.append(card);
    }

    // The ＋ at the end of the row, which the reference has at both ends of
    // its own. Pressing it arms the marquee in "raise a formation" mode: the
    // rectangle that follows becomes the army, whatever those divisions
    // belonged to before. 「下の追加から範囲選択して未所属、他の軍に所属してる
    // 師団を新たに一つの軍にできたりとか、今一個ずつタップで編成に加えてる」.
    if (mine.length < MAX_ARMIES) {
      const add = el('button', 'hud-officer hud-officer-add');
      add.title = UI.newArmyFromBox;
      add.setAttribute('aria-label', UI.newArmyFromBox);
      add.append(el('span', 'hud-officer-plus', '＋'), el('span', 'hud-officer-name', UI.orderNewArmy));
      add.addEventListener('click', () => {
        game.boxSelectArmed = true;
        game.boxRaisesArmy = true;
        syncSelectTool();
        setText(armedHint, UI.newArmyArmed);
      });
      officers.append(add);
    }
  }

  // --- the force panel -----------------------------------------------------
  // 「範囲選択したら横に出るんだよ」. The reference keeps a list of what is under
  // orders beside the map, and that list is where a formation is put together:
  // tick rows, drop rows, raise an army out of what is ticked. Without it a
  // rectangle drawn on the map produced a selection that was nowhere on
  // screen -- the order bar said 「24個師団」 and that was all -- which is what
  // 「全然範囲選択できてないやん」 was about. The box worked; nothing showed for it.
  const force = el('div', 'hud-force');
  const forceHead = el('button', 'hud-force-head');
  const forceTitle = el('span', 'hud-force-title', '');
  const forceCount = el('span', 'hud-force-count', '');
  forceHead.append(forceTitle, forceCount);
  forceHead.addEventListener('click', () => {
    force.classList.toggle('is-shut');
    forceHead.setAttribute(
      'aria-label', force.classList.contains('is-shut') ? UI.forceExpand : UI.forceCollapse,
    );
    measureBand();
  });
  const forceTools = el('div', 'hud-force-tools');
  const forceList = el('div', 'hud-force-list');
  force.append(forceHead, forceTools, forceList);

  /** Keyed on everything drawn, so the list is left alone between changes. */
  let lastForceKey = '';

  function forceButton(label: string, onPick: () => void): HTMLButtonElement {
    const btn = el('button', 'hud-force-btn', label);
    btn.addEventListener('click', () => {
      // The list changing the selection is not a reason for the list to fold
      // away: the player is editing, and the next thing they want is the row
      // below the one they just used.
      game.forceShouldOpen = true;
      onPick();
    });
    return btn;
  }

  /** The set of divisions the list last opened itself for. */
  let lastForceSet = '';

  function syncForce(): void {
    const state = game.state;
    const me = state.meta.playerCountry;
    if (game.forceShouldShut) {
      game.forceShouldShut = false;
      force.classList.add('is-shut');
      measureBand();
    }
    const live = game.selection.divisions
      .map((id) => state.divisions[id])
      .filter((d) => d && !d.dead && d.owner === me);
    const on = live.length > 0;
    force.classList.toggle('is-on', on);
    if (!on) { lastForceKey = ''; return; }

    const army = game.selection.army === null ? null : armyById(state, game.selection.army);
    const key = `${army?.id ?? -1}:${army?.name ?? ''}:${live
      .map((d) => `${d.id}:${d.provinceId}:${d.combatId !== null ? 'c' : ''}${d.detached ? 'd' : ''}`)
      .join(',')}`;
    // A rectangle opens the list; everything else leaves it folded to its
    // header. The header alone is what says the selection happened -- which is
    // the thing that was missing -- and it costs 40px of the corner instead of
    // half the map. Keyed on the set of divisions rather than the whole row
    // state: the key below changes every time a division crosses a province,
    // and a list that reopened itself for that could not be put away.
    const set = live.map((d) => d.id).join(',');
    if (set !== lastForceSet) {
      lastForceSet = set;
      force.classList.toggle('is-shut', !game.forceShouldOpen);
      game.forceShouldOpen = false;
      measureBand();
    }
    if (key === lastForceKey) return;
    lastForceKey = key;

    const commander = army ? commanderById(state, army.commander) : null;
    const limit = commander ? commandLimit(commander) : COMMAND_LIMIT;
    setText(forceTitle, army
      ? `${army.name}${commander ? ` · ${commander.name}` : ''}`
      : UI.forceTitle);
    setText(forceCount, army ? `${army.divisions.length}/${limit}` : String(live.length));

    forceTools.innerHTML = '';
    forceTools.append(el('span', 'hud-force-n', UI.selectedCount(live.length)));
    // Raising a formation out of whatever is ticked, wherever those divisions
    // came from: 「他に所属してる師団だったら抜けて新たに」. `assignDivisions`
    // moves a division between armies, so one command does both halves.
    if ((state.armies ?? []).filter((a) => a.owner === me && !a.isArmyGroup).length < MAX_ARMIES) {
      forceTools.append(forceButton(UI.forceNewArmy, () => {
        game.raiseArmy(live.map((d) => d.id));
        syncForce();
      }));
    }
    if (live.some((d) => d.armyId !== null)) {
      forceTools.append(forceButton(UI.forceDetach, () => {
        game.issue({
          t: 'assignDivisions', country: me, army: null, divisions: live.map((d) => d.id),
        });
        syncForce();
      }));
    }
    // Getting rid of a formation, where the player is when they want to.
    // 「軍の削除ができない」: the button existed, at the bottom of the command
    // panel's army card -- which since the order of battle became a list of
    // every division is twenty-four rows down a scrolling sheet.
    if (army) {
      forceTools.append(forceButton(UI.forceDisband, () => {
        game.issue({ t: 'disbandArmy', country: me, army: army.id });
        game.selectDivisions([], { centre: false });
        game.unitSelected = false;
        syncForce();
        syncOrder();
        syncOfficers();
      }));
    }
    forceTools.append(forceButton(UI.forceClear, () => {
      game.selectDivisions([], { centre: false });
      game.unitSelected = false;
      syncForce();
      syncOrder();
    }));

    forceList.innerHTML = '';
    for (const d of live) {
      const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
      const row = el('button', 'hud-force-row');
      row.append(iconNode('hud-force-sym', `units/${symbolOf(tpl?.battalions ?? [])}.svg`));
      const main = el('span', 'hud-force-main');
      main.append(el('span', 'hud-force-name',
        UI.divisionName(d.ordinal, tpl?.name ?? UI.newTemplate)));
      const tag = d.combatId !== null ? UI.inCombat
        : d.detached ? UI.detached
          : d.path.length > 0 ? UI.onTheMove : game.index.get(d.provinceId).name;
      main.append(el('span', 'hud-force-sub', tag));
      row.append(main);
      if (d.combatId !== null) row.classList.add('is-fighting');
      // Tapping a row drops it out of the selection, which is the whole point
      // of a list you can see: a rectangle catches more than you meant, and
      // this is where the extras come off.
      row.addEventListener('click', () => {
        game.forceShouldOpen = true;
        const next = game.selection.divisions.filter((id) => id !== d.id);
        game.selectDivisions(next, { army: game.armyOf(next), centre: false });
        if (next.length === 0) game.unitSelected = false;
        syncForce();
        syncOrder();
      });
      forceList.append(row);
    }
  }

  // --- the battle-plan bar -------------------------------------------------
  // 「下の戦闘計画のタブから色々できる」. The reference hangs a row of tools
  // along the foot of the screen, above the officers, and every plan on the
  // map is drawn with one of them in hand. Picking one up arms the next
  // stroke; drawing with it issues the order and puts the tool down again.
  const planBar = el('div', 'hud-plans');
  const planTools = el('div', 'hud-plan-tools');
  const planHint = el('div', 'hud-plan-hint', '');
  planBar.append(planHint, planTools);

  const TOOLS: [Exclude<PlanTool, null>, string, string, string][] = [
    ['front', UI.toolFront, UI.toolFrontHint, 'plan-front'],
    ['offensive', UI.toolOffensive, UI.toolOffensiveHint, 'plan-offensive'],
    ['spearhead', UI.toolSpearhead, UI.toolSpearheadHint, 'plan-spearhead'],
    ['garrison', UI.toolGarrison, UI.toolGarrisonHint, 'plan-garrison'],
    ['invade', UI.toolInvade, UI.toolInvadeHint, 'plan-invade'],
    // No 海上輸送 tool. 「海上輸送は作戦じゃない」 -- a transfer by sea is what a
    // move order does when there is no road, not a plan the player draws, so
    // it lives in `orderMove` and nowhere on this bar.
  ];
  const toolNodes = new Map<Exclude<PlanTool, null>, HTMLButtonElement>();
  for (const [tool, label, hint, icon] of TOOLS) {
    const btn = el('button', 'hud-plan-tool');
    btn.title = `${label} — ${hint}`;
    btn.setAttribute('aria-label', label);
    btn.dataset.tool = tool;
    btn.append(iconNode('hud-plan-icon', `icons/${icon}.svg`), el('span', 'hud-plan-l', label));
    btn.addEventListener('click', () => {
      // Pressing the tool you are already holding puts it down, which is the
      // only way off a mode on a screen with no escape key.
      game.planTool = game.planTool === tool ? null : tool;
      game.planDraft = [];
      syncPlanBar();
    });
    toolNodes.set(tool, btn);
    planTools.append(btn);
  }

  // Execute and halt, for every army at once: the reference has this pair on
  // the bar as well as on each general, because a plan drawn across four
  // armies is started as one act.
  const planGo = el('button', 'hud-plan-tool is-go');
  planGo.title = UI.planExecute;
  planGo.setAttribute('aria-label', UI.planExecute);
  planGo.append(el('span', 'hud-plan-glyph', '▶'), el('span', 'hud-plan-l', UI.planExecute));
  const planStop = el('button', 'hud-plan-tool is-stop');
  planStop.title = UI.planStop;
  planStop.setAttribute('aria-label', UI.planStop);
  planStop.append(el('span', 'hud-plan-glyph', '■'), el('span', 'hud-plan-l', UI.planStop));
  for (const [btn, executing] of [[planGo, true], [planStop, false]] as
    [HTMLButtonElement, boolean][]) {
    btn.addEventListener('click', () => {
      const me = game.state.meta.playerCountry;
      for (const a of game.state.armies ?? []) {
        if (a.owner !== me || a.order === null) continue;
        game.issue({ t: 'setPlanExecution', country: me, army: a.id, executing });
      }
      syncPlanBar();
      syncOfficers();
    });
  }
  planTools.append(planStop, planGo);

  const planClear = el('button', 'hud-plan-tool is-clear');
  planClear.title = UI.toolClearHint;
  planClear.setAttribute('aria-label', UI.toolClear);
  planClear.append(
    iconNode('hud-plan-icon', 'icons/plan-clear.svg'), el('span', 'hud-plan-l', UI.toolClear),
  );
  planClear.addEventListener('click', () => {
    const army = game.selection.army;
    if (army === null) { planHint.textContent = UI.planNeedsArmy; return; }
    game.issue({
      t: 'setArmyOrder', country: game.state.meta.playerCountry, army, order: null,
    });
    planHint.textContent = UI.planCleared;
    syncPlanBar();
  });
  planTools.append(planClear);

  /** Cleared when the next message replaces it, so two do not race. */
  let transportNotice = 0;

  function syncPlanBar(): void {
    for (const [tool, btn] of toolNodes) {
      const on = game.planTool === tool;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    const held = TOOLS.find(([t]) => t === game.planTool);
    if (held) {
      // With a line already drawn, the tool does two things and the hint has to
      // say which is which: grabbing an end lengthens or shortens it, starting
      // clear of it draws a new one.
      const army = game.selection.army === null
        ? null : armyById(game.state, game.selection.army);
      const drawn = army?.order?.kind === 'line' && army.order.anchors.length > 0;
      planHint.textContent = game.selection.army === null ? UI.planNeedsArmy
        : (held[0] === 'front' && drawn) ? UI.toolFrontExtendHint : held[2];
    }
    else if (planHint.textContent === UI.planNeedsArmy) planHint.textContent = '';
    planBar.classList.toggle('is-armed', game.planTool !== null);
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
  // --- alerts --------------------------------------------------------------
  const alertRow = el('div', 'hud-alerts');
  let lastAlertKey = '';

  function syncAlerts(): void {
    const alerts = collectAlerts(game);
    const key = alerts.map((a) => `${a.id}:${a.text}`).join('|');
    if (key === lastAlertKey) return;
    lastAlertKey = key;
    alertRow.innerHTML = '';
    alertRow.classList.toggle('is-empty', alerts.length === 0);
    for (const a of alerts) {
      const chip = el('button', 'hud-alert');
      chip.classList.toggle('is-urgent', a.urgent);
      chip.title = a.title;
      chip.setAttribute('aria-label', a.title);
      const line = el('span', 'hud-chip-line');
      line.append(iconNode('hud-res-icon', `icons/${a.icon}.svg`));
      if (a.text !== '') line.append(el('span', 'hud-alert-v', a.text));
      chip.append(line, el('span', 'hud-chip-c', a.caption));
      chip.addEventListener('click', () => togglePanel(a.panel));
      alertRow.append(chip);
    }
    markOverflow();
  }

  // Alerts, figures and resources are one scrolling band, not three stacked
  // rows. Measured before this: the bar took 225px of a 915px screen -- 24.6%
  // of the phone, against 11% in the reference, and 「上側が圧迫しすぎてる」
  // is what that looks like. The three rows were 68 + 36 and the gaps between
  // them; side by side in one 38px band they cost 38.
  //
  // The order is alerts, then the national figures, then resources: the band
  // starts at the left, and what is wrong with the country should be the first
  // thing under the eye rather than the thing that has scrolled away.
  const figures = el('div', 'hud-figures');
  figures.append(alertRow, stats, resStrip);
  top.append(topRow, figures, nav);

  // The rubber band, in the document rather than on the canvas: it is a band
  // on the glass, and drawing it here costs four style writes a frame instead
  // of a Graphics rebuild.
  const marquee = el('div', 'hud-marquee');
  root.append(
    top, modeBar, force, armedHint, marquee, orderHint, planBar, toasts, officers,
    sheet, outcome,
  );

  // Everything below the top bar is placed against its measured height rather
  // than a constant. The constant was 78px, chosen when the bar was one row;
  // the bar grows with the safe-area inset and with the text size the player
  // has chosen, and the map-mode buttons were landing on top of it.
  const measureTop = () => {
    root.style.setProperty('--hud-top-h', `${Math.round(top.getBoundingClientRect().height)}px`);
  };
  // The strip of map a player can actually see, which is what the map-mode
  // column has to fit inside: the sheet covers everything below it.
  function measureBand(): void {
    const topH = top.getBoundingClientRect().height;
    // The officer strip is the floor when no panel is open. Measured rather
    // than assumed: it is empty before the first army is raised, and a
    // constant 56px was the height of a tab bar that no longer lives there.
    const officersH = officers.classList.contains('is-empty')
      ? 0 : Math.round(officers.getBoundingClientRect().height);
    // The plan bar stands on the officers, so it needs their height to place
    // itself, and everything above the two needs the sum.
    root.style.setProperty('--hud-officers-h', `${officersH}px`);
    const footH = officersH + Math.round(planTools.getBoundingClientRect().height);
    root.style.setProperty('--hud-foot-h', `${footH}px`);
    const sheetTop = sheet.classList.contains('is-open')
      ? sheet.getBoundingClientRect().top
      : window.innerHeight - footH;
    root.style.setProperty('--map-band', `${Math.max(60, Math.round(sheetTop - topH))}px`);
  }

  /**
   * The fade at the trailing edge belongs on a row that continues off-screen,
   * and nowhere else. The stats row is 395px of content in 396px of space, so
   * a mask that starts at 94% was greying out the last chip on a row that fits.
   */
  // One scroller now, so one thing to mark. The groups inside it do not
  // scroll on their own any more.
  const scrollRows = [figures];
  function markOverflow(): void {
    for (const row of scrollRows) {
      row.classList.toggle('is-clipped', row.scrollWidth > row.clientWidth + 1);
    }
  }

  // A panel can ask to get out of the way; putting an army under orders does,
  // because the next thing the player does is tap the ground underneath.
  setSheetCloser(() => { togglePanel(null); });

  const topObserver = new ResizeObserver(() => { measureTop(); measureBand(); markOverflow(); });
  topObserver.observe(top);
  topObserver.observe(officers);
  measureTop();
  measureBand();
  markOverflow();

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
      // A new panel starts at its own top. The body is one scrolling element
      // reused by every panel, so opening the relations sheet from a country
      // three screens down the diplomacy list used to land halfway through the
      // action list, with the flag and the name above the fold.
      sheetBody.scrollTop = 0;
      sheet.classList.add('is-open');
    }
    for (const b of navButtons) b.classList.toggle('is-active', b.dataset.panel === openPanel);
    root.classList.toggle('is-panel-open', openPanel !== null);
    modeBar.classList.remove('is-open');
    measureBand();
  }

  // Panels that are not nav destinations open from inside another panel: the
  // designer from the army list, the province sheet from a tap on the map.
  game.openPanel = (id) => togglePanel(id as PanelId | null);

  /** Two panels are titled with the thing they are showing. */
  function panelTitle(id: PanelId): string {
    if (id === 'nation') {
      return UI.relationsWith(country(game.state.countries[openNationId()].tag));
    }
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

  /**
   * Fails here rather than sixty times a second.
   *
   * `statNodes` is keyed by string, so dropping a chip from the top bar and
   * leaving its tween behind type-checks perfectly and then throws inside the
   * frame loop, where it takes the whole HUD down every frame and shows up as
   * eight unrelated browser tests failing. Once, at mount, is where a missing
   * figure should be found -- the boot guard reports it and the boot test
   * catches it.
   */
  const statNode = (key: string): HTMLElement => {
    const node = statNodes[key];
    if (!node) throw new Error(`hud: no top-bar figure "${key}"`);
    return node;
  };

  const tweens = {
    pp: new NumberTween(statNode('pp'), formatNumber),
    mp: new NumberTween(statNode('mp'), formatNumber),
    civ: new NumberTween(statNode('civ'), (v) => String(Math.round(v))),
    mil: new NumberTween(statNode('mil'), (v) => String(Math.round(v))),
    stab: new NumberTween(statNode('stab'), (v) => `${Math.round(v)}%`),
    ws: new NumberTween(statNode('ws'), (v) => `${Math.round(v)}%`),
    fuel: new NumberTween(statNode('fuel'), (v) => String(Math.round(v))),
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
    syncAlerts();
    syncOfficers();
    tweens.stab.set(me.stability * 100, dt);
    tweens.ws.set(me.warSupport * 100, dt);
    tweens.fuel.set(me.economy.fuel, dt);
    statNodes.fuel.classList.toggle('is-short', me.economy.fuelRatio < 0.999);

    for (const r of RESOURCE_TYPES) {
      const flow = me.economy.resources[r];
      // A chip that has read zero since 1936 is not information. Six of the
      // fourteen in the top bar were permanently empty, taking a whole row.
      resNodes[r]?.parentElement?.classList.toggle(
        'is-idle', flow.produced === 0 && flow.consumed === 0,
      );
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
    //
    // Except while the selection is an order rather than a question. Putting a
    // stack under orders also names the province it is standing in, and the
    // sheet that opened for it covered the bottom half of the map -- which is
    // where the next tap, the one that says where to go, has to land. Reading
    // the map opens the sheet; commanding the army does not.
    const sel = game.unitSelected ? null : game.selection.province;
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

    syncOrder();
    syncForce();
    syncMarquee();
    // The tool disarms itself when a rectangle is finished, and the button has
    // to stop looking armed at the same moment.
    if (selectTool.classList.contains('is-active') !== game.boxSelectArmed) syncSelectTool();
    // Same for a plan tool: drawing with it puts it down, and the bar has to
    // stop looking armed on the frame that happens.
    if (planBar.classList.contains('is-armed') !== (game.planTool !== null)) syncPlanBar();
    // A transfer that could not be arranged says which of the five reasons it
    // was. An order that silently does nothing is the worst kind of failure on
    // a screen with no status bar.
    if (game.transportBlock !== null) {
      const why = game.transportBlock;
      game.transportBlock = null;
      setText(planHint, why === 'ok'
        ? UI.transportSailing(game.selection.divisions.length, game.sealiftFree())
        : TRANSPORT_WHY[why]);
      planBar.classList.add('is-armed');
      window.clearTimeout(transportNotice);
      transportNotice = window.setTimeout(() => {
        planBar.classList.toggle('is-armed', game.planTool !== null);
      }, 4000);
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
