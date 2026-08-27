import { BitmapText, Container, Graphics } from 'pixi.js';

import type { ProvinceIndex } from '../../sim/map/ProvinceIndex';
import type { CountryId, GameState, ProvinceId } from '../../sim/core/types';
import { Camera } from '../Camera';
import { rgbToHex } from '../palette';
import { FONT_CITY } from './LabelLayer';

/**
 * NATO-style counters, one per stack of divisions in a province.
 *
 * These are the objects the player looks at most, so they are drawn as a
 * physical thing rather than as an outline: a cast shadow lifts the counter off
 * the map, a bevel gives the frame thickness, and a light gradient across the
 * face implies a lit surface. All of it is flat Graphics -- no filters, no
 * render targets -- because a counter per province means three hundred of them
 * and a mobile GPU will not pay for a blur on any of them.
 *
 * Counters are pooled and their artwork is cached against a key, so a stack
 * that has not changed costs one transform write per frame and nothing else.
 */

interface Counter {
  root: Container;
  /** Shadow, frame, face and readouts. One Graphics: one draw call. */
  plate: Graphics;
  symbol: Graphics;
  count: BitmapText;
  /** Cached so a counter that has not changed skips its redraw. */
  key: string;
  /**
   * Which stack this pooled counter is currently showing, and where it was
   * drawn last frame. A counter follows its stack across a province boundary
   * rather than teleporting; when the pool slot is reassigned to a different
   * stack it jumps, because interpolating between two unrelated armies would
   * draw a unit sliding across countries it was never in.
   */
  stack: number;
  x: number;
  y: number;
}

/** An order the player is still dragging out; null once it lands or is cancelled. */
export interface DragOrder {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Province under the finger, or null where the drop would do nothing. */
  target: number | null;
}

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type SymbolKind = 'infantry' | 'motorised' | 'armour' | 'mountain' | 'artillery';

interface Stack {
  province: ProvinceId;
  owner: CountryId;
  divisions: number;
  /** 0..1 average organisation. */
  org: number;
  /** 0..1 average strength. */
  strength: number;
  kind: SymbolKind;
  inCombat: boolean;
  selected: boolean;
  /** Selected *and* taking orders: the next tap on the map moves it. */
  ordering: boolean;
}

/** A counter as the player sees it: where it is drawn, and whose it is. */
export interface CounterHit {
  province: ProvinceId;
  owner: CountryId;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Whether the point that found this counter landed on the counter's own box
   * rather than in the invisible margin grown around it for touch. The caller
   * needs the difference: a tap on the thing itself is not open to
   * reinterpretation, and a tap in the margin is.
   */
  inside: boolean;
}

const PLATE_W = 34;
const PLATE_H = 24;

/** Ink used for every rim, shadow and symbol outline. */
const INK = 0x0b0906;
const SYMBOL = 0xf6f0e2;
/** The counter face, identical for every nation. See `draw`. */
const PLATE_FACE = 0x2b2d33;

/** On-screen counter width in CSS pixels, ramped between these zoom levels. */
const COUNTER_MIN_PX = 14;
const COUNTER_MAX_PX = 24;
const ZOOM_SMALL = 0.05;
const ZOOM_LARGE = 0.28;

/**
 * Counter level of detail.
 *
 * Three hundred provinces means three hundred counters, and at continental zoom
 * they cover the map completely -- the political situation, the front line and
 * every place name disappear under a carpet of unit symbols. So counters
 * aggregate to one per state as the camera pulls back, and vanish entirely at
 * the widest view where the map itself is the information.
 */
const ZOOM_HIDE_COUNTERS = 0.055;
/*
 * Measured before this was raised, on a 412x869 screen: at the zoom the game
 * opens at, 173 counters covered 28.2% of the map, and at 0.3 it was 42.5% --
 * nearly half the board was unit symbols. The threshold sat at 0.13, just
 * below the opening view, so aggregation almost never applied when it was
 * most needed. It now covers the whole of the range a player reads the
 * continent at, and only breaks into per-province counters once the camera is
 * close enough that the provinces themselves are large.
 */
export const ZOOM_AGGREGATE_STATES = 0.22;

/** Below this the bevel and the readouts are smaller than a pixel: skip them. */
const ZOOM_DETAIL = 0.09;

/**
 * The smallest a counter may be to a finger, whatever it is to the eye.
 *
 * The drawn plate is 14 to 24 CSS pixels wide and 10 to 17 tall; the box
 * recorded for it adds 10px of vertical room for the place name underneath,
 * so hit testing starts from 14x20 at the widest zoom and 24x27 at the
 * closest. Both are under the 44px that every touch guideline has asked for
 * since 2010, and the report -- twice -- was that divisions are hard to
 * press. This is the number the box is grown to for hit testing only; the
 * drawn counter is unchanged, because 44px of ink on every province of a
 * front would leave no map underneath it.
 */
export const MIN_TOUCH_PX = 44;

export class UnitLayer {
  readonly container = new Container();
  /** Movement orders, drawn under the counters. */
  private orders = new Graphics();
  private counters = new Container();
  private pool: Counter[] = [];
  /** Last frame's counters in screen space, for hit testing. */
  readonly hitBoxes: CounterHit[] = [];
  private anchors = new Map<number, ProvinceId>();
  private selectedProvince: ProvinceId | null = null;
  /** Every province the current selection occupies, for the rings. */
  private selectedProvinces = new Set<ProvinceId>();
  /** How many plates were drawn with a selection ring last frame; read by tests. */
  litCount = 0;
  private ordering = false;
  private neutral = false;
  private drag: DragOrder | null = null;

  constructor(private index: ProvinceIndex) {
    this.container.eventMode = 'none';
    this.container.addChild(this.orders, this.counters);
  }

  /** Kept for symmetry with the other layers; counters read zoom per frame. */
  setZoom(_zoom: number): void {}

  /**
   * `ordering` is the difference between a province the player is reading and
   * a stack the player is commanding. On a touch screen there is one gesture
   * for both, so the counter has to say which mode the next tap is in --
   * otherwise a tap meant to inspect a neighbour marches the army into it.
   */
  setSelection(id: ProvinceId | null, ordering = false, also?: Iterable<ProvinceId>): void {
    this.selectedProvince = id;
    this.ordering = ordering;
    // Every province the selection stands in, not just the one the tap landed
    // on. A rectangle over twenty-three provinces used to ring one counter --
    // measured: 24 divisions across 23 provinces, one of them lit -- so the
    // player could see that something had been caught but not what.
    this.selectedProvinces.clear();
    if (id !== null) this.selectedProvinces.add(id);
    if (also) for (const p of also) this.selectedProvinces.add(p);
  }

  /**
   * Drops national colouring outside the political map.
   *
   * A terrain or supply view is a single ramp the player is reading for one
   * variable; three hundred counters in thirty national colours sit on top of
   * it arguing for a different one. Neutral plates keep the units locatable
   * without competing with the mode they are drawn over.
   */
  setNeutral(neutral: boolean): void {
    this.neutral = neutral;
  }

  setDrag(drag: DragOrder | null): void {
    this.drag = drag;
  }

  /** Largest province of a state, cached: it is the state's counter position. */
  private stateAnchor(stateId: number): ProvinceId {
    const cached = this.anchors.get(stateId);
    if (cached !== undefined) return cached;
    const members = this.index.data.states[stateId]?.provinces ?? [];
    let best = members[0] ?? 0;
    let bestArea = -1;
    for (const id of members) {
      const area = this.index.get(id).area;
      if (area > bestArea) { bestArea = area; best = id; }
    }
    this.anchors.set(stateId, best);
    return best;
  }

  private acquire(i: number): Counter {
    while (this.pool.length <= i) {
      const root = new Container();
      const plate = new Graphics();
      const symbol = new Graphics();
      const count = new BitmapText({ text: '', style: { fontFamily: FONT_CITY } });
      count.anchor.set(0.5);
      count.scale.set(0.34);
      count.position.set(PLATE_W / 2 - 5, PLATE_H / 2 - 4);
      root.addChild(plate, symbol, count);
      root.visible = false;
      this.counters.addChild(root);
      this.pool.push({ root, plate, symbol, count, key: '', stack: -1, x: 0, y: 0 });
    }
    return this.pool[i];
  }

  update(state: GameState, camera: Camera, elapsed: number, dtMs = 16.667): ScreenRect[] {
    const zoom = Math.max(1e-4, camera.zoom);
    if (zoom < ZOOM_HIDE_COUNTERS) {
      for (const c of this.pool) c.root.visible = false;
      this.orders.clear();
      return [];
    }
    const byState = zoom < ZOOM_AGGREGATE_STATES;
    const dtSeconds = Math.min(0.05, Math.max(0, dtMs) / 1000);
    const stacks = this.collect(state, camera, byState);
    // Counters hold a constant on-screen size, but a plate sized for a corps
    // view swamps a continental one, so the target pixel size ramps with zoom.
    const targetPx = COUNTER_MIN_PX +
      (COUNTER_MAX_PX - COUNTER_MIN_PX) *
      Math.min(1, Math.max(0, (zoom - ZOOM_SMALL) / (ZOOM_LARGE - ZOOM_SMALL)));
    const scale = (targetPx / PLATE_W) / zoom;
    const detailed = zoom >= ZOOM_DETAIL;
    const rects: ScreenRect[] = [];
    // Kept so a tap can ask which counter it landed on. The counter is what
    // the player is aiming at -- it is the drawn thing -- and its rectangle is
    // already computed here for label occlusion.
    this.hitBoxes.length = 0;
    // Counters sit above the province centre so the place name below stays
    // readable; the reserved rects keep labels from sliding under them.
    const liftWorld = (targetPx * 0.85) / zoom;

    this.drawOrders(state, byState, zoom);

    for (let i = 0; i < stacks.length; i++) {
      const s = stacks[i];
      const c = this.acquire(i);
      const p = this.index.provinces[s.province];
      const tx = p.centerX;
      const ty = p.centerY - liftWorld;
      if (c.stack !== s.province) {
        // New occupant of this pool slot: place it, do not fly it in.
        c.stack = s.province;
        c.x = tx;
        c.y = ty;
      } else {
        // Framerate-independent ease, so the follow looks the same at 30fps.
        const k = 1 - Math.pow(0.001, dtSeconds);
        c.x += (tx - c.x) * k;
        c.y += (ty - c.y) * k;
        // Snap once the remainder is under a pixel, so a counter never creeps.
        if (Math.hypot(tx - c.x, ty - c.y) * zoom < 0.5) { c.x = tx; c.y = ty; }
      }
      c.root.visible = true;
      c.root.position.set(c.x, c.y);
      c.root.scale.set(scale);
      const boxX = camera.worldToScreenX(p.centerX);
      const boxY = camera.worldToScreenY(p.centerY - liftWorld);
      this.hitBoxes.push({
        province: s.province,
        owner: s.owner,
        x: boxX,
        y: boxY,
        w: targetPx * (byState ? 0.8 : 1),
        h: ((targetPx * PLATE_H) / PLATE_W + 10) * (byState ? 0.8 : 1),
        inside: false,
      });
      rects.push({
        x: boxX,
        y: boxY,
        // Aggregated counters stand in for a whole state, so they claim a
        // little less than they occupy -- but they must still claim. Returning
        // nothing let labels draw straight underneath, and a country name with
        // its first character covered is not a degraded label, it is a
        // different word: Germany read as "イツ".
        w: targetPx * (byState ? 0.8 : 1),
        h: ((targetPx * PLATE_H) / PLATE_W + 10) * (byState ? 0.8 : 1),
      });

      const color = this.neutral ? 0x4a4d55 : rgbToHex(state.countries[s.owner].color);
      const key = `${color}|${this.neutral}|${s.divisions}|${s.kind}|${Math.round(s.org * 10)}` +
        `|${Math.round(s.strength * 6)}|${s.inCombat}|${s.selected}|${s.ordering}|${detailed}`;
      if (c.key !== key) {
        c.key = key;
        this.draw(c, s, color, detailed);
        c.count.text = String(s.divisions);
        c.count.visible = detailed;
      }
      // Combat pulses the rim rather than the whole counter: fading a unit out
      // reads as "leaving", which is the opposite of what is happening.
      c.root.alpha = 1;
      if (s.inCombat) {
        c.symbol.alpha = 0.75 + 0.25 * Math.abs(Math.sin(elapsed / 210));
      } else if (c.symbol.alpha !== 1) {
        c.symbol.alpha = 1;
      }
    }

    for (let i = stacks.length; i < this.pool.length; i++) this.pool[i].root.visible = false;
    return rects;
  }

  /**
   * Arrows from a moving stack to where it is headed.
   *
   * Without these an order is invisible until the unit arrives, and an order
   * that produces no visible response reads as an order that was not accepted.
   */
  private drawOrders(state: GameState, byState: boolean, zoom: number): void {
    const g = this.orders;
    g.clear();
    this.drawDrag(g, zoom);
    if (byState) return;

    const width = 2.4 / zoom;
    const head = 9 / zoom;
    const seen = new Set<number>();
    for (const d of state.divisions) {
      if (d.dead || d.path.length === 0) continue;
      if (d.owner !== state.meta.playerCountry) continue;
      const from = this.index.provinces[d.provinceId];
      const to = this.index.provinces[d.path[d.path.length - 1]];
      // One arrow per origin/destination pair: a whole army moving together
      // would otherwise draw the same arrow forty times.
      const pair = d.provinceId * 100_000 + d.path[d.path.length - 1];
      if (seen.has(pair)) continue;
      seen.add(pair);

      const dx = to.centerX - from.centerX;
      const dy = to.centerY - from.centerY;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len;
      const uy = dy / len;
      // Stop short of the destination so the head does not sit under its counter.
      const tipX = to.centerX - ux * head;
      const tipY = to.centerY - uy * head;

      g.moveTo(from.centerX, from.centerY);
      g.lineTo(tipX, tipY);
      g.stroke({ color: INK, width: width * 2.1, alpha: 0.5, cap: 'round' });
      g.moveTo(from.centerX, from.centerY);
      g.lineTo(tipX, tipY);
      g.stroke({ color: 0xf2d98a, width, alpha: 0.95, cap: 'round' });

      const nx = -uy;
      const ny = ux;
      g.moveTo(tipX + ux * head, tipY + uy * head);
      g.lineTo(tipX + nx * head * 0.45, tipY + ny * head * 0.45);
      g.lineTo(tipX - nx * head * 0.45, tipY - ny * head * 0.45);
      g.fill({ color: 0xf2d98a, alpha: 0.95 });
    }
  }

  /**
   * The order the finger is still holding.
   *
   * Dragging an army across the map used to produce no response at all until
   * the finger lifted, which on a touch screen is indistinguishable from the
   * gesture not having been recognised. The line follows the finger, a ring
   * marks the province the order would land on, and a cross says the drop
   * would do nothing.
   */
  private drawDrag(g: Graphics, zoom: number): void {
    const d = this.drag;
    if (!d) return;
    const valid = d.target !== null;
    const color = valid ? 0xf2d98a : 0xd8574a;
    const w = 2.6 / zoom;

    g.moveTo(d.fromX, d.fromY);
    g.lineTo(d.toX, d.toY);
    g.stroke({ color: INK, width: w * 2.2, alpha: 0.45, cap: 'round' });
    g.moveTo(d.fromX, d.fromY);
    g.lineTo(d.toX, d.toY);
    g.stroke({ color, width: w, alpha: 0.95, cap: 'round' });

    const r = 13 / zoom;
    if (valid) {
      const p = this.index.provinces[d.target!];
      g.circle(p.centerX, p.centerY, r);
      g.stroke({ color, width: w, alpha: 0.95 });
      g.circle(p.centerX, p.centerY, r * 0.32);
      g.fill({ color, alpha: 0.85 });
    } else {
      const k = r * 0.62;
      g.moveTo(d.toX - k, d.toY - k);
      g.lineTo(d.toX + k, d.toY + k);
      g.moveTo(d.toX + k, d.toY - k);
      g.lineTo(d.toX - k, d.toY + k);
      g.stroke({ color, width: w * 1.2, alpha: 0.95, cap: 'round' });
    }
  }

  private draw(c: Counter, s: Stack, color: number, detailed: boolean): void {
    const g = c.plate;
    g.clear();
    const hw = PLATE_W / 2;
    const hh = PLATE_H / 2;

    // Cast shadow. Offset down only: a single light source high on the screen
    // is what makes a flat plate read as a raised one.
    g.roundRect(-hw + 0.5, -hh + 2.5, PLATE_W, PLATE_H, 4);
    g.fill({ color: 0x000000, alpha: 0.4 });

    // Outer rim.
    g.roundRect(-hw, -hh, PLATE_W, PLATE_H, 4);
    g.fill({ color: INK });

    // One plate material for every nation, with identity carried by a bar down
    // the left edge instead of by the face.
    //
    // Painting the face in the national colour put the symbol at 1.28:1 against
    // a pale nation and grey-on-grey over Germany -- and a German counter
    // standing on German territory then had nothing but its frame separating
    // it from the ground, which is why the frame had to be so heavy. On a
    // constant dark face the symbol holds about 10:1 everywhere, and the
    // colour still reads at a glance because it is the only chroma present.
    g.roundRect(-hw + 2, -hh + 2, PLATE_W - 4, PLATE_H - 4, 2.5);
    g.fill({ color: PLATE_FACE });

    // Wide enough to carry a nation at 25 screen pixels. At a tenth of the
    // plate the bar was there but not readable, and a map where every counter
    // looks the same is worse than one where the symbol is hard to read.
    const barW = 7;
    g.roundRect(-hw + 2, -hh + 2, barW, PLATE_H - 4, 1.6);
    g.fill({ color });
    g.rect(-hw + 2 + barW, -hh + 2, 0.9, PLATE_H - 4);
    g.fill({ color: INK, alpha: 0.75 });

    if (detailed) {
      // Two flat bands instead of a gradient: a real gradient fill costs a
      // texture upload per counter, and at this size the seam is invisible.
      g.rect(-hw + 2 + 7, -hh + 2, PLATE_W - 4 - 7, (PLATE_H - 4) * 0.42);
      g.fill({ color: 0xffffff, alpha: 0.09 });
      g.rect(-hw + 2 + 7, hh - 2 - (PLATE_H - 4) * 0.34, PLATE_W - 4 - 7, (PLATE_H - 4) * 0.34);
      g.fill({ color: 0x000000, alpha: 0.18 });

      // Bevel: light along the top and left, shadow along the bottom and right.
      g.moveTo(-hw + 2.5, hh - 3);
      g.lineTo(-hw + 2.5, -hh + 3);
      g.lineTo(hw - 3, -hh + 2.5);
      g.stroke({ color: 0xffffff, width: 1, alpha: 0.34 });
      g.moveTo(hw - 2.5, -hh + 3);
      g.lineTo(hw - 2.5, hh - 3);
      g.lineTo(-hw + 3, hh - 2.5);
      g.stroke({ color: 0x000000, width: 1, alpha: 0.34 });

      // Organisation, in a recessed track so an empty bar still reads as a
      // gauge rather than as a missing element.
      const trackW = PLATE_W - 9;
      const trackY = hh - 5.5;
      g.roundRect(-trackW / 2, trackY, trackW, 2.6, 1.3);
      g.fill({ color: 0x000000, alpha: 0.55 });
      const org = Math.max(0, Math.min(1, s.org));
      if (org > 0.02) {
        g.roundRect(-trackW / 2, trackY, trackW * org, 2.6, 1.3);
        g.fill({ color: org > 0.5 ? 0x74d07e : org > 0.25 ? 0xe0c44f : 0xd8574a });
      }
      // Strength as a hairline under the organisation track: two gauges, one
      // dominant. A unit at full organisation and half strength is a different
      // problem from the reverse, and the player has to be able to see which.
      const str = Math.max(0, Math.min(1, s.strength));
      if (str < 0.995) {
        g.rect(-trackW / 2, trackY + 3.4, trackW * str, 1);
        g.fill({ color: 0xe8dcc0, alpha: 0.75 });
      }

      // Count badge, bottom-right, sitting on the rim.
      g.circle(hw - 5, hh - 4, 4.6);
      g.fill({ color: INK });
      g.circle(hw - 5, hh - 4, 4.6);
      g.stroke({ color: 0xffffff, width: 0.8, alpha: 0.22 });
    }

    if (s.inCombat) {
      g.roundRect(-hw + 0.75, -hh + 0.75, PLATE_W - 1.5, PLATE_H - 1.5, 3.5);
      g.stroke({ color: 0xe2503f, width: 1.6, alpha: 0.95 });
    }
    if (s.selected) {
      g.roundRect(-hw - 2, -hh - 2, PLATE_W + 4, PLATE_H + 4, 5.5);
      g.stroke({ color: 0xf5e2a3, width: 1.8, alpha: 0.95 });
    }
    if (s.ordering) {
      // A second, wider ring plus corner ticks. The single gold outline also
      // appears when a province is merely being read, so on its own it cannot
      // tell the player that the next tap is an order rather than a look.
      g.roundRect(-hw - 5, -hh - 5, PLATE_W + 10, PLATE_H + 10, 7.5);
      g.stroke({ color: 0xf5e2a3, width: 1.2, alpha: 0.7 });
      const tx = hw + 5;
      const ty = hh + 5;
      const arm = 4.5;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        g.moveTo(sx * tx, sy * (ty - arm));
        g.lineTo(sx * tx, sy * ty);
        g.lineTo(sx * (tx - arm), sy * ty);
      }
      g.stroke({ color: 0xffffff, width: 1.6, alpha: 0.9 });
    }

    this.drawSymbol(c.symbol, s.kind, detailed);
  }

  /**
   * The NATO symbol, drawn twice: once in ink, offset a little, and once in
   * bone white on top. A single hairline over a mid-tone plate is the thing
   * that made these read as clip art -- the dark pass is what gives the stroke
   * an edge at counter size.
   */
  private drawSymbol(sy: Graphics, kind: SymbolKind, detailed: boolean): void {
    sy.clear();
    const w = PLATE_W / 2 - 10;
    const h = PLATE_H / 2 - 7;
    const cy = -1.2;
    const cx = 3.4;

    const path = (): void => {
      switch (kind) {
        case 'armour':
          sy.ellipse(cx, cy, w, h * 0.92);
          break;
        case 'mountain':
          // Two peaks, the mountain-troops symbol.
          // A filled peak: the NATO mountain symbol is solid, and two open
          // chevrons at this size read as a chevron, not as mountains.
          sy.moveTo(cx - w, cy + h);
          sy.lineTo(cx - w * 0.1, cy - h);
          sy.lineTo(cx + w * 0.8, cy + h);
          sy.lineTo(cx - w, cy + h);
          break;
        case 'artillery':
          sy.circle(cx, cy, Math.min(w, h) * 0.62);
          break;
        default:
          // Infantry and motorised share the crossed diagonals.
          sy.moveTo(cx - w, cy - h);
          sy.lineTo(cx + w, cy + h);
          sy.moveTo(cx + w, cy - h);
          sy.lineTo(cx - w, cy + h);
      }
    };

    if (detailed) {
      path();
      sy.stroke({ color: INK, width: 3.4, alpha: 0.55, cap: 'round', join: 'round' });
    }
    path();
    sy.stroke({ color: SYMBOL, width: detailed ? 2 : 2.4, cap: 'round', join: 'round' });

    if (kind === 'artillery') {
      sy.circle(cx, cy, Math.min(w, h) * 0.62);
      sy.fill({ color: SYMBOL });
    }
    if (kind === 'mountain') {
      sy.moveTo(cx - w, cy + h);
      sy.lineTo(cx - w * 0.1, cy - h);
      sy.lineTo(cx + w * 0.8, cy + h);
      sy.fill({ color: SYMBOL });
    }
    if (kind === 'motorised') {
      // The wheel that separates motorised from foot infantry.
      sy.circle(cx, cy, 2.4);
      sy.fill({ color: INK });
      sy.circle(cx, cy, 2.4);
      sy.stroke({ color: SYMBOL, width: 1.4 });
    }
    if (kind === 'armour') {
      sy.ellipse(cx, cy, w * 0.42, h * 0.34);
      sy.stroke({ color: SYMBOL, width: 1.2, alpha: 0.8 });
    }
  }

  /**
   * Aggregates divisions into stacks, culled to the viewport.
   *
   * When `byState` is set, every division in a state shares one counter placed
   * on its largest province, which is what keeps a continental view readable.
   */
  private collect(state: GameState, camera: Camera, byState: boolean): Stack[] {
    const view = camera.visibleRect();
    const pad = 200 / Math.max(1e-4, camera.zoom);
    const byProvince = new Map<ProvinceId, Stack>();
    /** Battalion counts per stack, so the symbol reflects the dominant arm. */
    const arms = new Map<ProvinceId, Record<SymbolKind, number>>();

    for (const d of state.divisions) {
      if (d.dead) continue;
      const home = this.index.provinces[d.provinceId];
      const anchorId = byState ? this.stateAnchor(home.stateId) : d.provinceId;
      const p = this.index.provinces[anchorId];
      if (p.centerX < view.minX - pad || p.centerX > view.maxX + pad) continue;
      if (p.centerY < view.minY - pad || p.centerY > view.maxY + pad) continue;

      const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
      let stack = byProvince.get(anchorId);
      if (!stack) {
        stack = {
          province: anchorId, owner: d.owner, divisions: 0,
          org: 0, strength: 0, kind: 'infantry', inCombat: false, selected: false,
          ordering: false,
        };
        byProvince.set(anchorId, stack);
        arms.set(anchorId, { infantry: 0, motorised: 0, armour: 0, mountain: 0, artillery: 0 });
      }
      // A province can hold units from several countries; the controller's
      // stack wins the counter so the map never shows two plates in one place.
      if (stack.owner !== d.owner && d.owner === state.provinces[anchorId].controller) {
        stack.owner = d.owner;
      }
      stack.divisions++;
      stack.org += tpl ? d.org / Math.max(1, tpl.maxOrg) : 0;
      stack.strength += tpl ? d.hp / Math.max(1, tpl.maxHp) : 0;
      if (d.combatId !== null) stack.inCombat = true;
      // Lit by the division, not by the plate's anchor. Below the aggregation
      // zoom one counter stands for a whole state, so its anchor is not any
      // division's province and matching on it lit nothing at all.
      if (this.selectedProvinces.has(d.provinceId)) stack.selected = true;

      const tally = arms.get(anchorId)!;
      const bns = tpl?.battalions ?? [];
      if (bns.includes('medium_armor') || bns.includes('light_armor')) tally.armour++;
      else if (bns.includes('mountaineers')) tally.mountain++;
      else if (bns.includes('motorized')) tally.motorised++;
      else if (bns.includes('artillery') && !bns.includes('infantry')) tally.artillery++;
      else tally.infantry++;
    }

    const out: Stack[] = [];
    for (const s of byProvince.values()) {
      s.org /= Math.max(1, s.divisions);
      s.strength /= Math.max(1, s.divisions);
      // Armour is what a player needs to spot on a front, so it wins ties.
      const tally = arms.get(s.province)!;
      const order: SymbolKind[] = ['armour', 'mountain', 'motorised', 'artillery', 'infantry'];
      let best: SymbolKind = 'infantry';
      let bestN = -1;
      for (const k of order) {
        if (tally[k] > bestN) { bestN = tally[k]; best = k; }
      }
      s.kind = best;
      // Ordering marks the one the player tapped: it says which stack the next
      // tap on the ground moves, and a whole rectangle of them saying it would
      // say nothing.
      s.ordering = s.province === this.selectedProvince && this.ordering;
      if (s.ordering) s.selected = true;
      out.push(s);
    }
    // Stable order so the pool assignment does not shuffle between frames.
    out.sort((a, b) => a.province - b.province);
    this.litCount = out.reduce((n, s) => n + (s.selected ? 1 : 0), 0);
    return out;
  }
  /**
   * The counter under a screen point, or null.
   *
   * Slack is added around the plate because a fingertip is about 8mm and a
   * counter is 20px; without it the player has to hit a target smaller than
   * the thing they can see. Nearest centre wins when two overlap, so a dense
   * front picks the one actually aimed at rather than whichever was drawn
   * last.
   */
  pickCounter(screenX: number, screenY: number, minTouch = MIN_TOUCH_PX): CounterHit | null {
    let best: CounterHit | null = null;
    let bestDist = Infinity;
    for (const b of this.hitBoxes) {
      const dx = screenX - b.x;
      const dy = screenY - b.y;
      // Grown to the touch minimum on each axis independently. A fixed slack
      // could not do this: the recorded box runs from 14x20 to 24x27 across
      // the zoom range, so one added number is either too little on the small
      // counter or a halo three provinces wide on the large one. Growing to a
      // floor gives every counter the same 44px target and adds nothing to a
      // box that already reaches it.
      const halfW = Math.max(b.w, minTouch) / 2;
      const halfH = Math.max(b.h, minTouch) / 2;
      if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) continue;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = { ...b, inside: Math.abs(dx) <= b.w / 2 && Math.abs(dy) <= b.h / 2 };
      }
    }
    return best;
  }

}
