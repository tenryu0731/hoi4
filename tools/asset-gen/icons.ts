/**
 * Interface iconography, generated as SVG.
 *
 * Every icon is a single path or a handful of primitives on a 32x32 grid, drawn
 * in one ink colour so the UI can tint them. Keeping them as geometry rather
 * than bitmaps means they stay sharp on a 3x display and the whole set costs
 * less than one small PNG.
 */

const S = 32;

function svg(body: string, size = S): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    body +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const RESOURCE_ICONS: Record<string, string> = {
  // Oil: a derrick over a drop.
  oil: svg(
    '<path d="M6 27h20"/>' +
    '<path d="M16 27V9"/><path d="M10 27 16 9l6 18"/>' +
    '<path d="M16 22c-2 0-3.4-1.5-3.4-3.2 0-1.9 3.4-5.4 3.4-5.4s3.4 3.5 3.4 5.4C19.4 20.5 18 22 16 22z" fill="currentColor" stroke="none"/>',
  ),
  // Steel: an ingot stack.
  steel: svg(
    '<path d="M5 20h22l-3 7H8z"/>' +
    '<path d="M9 13h14l-2 6H11z"/>' +
    '<path d="M13 7h6l-1.5 5h-3z"/>',
  ),
  // Aluminium: a light sheet, folded.
  aluminium: svg(
    '<path d="M4 22 12 8h8l8 14z"/>' +
    '<path d="M12 8 16 22 20 8"/>',
  ),
  // Tungsten: a hard crystal.
  tungsten: svg(
    '<path d="M16 4 27 12v12L16 28 5 24V12z"/>' +
    '<path d="M5 12 16 16l11-4M16 16v12"/>',
  ),
  // Rubber: a tyre.
  rubber: svg(
    '<circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="5"/>' +
    '<path d="M16 5v6M16 21v6M5 16h6M21 16h6"/>',
  ),
  // Chromium: a polished bar with a highlight.
  chromium: svg(
    '<rect x="6" y="10" width="20" height="12" rx="2"/>' +
    '<path d="M10 10v12M16 10v12"/>',
  ),
};

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export const UI_ICONS: Record<string, string> = {
  factory: svg(
    '<path d="M4 27V14l7 4V14l7 4V9h10v18z"/>' +
    '<path d="M22 14h4M22 19h4"/>',
  ),
  military_factory: svg(
    '<path d="M4 27V14l7 4V14l7 4V9h10v18z"/>' +
    '<path d="M24 5v4M22 7h4"/>',
  ),
  dockyard: svg(
    '<path d="M5 20c2 4 6 6 11 6s9-2 11-6"/>' +
    '<path d="M16 26V8"/><circle cx="16" cy="6" r="2"/><path d="M10 11h12"/>',
  ),
  manpower: svg(
    '<circle cx="16" cy="10" r="4"/>' +
    '<path d="M7 27c0-5 4-9 9-9s9 4 9 9"/>',
  ),
  political_power: svg(
    '<path d="M16 4l3.6 7.6L28 12.8l-6 5.8 1.5 8.2-7.5-4-7.5 4L10 18.6l-6-5.8 8.4-1.2z"/>',
  ),
  research: svg(
    '<circle cx="14" cy="14" r="8"/><path d="M20 20l7 7"/>',
  ),
  construction: svg(
    '<path d="M5 27h22"/><path d="M8 27V13l8-6 8 6v14"/><path d="M13 27v-7h6v7"/>',
  ),
  production: svg(
    '<path d="M5 24h22"/><path d="M8 24v-6M14 24v-11M20 24v-8M26 24v-14"/>',
  ),
  army: svg(
    '<rect x="5" y="10" width="22" height="14" rx="1"/>' +
    '<path d="M5 10l22 14M27 10 5 24"/>',
  ),
  diplomacy: svg(
    '<circle cx="16" cy="16" r="11"/>' +
    '<path d="M5 16h22M16 5c3 3.4 4.5 7 4.5 11S19 24.6 16 27c-3-2.4-4.5-6-4.5-11S13 8.4 16 5z"/>',
  ),
  pause: svg('<rect x="9" y="7" width="5" height="18" rx="1"/><rect x="18" y="7" width="5" height="18" rx="1"/>'),
  play: svg('<path d="M11 6l14 10-14 10z"/>'),
  fast_forward: svg('<path d="M5 8l9 8-9 8zM17 8l9 8-9 8z"/>'),
  victory_point: svg(
    '<path d="M16 4l4 8 8 1-6 6 1.6 8L16 23l-7.6 4L10 19l-6-6 8-1z"/>',
  ),
  supply: svg(
    '<rect x="4" y="12" width="14" height="10" rx="1"/>' +
    '<path d="M18 15h5l4 4v3h-9z"/><circle cx="9" cy="24" r="2.5"/><circle cx="22" cy="24" r="2.5"/>',
  ),
  warning: svg(
    '<path d="M16 5 29 27H3z"/><path d="M16 13v6M16 23h.01"/>',
  ),
};

// ---------------------------------------------------------------------------
// NATO unit symbols
// ---------------------------------------------------------------------------

const UW = 48;
const UH = 32;

function unitSvg(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UW} ${UH}" ` +
    `width="${UW}" height="${UH}" fill="none" stroke="currentColor" ` +
    `stroke-width="2.5" stroke-linecap="round">` +
    `<rect x="1.25" y="1.25" width="${UW - 2.5}" height="${UH - 2.5}" rx="1.5"/>` +
    body +
    `</svg>`
  );
}

/** Standard APP-6 style symbols, drawn inside the unit frame. */
export const UNIT_ICONS: Record<string, string> = {
  infantry: unitSvg('<path d="M6 6 42 26M42 6 6 26"/>'),
  motorized: unitSvg('<path d="M6 6 42 26M42 6 6 26"/><circle cx="24" cy="16" r="3.5" fill="currentColor" stroke="none"/>'),
  mechanized: unitSvg('<path d="M6 6 42 26M42 6 6 26"/><path d="M18 16h12"/>'),
  armor: unitSvg('<ellipse cx="24" cy="16" rx="15" ry="9"/>'),
  artillery: unitSvg('<circle cx="24" cy="16" r="4.5" fill="currentColor" stroke="none"/>'),
  mountaineers: unitSvg('<path d="M10 24 24 8l14 16z"/>'),
  marines: unitSvg('<path d="M8 20c4-6 10-6 16 0s12 6 16 0"/><path d="M6 6 42 26"/>'),
  paratrooper: unitSvg('<path d="M9 18c0-8 6-12 15-12s15 4 15 12"/><path d="M24 6v20"/>'),
  cavalry: unitSvg('<path d="M8 24 40 8"/>'),
  headquarters: unitSvg('<path d="M14 8v16M34 8v16M14 16h20"/>'),
  air: unitSvg('<path d="M8 16h32M18 8l-6 8 6 8M30 8l6 8-6 8"/>'),
  naval: unitSvg('<path d="M10 20c3 4 8 6 14 6s11-2 14-6"/><path d="M24 26V8"/>'),
};

export const ALL_ICONS = { ...RESOURCE_ICONS, ...UI_ICONS };
