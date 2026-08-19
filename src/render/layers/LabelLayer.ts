import { BitmapFont, BitmapText, Container } from 'pixi.js';

import type { ProvinceIndex } from '../../sim/map/ProvinceIndex';
import type { ScreenRect } from './UnitLayer';
import { Camera } from '../Camera';
import { PALETTE } from '../palette';

/**
 * Place names.
 *
 * Text is the easiest thing to make a map slow with: a `Text` object rasterises
 * its own texture, so 200 city labels means 200 texture uploads. Bitmap fonts
 * pay that cost once for the glyph atlas and then draw every label from the
 * same texture, which keeps the whole layer inside a single batch.
 *
 * Labels are counter-scaled each frame so they hold a constant pixel size while
 * living in world space, and they fade in by LOD step rather than appearing all
 * at once.
 */

export const FONT_COUNTRY = 'IF-Country';
export const FONT_CITY = 'IF-City';

let fontsInstalled = false;

function installFonts(): void {
  if (fontsInstalled) return;
  fontsInstalled = true;
  BitmapFont.install({
    name: FONT_COUNTRY,
    style: {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: 44,
      fontWeight: 'bold',
      fill: 0xffffff,
      letterSpacing: 2,
    },
    chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], " -'.,()àáäâãåèéêëìíîïòóôöõùúûüçñßÀÁÄÂÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜÇÑ"],
    resolution: 2,
  });
  BitmapFont.install({
    name: FONT_CITY,
    style: {
      fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      fontSize: 26,
      fill: 0xffffff,
    },
    chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], " -'.,()àáäâãåèéêëìíîïòóôöõùúûüçñßÀÁÄÂÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜÇÑ"],
    resolution: 2,
  });
}

interface LabelEntry {
  text: BitmapText;
  shadow: BitmapText;
  worldX: number;
  worldY: number;
  /** Lowest LOD step at which this label is shown. */
  minStep: number;
  /** Target on-screen height in CSS pixels. */
  pxSize: number;
  /** Higher wins when two labels want the same patch of screen. */
  priority: number;
  /** World-space extent of the shape being labelled, for fit testing. */
  shapeW: number;
  shapeH: number;
  /** Font size the bitmap atlas was built at. */
  baseSize: number;
}

export class LabelLayer {
  readonly container = new Container();
  private countryLabels: LabelEntry[] = [];
  private cityLabels: LabelEntry[] = [];
  private step = 0;
  private occupied = new Set<number>();
  /** Screen-space collision cell size in CSS pixels. */
  private static readonly CELL = 14;

  constructor(private index: ProvinceIndex) {
    installFonts();
    this.container.eventMode = 'none';
    this.build();
  }

  private makeLabel(
    value: string, font: string, x: number, y: number,
    minStep: number, pxSize: number, priority: number,
    shapeW: number, shapeH: number, into: LabelEntry[],
  ): void {
    const shadow = new BitmapText({ text: value, style: { fontFamily: font } });
    shadow.anchor.set(0.5);
    shadow.tint = PALETTE.textShadow;
    shadow.alpha = 0.75;

    const text = new BitmapText({ text: value, style: { fontFamily: font } });
    text.anchor.set(0.5);
    text.tint = font === FONT_COUNTRY ? PALETTE.textPrimary : PALETTE.textCity;

    this.container.addChild(shadow);
    this.container.addChild(text);
    into.push({
      text, shadow, worldX: x, worldY: y, minStep, pxSize, priority,
      shapeW, shapeH, baseSize: font === FONT_COUNTRY ? 44 : 26,
    });
  }

  private build(): void {
    for (const p of this.index.provinces) {
      this.makeLabel(
        p.name.toUpperCase(), FONT_COUNTRY,
        p.centerX, p.centerY, 0, 14, p.area,
        p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1],
        this.countryLabels,
      );
    }
    for (const c of this.index.data.cities) {
      // Only cities that matter get a name; the rest stay as dots.
      const minStep = c.capitalOf ? 2 : c.vp >= 12 ? 3 : c.vp >= 8 ? 4 : 5;
      this.makeLabel(
        c.name, FONT_CITY, c.x, c.y + 26, minStep, 11,
        c.vp + (c.capitalOf ? 1000 : 0), Infinity, Infinity, this.cityLabels,
      );
    }
    // Draw order follows priority so that if two do overlap, the more important
    // one is on top rather than whichever happened to be built last.
    this.countryLabels.sort((a, b) => b.priority - a.priority);
    this.cityLabels.sort((a, b) => b.priority - a.priority);
  }

  setLod(step: number, _zoom: number): void {
    this.step = step;
  }

  /**
   * Places labels for one frame.
   *
   * Two rules keep the map readable rather than a pile of overlapping words:
   * a country label is only drawn when it physically fits inside its own
   * territory on screen, and every label claims a block of screen-space cells
   * that later, lower-priority labels cannot reuse. Both tests run in screen
   * space, so a label that is illegible at one zoom simply is not drawn.
   */
  update(camera: Camera, reserved: readonly ScreenRect[] = []): void {
    const zoom = Math.max(1e-4, camera.zoom);
    const view = camera.visibleRect();
    const pad = 200 / zoom;
    this.occupied.clear();
    for (const r of reserved) this.claim(r.x, r.y, r.w, r.h);

    const place = (e: LabelEntry, fitToShape: boolean): boolean => {
      if (this.step < e.minStep) return false;
      if (e.worldX < view.minX - pad || e.worldX > view.maxX + pad) return false;
      if (e.worldY < view.minY - pad || e.worldY > view.maxY + pad) return false;

      // Label size is constant on screen, so its pixel width is independent of
      // zoom: width(local) * pxSize / atlasFontSize.
      const k = e.pxSize / e.baseSize;
      let wPx = e.text.width * k;
      let hPx = e.pxSize;

      if (fitToShape) {
        const shapeWPx = e.shapeW * zoom;
        const shapeHPx = e.shapeH * zoom;
        if (shapeHPx < hPx * 1.6) return false;
        // Allow shrinking to 62% before giving up, which keeps small countries
        // captioned a little longer as you zoom in.
        const need = wPx / (shapeWPx * 0.88);
        if (need > 1) {
          if (need > 1 / 0.62) return false;
          wPx /= need;
          hPx /= need;
        }
      }

      const sx = camera.worldToScreenX(e.worldX);
      const sy = camera.worldToScreenY(e.worldY);
      if (!this.claim(sx, sy, wPx, hPx)) return false;

      const s = (hPx / e.baseSize) / zoom;
      e.text.position.set(e.worldX, e.worldY);
      e.text.scale.set(s);
      e.shadow.position.set(e.worldX + 2 * s, e.worldY + 2 * s);
      e.shadow.scale.set(s);
      return true;
    };

    for (const e of this.countryLabels) {
      const ok = place(e, true);
      e.text.visible = ok;
      e.shadow.visible = ok;
    }
    for (const e of this.cityLabels) {
      const ok = place(e, false);
      e.text.visible = ok;
      e.shadow.visible = ok;
    }
  }

  /**
   * Reserves the screen cells a label covers. Returns false when any of them is
   * already taken, which is what stops Benelux from turning into a smear.
   */
  private claim(cx: number, cy: number, wPx: number, hPx: number): boolean {
    const cell = LabelLayer.CELL;
    const x0 = Math.floor((cx - wPx / 2) / cell);
    const x1 = Math.floor((cx + wPx / 2) / cell);
    const y0 = Math.floor((cy - hPx / 2) / cell);
    const y1 = Math.floor((cy + hPx / 2) / cell);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (this.occupied.has(y * 4096 + x)) return false;
      }
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.occupied.add(y * 4096 + x);
    }
    return true;
  }
}
