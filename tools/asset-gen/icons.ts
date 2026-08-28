/**
 * Interface iconography, generated as SVG.
 *
 * Every icon is a single path or a handful of primitives on a 32x32 grid, drawn
 * in one ink colour so the UI can tint them. Keeping them as geometry rather
 * than bitmaps means they stay sharp on a 3x display and the whole set costs
 * less than one small PNG.
 */

const S = 32;

/**
 * A filled icon.
 *
 * The interface icons used to be 2px outlines, and at the size they are
 * actually shown -- 13px in a top-bar chip, 18px on a tab -- a 2px outline is
 * a grey smear: the stroke and the gap between strokes are both about one
 * device pixel, so antialiasing averages them into the background. HOI4 draws
 * solid, high-contrast shapes for the same reason. Interior detail is cut out
 * with the even-odd rule rather than drawn in a second colour, because these
 * are used as CSS masks and only carry one ink.
 *
 * The NATO unit symbols below stay outlines: that is what the symbology is,
 * and they are drawn at 48x32 on a counter, not at 13px in a chip.
 */
function solid(body: string, size = S): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" fill="currentColor" fill-rule="evenodd">` +
    body +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const RESOURCE_ICONS: Record<string, string> = {
  // Oil: a drum, which is the unit the game counts it in. Drawn with rolled
  // ends -- a plain rectangle with two bars across it is a hamburger menu.
  oil: solid(
    '<path d="M8 7.4a8 3.6 0 0 1 16 0v17.2a8 3.6 0 0 1-16 0z' +
    'M8.8 12.4h14.4v2.6H8.8z' +
    'M8.8 18.2h14.4v2.6H8.8z"/>',
  ),
  // Steel: an I-beam, the shape it is sold in.
  steel: solid(
    '<path d="M4 4.8h24v4.4h-9.6v13.6H28v4.4H4v-4.4h9.6V9.2H4z"/>',
  ),
  // Aluminium: three stacked ingots.
  aluminium: solid(
    '<path d="M11.4 7h9.2l2.6 5.6H8.8z"/>' +
    '<path d="M6.2 14.8h19.6l2.8 5.8H3.4z"/>' +
    '<path d="M2.4 22.8h27.2l-1.4 4.4H3.8z"/>',
  ),
  // Tungsten: a cut gem. The hexagon over a stem it replaces was a map pin.
  tungsten: solid(
    '<path d="M6.4 4.4h19.2l4.4 6.8L16 27.8 2 11.2z' +
    'M4.2 11.8h23.6v1.8H4.2z"/>',
  ),
  // Rubber: a tyre, hub cut out.
  rubber: solid(
    '<path d="M16 3.2C8.9 3.2 3.2 8.9 3.2 16S8.9 28.8 16 28.8 28.8 23.1 28.8 16 23.1 3.2 16 3.2z' +
    'M16 10.4a5.6 5.6 0 1 0 0 11.2 5.6 5.6 0 0 0 0-11.2z"/>' +
    '<path d="M14.6 3.4h2.8v6h-2.8zM14.6 22.6h2.8v6h-2.8z' +
    'M3.4 14.6h6v2.8h-6zM22.6 14.6h6v2.8h-6z"/>',
  ),
  // Chromium: a plated hexagonal blank.
  chromium: solid(
    '<path d="M16 2.8l11.4 6.6v13.2L16 29.2 4.6 22.6V9.4z' +
    'M16 7.2L8.4 11.6v8.8L16 24.8l7.6-4.4v-8.8z"/>' +
    '<path d="M12.6 12.8h6.8v6.4h-6.8z"/>',
  ),
};

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** The civilian plant; the military one is the same building plus a shell. */
const FACTORY_BODY =
  '<path d="M3.4 28.6V13.4l7 4.1v-4.1l7 4.1V7.6h11.2v21z' +
  'M20.6 12.4h6.2v2.4h-6.2z' +
  'M20.6 17.4h6.2v2.4h-6.2z' +
  'M6.4 21.4h3.6v3.4H6.4z' +
  'M13.4 21.4h3.6v3.4h-3.6z"/>';

export const UI_ICONS: Record<string, string> = {
  // --- the battle-plan bar ------------------------------------------------
  // The reference puts a row of these along the foot of the screen and every
  // plan is drawn with one of them held. Each is the shape of what it draws,
  // because a toolbar of six abstractions is six things to memorise.
  /** A front line: the comb the map draws, with the teeth on the near side. */
  'plan-front': solid(
    '<path d="M3 12h26v3.4H3z"/>'
    + '<path d="M4.6 15.4h3.2v6H4.6zM11 15.4h3.2v6H11zM17.4 15.4h3.2v6h-3.2z'
    + 'M23.8 15.4h3.2v6h-3.2z"/>',
  ),
  /** An offensive: a broad head pushing forward on a wide face. */
  'plan-offensive': solid(
    '<path d="M3 6h4.4v20H3zM10 6h4.4v20H10z"/>'
    + '<path d="M18 16 27.6 8.4v5.4H31v4.4h-3.4v5.4z"/>',
  ),
  /** A spearhead: the same push, one lane wide. */
  'plan-spearhead': solid(
    '<path d="M3 13.6h16v4.8H3z"/>'
    + '<path d="M17.6 6 30 16 17.6 26z"/>',
  ),
  /** A garrison: a shield over ground that is already ours. */
  'plan-garrison': solid(
    '<path d="M16 2.6 27.4 7v9.2c0 6-4.7 11.2-11.4 13.2C9.3 27.4 4.6 22.2 4.6 16.2V7z'
    + 'm0 4.3L8.4 9.9v6.3c0 4.1 3 7.8 7.6 9.4 4.6-1.6 7.6-5.3 7.6-9.4V9.9z"/>',
  ),
  /** A landing: an anchor, which is the mark the reference uses for one. */
  'plan-invade': solid(
    '<path d="M14 8.6a2.6 2.6 0 1 1 4 0v1.8h3.2v3H18v11.3c3.1-.7 5.5-3.3 5.9-6.5h-2.6l4-5.6 4 5.6'
    + 'h-2.5c-.5 5.6-5.2 10-11.8 10S4.1 18.8 3.6 13.2H1.1l4-5.6 4 5.6H6.5c.4 3.2 2.8 5.8 5.9 6.5'
    + 'V13.4h-3.2v-3H12z"/>',
  ),
  /** Clearing the plan: a bin, which is what the reference draws too. */
  'plan-clear': solid(
    '<path d="M12 2h8v3h8v3.4H4V5h8zM6.4 10.8h19.2L24 30H8z'
    + 'm5 3.4v12h2.4v-12zm7.2 0v12H21v-12z"/>',
  ),
  factory: solid(FACTORY_BODY),
  // The two plants stand next to each other in the top bar, so the military
  // one needs a mark that survives being 13px wide: a shell over the roofline.
  military_factory: solid(
    FACTORY_BODY +
    '<path d="M24 1.6c1 1 1.6 2.3 1.6 3.6v1.2h-3.2V5.2c0-1.3.6-2.6 1.6-3.6z"/>',
  ),
  dockyard: solid(
    '<path d="M14.4 8.9a2.6 2.6 0 1 1 3.2 0v1.9h3.2v3H17.6v10.6c2.9-.6 5.1-3 5.5-5.9h-2.4l3.9-5.4 3.9 5.4' +
    'h-2.3c-.5 5.3-4.9 9.5-10.2 9.5S6.2 23.8 5.7 18.5H3.4l3.9-5.4 3.9 5.4H8.8c.4 2.9 2.6 5.3 5.6 5.9V13.8' +
    'h-3.2v-3h3.2z"/>',
  ),
  /**
   * Trade: a freighter under way, seen from the side.
   *
   * The trade tab used to share the diplomacy globe. That was survivable while
   * the tabs carried labels; once they became a row of eight icons under the
   * national figures -- which is where the reference puts them -- two
   * identical globes are two tabs the player has to guess between. A ship is
   * what this trade actually is: civilian industry shipped out as convoys and
   * ore shipped back.
   */
  trade: solid(
    // Six shapes with 1.4-unit gaps drew a ship at full size and a lump at
    // the 13px this is actually used at: the deck line, the containers and the
    // funnel all closed up into the hull. Three shapes with gaps twice as wide
    // survive the shrink, which is the only size that matters.
    //
    // Hull: a raked bow, a flat transom, and a deck that overhangs both.
    '<path d="M2.4 18.6h27.2l-4.2 8.2a2.4 2.4 0 0 1-2.1 1.3H8.7a2.4 2.4 0 0 1-2.1-1.3z"/>' +
    // The island aft, funnel included as one mass rather than two thin ones.
    '<path d="M19.4 7.2h7.2v9.6h-7.2z"/>' +
    // One deck cargo block forward, wide enough to still be a rectangle.
    '<path d="M5.4 11.4h11.2v5.4H5.4z"/>',
  ),
  manpower: solid(
    '<circle cx="16" cy="9.6" r="5.1"/>' +
    '<path d="M16 16.4c-5.1 0-9.2 3.6-9.2 8.1v3.2h18.4v-3.2c0-4.5-4.1-8.1-9.2-8.1z"/>',
  ),
  // A parliament portico. A star was indistinguishable from the victory-point
  // icon at chip size, and a raised fist at 13px is an unreadable blob.
  political_power: solid(
    '<path d="M16 2.4l14 6.6v2.6H2V9z"/>' +
    '<path d="M4.6 13.4h3.6v11.2H4.6zM11.6 13.4h3.6v11.2h-3.6z' +
    'M16.8 13.4h3.6v11.2h-3.6zM23.8 13.4h3.6v11.2h-3.6z"/>' +
    '<path d="M2.4 26.2h27.2v3.2H2.4z"/>',
  ),
  // A laboratory flask, not a magnifying glass: the glass read as "search".
  research: solid(
    '<path d="M12.4 3.4h7.2v3h-1.3v6.1l6.6 11.7c1.1 2 -.3 4.4 -2.6 4.4H9.7c-2.3 0-3.7-2.4-2.6-4.4' +
    'l6.6-11.7V6.4h-1.3z' +
    'M13.9 17.4l-3.2 5.7c-.2.4.1.8.5.8h9.6c.4 0 .7-.4.5-.8l-3.2-5.7z"/>',
  ),
  // A tower crane, mast to the left. The house it replaces meant "home", and
  // a centred mast under a full-width jib just draws the letter T.
  construction: solid(
    '<path d="M7 6.2h4.2v20.4H7z"/>' +
    '<path d="M2.4 3.2h27.2v3H2.4z"/>' +
    '<path d="M2.4 6.2h3.4v5.6H2.4z"/>' +
    '<path d="M24.2 6.2h1.8v6.4h-1.8z"/>' +
    '<path d="M21.6 12.2h6.8l-1.8 4.6h-3.2z"/>' +
    '<path d="M3 26.6h12.2v2.6H3z"/>',
  ),
  // A cogwheel. The bar chart it replaces read as "statistics".
  production: solid(
    '<path d="M16 3.2l2.6 1.5 2.9-.6 1.4 2.6 2.9.7-.1 3 2.3 1.9-1.5 2.6 1 2.8-2.6 1.5-.5 2.9-3 .3' +
    '-1.7 2.5-2.8-1-2.4 1.8-2.3-1.9-2.9.5-1.3-2.7-2.9-.8.2-3-2.2-2 1.6-2.5-.9-2.9 2.6-1.4.6-2.9 3-.2z' +
    'M16 11.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6z"/>',
  ),
  // The NATO infantry counter the map already draws: a solid plate with the
  // saltire cut out of it. The saltire stops short of the corners, because an
  // X that runs into them draws the flap of an envelope instead.
  army: solid(
    '<path d="M2.6 7.4h26.8v17.2H2.6z' +
    'M7.4 10.4l-1.9 1.3 19.1 9.9 1.9-1.3z' +
    'M24.6 10.4l1.9 1.3-19.1 9.9-1.9-1.3z"/>',
  ),
  diplomacy: solid(
    '<path d="M16 2.6C8.6 2.6 2.6 8.6 2.6 16S8.6 29.4 16 29.4 29.4 23.4 29.4 16 23.4 2.6 16 2.6z' +
    'M3.6 14.6h24.8v2.8H3.6z' +
    'M16 2.6c-3.9 0-7.1 6-7.1 13.4S12.1 29.4 16 29.4s7.1-6 7.1-13.4S19.9 2.6 16 2.6z' +
    'M16 5.4c-2.4 0-4.3 4.7-4.3 10.6S13.6 26.6 16 26.6s4.3-4.7 4.3-10.6S18.4 5.4 16 5.4z"/>',
  ),
  pause: solid('<path d="M8 5h5.4v22H8zM18.6 5H24v22h-5.4z"/>'),
  play: solid('<path d="M8 4.6L27 16 8 27.4z"/>'),
  fast_forward: solid('<path d="M3 5.6L15 16 3 26.4zM17 5.6L29 16 17 26.4z"/>'),
  victory_point: solid(
    '<path d="M16 2.4l4.1 8.6 9.3 1.3-6.8 6.7 1.7 9.4L16 24l-8.3 4.4 1.7-9.4-6.8-6.7 9.3-1.3z"/>',
  ),
  supply: solid(
    '<path d="M1.8 8.4h15.4v12.8H1.8z"/>' +
    '<path d="M18.6 12.2h5.6l4.8 5.2v3.8h-10.4z"/>' +
    '<path d="M1.8 22.4h26.6v2.2H1.8z"/>' +
    '<circle cx="8.4" cy="25.2" r="3.4"/><circle cx="23.2" cy="25.2" r="3.4"/>' +
    '<path d="M8.4 23.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z"/>' +
    '<path d="M23.2 23.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z"/>',
  ),
  // Rank insignia: the chain of command is about who is in charge, and a
  // chevron stack says that at 18px where a portrait cannot.
  command: solid(
    '<path d="M16 3.2L29 13.4l-3.4 2.6L16 8.6 6.4 16 3 13.4z"/>' +
    '<path d="M16 12.4L29 22.6l-3.4 2.6L16 17.8l-9.6 7.4L3 22.6z"/>',
  ),
  // A jerrycan. Fuel borrowed the oil-barrel glyph, so the same picture meant
  // 燃料 600 in one row of the top bar and 石油 0 two rows below it.
  fuel: solid(
    '<path d="M6.4 7.2h15.2v21.2H6.4z' +
    'M9.2 11.4h9.6v2.4H9.2z"/>' +
    '<path d="M9 3.6h10v3H9z"/>' +
    '<path d="M22.6 9.6h3.2c1.6 0 2.8 1.3 2.8 2.9v9.2c0 1.2-1 2.2-2.2 2.2' +
    'h-1.6v-2.8h1v-8.6c0-.1-.1-.2-.2-.2h-3z"/>',
  ),
  // Scales. Stability is the government's balance, and borrowing the
  // victory-point star for it said "this province is worth something".
  stability: solid(
    '<path d="M14.6 3.4h2.8v24.2h-2.8z"/>' +
    '<path d="M7.4 26h17.2v2.8H7.4z"/>' +
    '<path d="M5.4 8.4h21.2v2.6H5.4z"/>' +
    '<path d="M2 20.4l4.4-9.6 4.4 9.6z' +
    'M6.4 15.2l-1.5 3.2h3z"/>' +
    '<path d="M21.2 20.4l4.4-9.6 4.4 9.6z' +
    'M25.6 15.2l-1.5 3.2h3z"/>',
  ),
  // A rifle held up. War support is the nation's willingness to fight, and the
  // warning triangle it borrowed meant "something is wrong".
  war_support: solid(
    '<path d="M20.6 2.4l3 1.9-14.4 22.6-3-1.9z"/>' +
    '<path d="M8.2 20.6l6.4 4.1-2 3.1-6.4-4.1z"/>' +
    '<path d="M17.4 9.2l5.2 3.3-1.5 2.4-5.2-3.3z"/>',
  ),
  warning: solid(
    '<path d="M16 2.8l14 25.4H2z' +
    'M14.6 11.4h2.8v8.4h-2.8z' +
    'M14.6 21.6h2.8v3h-2.8z"/>',
  ),
  // Crossed sabres: a focus that hands over a war goal. Distinct from the
  // army tab's chevrons, which mean a formation rather than an intention.
  wargoal: solid(
    '<path d="M4.4 3.2l4.2.5 17 17-3.7 3.7-17-17z' +
    'M27.6 3.2l-.5 4.2-17 17 3.7 3.7 17-17z' +
    'M3.6 24.4l4.4 4.4 3.2-3.2-4.4-4.4z' +
    'M28.4 24.4L24 28.8l-3.2-3.2 4.4-4.4z"/>',
  ),
  // A flag planted on ground that has just changed hands: annexation and
  // cession, which are the same gesture at two scales.
  annex: solid(
    '<path d="M7.6 2.4h3v27.2h-3z' +
    'M12 3.6h15.6l-3.6 5.2 3.6 5.2H12z"/>' +
    '<path d="M2.4 26.4h27.2v3.2H2.4z"/>',
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

/**
 * An equipment silhouette.
 *
 * Non-zero winding, not even-odd like `solid`. These are built by piling
 * simple shapes on top of each other -- a hull, a turret, a gun -- and under
 * even-odd every overlap would punch a hole through the very place the parts
 * join. Nothing here needs an interior cutout; what they need is to survive
 * being 28px wide in a production row, which is what the reference draws
 * beside every line and what this project had nowhere at all.
 */
function silhouette(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" ` +
    `width="${S}" height="${S}" fill="currentColor" fill-rule="nonzero">` +
    body +
    `</svg>`
  );
}

/**
 * One per equipment type, keyed by the type the simulation uses.
 *
 * Drawn side-on, which is how the reference draws them and how a rifle, a
 * truck and a tank are told apart at a glance. The two aircraft are the
 * exception: an aeroplane from the side is a smear, so they are plan views.
 */
export const EQUIPMENT_ICONS: Record<string, string> = {
  // Rifle, drawn corner to corner. Laid out horizontally it occupied the
  // middle third of its box and nothing else, so in a 44px plate it was a
  // thin smear with air above and below it; on the diagonal the same shape
  // fills the square and the length of a rifle is what you see first.
  // Butt, receiver, barrel, magazine, in that order along the axis.
  infantry_equipment: silhouette(
    '<path d="M6 28.5 13.1 22.9 9.1 17.9 2 23.5z"/>' +
    '<path d="M11.6 22.8 21.1 15.3 18.3 11.9 8.9 19.3z"/>' +
    '<path d="M19.6 15.1 29 7.7 27.6 5.9 18.2 13.3z"/>' +
    '<path d="M16.9 18.6 19.4 21.7 16.9 23.7 14.4 20.6z"/>',
  ),
  // A crate, drawn as slats with a lid. A plain filled rectangle is a
  // rectangle; the gaps between the boards are what make it a crate.
  support_equipment: silhouette(
    '<path d="M2.4 8h27.2v3.6H2.4z"/>' +
    '<path d="M4 11.6h6v14.4H4z"/>' +
    '<path d="M13 11.6h6v14.4h-6z"/>' +
    '<path d="M22 11.6h6v14.4h-6z"/>' +
    // A band across the boards. Without it the three slats read as a numeral.
    '<path d="M2.4 16.6h27.2v3.2H2.4z"/>',
  ),
  // Field gun: a raised barrel, the breech under it, one road wheel and the
  // trail running back. The first attempt gave it a six-radius wheel and a
  // barrel lying almost flat, and the parts merged into a blob with a stick
  // through it. What makes a howitzer legible at this size is the angle of
  // the barrel against the horizontal of the trail.
  artillery: silhouette(
    '<path d="M12.8 18.4 29.6 9 28 6 11.2 15.4z"/>' +
    '<path d="M8.6 13.4h5.6v6.6H8.6z"/>' +
    '<circle cx="10.4" cy="22.6" r="4.8"/>' +
    '<path d="M10.6 21.6 2.2 26.4l1.5 2.6 8.4-4.8z"/>',
  ),
  // Truck: box body, cab with a sloped bonnet, two wheels.
  motorized: silhouette(
    '<path d="M2 11.6h16v10.6H2z"/>' +
    '<path d="M18 15h5.6l4.6 4.6v2.6H18z"/>' +
    '<circle cx="8" cy="24.4" r="3.4"/>' +
    '<circle cx="23.2" cy="24.4" r="3.4"/>',
  ),
  // Light tank: shallow hull, small turret, four road wheels.
  light_armor: silhouette(
    '<path d="M3 16.8h26v6.2H3z"/>' +
    '<path d="M11 11.8h9v5h-9z"/>' +
    '<path d="M19.6 13.4h9.8v1.9h-9.8z"/>' +
    '<circle cx="7.2" cy="24" r="2.6"/>' +
    '<circle cx="13.4" cy="24" r="2.6"/>' +
    '<circle cx="19.6" cy="24" r="2.6"/>' +
    '<circle cx="25.8" cy="24" r="2.6"/>',
  ),
  // Medium tank: sloped glacis, taller turret, a longer gun. It has to read as
  // the bigger of the two next to the light tank in a list, not merely as a
  // different tank.
  medium_armor: silhouette(
    '<path d="M2 15.6h28v7.4H2z"/>' +
    '<path d="M2 15.6 8 11.4h16l6 4.2z"/>' +
    '<path d="M11.6 6.6h9.4v5.2h-9.4z"/>' +
    '<path d="M20.6 8h9.6v2h-9.6z"/>' +
    '<circle cx="6" cy="24" r="2.9"/>' +
    '<circle cx="12" cy="24" r="2.9"/>' +
    '<circle cx="18" cy="24" r="2.9"/>' +
    '<circle cx="24" cy="24" r="2.9"/>',
  ),
  // Fighter, from above: straight wing, narrow fuselage.
  fighter: silhouette(
    '<path d="M14.4 2.4h3.2l1.4 24h-6z"/>' +
    '<path d="M2 13.6h28v4.2H2z"/>' +
    '<path d="M8.4 24h15.2v3.2H8.4z"/>',
  ),
  // Close support, from above: a cranked wing, which is the shape that tells
  // it apart from the fighter at this size.
  cas: silhouette(
    '<path d="M14.2 2.4h3.6l1.4 24h-6.4z"/>' +
    '<path d="M2 12.4 11.4 15.6h9.2L30 12.4v4.4l-9.4 3.2h-9.2L2 16.8z"/>' +
    '<path d="M8.8 24h14.4v3.2H8.8z"/>',
  ),
  // Cargo ship: raked hull, deck house, funnel, mast.
  convoy: silhouette(
    '<path d="M2 18.8h28l-4 7.4H6z"/>' +
    '<path d="M11.6 11.6h7.4v7.4h-7.4z"/>' +
    '<path d="M13.6 7.4h3.2v4.4h-3.2z"/>' +
    '<path d="M22 9.6h1.8v9.4H22z"/>',
  ),
};

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

export const ALL_ICONS = { ...RESOURCE_ICONS, ...UI_ICONS, ...EQUIPMENT_ICONS };

// ---------------------------------------------------------------------------
// Officer portraits
// ---------------------------------------------------------------------------

/** Portraits are the one thing here that is taller than it is wide. */
const PW = 36;
const PH = 44;

/**
 * The only art in the project that is not one flat ink.
 *
 * Everything else here is a mask the interface tints. A face cannot be: drawn
 * in a single colour, the cap merges into the hair, the hair into the head,
 * the head into the neck and the neck into the shoulders, and what comes out
 * is a snowman -- which is exactly what the first attempt produced, eight
 * times over and indistinguishable. A portrait needs tone: a dark uniform, a
 * light face, and the features cut back into the face in the dark tone. Three
 * colours is enough for a woodcut and a woodcut is enough at 40px.
 */
const P_BACK = '#211f1a';
const P_COAT = '#4a4639';
const P_TRIM = '#615b49';
const P_SKIN = '#c9a888';
const P_DARK = '#2b2621';

function portrait(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PW} ${PH}" ` +
    `width="${PW}" height="${PH}">` +
    `<rect width="${PW}" height="${PH}" fill="${P_BACK}"/>` +
    body +
    `</svg>`
  );
}

/** Shoulders and chest. `braid` squares off an epaulette at each end. */
function body_(braid: boolean): string {
  return (
    `<path d="M2 44c0-8.2 5.6-13 16-14.4C28.4 31 34 35.8 34 44z" fill="${P_COAT}"/>`
    // A collar, so the head is not growing straight out of the coat.
    + `<path d="M13.6 30.6 18 36l4.4-5.4 2.6 1.1L18 39l-7-7.3z" fill="${P_TRIM}"/>`
    + (braid
      ? `<path d="M2.6 37.2h7.2v3H2.6zM26.2 37.2h7.2v3h-7.2z" fill="${P_TRIM}"/>`
      : '')
  );
}

const NECK = `<path d="M14.9 24h6.2v7.4h-6.2z" fill="${P_SKIN}"/>`;
const HEAD = `<ellipse cx="18" cy="17" rx="7.2" ry="8.4" fill="${P_SKIN}"/>`;
/** Eyes, always. A face without them is a thumb. */
const EYES = `<path d="M14.3 15.6h2.1v1.5h-2.1zM19.6 15.6h2.1v1.5h-2.1z" fill="${P_DARK}"/>`;

/** A peaked service cap: crown, band, and a visor that juts forward. */
const CAP_PEAKED =
  `<path d="M9.6 11.4c0-4.4 3.8-6.8 8.4-6.8s8.4 2.4 8.4 6.8z" fill="${P_COAT}"/>`
  + `<path d="M9.2 11.2h17.6v2.6H9.2z" fill="${P_DARK}"/>`
  + `<path d="M7.2 13.6h21.6v1.9H7.2z" fill="${P_TRIM}"/>`;
/** A folded side cap, no visor. */
const CAP_SIDE =
  `<path d="M10.4 13.4c0-4.8 3.4-7.4 7.6-7.4s7.6 2.6 7.6 7.4z" fill="${P_COAT}"/>`
  + `<path d="M10.4 12.6h15.2v2.1H10.4z" fill="${P_TRIM}"/>`;
/** A steel helmet: a dome with a flared rim. */
const HELMET =
  `<path d="M8.6 14a9.4 9.8 0 0 1 18.8 0z" fill="${P_TRIM}"/>`
  + `<path d="M7 13.6h22v2.4a1.8 1.8 0 0 1-1.8 1.8H8.8A1.8 1.8 0 0 1 7 16z" fill="${P_COAT}"/>`;
/** Bare, hair swept back. */
const HAIR = `<path d="M10.8 13.2c0-5 3.2-7.8 7.2-7.8s7.2 2.8 7.2 7.8c-2.2-2.6-4.4-3.6-7.2-3.6s-5 1-7.2 3.6z" fill="${P_DARK}"/>`;

const MOUSTACHE = `<path d="M14.6 20.1h6.8v1.9h-6.8z" fill="${P_DARK}"/>`;
const BEARD = `<path d="M11.8 20.4c1 4.2 3 6.2 6.2 6.2s5.2-2 6.2-6.2c-1.6 2.6-3.6 3.6-6.2 3.6s-4.6-1-6.2-3.6z" fill="${P_DARK}"/>`;
const GLASSES =
  `<path d="M12.4 14.9h4.6v3.2h-4.6zM19 14.9h4.6v3.2H19z" fill="none" `
  + `stroke="${P_DARK}" stroke-width="1"/>`
  + `<path d="M17 16.2h2v.9h-2z" fill="${P_DARK}"/>`;

/**
 * The eight officers, in the order the strip picks them.
 *
 * Ordered so that neighbours differ in the loudest feature first -- headgear
 * -- because the strip shows them side by side and that is the comparison the
 * player actually makes. The name and the division count underneath carry the
 * rest of the identifying; these only have to be eight different men.
 */
export const PORTRAIT_ICONS: Record<string, string> = {
  '0': portrait(body_(true) + NECK + HEAD + EYES + CAP_PEAKED + MOUSTACHE),
  '1': portrait(body_(false) + NECK + HEAD + EYES + CAP_SIDE),
  '2': portrait(body_(false) + NECK + HEAD + EYES + HELMET),
  '3': portrait(body_(true) + NECK + HEAD + EYES + HAIR + BEARD),
  '4': portrait(body_(false) + NECK + HEAD + EYES + CAP_PEAKED + GLASSES),
  '5': portrait(body_(true) + NECK + HEAD + EYES + CAP_SIDE + MOUSTACHE),
  '6': portrait(body_(false) + NECK + HEAD + EYES + HAIR + GLASSES),
  '7': portrait(body_(true) + NECK + HEAD + EYES + HELMET + MOUSTACHE),
};
