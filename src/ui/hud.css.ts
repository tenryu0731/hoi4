/**
 * HUD styling.
 *
 * Kept as a TypeScript string rather than a stylesheet so the whole HUD ships
 * as one module and the styles cannot load out of order with the code that
 * depends on them.
 *
 * Two rules govern the layout. Every interactive element is at least 32px on
 * its short axis and 44px on its long one, because a fingertip is about 8mm.
 * And nothing interactive sits in the middle third of the screen: that band
 * belongs to the map's pan and pinch gestures, and a control there silently
 * eats them.
 */
export const HUD_CSS = `
/* A column, not a row. Portrait screens are 412px wide: a flag, a name, five
   figures and a clock on one line pushed the clock off the right-hand edge,
   which is exactly the control a player needs most. */
.hud-top {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; flex-direction: column; gap: 4px; touch-action: manipulation;
  padding: calc(var(--safe-top) + 6px) 8px 8px;
  /* Opaque and warm, not a fade to nothing. HOI4's top bar is a solid strip of
     dark steel with a hard bottom edge; a gradient dissolving into the map
     left the figures sitting on whatever colour the terrain happened to be. */
  background: linear-gradient(180deg, #2c2b28 0%, #232220 62%, #1b1a17 100%);
  border-bottom: 1px solid #0d0c0a;
  box-shadow: inset 0 1px 0 var(--edge-hi), 0 2px 8px rgba(0,0,0,0.55);
  pointer-events: auto;
}
.hud-top-row { display: flex; align-items: center; gap: 8px; }
/* The flag and the country name are one control: it opens politics. */
.hud-identity {
  display: flex; align-items: center; gap: 8px; min-height: 44px;
  padding: 0; background: none; border: none; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
.hud-identity:active { transform: none; }
.hud-identity:active .hud-flag { box-shadow: 0 0 0 1px var(--accent), 0 1px 3px rgba(0,0,0,0.7); }
.hud-spacer { flex: 1 1 auto; }
.hud-flag {
  width: 34px; height: 23px; flex: 0 0 auto;
  /* Framed, the way every flag in the game is: a hard dark rule with a thin
     gold inner edge. An unframed rectangle reads as a placeholder image. */
  border: 1px solid #0d0c0a;
  box-shadow: 0 0 0 1px rgba(211,171,99,0.45), 0 1px 3px rgba(0,0,0,0.7);
  background: #2b2a26;
}
.hud-country { min-width: 0; flex: 0 0 auto; }
.hud-country-name {
  font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 74px;
}
.hud-country-tag {
  font-size: 9px; color: var(--accent-dim); letter-spacing: var(--track);
}

/* The figures and the resources are one scrolling row of identical chips. */
/* The panning these rows want, declared rather than assumed. The page sets
   touch-action: none on body, and the spec says the used value is the
   intersection along the hit-test chain, which would veto scrolling here --
   but measured on Chromium it does not: a swipe scrolls these rows to 287px
   with the body rule in force and with it removed alike. So these are an
   explicit statement of intent, not a fix for anything. */
.hud-stats, .hud-resources {
  display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
  touch-action: pan-x;
  /* Should a row still not fit, fading the trailing edge is what tells the
     player it continues, rather than the last chip being guillotined by the
     screen edge with no affordance at all. */
  -webkit-mask-image: linear-gradient(90deg, #000 94%, transparent);
          mask-image: linear-gradient(90deg, #000 94%, transparent);
}
.hud-stats::-webkit-scrollbar, .hud-resources::-webkit-scrollbar { display: none; }
.hud-stats > *, .hud-resources > * { flex: 0 0 auto; }
.hud-stat, .hud-res {
  display: flex; align-items: center; gap: 4px;
  background: linear-gradient(180deg, #302e29 0%, #211f1b 100%);
  border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: var(--bevel);
  padding: 3px 6px; white-space: nowrap;
}
.hud-stat-v {
  font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
  text-align: right;
}
/* The caption next to a figure. Without this rule it inherits the body
   default -- 16px, regular weight, full-strength ink -- which is larger and
   louder than the number it is labelling, in seventeen places across the
   panels. HOI4 does the exact inverse: a big bright value, a small dim name.
   The top bar has no captions at all; only the panel headers use these. */
.hud-stat-l {
  font-size: 10px; font-weight: 400; letter-spacing: var(--track);
  color: var(--ink-dim);
}
.panel-head .hud-stat-v { font-size: 16px; }
.panel-head .hud-stat { gap: 5px; padding: 5px 7px; }
/* A brief tint as a figure moves, so a change is noticed without the player
   having to be looking at that number when it happens. */
.hud-stat-v.is-changing { animation: hud-flash 520ms ease-out; }
@keyframes hud-flash {
  0% { color: var(--accent); }
  100% { color: inherit; }
}

/* The alert row. Amber for something idle, red for something being lost. */
.hud-alerts {
  display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
  touch-action: pan-x;
}
.hud-alerts.is-empty { display: none; }
.hud-alerts::-webkit-scrollbar { display: none; }
.hud-alert {
  display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
  /* 44px on the long axis and 36 on the short, which is the rule this file
     opens with. They are buttons, not chips: each one opens the panel where
     the problem is fixed. */
  min-width: 44px; min-height: 36px; padding: 3px 9px; justify-content: center;
  background: linear-gradient(180deg, #3a3222 0%, #2a2417 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
  color: var(--accent); font: inherit; font-size: 12px; cursor: pointer;
}
.hud-alert.is-urgent {
  background: linear-gradient(180deg, #3f2620 0%, #2c1a16 100%);
  color: #e8a094;
}
/* A slow pulse, so a warning is noticed without being a strobe. */
.hud-alert.is-urgent { animation: hud-alert-pulse 2.4s ease-in-out infinite; }
@keyframes hud-alert-pulse {
  0%, 100% { border-color: #100f0d; }
  50% { border-color: #8a4034; }
}
.hud-alert-v { font-weight: 700; font-variant-numeric: tabular-nums; }

.hud-clock { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.hud-date {
  font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
  white-space: nowrap; text-align: right; letter-spacing: 0.04em;
  color: var(--ink);
}
.hud-speed { display: flex; align-items: center; gap: 3px; }
/* 44px square. The speed used to be five 8px pips two pixels apart, which no
   thumb can hit; these are the controls a player reaches for most. */
.hud-btn {
  min-width: 44px; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #3a372f 0%, #26241f 100%);
  color: var(--ink);
  border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: var(--bevel);
  font-size: 16px; line-height: 1; cursor: pointer;
}
.hud-btn:active { background: linear-gradient(180deg, #211f1b 0%, #2b2924 100%); }
.hud-btn.is-paused { color: var(--accent); border-color: var(--accent-dim); }
.hud-step { font-size: 20px; font-weight: 700; }
/* Dimmed, not disabled: a disabled button gives no feedback at all when a
   player presses it and cannot tell why nothing happened. */
.hud-step.is-off { color: var(--ink-dim); opacity: 0.45; }
.hud-speed-v {
  font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums;
  min-width: 1.4ch; text-align: center; color: var(--accent);
}
/* Greyed while paused: the number is the speed you will resume at, and it
   should not read as the speed the clock is running at right now. */
.hud-speed-v.is-paused { color: var(--ink-dim); }


/* Masked rather than drawn: see iconNode. The background supplies the colour,
   so these tint with whatever colour the enclosing control carries. */
.hud-res-icon, .hud-nav-icon {
  display: inline-block; flex: none;
  background: currentColor;
  -webkit-mask: var(--icon) center / contain no-repeat;
          mask: var(--icon) center / contain no-repeat;
}
.hud-res-icon { width: 14px; height: 14px; color: #a89b80; }
.hud-res-v {
  font-size: 11px; font-variant-numeric: tabular-nums;
  min-width: 3ch; text-align: right;
}
.hud-res-v.is-short, .hud-stat-v.is-short { color: var(--danger); font-weight: 700; }
.hud-res-l { font-size: 11px; color: var(--ink-dim); letter-spacing: 0; }

/* Map modes hug the top-right so the centre of the screen stays gesture-only. */
.hud-modes {
  position: absolute; top: calc(var(--hud-top-h, 88px) + 6px); right: 8px;
  display: flex; flex-direction: column; gap: 5px; pointer-events: auto;
  touch-action: manipulation;
}
/* 44px, like everything else. These were 28px tall on a 31px pitch, and they
   are the only way to change map mode. */
.hud-mode {
  min-width: 58px; min-height: 44px; padding: 0 7px;
  font-size: 11px; letter-spacing: 0.05em;
  background: linear-gradient(180deg, rgba(48,46,41,0.94) 0%, rgba(29,28,24,0.94) 100%);
  color: var(--ink-dim);
  border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: var(--bevel); cursor: pointer;
}
.hud-mode.is-active {
  color: #1a1811; font-weight: 700;
  background: linear-gradient(180deg, #e0bd7c 0%, #b08f4e 100%);
  border-color: #6d5730;
}

/* --- alerts -------------------------------------------------------------- */
.hud-toasts {
  position: absolute; top: calc(var(--hud-top-h, 88px) + 6px); left: 10px;
  display: flex; flex-direction: column; gap: 4px;
  max-width: 62%; pointer-events: none;
}
.hud-toast {
  font-size: 11px; line-height: 1.45; padding: 6px 9px;
  background: rgba(28,26,22,0.95); border-left: 3px solid var(--accent);
  border-radius: 0 2px 2px 0; box-shadow: var(--bevel);
  opacity: 1; transition: opacity 500ms ease;
}
.hud-toast.is-out { opacity: 0; }
.hud-toast.kind-war { border-left-color: var(--danger); }
.hud-toast.kind-capitulation { border-left-color: #b06ad0; }
.hud-toast.kind-construction { border-left-color: var(--good); }
.hud-toast.kind-outcome { border-left-color: #fff; }

/* --- bottom sheet -------------------------------------------------------- */
.hud-sheet {
  position: absolute; left: 0; right: 0; bottom: calc(var(--safe-bottom) + 56px);
  background: linear-gradient(180deg, #2a2823 0%, #201f1b 34%, #1b1a17 100%);
  border-top: 1px solid #0d0c0a;
  box-shadow: inset 0 1px 0 var(--edge-hi), 0 -4px 14px rgba(0,0,0,0.6);
  transform: translateY(calc(100% + var(--safe-bottom) + 56px));
  transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: auto;
  /* Height is the player's, dragged on the grip and remembered. One fixed
     52vh was too short for the technology list and too tall for a province
     card, and there was no way to say so. */
  height: var(--sheet-h, 52vh);
  display: flex; flex-direction: column;
}
.hud-sheet.is-open { transform: translateY(0); }
/* No easing while a finger is on the grip: the transition made the panel lag
   half a second behind the drag. */
.hud-sheet.is-dragging { transition: none; }
.hud-sheet-grip {
  width: 100%; padding: 14px 0 10px; flex: 0 0 auto; cursor: grab;
  display: flex; justify-content: center; touch-action: none;
}
.hud-sheet-grip::after {
  content: ''; display: block; width: 40px; height: 4px; border-radius: 2px;
  background: #56503f; box-shadow: 0 1px 0 rgba(0,0,0,0.6);
}
.hud-sheet-header {
  display: flex; align-items: center; gap: 4px;
  padding: 0 8px 7px; flex: 0 0 auto;
  border-bottom: 1px solid #0d0c0a;
  box-shadow: 0 1px 0 var(--edge-hi);
  margin-bottom: 9px;
}
/* Letterspaced, the way every panel heading in HOI4 is set. Japanese has no
   small caps, so the tracking alone has to carry that register. */
.hud-sheet-title {
  flex: 1 1 auto; min-width: 0;
  font-size: 14px; font-weight: 700; letter-spacing: var(--track);
  color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hud-sheet-zoom {
  width: 40px; height: 44px; flex: 0 0 auto; font-size: 16px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #37342d 0%, #24221e 100%);
  color: var(--ink); border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: var(--bevel); cursor: pointer;
}
.hud-sheet-zoom-v {
  min-width: 4ch; text-align: center; flex: 0 0 auto;
  font-size: 11px; font-variant-numeric: tabular-nums; color: var(--ink-dim);
}
.hud-sheet-close {
  width: 40px; height: 44px; flex: 0 0 auto; font-size: 20px; line-height: 1;
  background: transparent; color: var(--ink-dim); border: none; cursor: pointer;
}
.hud-sheet-body {
  padding: 0 10px 14px; overflow-y: auto; -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  /* CSS zoom, not a scaled transform: zoom takes part in layout, so the text
     rewraps and the scroll height is right. A transform would draw the panel
     larger while laying it out for the old size, leaving the bottom of a
     zoomed panel unreachable. */
  zoom: var(--sheet-zoom, 1);
}

/* --- panels -------------------------------------------------------------- */
/* Scrolls rather than clips. Four figures with Japanese labels need about
   560px and the sheet is 392px wide, so the last one was being cut in half by
   the panel edge with nothing to say it was there. */
.panel-head {
  display: flex; gap: 6px; padding: 8px 9px 9px; margin-bottom: 9px;
  background: linear-gradient(180deg, #302d27 0%, #232119 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
  overflow-x: auto; scrollbar-width: none; touch-action: pan-x;
  -webkit-mask-image: linear-gradient(90deg, #000 93%, transparent);
          mask-image: linear-gradient(90deg, #000 93%, transparent);
}
.panel-head::-webkit-scrollbar { display: none; }
.panel-head > * { flex: 0 0 auto; }
.panel-sub { font-size: 11px; color: var(--ink-dim); margin-bottom: 8px; }
/* A section heading with the gold rule HOI4 draws under its own. */
.panel-label {
  font-size: 11px; letter-spacing: var(--track); font-weight: 700;
  color: var(--accent); margin: 13px 0 6px; padding-bottom: 4px;
  border-bottom: 1px solid rgba(211,171,99,0.22);
}
.panel-list { display: flex; flex-direction: column; gap: 3px; }
.panel-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 2px;
  background: linear-gradient(180deg, #2b2924 0%, #211f1b 100%);
  border: 1px solid #100f0d; box-shadow: var(--bevel);
}
.panel-row.is-hostile {
  background: linear-gradient(180deg, #3a2622 0%, #2a1a17 100%);
  border-color: #1a0d0b;
}
.panel-row.is-dead { opacity: 0.45; }
.panel-row-main { flex: 1 1 auto; min-width: 0; }
.panel-row-title {
  font-size: 13px; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.panel-row-sub { font-size: 11px; color: var(--ink-dim); margin-top: 2px; line-height: 1.6; }
.panel-row-controls { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
/* The same frame the player's own flag carries in the top bar, at list size. */
.panel-flag {
  width: 26px; height: 17px; flex: 0 0 auto; object-fit: cover;
  border: 1px solid #0d0c0a;
  box-shadow: 0 0 0 1px rgba(211,171,99,0.35), 0 1px 2px rgba(0,0,0,0.7);
}
.panel-btn {
  min-width: 44px; min-height: 44px; padding: 0 8px;
  background: linear-gradient(180deg, #38352d 0%, #25231e 100%); color: var(--ink);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
  font-size: 13px; line-height: 1; cursor: pointer;
}
.panel-btn:active { background: linear-gradient(180deg, #201e1a 0%, #2a2823 100%); }
/* Japanese has no ascender/descender rhythm to fall back on, so 10px glyphs
   lose their internal strokes entirely. These are primary verbs -- declare
   war, start a focus, add a division -- and they were the smallest text on
   the screen. 12px is the floor for CJK now. */
.panel-btn.wide { min-width: 64px; font-size: 12px; }
.panel-btn.danger {
  color: #f0a49a; border-color: #100f0d;
  background: linear-gradient(180deg, #43302b 0%, #2c1e1a 100%);
}
.panel-btn:disabled { color: #7d7566; background: #1c1b17; }
.panel-count {
  min-width: 22px; text-align: center; font-size: 12px;
  font-variant-numeric: tabular-nums;
}
/* Sunk into the plate rather than laid on top of it, and thick enough to
   read: three transparent pixels were invisible against the row behind. */
.panel-bar {
  height: 6px; background: #14130f; border: 1px solid #0b0a08; border-radius: 1px;
  margin-top: 5px; overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.7);
}
.panel-bar-fill {
  display: block; height: 100%; width: 0%;
  background: linear-gradient(180deg, #e2c184 0%, #a8853f 100%);
}
.panel-empty { font-size: 11px; color: var(--ink-dim); padding: 8px 0; }
.panel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.panel-build {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  min-height: 46px; padding: 7px 9px; text-align: left;
  background: linear-gradient(180deg, #33302a 0%, #232119 100%); color: var(--ink);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
  cursor: pointer;
}
.panel-build:disabled { color: #8b8371; }
.panel-build-title { font-size: 13px; font-weight: 700; }
.panel-build-sub {
  font-size: 11px; color: var(--ink-dim); line-height: 1.7;
  white-space: pre-line; line-break: strict; overflow-wrap: normal;
}
/* The blocking reason, so a disabled recruit button says what it is waiting
   for instead of just refusing. */
.panel-build-note {
  display: block; margin-top: 5px; font-size: 11px; letter-spacing: 0;
  color: var(--accent);
}
.panel-build.is-blocked {
  background: linear-gradient(180deg, #2a2822 0%, #1e1c18 100%);
  color: #a49b89;
}
.panel-build.is-blocked .panel-build-sub { color: #8b8371; }
.panel-build { position: relative; }
.panel-build.is-on {
  border-color: var(--accent-dim); color: var(--accent);
  background: linear-gradient(180deg, #3d3626 0%, #2a2418 100%);
  box-shadow: var(--bevel), inset 0 0 0 1px rgba(211,171,99,0.18);
}
/* Sits on the recruit tile rather than beside it: the tile is already the
   width of half the sheet, and a second full-width row per template would
   push the equipment list off the screen. */
.panel-edit {
  position: absolute; top: 4px; right: 4px; min-width: 44px; min-height: 44px;
  padding: 2px 8px; font-size: 12px; color: var(--ink-dim);
  background: rgba(0,0,0,0.4); border: 1px solid #100f0d; border-radius: 2px;
}
.panel-input {
  flex: 1; min-height: 40px; padding: 8px 10px; font: inherit; font-size: 13px;
  color: var(--ink); background: #14130f;
  border: 1px solid #0b0a08; border-radius: 2px;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.7);
}
.panel-btn.primary {
  background: linear-gradient(180deg, #e0bd7c 0%, #a8853f 100%);
  border-color: #6d5730; color: #1a1811; font-weight: 700;
}
.panel-build.is-blocked .panel-build-note { color: var(--danger); }
.panel-kvs { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 14px; }
.panel-kv {
  display: flex; justify-content: space-between; gap: 8px; font-size: 12px;
  padding: 3px 0; border-bottom: 1px dotted rgba(157,148,132,0.3);
}
.panel-k { color: var(--ink-dim); }
.panel-v { font-variant-numeric: tabular-nums; text-align: right; }

/* --- bottom navigation --------------------------------------------------- */
.hud-nav {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; padding-bottom: var(--safe-bottom); touch-action: manipulation;
  background: linear-gradient(180deg, #2c2a25 0%, #1c1b17 100%);
  border-top: 1px solid #0d0c0a;
  box-shadow: inset 0 1px 0 var(--edge-hi), 0 -2px 8px rgba(0,0,0,0.5);
  pointer-events: auto;
}
/* A hairline between tabs, as on the real toolbar. */
.hud-nav-btn + .hud-nav-btn { border-left: 1px solid rgba(0,0,0,0.45); }
.hud-nav-btn {
  flex: 1 1 0; min-width: 0; min-height: 56px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  background: transparent; border: none; color: var(--ink-dim); cursor: pointer;
  padding: 0 2px;
}
/* An indicator, not a block. The full-height olive rectangle it replaces had
   square corners and no relationship to anything else on screen, so it read as
   a compositing seam rather than a selected tab. */
.hud-nav-btn { position: relative; }
.hud-nav-btn.is-active {
  color: var(--accent);
  background: linear-gradient(180deg, rgba(211,171,99,0.14) 0%, rgba(211,171,99,0) 70%);
}
.hud-nav-btn.is-active::before {
  content: ''; position: absolute; top: 0; left: 22%; right: 22%;
  height: 2px; background: var(--accent); border-radius: 0 0 2px 2px;
}
.hud-nav-icon { width: 18px; height: 18px; }
.hud-nav-label {
  font-size: 11px; letter-spacing: 0; white-space: nowrap;
  overflow: hidden; text-overflow: clip;
}

/* --- outcome ------------------------------------------------------------- */
.hud-outcome {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 45%, rgba(20,40,64,0.9), rgba(6,10,16,0.96));
  opacity: 0; pointer-events: none; transition: opacity 600ms ease;
}
.hud-outcome.is-shown { opacity: 1; pointer-events: auto; }
.hud-outcome-card { display: flex; flex-direction: column; align-items: center; }
.hud-outcome-title {
  font-family: Georgia, "Times New Roman", "Hiragino Mincho ProN", "Yu Mincho",
    "Noto Serif JP", serif;
  /* No tracking: it is applied after the final glyph too, so centred CJK
     drifts left by half a letter-space. */
  font-size: 44px; color: var(--good); text-align: center;
}
.hud-outcome-again {
  margin-top: 22px; padding: 10px 26px; min-height: 44px;
  background: rgba(216,176,74,0.12); border: 1px solid var(--accent);
  border-radius: 3px; color: var(--accent); font-size: 13px;
}
.hud-outcome.is-defeat .hud-outcome-title { color: var(--danger); }
.hud-outcome-sub {
  margin-top: 10px; font-size: 13px; color: var(--ink-dim);
  text-align: center; max-width: 80vw;
}

@media (max-width: 380px) {
  .hud-stats { gap: 3px; }
  /* Below 380px the clock cannot keep its 44px targets and the country name
     at the same time. The flag and the three-letter tag already say who you
     are; the speed control is the one thing on this bar a player must hit. */
  .hud-country-name { display: none; }
  .panel-kvs, .panel-grid { grid-template-columns: 1fr; }
}
@media (min-width: 700px) {
  .panel-kvs { grid-template-columns: 1fr 1fr 1fr; }
}
/* A phone on its side is 412px tall. A bottom sheet at half of that, over an
   86px bar and a 57px tab strip, leaves 55px of map -- the panel and the map
   cannot both be bottom-anchored on a landscape phone. Dock it to the left
   instead, which is where HOI4 docks its own panels. */
@media (orientation: landscape) and (max-height: 560px) {
  .hud-sheet {
    top: var(--hud-top-h, 88px);
    bottom: calc(var(--safe-bottom) + 56px);
    right: auto; width: min(62%, 430px); height: auto;
    border-top: none; border-right: 1px solid #0d0c0a;
    box-shadow: inset -1px 0 0 var(--edge-hi), 4px 0 14px rgba(0,0,0,0.6);
    transform: translateX(-101%);
  }
  .hud-sheet.is-open { transform: translateX(0); }
  /* Nothing to drag vertically when the panel is already full height. */
  .hud-sheet-grip { display: none; }
  .hud-sheet-header { padding-top: 8px; }
  /* The map modes would sit on top of the docked panel. */
  .hud-modes { top: auto; bottom: calc(var(--safe-bottom) + 62px); flex-direction: row; }
  .hud-toasts { max-width: 34%; left: auto; right: 10px; }
}

button { transition: background 90ms ease, transform 90ms ease, color 90ms ease; }
button:active { transform: scale(0.96); }
.hud-nav-btn:active { transform: none; }

.panel-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.panel-chip {
  min-height: 44px; padding: 7px 11px; font-size: 12px;
  background: linear-gradient(180deg, #35322b 0%, #24221d 100%);
  border: 1px solid #100f0d; box-shadow: var(--bevel);
  border-radius: 3px; color: var(--ink-dim);
}
.panel-chip.is-on {
  background: linear-gradient(180deg, #e0bd7c 0%, #b08f4e 100%);
  border-color: #6d5730; color: #1a1811; font-weight: 700;
}
.panel-note { font-size: 11px; color: var(--ink-dim); margin-bottom: 8px; }
/* A state row is the tap target for "build here", so it is a button and needs
   to look like a row rather than like a control. */
.panel-row.wide-row {
  width: 100%; min-height: 46px; text-align: left; cursor: pointer;
  background: transparent; border: none;
  border-bottom: 1px solid rgba(157,148,132,0.18);
  box-shadow: none;
  display: flex; align-items: center; gap: 8px; color: inherit;
}
.panel-row.wide-row.is-blocked { color: #8b8371; }
.panel-row-tag { font-size: 12px; color: var(--accent); flex: none; }
.panel-row.wide-row.is-blocked .panel-row-tag { color: var(--ink-dim); }

/* A section heading that opens and closes. Sized as a full-width control,
   because it is one. */
.panel-section {
  display: flex; align-items: center; gap: 7px; width: 100%;
  min-height: 44px; padding: 0 10px; margin: 12px 0 6px;
  background: linear-gradient(180deg, #322f28 0%, #232119 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
  color: var(--accent); font: inherit; font-size: 12px; font-weight: 700;
  letter-spacing: var(--track); text-align: left; cursor: pointer;
}
.panel-section-l { flex: 1 1 auto; min-width: 0; }
.panel-section-n {
  flex: 0 0 auto; min-width: 2.2ch; padding: 2px 6px;
  background: #14130f; border-radius: 2px;
  color: var(--ink-dim); font-size: 11px; font-variant-numeric: tabular-nums;
  letter-spacing: 0; text-align: center;
}
.panel-caret {
  flex: 0 0 auto; width: 0; height: 0;
  border-left: 5px solid var(--accent);
  border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  transition: transform 140ms ease;
}
.panel-section.is-open .panel-caret { transform: rotate(90deg) translateX(1px); }

/* A focus or a research slot is a card, not a row: it carries a name, a
   sentence, a bar and an action, and squeezing that into a list row makes all
   four illegible. */
.panel-focus {
  padding: 11px 12px; margin-bottom: 8px;
  background: linear-gradient(180deg, #2d2a24 0%, #201f1b 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
}
.panel-focus.is-current {
  border-color: var(--accent-dim);
  background: linear-gradient(180deg, #3a3323 0%, #262117 100%);
  box-shadow: var(--bevel), inset 0 0 0 1px rgba(211,171,99,0.2);
}
/* Dimmed by token, not by opacity. Compositing a whole card at 0.5 took the
   prerequisite line to 1.76:1 and the description to 2.42:1 against a 4.5:1
   floor -- and at the 1936 start every focus but one is locked, so most of the
   panel was unreadable. The blocking reason keeps its full strength: it is the
   one line a player who cannot press the button actually needs. */
.panel-focus.is-done { opacity: 0.62; }
.panel-focus.is-locked {
  background: linear-gradient(180deg, #262420 0%, #1c1b18 100%);
}
.panel-focus.is-locked .panel-focus-name { color: #a49b89; }
.panel-focus.is-locked .panel-focus-desc,
.panel-focus.is-locked .panel-focus-meta { color: #8b8371; }
.panel-focus-name { font-size: 13px; font-weight: 700; margin-bottom: 3px; }
.panel-focus-desc { font-size: 11px; line-height: 1.65; color: var(--ink-dim); }
.panel-focus-effect {
  margin-top: 5px; font-size: 11px; line-height: 1.6; color: #a8c47f;
}
.panel-focus-block { margin-top: 6px; font-size: 11px; color: var(--danger); }
.panel-focus-meta { margin-top: 4px; font-size: 11px; color: var(--ink-dim); }
.panel-focus .panel-btn.wide { margin-top: 9px; width: 100%; min-height: 46px; }

/* --- chain of command ---------------------------------------------------- */
/* The whole card header is the control that opens it, so it is a button with
   the title's typography rather than a title with a button beside it. */
.panel-army-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  min-height: 44px; padding: 0; margin-bottom: 2px;
  background: none; border: none; box-shadow: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.panel-army-head .panel-focus-name { flex: 1 1 auto; min-width: 0; margin-bottom: 0; }
.panel-army-count {
  flex: 0 0 auto; padding: 3px 8px;
  background: #14130f; border: 1px solid #0b0a08; border-radius: 2px;
  font-size: 12px; font-variant-numeric: tabular-nums; color: var(--ink-dim);
}
/* A general with more divisions than he can handle is the one number on this
   panel the player has to notice, so it is the one thing painted in alarm. */
.panel-army-head.is-over .panel-army-count {
  color: var(--danger); border-color: #4a1f1a; font-weight: 700;
}
.panel-attrs { display: flex; gap: 5px; margin: 8px 0 2px; }
.panel-attr {
  flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 5px 2px;
  background: linear-gradient(180deg, #302d27 0%, #232119 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
}
.panel-attr-l { font-size: 10px; color: var(--ink-dim); letter-spacing: var(--track); }
.panel-attr-v {
  font-size: 16px; font-weight: 700; color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.panel-focus .panel-bar { margin-top: 7px; }
`;
