import { BitmapFont, BitmapText, Container } from 'pixi.js';
import { COUNTRY } from '../../ui/strings';

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

/** How far from its capital a province still counts as a nation's heartland. */
const HOME_RADIUS_KM = 1500;
/**
 * Most a label may be shrunk to make it fit its shape before it is dropped.
 * 1.6 keeps small countries captioned a little longer as the map zooms in.
 */
const MAX_LABEL_SHRINK = 1.6;

export const FONT_COUNTRY = 'IF-Country';
export const FONT_PROVINCE = 'IF-Province';
export const FONT_CITY = 'IF-City';

/**
 * Every distinct character the Japanese country names use.
 *
 * A bitmap font rasterises a fixed glyph set at install time, so the CJK
 * characters have to be declared -- there is no fallback for a glyph the atlas
 * does not contain. Deriving the set from the label table means adding a nation
 * can never leave its name rendering as blanks.
 */
const COUNTRY_GLYPHS = [...new Set(Object.values(COUNTRY).join(''))].join('');

const LATIN_GLYPHS = " -'.,()àáäâãåèéêëìíîïòóôöõùúûüçñßÀÁÄÂÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜÇÑ";

let fontsInstalled = false;

function installFonts(): void {
  if (fontsInstalled) return;
  fontsInstalled = true;
  BitmapFont.install({
    name: FONT_COUNTRY,
    style: {
      fontFamily: 'Georgia, "Times New Roman", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
      fontSize: 44,
      fontWeight: 'bold',
      fill: 0xffffff,
      letterSpacing: 2,
    },
    chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], LATIN_GLYPHS + COUNTRY_GLYPHS],
    resolution: 2,
  });
  BitmapFont.install({
    name: FONT_PROVINCE,
    style: {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: 30,
      fill: 0xffffff,
      letterSpacing: 1,
    },
    chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], LATIN_GLYPHS],
    resolution: 2,
  });
  BitmapFont.install({
    name: FONT_CITY,
    style: {
      fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      fontSize: 26,
      fill: 0xffffff,
    },
    chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], LATIN_GLYPHS],
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
  readonly countryLabels: LabelEntry[] = [];
  readonly provinceLabels: LabelEntry[] = [];
  readonly cityLabels: LabelEntry[] = [];
  private step = 0;
  private occupied = new Set<number>();
  /** Screen-space collision cell size in CSS pixels. */
  private static readonly CELL = 14;

  constructor(
    private index: ProvinceIndex,
    private countryNames: Map<string, string> = new Map(),
  ) {
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
    if (font === FONT_PROVINCE) text.alpha = 0.88;

    this.container.addChild(shadow);
    this.container.addChild(text);
    into.push({
      text, shadow, worldX: x, worldY: y, minStep, pxSize, priority,
      shapeW, shapeH,
      baseSize: font === FONT_COUNTRY ? 44 : font === FONT_PROVINCE ? 30 : 26,
    });
  }

  private build(): void {
    // Country names first. Without them a zoomed-out map is a mosaic of a
    // few hundred place names and no sense of who holds what.
    for (const c of this.collectCountries()) {
      this.makeLabel(
        c.name.toUpperCase(), FONT_COUNTRY,
        c.x, c.y, 0, 15, c.area,
        c.width, c.height,
        this.countryLabels,
      );
    }
    // Province names take over as the map gets closer.
    for (const p of this.index.provinces) {
      this.makeLabel(
        p.name.toUpperCase(), FONT_PROVINCE,
        p.centerX, p.centerY, 3, 10, p.area,
        p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1],
        this.provinceLabels,
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
    this.provinceLabels.sort((a, b) => b.priority - a.priority);
    this.cityLabels.sort((a, b) => b.priority - a.priority);
  }

  /**
   * One label anchor per nation, placed on the province closest to the
   * area-weighted centre of its home territory. Anchoring on a real province
   * guarantees the name lands on land rather than in a bay.
   */
  private collectCountries(): {
    name: string; x: number; y: number; area: number; width: number; height: number;
  }[] {
    const byTag = new Map<string, { members: number[] }>();
    for (const p of this.index.provinces) {
      let acc = byTag.get(p.ownerTag);
      if (!acc) { acc = { members: [] }; byTag.set(p.ownerTag, acc); }
      acc.members.push(p.id);
    }

    // Capital cities give the display name and a better anchor than a colonial
    // centroid, which for France sits in the Mediterranean.
    const capitals = new Map<string, { name: string; x: number; y: number }>();
    for (const c of this.index.data.cities) {
      if (c.capitalOf) capitals.set(c.capitalOf, { name: c.name, x: c.x, y: c.y });
    }

    const out: { name: string; x: number; y: number; area: number; width: number; height: number }[] = [];
    for (const [tag, acc] of byTag) {
      const cap = capitals.get(tag);

      // Only home territory decides where the name goes. Averaging in the
      // colonies puts "United Kingdom" over Egypt and "France" in the Bay of
      // Biscay, because that really is where the centre of those empires lies.
      const home = cap
        ? acc.members.filter((id) => {
          const p = this.index.get(id);
          return Math.hypot(p.centerX - cap.x, p.centerY - cap.y) <= HOME_RADIUS_KM;
        })
        : acc.members;
      const pool = home.length > 0 ? home : acc.members;

      let sx = 0;
      let sy = 0;
      let homeArea = 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of pool) {
        const p = this.index.get(id);
        sx += p.centerX * p.area;
        sy += p.centerY * p.area;
        homeArea += p.area;
        minX = Math.min(minX, p.bbox[0]);
        minY = Math.min(minY, p.bbox[1]);
        maxX = Math.max(maxX, p.bbox[2]);
        maxY = Math.max(maxY, p.bbox[3]);
      }
      const targetX = sx / Math.max(1, homeArea);
      const targetY = sy / Math.max(1, homeArea);

      let best = pool[0];
      let bestD = Infinity;
      for (const id of pool) {
        const p = this.index.get(id);
        const d = (p.centerX - targetX) ** 2 + (p.centerY - targetY) ** 2;
        if (d < bestD) { bestD = d; best = id; }
      }
      const anchor = this.index.get(best);
      out.push({
        name: this.countryNames.get(tag) ?? tag,
        x: anchor.centerX,
        y: anchor.centerY,
        area: homeArea,
        width: maxX - minX,
        height: maxY - minY,
      });
    }
    return out;
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
      //
      // Both sides of the fit test are rounded to whole pixels. Glyph metrics
      // come from a canvas-rasterised atlas and vary by a fraction of a pixel
      // between page loads; without rounding, a label sitting exactly on the
      // threshold appears in one render and not the next, which is a visual
      // regression the eye cannot see but a pixel diff can.
      const k = e.pxSize / e.baseSize;
      let wPx = Math.round(e.text.width * k);
      let hPx = e.pxSize;

      if (fitToShape) {
        const shapeWPx = Math.round(e.shapeW * zoom);
        const shapeHPx = Math.round(e.shapeH * zoom);
        if (shapeHPx < hPx * 1.6) return false;
        // Allow shrinking to 62% before giving up, which keeps small countries
        // captioned a little longer as you zoom in.
        // Quantise how much the label has to shrink. Glyph advances come from
        // a canvas-rasterised atlas whose metrics move by a fraction of a
        // percent between page loads, and a label sitting exactly on the
        // shrink-or-drop threshold would then appear in one render and not the
        // next. Snapping to tenths means only a real six-percent change in fit
        // can flip the decision.
        const raw = wPx / Math.max(1, Math.round(shapeWPx * 0.88));
        if (raw > 1) {
          const need = Math.ceil(raw * 10) / 10;
          if (need > MAX_LABEL_SHRINK) return false;
          wPx = Math.round(wPx / need);
          hPx = Math.round(hPx / need);
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
    for (const e of this.provinceLabels) {
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
