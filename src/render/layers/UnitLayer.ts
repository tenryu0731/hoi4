import { BitmapText, Container, Graphics } from 'pixi.js';

import type { ProvinceIndex } from '../../sim/map/ProvinceIndex';
import type { CountryId, GameState, ProvinceId } from '../../sim/core/types';
import { Camera } from '../Camera';
import { mix, rgbToHex } from '../palette';
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
}

const PLATE_W = 34;
const PLATE_H = 24;

/** Ink used for every rim, shadow and symbol outline. */
const INK = 0x0b0906;
const SYMBOL = 0xf6f0e2;

/** On-screen counter width in CSS pixels, ramped between these zoom levels. */
const COUNTER_MIN_PX = 15;
const COUNTER_MAX_PX = 34;
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
const ZOOM_AGGREGATE_STATES = 0.13;

/** Below this the bevel and the readouts are smaller than a pixel: skip them. */
const ZOOM_DETAIL = 0.09;

export class UnitLayer {
  readonly container = new Container();
  /** Movement orders, drawn under the counters. */
  private orders = new Graphics();
  private counters = new Container();
  private pool: Counter[] = [];
  private anchors = new Map<number, ProvinceId>();
  private selectedProvince: ProvinceId | null = null;

  constructor(private index: ProvinceIndex) {
    this.container.eventMode = 'none';
    this.container.addChild(this.orders, this.counters);
  }

  /** Kept for symmetry with the other layers; counters read zoom per frame. */
  setZoom(_zoom: number): void {}

  setSelection(id: ProvinceId | null): void {
    this.selectedProvince = id;
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
      this.pool.push({ root, plate, symbol, count, key: '' });
    }
    return this.pool[i];
  }

  update(state: GameState, camera: Camera, elapsed: number): ScreenRect[] {
    const zoom = Math.max(1e-4, camera.zoom);
    if (zoom < ZOOM_HIDE_COUNTERS) {
      for (const c of this.pool) c.root.visible = false;
      this.orders.clear();
      return [];
    }
    const byState = zoom < ZOOM_AGGREGATE_STATES;
    const stacks = this.collect(state, camera, byState);
    // Counters hold a constant on-screen size, but a plate sized for a corps
    // view swamps a continental one, so the target pixel size ramps with zoom.
    const targetPx = COUNTER_MIN_PX +
      (COUNTER_MAX_PX - COUNTER_MIN_PX) *
      Math.min(1, Math.max(0, (zoom - ZOOM_SMALL) / (ZOOM_LARGE - ZOOM_SMALL)));
    const scale = (targetPx / PLATE_W) / zoom;
    const detailed = zoom >= ZOOM_DETAIL;
    const rects: ScreenRect[] = [];
    // Counters sit above the province centre so the place name below stays
    // readable; the reserved rects keep labels from sliding under them.
    const liftWorld = (targetPx * 0.85) / zoom;

    this.drawOrders(state, byState, zoom);

    for (let i = 0; i < stacks.length; i++) {
      const s = stacks[i];
      const c = this.acquire(i);
      const p = this.index.provinces[s.province];
      c.root.visible = true;
      c.root.position.set(p.centerX, p.centerY - liftWorld);
      c.root.scale.set(scale);
      rects.push({
        x: camera.worldToScreenX(p.centerX),
        y: camera.worldToScreenY(p.centerY - liftWorld),
        // Aggregated counters stand in for a whole state, so they claim a
        // little less than they occupy -- but they must still claim. Returning
        // nothing let labels draw straight underneath, and a country name with
        // its first character covered is not a degraded label, it is a
        // different word: Germany read as "イツ".
        w: targetPx * (byState ? 0.8 : 1),
        h: ((targetPx * PLATE_H) / PLATE_W + 10) * (byState ? 0.8 : 1),
      });

      const color = rgbToHex(state.countries[s.owner].color);
      const key = `${color}|${s.divisions}|${s.kind}|${Math.round(s.org * 10)}` +
        `|${Math.round(s.strength * 6)}|${s.inCombat}|${s.selected}|${detailed}`;
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

    // Face, in the national colour. Lifted well clear of the rim so the colour
    // is legible as an identity rather than as a tint on black.
    const face = mix(color, 0xffffff, 0.06);
    g.roundRect(-hw + 2, -hh + 2, PLATE_W - 4, PLATE_H - 4, 2.5);
    g.fill({ color: face });

    if (detailed) {
      // Two flat bands instead of a gradient: a real gradient fill costs a
      // texture upload per counter, and at this size the seam is invisible.
      g.rect(-hw + 2, -hh + 2, PLATE_W - 4, (PLATE_H - 4) * 0.42);
      g.fill({ color: 0xffffff, alpha: 0.1 });
      g.rect(-hw + 2, hh - 2 - (PLATE_H - 4) * 0.34, PLATE_W - 4, (PLATE_H - 4) * 0.34);
      g.fill({ color: 0x000000, alpha: 0.16 });

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
    const w = PLATE_W / 2 - 7.5;
    const h = PLATE_H / 2 - 7;
    const cy = -1.2;

    const path = (): void => {
      switch (kind) {
        case 'armour':
          sy.ellipse(0, cy, w, h * 0.92);
          break;
        case 'mountain':
          // Two peaks, the mountain-troops symbol.
          sy.moveTo(-w, cy + h);
          sy.lineTo(-w * 0.3, cy - h);
          sy.lineTo(w * 0.35, cy + h);
          sy.moveTo(w * 0.35, cy + h);
          sy.lineTo(w * 0.35, cy + h);
          sy.moveTo(-w * 0.1, cy + h * 0.1);
          sy.lineTo(w * 0.45, cy - h);
          sy.lineTo(w, cy + h);
          break;
        case 'artillery':
          sy.circle(0, cy, Math.min(w, h) * 0.62);
          break;
        default:
          // Infantry and motorised share the crossed diagonals.
          sy.moveTo(-w, cy - h);
          sy.lineTo(w, cy + h);
          sy.moveTo(w, cy - h);
          sy.lineTo(-w, cy + h);
      }
    };

    if (detailed) {
      path();
      sy.stroke({ color: INK, width: 3.4, alpha: 0.55, cap: 'round', join: 'round' });
    }
    path();
    sy.stroke({ color: SYMBOL, width: detailed ? 2 : 2.4, cap: 'round', join: 'round' });

    if (kind === 'artillery') {
      sy.circle(0, cy, Math.min(w, h) * 0.62);
      sy.fill({ color: SYMBOL });
    }
    if (kind === 'motorised') {
      // The wheel that separates motorised from foot infantry.
      sy.circle(0, cy, 2.4);
      sy.fill({ color: INK });
      sy.circle(0, cy, 2.4);
      sy.stroke({ color: SYMBOL, width: 1.4 });
    }
    if (kind === 'armour') {
      sy.ellipse(0, cy, w * 0.42, h * 0.34);
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
      s.selected = s.province === this.selectedProvince;
      out.push(s);
    }
    // Stable order so the pool assignment does not shuffle between frames.
    out.sort((a, b) => a.province - b.province);
    return out;
  }
}
