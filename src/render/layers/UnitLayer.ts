import { BitmapText, Container, Graphics } from 'pixi.js';

import type { ProvinceIndex } from '../../sim/map/ProvinceIndex';
import type { CountryId, GameState, ProvinceId } from '../../sim/core/types';
import { Camera } from '../Camera';
import { mix, rgbToHex } from '../palette';
import { FONT_CITY } from './LabelLayer';

/**
 * NATO-style counters, one per stack of divisions in a province.
 *
 * Counters are pooled: the pool grows to the high-water mark of simultaneously
 * visible stacks and is then reused forever. Creating and destroying Containers
 * every tick is what turns a busy front into a garbage-collection stutter.
 */

interface Counter {
  root: Container;
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

interface Stack {
  province: ProvinceId;
  owner: CountryId;
  divisions: number;
  /** 0..1 average organisation. */
  org: number;
  strength: number;
  armour: boolean;
  motorised: boolean;
  inCombat: boolean;
}

const PLATE_W = 34;
const PLATE_H = 24;

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

export class UnitLayer {
  readonly container = new Container();
  private pool: Counter[] = [];
  private anchors = new Map<number, ProvinceId>();

  constructor(private index: ProvinceIndex) {
    this.container.eventMode = 'none';
  }

  /** Kept for symmetry with the other layers; counters read zoom per frame. */
  setZoom(_zoom: number): void {}

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
      count.scale.set(0.42);
      count.position.set(0, PLATE_H / 2 + 7);
      root.addChild(plate, symbol, count);
      root.visible = false;
      this.container.addChild(root);
      this.pool.push({ root, plate, symbol, count, key: '' });
    }
    return this.pool[i];
  }

  update(state: GameState, camera: Camera, elapsed: number): ScreenRect[] {
    const zoom = Math.max(1e-4, camera.zoom);
    if (zoom < ZOOM_HIDE_COUNTERS) {
      for (const c of this.pool) c.root.visible = false;
      return [];
    }
    const stacks = this.collect(state, camera, zoom < ZOOM_AGGREGATE_STATES);
    // Counters hold a constant on-screen size, but a plate sized for a corps
    // view swamps a continental one, so the target pixel size ramps with zoom.
    const targetPx = COUNTER_MIN_PX +
      (COUNTER_MAX_PX - COUNTER_MIN_PX) *
      Math.min(1, Math.max(0, (zoom - ZOOM_SMALL) / (ZOOM_LARGE - ZOOM_SMALL)));
    const scale = (targetPx / PLATE_W) / zoom;
    const rects: ScreenRect[] = [];
    // Counters sit above the province centre so the place name below stays
    // readable; the reserved rects keep labels from sliding under them.
    const liftWorld = (targetPx * 0.85) / zoom;

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
        w: targetPx,
        h: (targetPx * PLATE_H) / PLATE_W + 10,
      });

      const color = rgbToHex(state.countries[s.owner].color);
      const key = `${color}|${s.divisions}|${s.armour}|${s.motorised}|${Math.round(s.org * 8)}|${s.inCombat}`;
      if (c.key !== key) {
        c.key = key;
        this.draw(c, s, color);
        c.count.text = String(s.divisions);
      }
      // Units in combat pulse; everything else is perfectly still so the eye is
      // drawn only to where something is actually happening.
      c.root.alpha = s.inCombat ? 0.72 + 0.28 * Math.abs(Math.sin(elapsed / 200)) : 1;
    }

    for (let i = stacks.length; i < this.pool.length; i++) this.pool[i].root.visible = false;
    // Only claim space against labels when counters are per-province. While
    // aggregated, place names matter more than exact unit positions.
    return zoom < ZOOM_AGGREGATE_STATES ? [] : rects;
  }

  private draw(c: Counter, s: Stack, color: number): void {
    const g = c.plate;
    g.clear();
    g.roundRect(-PLATE_W / 2, -PLATE_H / 2, PLATE_W, PLATE_H, 3);
    g.fill({ color: mix(color, 0x000000, 0.25) });
    g.stroke({ color: 0x100d08, width: 2 });
    // Organisation bar along the bottom edge of the plate.
    const barW = (PLATE_W - 6) * Math.max(0, Math.min(1, s.org));
    g.rect(-PLATE_W / 2 + 3, PLATE_H / 2 - 5, barW, 3);
    g.fill({ color: s.org > 0.5 ? 0x6fcf7a : s.org > 0.25 ? 0xd8bf4a : 0xd05a4a });

    const sy = c.symbol;
    sy.clear();
    const w = PLATE_W / 2 - 7;
    const h = PLATE_H / 2 - 6;
    if (s.armour) {
      // Armour: the standard flattened ellipse.
      sy.ellipse(0, -1, w, h * 0.85);
      sy.stroke({ color: 0xf2ead8, width: 2 });
    } else if (s.motorised) {
      // Motorised infantry: infantry cross with a dot.
      sy.moveTo(-w, -h - 1); sy.lineTo(w, h - 1);
      sy.moveTo(w, -h - 1); sy.lineTo(-w, h - 1);
      sy.stroke({ color: 0xf2ead8, width: 2 });
      sy.circle(0, -1, 2.6);
      sy.fill({ color: 0xf2ead8 });
    } else {
      // Infantry: crossed diagonals.
      sy.moveTo(-w, -h - 1); sy.lineTo(w, h - 1);
      sy.moveTo(w, -h - 1); sy.lineTo(-w, h - 1);
      sy.stroke({ color: 0xf2ead8, width: 2 });
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
          org: 0, strength: 0, armour: false, motorised: false, inCombat: false,
        };
        byProvince.set(anchorId, stack);
      }
      // A province can hold units from several countries; the controller's
      // stack wins the counter so the map never shows two plates in one place.
      if (stack.owner !== d.owner && d.owner === state.provinces[anchorId].controller) {
        stack.owner = d.owner;
      }
      stack.divisions++;
      stack.org += tpl ? d.org / Math.max(1, tpl.maxOrg) : 0;
      stack.strength += d.hp;
      if (tpl?.battalions.includes('medium_armor') || tpl?.battalions.includes('light_armor')) {
        stack.armour = true;
      } else if (tpl?.battalions.includes('motorized')) {
        stack.motorised = true;
      }
      if (d.combatId !== null) stack.inCombat = true;
    }

    const out: Stack[] = [];
    for (const s of byProvince.values()) {
      s.org /= Math.max(1, s.divisions);
      out.push(s);
    }
    // Stable order so the pool assignment does not shuffle between frames.
    out.sort((a, b) => a.province - b.province);
    return out;
  }
}
