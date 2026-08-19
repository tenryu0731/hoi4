/**
 * National flags, generated as SVG from a description of each design.
 *
 * Flags are drawn rather than downloaded. A period-correct flag set is a
 * licensing minefield, and a 1936 set doubly so; describing each one as a few
 * primitives keeps the whole set under a few kilobytes, renders crisply at any
 * size, and is reproducible on every build.
 *
 * Designs are the civil or state flags in use in 1936. Where a design carries
 * a charge too intricate to draw honestly at 60x40 -- a coat of arms, an eagle
 * -- it is rendered as a simplified emblem rather than a poor imitation.
 */

export type FlagSpec =
  | { kind: 'horizontal'; bands: string[] }
  | { kind: 'vertical'; bands: string[] }
  | { kind: 'nordic'; field: string; cross: string; outline?: string }
  | { kind: 'cross'; field: string; cross: string }
  | { kind: 'saltire'; field: string; cross: string }
  | { kind: 'canton'; field: string; canton: string; charge?: string }
  | { kind: 'disc'; field: string; disc: string; ring?: string }
  | { kind: 'plain'; field: string; emblem?: string }
  | { kind: 'union' }
  | { kind: 'crescent'; field: string; charge: string }
  | { kind: 'triband-charge'; bands: string[]; charge: string };

export const FLAGS: Record<string, FlagSpec> = {
  // The black-white-red tricolour, co-official through 1933-1935 and the
  // imperial flag before that. The party banner is deliberately not drawn.
  GER: { kind: 'horizontal', bands: ['#101010', '#f4f4f4', '#c8102e'] },
  SOV: { kind: 'plain', field: '#c8102e', emblem: '#f0c419' },
  ENG: { kind: 'union' },
  FRA: { kind: 'vertical', bands: ['#0b2d70', '#f4f4f4', '#c8102e'] },
  ITA: { kind: 'vertical', bands: ['#0d7a3e', '#f4f4f4', '#c8102e'] },
  POL: { kind: 'horizontal', bands: ['#f4f4f4', '#d81e3f'] },
  CZE: { kind: 'canton', field: '#f4f4f4', canton: '#11457e', charge: '#d7141a' },
  YUG: { kind: 'horizontal', bands: ['#1d4f91', '#f4f4f4', '#c8102e'] },
  ROM: { kind: 'vertical', bands: ['#00319c', '#ffd200', '#de2110'] },
  HUN: { kind: 'horizontal', bands: ['#cd2a3e', '#f4f4f4', '#436f4d'] },
  AUS: { kind: 'horizontal', bands: ['#c8102e', '#f4f4f4', '#c8102e'] },
  BUL: { kind: 'horizontal', bands: ['#f4f4f4', '#00966e', '#d62612'] },
  GRE: { kind: 'canton', field: '#0d5eaf', canton: '#0d5eaf', charge: '#f4f4f4' },
  ALB: { kind: 'plain', field: '#c8102e', emblem: '#101010' },
  TUR: { kind: 'crescent', field: '#e30a17', charge: '#f4f4f4' },
  SPR: { kind: 'horizontal', bands: ['#aa151b', '#f1bf00', '#aa151b'] },
  POR: { kind: 'vertical', bands: ['#046a38', '#da291c'] },
  SWI: { kind: 'cross', field: '#d52b1e', cross: '#f4f4f4' },
  BEL: { kind: 'vertical', bands: ['#101010', '#fae042', '#ed2939'] },
  HOL: { kind: 'horizontal', bands: ['#ae1c28', '#f4f4f4', '#21468b'] },
  LUX: { kind: 'horizontal', bands: ['#ed2939', '#f4f4f4', '#00a1de'] },
  DEN: { kind: 'nordic', field: '#c60c30', cross: '#f4f4f4' },
  NOR: { kind: 'nordic', field: '#ba0c2f', cross: '#00205b', outline: '#f4f4f4' },
  SWE: { kind: 'nordic', field: '#005293', cross: '#fecb00' },
  FIN: { kind: 'nordic', field: '#f4f4f4', cross: '#003580' },
  EST: { kind: 'horizontal', bands: ['#0072ce', '#101010', '#f4f4f4'] },
  LAT: { kind: 'horizontal', bands: ['#9e3039', '#f4f4f4', '#9e3039'] },
  LIT: { kind: 'horizontal', bands: ['#fdb913', '#006a44', '#c1272d'] },
  IRE: { kind: 'vertical', bands: ['#169b62', '#f4f4f4', '#ff883e'] },
  ICE: { kind: 'nordic', field: '#02529c', cross: '#dc1e35', outline: '#f4f4f4' },
};

const W = 60;
const H = 40;

function horizontal(bands: string[]): string {
  const h = H / bands.length;
  return bands
    .map((c, i) => `<rect y="${(i * h).toFixed(2)}" width="${W}" height="${h.toFixed(2)}" fill="${c}"/>`)
    .join('');
}

function vertical(bands: string[]): string {
  const w = W / bands.length;
  return bands
    .map((c, i) => `<rect x="${(i * w).toFixed(2)}" width="${w.toFixed(2)}" height="${H}" fill="${c}"/>`)
    .join('');
}

/** Scandinavian cross: offset toward the hoist, as every Nordic flag is. */
function nordic(field: string, cross: string, outline?: string): string {
  const cx = 22;
  const cy = H / 2;
  const arm = 8;
  const inner = 5;
  const parts = [`<rect width="${W}" height="${H}" fill="${field}"/>`];
  if (outline) {
    parts.push(
      `<rect x="${cx - arm / 2}" width="${arm}" height="${H}" fill="${outline}"/>`,
      `<rect y="${cy - arm / 2}" width="${W}" height="${arm}" fill="${outline}"/>`,
    );
  }
  parts.push(
    `<rect x="${cx - inner / 2}" width="${inner}" height="${H}" fill="${cross}"/>`,
    `<rect y="${cy - inner / 2}" width="${W}" height="${inner}" fill="${cross}"/>`,
  );
  return parts.join('');
}

function centredCross(field: string, cross: string): string {
  const t = 8;
  return [
    `<rect width="${W}" height="${H}" fill="${field}"/>`,
    `<rect x="${(W - t) / 2}" y="8" width="${t}" height="${H - 16}" fill="${cross}"/>`,
    `<rect x="16" y="${(H - t) / 2}" width="${W - 32}" height="${t}" fill="${cross}"/>`,
  ].join('');
}

function canton(field: string, cantonColor: string, charge?: string): string {
  const parts = [`<rect width="${W}" height="${H}" fill="${field}"/>`];
  if (field !== cantonColor) {
    parts.push(`<rect width="${W * 0.42}" height="${H / 2}" fill="${cantonColor}"/>`);
  }
  if (charge) {
    // A simple charge: a wedge for Czechoslovakia, a cross for Greece.
    if (field === '#0d5eaf') {
      parts.push(
        `<rect width="${W * 0.42}" height="${H / 2}" fill="${field}"/>`,
        `<rect x="${W * 0.16}" width="${W * 0.1}" height="${H / 2}" fill="${charge}"/>`,
        `<rect y="${H * 0.2}" width="${W * 0.42}" height="${H * 0.1}" fill="${charge}"/>`,
      );
      for (let i = 1; i < 5; i += 2) {
        parts.push(
          `<rect y="${(i * H) / 9 + H / 2 - H / 9}" width="${W}" height="${H / 9}" fill="${charge}"/>`,
        );
      }
    } else {
      parts.push(`<polygon points="0,0 ${W * 0.4},${H / 2} 0,${H}" fill="${charge}"/>`);
    }
  }
  return parts.join('');
}

function disc(field: string, discColor: string, ring?: string): string {
  const parts = [
    `<rect width="${W}" height="${H}" fill="${field}"/>`,
    `<circle cx="${W / 2}" cy="${H / 2}" r="11" fill="${discColor}"/>`,
  ];
  if (ring) {
    // A stylised emblem rather than an attempt at the real charge.
    parts.push(
      `<rect x="${W / 2 - 7}" y="${H / 2 - 2}" width="14" height="4" fill="${ring}"/>`,
      `<rect x="${W / 2 - 2}" y="${H / 2 - 7}" width="4" height="14" fill="${ring}"/>`,
    );
  }
  return parts.join('');
}

function plain(field: string, emblem?: string): string {
  const parts = [`<rect width="${W}" height="${H}" fill="${field}"/>`];
  if (emblem === '#f0c419') {
    // Hammer and sickle, reduced to two crossed strokes and a star.
    parts.push(
      `<path d="M8 8 L20 20 M20 8 L8 20" stroke="${emblem}" stroke-width="2.4" fill="none"/>`,
      `<polygon points="14,4 15.4,7.6 19.2,7.6 16.2,10 17.4,13.6 14,11.4 10.6,13.6 11.8,10 8.8,7.6 12.6,7.6" fill="${emblem}"/>`,
    );
  } else if (emblem) {
    parts.push(
      `<polygon points="${W / 2},${H / 2 - 9} ${W / 2 + 9},${H / 2} ${W / 2},${H / 2 + 9} ${W / 2 - 9},${H / 2}" fill="${emblem}"/>`,
    );
  }
  return parts.join('');
}

function crescent(field: string, charge: string): string {
  return [
    `<rect width="${W}" height="${H}" fill="${field}"/>`,
    `<circle cx="24" cy="${H / 2}" r="9" fill="${charge}"/>`,
    `<circle cx="28" cy="${H / 2}" r="7.2" fill="${field}"/>`,
    `<polygon points="38,14 40.2,19.2 45.6,19.6 41.4,23.2 42.8,28.6 38,25.6 33.2,28.6 34.6,23.2 30.4,19.6 35.8,19.2" fill="${charge}"/>`,
  ].join('');
}

/** The Union Flag, built from its three crosses. */
function union(): string {
  const blue = '#012169';
  const white = '#f4f4f4';
  const red = '#c8102e';
  return [
    `<rect width="${W}" height="${H}" fill="${blue}"/>`,
    // Saltire of St Andrew, with St Patrick's red counterchange on top.
    `<path d="M0 0 L${W} ${H} M${W} 0 L0 ${H}" stroke="${white}" stroke-width="9"/>`,
    `<path d="M0 0 L${W} ${H} M${W} 0 L0 ${H}" stroke="${red}" stroke-width="4"/>`,
    // Cross of St George.
    `<rect y="${H / 2 - 7}" width="${W}" height="14" fill="${white}"/>`,
    `<rect x="${W / 2 - 7}" width="14" height="${H}" fill="${white}"/>`,
    `<rect y="${H / 2 - 4}" width="${W}" height="8" fill="${red}"/>`,
    `<rect x="${W / 2 - 4}" width="8" height="${H}" fill="${red}"/>`,
  ].join('');
}

export function renderFlag(spec: FlagSpec): string {
  let body: string;
  switch (spec.kind) {
    case 'horizontal': body = horizontal(spec.bands); break;
    case 'vertical': body = vertical(spec.bands); break;
    case 'nordic': body = nordic(spec.field, spec.cross, spec.outline); break;
    case 'cross': body = centredCross(spec.field, spec.cross); break;
    case 'saltire': body = centredCross(spec.field, spec.cross); break;
    case 'canton': body = canton(spec.field, spec.canton, spec.charge); break;
    case 'disc': body = disc(spec.field, spec.disc, spec.ring); break;
    case 'plain': body = plain(spec.field, spec.emblem); break;
    case 'union': body = union(); break;
    case 'crescent': body = crescent(spec.field, spec.charge); break;
    case 'triband-charge': body = horizontal(spec.bands); break;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<clipPath id="c"><rect width="${W}" height="${H}"/></clipPath>` +
    `<g clip-path="url(#c)">${body}</g>` +
    `<rect width="${W}" height="${H}" fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="2"/>` +
    `</svg>`
  );
}
