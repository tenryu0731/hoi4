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
/* A pale metal surround, as in the reference. The frame used to be #0d0c0a,
   which the black band of the German tricolour met at 1.028:1 -- the top third
   of the flag disappeared into its own border and the player's identity
   control rendered as white-over-red, which is Poland. */
.hud-flag {
  width: 34px; height: 23px; flex: 0 0 auto;
  border: 1px solid #8a7f6a;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.7);
  background: #2b2a26;
}
.hud-country { min-width: 0; flex: 0 0 auto; }
.hud-country-name {
  font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 74px;
}
.hud-country-tag {
  font-size: 11px; color: var(--ink-dim); letter-spacing: var(--track);
}

/* The figures and the resources are one scrolling row of identical chips. */
/* The panning these rows want, declared rather than assumed. The page sets
   touch-action: none on body, and the spec says the used value is the
   intersection along the hit-test chain, which would veto scrolling here --
   but measured on Chromium it does not: a swipe scrolls these rows to 287px
   with the body rule in force and with it removed alike. So these are an
   explicit statement of intent, not a fix for anything. */
.hud-figures { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.hud-stats, .hud-resources {
  display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
  touch-action: pan-x;
}
/* Should a row still not fit, fading the trailing edge is what tells the
   player it continues, rather than the last chip being guillotined by the
   screen edge with no affordance at all. Applied only when the row actually
   overflows: unconditionally, it dimmed the last chip of a row that fits. */
.hud-stats.is-clipped, .hud-resources.is-clipped, .hud-alerts.is-clipped {
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
/* A caption under every figure in the top bar.
   Measured before: eight icon-and-number chips, no words anywhere, and two of
   the icons are a bank and a pair of scales. The caption goes underneath
   rather than beside because beside costs 21px of width per chip on a strip
   that already overflows -- 446px of content in 396px -- while underneath
   costs 11px of height once, for the whole row. */
.hud-stats > .hud-stat, .hud-resources > .hud-res, .hud-alerts > .hud-alert {
  flex-direction: column; align-items: center; gap: 0; padding: 2px 6px 3px;
}
.hud-chip-line { display: flex; align-items: center; gap: 4px; }
.hud-chip-c {
  font-size: 9px; font-weight: 400; line-height: 11px;
  letter-spacing: 0; color: var(--ink-dim);
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
.hud-res-v.is-short, .hud-stat-v.is-short { color: #f0a294; font-weight: 700; }
/* Hidden until the country has any of it at all. */
.hud-res.is-idle { display: none; }
.hud-res-l { font-size: 11px; color: var(--ink-dim); letter-spacing: 0; }

/* Map modes hug the top-right so the centre of the screen stays gesture-only. */
/* Bounded by the space above the sheet. Raising these to 44px tall pushed the
   column to y 157..446 while an open panel's top edge lands at y 361 on a
   412px screen and y 250 on a 360px one -- so opening any panel buried two of
   the six buttons, and four of them on a small screen. Measured with
   elementFromPoint: 補給 15% reachable, 勝利点 0%. */
.hud-modes {
  position: absolute; top: calc(var(--hud-top-h, 88px) + 6px); right: 8px;
  display: flex; flex-direction: column; gap: 5px; pointer-events: auto;
  touch-action: manipulation;
}
/* With a panel open there is no vertical room for a column of six, and laying
   it down horizontally was worse: it put a 44px full-width band of buttons
   across the middle of the map, measured at y 311..355 from x 8 to 404, which
   swallowed every tap aimed at the ground underneath it. So it collapses to
   one button showing the current mode, and opens on demand. */
.is-panel-open .hud-modes:not(.is-open) .hud-mode { display: none; }
.is-panel-open .hud-modes:not(.is-open) .hud-mode.is-active { display: flex; }
.hud-modes-toggle { display: none; }
.is-panel-open .hud-modes-toggle {
  display: flex; align-items: center; justify-content: center;
  min-width: 58px; min-height: 44px;
  background: linear-gradient(180deg, rgba(48,46,41,0.94) 0%, rgba(29,28,24,0.94) 100%);
  color: var(--ink-dim); border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: var(--bevel); font: inherit; font-size: 16px; cursor: pointer;
}
.is-panel-open .hud-modes { max-height: calc(var(--map-band, 60vh) - 12px); overflow: hidden; }
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

/* The marquee tool sits under the mode column with a gap, so it reads as a
   different kind of control rather than a seventh map mode. Deliberately not
   a .hud-mode: the collapse rule above must not hide it when a panel opens. */
.hud-select-tool {
  min-width: 58px; min-height: 44px; padding: 0 7px; margin-top: 7px;
  font-size: 11px; letter-spacing: 0.05em;
  background: linear-gradient(180deg, rgba(48,46,41,0.94) 0%, rgba(29,28,24,0.94) 100%);
  color: var(--ink-dim);
  border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: var(--bevel); cursor: pointer;
}
.hud-select-tool.is-active {
  color: #1a1811; font-weight: 700;
  background: linear-gradient(180deg, #e0bd7c 0%, #b08f4e 100%);
  border-color: #6d5730;
}
/* What the armed tool will do, along the foot of the map band where it cannot
   sit over the ground the player is about to draw on. */
.hud-armed {
  position: absolute; left: 8px; right: 8px;
  bottom: calc(var(--safe-bottom) + 64px);
  /* The order bar wants this spot too, but never at the same time: the tool
     is armed before anything is selected, and disarms the moment a rectangle
     names something. */
  display: none; pointer-events: none;
  padding: 7px 10px; border-radius: 3px;
  background: rgba(24,22,18,0.94); border: 1px solid #0f0e0c;
  box-shadow: var(--bevel);
  color: var(--ink); font-size: 12px; text-align: center;
}
.hud-armed.is-on { display: block; }
/* With a panel open the foot of the map band is the sheet. */
.is-panel-open .hud-armed { display: none; }

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

/* --- order hint ---------------------------------------------------------- */
/* Sits just above the sheet, centred, and only while a stack is taking orders.
   Without it the two modes of a single tap -- read this province, march the
   army there -- are indistinguishable, and the gold ring on the counter says
   only "selected", which it also says when nothing has been ordered. */
.hud-order {
  /* At the foot of the map band, not under the top bar.
     It has lived in both places. Under the top bar it sat on the ground the
     player was aiming at, and it moved while they aimed: --hud-top-h grows as
     the top bar gains an alert chip during play, so the bar slid down the map
     as the game ran. Measured with three buttons on it: a tap aimed at a
     province at y=174 opened the 軍へ編成 menu, after elementFromPoint a
     moment earlier had answered CANVAS.
     Down here it is clear of both. This only works because putting a stack
     under orders no longer opens the province sheet -- with the sheet shut,
     the foot of the band is the foot of the screen. With a panel open it goes
     back up top, where the rule below puts it. */
  position: absolute; left: 8px; right: 8px; transform: translateY(8px);
  bottom: calc(var(--safe-bottom) + 64px);
  display: none; flex-direction: column; align-items: stretch; gap: 4px;
  /* Transparent to touch except for its own controls. It sits over the map
     band, and a banner that eats taps is exactly the bug the horizontal
     map-mode strip had: the counter it is telling you about was underneath. */
  pointer-events: none; opacity: 0;
  transition: opacity 160ms ease, transform 160ms ease;
}
.hud-order.is-on { display: flex; opacity: 1; transform: translateY(0); }
/* A panel takes the foot of the screen, so the bar returns to the corner it
   used to live in -- clear of the map-mode column, and with the band that
   small the player is not aiming at counters anyway. */
.is-panel-open .hud-order {
  bottom: auto; top: calc(var(--hud-top-h, 200px) + 8px); right: 74px;
}
/* The chip row hangs off the bottom edge normally; with the bar up top it has
   to hang off the other way round. Column-reverse keeps the row against the
   bar in both directions without a second copy of the markup. */
.hud-order { flex-direction: column-reverse; }
.is-panel-open .hud-order { flex-direction: column; }
.hud-order-row {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 0 4px 0 12px; min-height: 40px;
  background: linear-gradient(180deg, rgba(58,52,38,0.96) 0%, rgba(36,32,24,0.96) 100%);
  border: 1px solid #0f0e0c; border-radius: 3px;
  box-shadow: var(--bevel), 0 4px 14px rgba(0,0,0,0.55);
  color: var(--ink); font-size: 13px;
}
.hud-order-text {
  color: #f0e4c4;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hud-order-btn {
  pointer-events: auto;
  min-height: 36px; padding: 0 9px;
  background: linear-gradient(180deg, #3b352a 0%, #2a2620 100%);
  border: 1px solid #0f0e0c; border-radius: 2px;
  box-shadow: var(--bevel);
  color: var(--ink); font: inherit; font-size: 12px; cursor: pointer;
}
.hud-order-btn.is-on { border-color: var(--accent); color: var(--accent); }
/* Dimmed rather than disabled: the button still has something to say when it
   cannot act, and that sentence is the only place the player finds out that a
   front belongs to a formation and not to a pile of divisions. */
.hud-order-btn.is-dim { color: var(--ink-dim); }
.hud-order-cancel {
  pointer-events: auto;
  min-width: 32px; min-height: 32px; padding: 0;
  background: transparent; border: 0; color: var(--ink-dim);
  font: inherit; font-size: 15px; cursor: pointer;
}
.hud-order-menu {
  display: none; gap: 4px; flex-wrap: wrap; justify-content: flex-end;
  padding: 6px; max-width: 100%;
  background: rgba(24,22,18,0.96);
  border: 1px solid #0f0e0c; border-radius: 3px;
  box-shadow: var(--bevel), 0 4px 14px rgba(0,0,0,0.55);
}
.hud-order-menu.is-on { display: flex; }
.hud-order-chip {
  pointer-events: auto;
  min-height: 40px; padding: 0 12px;
  background: linear-gradient(180deg, #3b352a 0%, #2a2620 100%);
  border: 1px solid #0f0e0c; border-radius: 2px;
  box-shadow: var(--bevel);
  color: var(--ink); font: inherit; font-size: 12px; cursor: pointer;
  white-space: nowrap;
}
.hud-order-note { color: var(--ink-dim); font-size: 12px; padding: 0 4px; }

/* --- marquee ------------------------------------------------------------- */
/* The rubber band. Never takes a pointer: the finger drawing it is captured by
   the canvas underneath, and an element that intercepted the move would end
   the gesture the moment the band grew under the contact point. */
.hud-marquee {
  position: absolute; display: none; pointer-events: none;
  border: 1px solid var(--accent);
  background: rgba(211,171,99,0.14);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.55) inset;
}
.hud-marquee.is-on { display: block; }

/* --- bottom sheet -------------------------------------------------------- */
/* The sheet ground is darker than the plates that sit on it. Measured before:
   a card at #26241f on a #1f1e1a ground is 1.076:1 -- every card in the game
   was carried by a single hairline, where HOI4's focus node plate reads
   2.08:1 against its tree. */
.hud-sheet {
  /* Flush to the floor. The 56px it used to reserve was for a bottom tab bar
     that is now at the top; what is down there instead is the officer strip,
     which is a control on the map like the map-mode column and is meant to be
     covered when a panel is open. */
  position: absolute; left: 0; right: 0; bottom: var(--safe-bottom);
  background: linear-gradient(180deg, #1a1917 0%, #151412 34%, #121110 100%);
  border-top: 1px solid #0d0c0a;
  box-shadow: inset 0 1px 0 var(--edge-hi), 0 -4px 14px rgba(0,0,0,0.6);
  transform: translateY(calc(100% + var(--safe-bottom)));
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
  background: linear-gradient(180deg, #35312a 0%, #272420 100%);
  border: 1px solid #100f0d; box-shadow: var(--bevel);
}
.panel-row.is-hostile {
  background: linear-gradient(180deg, #3a2622 0%, #2a1a17 100%);
  border-color: #1a0d0b;
}
.panel-row.is-dead { opacity: 0.45; }
/* A queued project the factories have not reached. Dimmed rather than hidden:
   it is still in the queue, and moving it up is the point. */
.panel-row.is-idle .panel-row-title,
.panel-row.is-idle .panel-row-sub { color: var(--ink-dim); }
.panel-row.is-idle .panel-bar-fill { filter: grayscale(1) brightness(0.7); }
.panel-row-main { flex: 1 1 auto; min-width: 0; }
.panel-row-title {
  font-size: 13px; font-weight: 700;
  /* Wraps rather than clipping. Japanese country names on one nowrap line
     beside three buttons lost 27 of 30 rows to the ellipsis at 360px. */
  overflow-wrap: anywhere; line-break: strict;
}
.panel-row-sub { font-size: 11px; color: var(--ink-dim); margin-top: 2px; line-height: 1.6; }
.panel-row-controls { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
/* The same frame the player's own flag carries in the top bar, at list size. */
.panel-flag {
  width: 26px; height: 17px; flex: 0 0 auto; object-fit: cover;
  border: 1px solid #8a7f6a;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.7);
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
.panel-btn.prio { min-width: 44px; font-size: 12px; color: var(--ink-dim); }
.panel-btn.prio.is-high { color: var(--accent); font-weight: 700; }
.panel-btn.danger {
  color: #f0a49a; border-color: #100f0d;
  background: linear-gradient(180deg, #43302b 0%, #2c1e1a 100%);
}
.panel-btn:disabled { color: #a49b89; background: #1c1b17; }
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
/* An editable field on a card. Sized as a control rather than as text: a
   44px target and 16px type, which is also the size Safari stops zooming the
   page in on focus. */
.panel-rename { display: flex; gap: 5px; align-items: center; margin-top: 6px; }
.panel-input {
  flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 8px;
  background: #191713; color: var(--ink);
  border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.7);
  font-size: 16px; font-family: inherit;
}
.panel-input:focus { outline: 1px solid var(--accent); }
.panel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.panel-build {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  min-height: 46px; padding: 7px 9px; text-align: left;
  background: linear-gradient(180deg, #3a352c 0%, #2a261f 100%); color: var(--ink);
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
.panel-build.is-blocked .panel-build-note { color: #f0a294; }
/* A parchment data plate, which is the surface HOI4 puts every table of
   numbers on and the one thing this interface had none of: with text masked
   out, 0.00% of any panel's pixels were above L 0.15, against 23.8% on the
   real game's division designer. */
.panel-kvs {
  display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px;
  padding: 8px 10px; margin: 2px 0 4px;
  background: linear-gradient(180deg, #cbb98f 0%, #ab9a74 100%);
  border: 1px solid #100f0d; border-radius: 2px;
  box-shadow: inset 0 1px 0 rgba(255,248,225,0.4), inset 0 -1px 0 rgba(0,0,0,0.35);
  color: #241f16;
}
.panel-kvs .panel-k { color: #5d5340; }
.panel-kvs .panel-v { color: #1c1810; font-weight: 700; }
.panel-kv {
  display: flex; justify-content: space-between; gap: 8px; font-size: 12px;
  padding: 3px 0; border-bottom: 1px dotted rgba(60,50,32,0.4);
}
.panel-k { color: var(--ink-dim); }
.panel-v { font-variant-numeric: tabular-nums; text-align: right; }

/* --- the tab strip, under the national figures ---------------------------- */
/* Where the reference puts it: a row of icons directly beneath the resource
   line. It is in the flow of .hud-top rather than pinned, so --hud-top-h keeps
   measuring the whole bar and everything below it stays clear. */
.hud-nav {
  display: flex; touch-action: manipulation;
  margin-top: 4px;
  background: linear-gradient(180deg, #2c2a25 0%, #1c1b17 100%);
  border-top: 1px solid #0d0c0a; border-bottom: 1px solid #0d0c0a;
  box-shadow: inset 0 1px 0 var(--edge-hi);
  pointer-events: auto;
}
/* A hairline between tabs, as on the real toolbar. */
.hud-nav-btn + .hud-nav-btn { border-left: 1px solid rgba(0,0,0,0.45); }
.hud-nav-btn {
  flex: 1 1 0; min-width: 0; min-height: 44px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; color: var(--ink-dim); cursor: pointer;
  padding: 0;
}
/* An indicator, not a block. The full-height olive rectangle it replaces had
   square corners and no relationship to anything else on screen, so it read as
   a compositing seam rather than a selected tab. Underneath now, because the
   strip sits above the map instead of below it. */
.hud-nav-btn { position: relative; }
.hud-nav-btn.is-active {
  color: var(--accent);
  background: linear-gradient(0deg, rgba(211,171,99,0.16) 0%, rgba(211,171,99,0) 70%);
}
.hud-nav-btn.is-active::before {
  content: ''; position: absolute; bottom: 0; left: 20%; right: 20%;
  height: 2px; background: var(--accent); border-radius: 2px 2px 0 0;
}
.hud-nav-icon { width: 22px; height: 22px; }

/* --- the officer strip ---------------------------------------------------- */
/* Centred along the foot of the screen, the way the reference lays it out, and
   scrolling sideways when there are more armies than fit. Seven armies is the
   ceiling and four fit at 412px. */
.hud-officers {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; justify-content: center; gap: 3px;
  padding: 0 6px calc(var(--safe-bottom) + 4px);
  overflow-x: auto; scrollbar-width: none;
  pointer-events: auto; touch-action: pan-x;
}
.hud-officers::-webkit-scrollbar { display: none; }
.hud-officers.is-empty { display: none; }
.hud-officer {
  flex: 0 0 auto; width: 66px; padding: 3px 2px 2px;
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  background: linear-gradient(180deg, #35312a 0%, #221f1b 100%);
  border: 1px solid #0d0c0a; border-bottom: none;
  border-radius: 3px 3px 0 0;
  box-shadow: 0 -2px 8px rgba(0,0,0,0.55), inset 0 1px 0 var(--edge-hi);
  color: var(--ink); cursor: pointer;
}
.hud-officer:active { background: linear-gradient(180deg, #201e1a 0%, #2a2823 100%); }
/* The frame the portrait sits in, which is what carries rank. */
.hud-officer-plate {
  width: 34px; height: 42px; overflow: hidden;
  border: 1px solid #8a7f6a;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.65);
}
.hud-officer-plate.is-marshal { border-color: var(--accent); }
/* A command with nobody holding it. Drawn as the empty frame it is, with the
   cross-hatch the rest of the interface uses for a slot waiting to be filled. */
.hud-officer-plate.is-vacant {
  border-style: dashed; border-color: #6b6353;
  background:
    repeating-linear-gradient(135deg, #201e1a 0 4px, #262319 4px 8px);
}
.hud-officer-face { width: 100%; height: 100%; display: block; object-fit: cover; }
.hud-officer-name {
  font-size: 10px; line-height: 1.2; color: var(--ink-dim);
  max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hud-officer-count {
  font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
}
/* An army bigger than its general can command. Every division in it is losing
   a share of his bonuses, and this is the only place that says so without the
   command panel being open. */
.hud-officer.is-over .hud-officer-count { color: #f0a49a; }
.hud-officer.is-over { border-color: #6b2f28; }

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
    /* On its side there is room for both, so the drawer stops above the
       officers rather than covering them. */
    bottom: calc(var(--safe-bottom) + var(--hud-foot-h, 0px));
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
  /* The figures go side by side. Measured on its side: 395px of stats and
     320px of resources, each stacked in its own 853px row, so the bar spent
     32px of a 412px screen saying nothing. */
  .hud-figures { flex-direction: row; align-items: flex-start; }
  .hud-figures > * { flex: 0 1 auto; min-width: 0; }
  /* Every pixel of bar is a pixel of map. */
  .hud-top { gap: 3px; padding-bottom: 5px; }
  .hud-stats > .hud-stat, .hud-resources > .hud-res { padding: 1px 6px 2px; }
  .hud-chip-c { line-height: 10px; }
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

/* --- production ---------------------------------------------------------- */
/* One card per line, three bands: who and what, the figures beside the
   silhouette, and the factories along the bottom. The reference stacks the
   same three horizontally because it has 380px of width to do it in. */
.panel-line {
  background: var(--panel, #23221e);
  border: 1px solid #100f0d; box-shadow: var(--bevel); border-radius: 3px;
  padding: 5px 7px 6px; margin-bottom: 5px;
}
.panel-line-top { display: flex; align-items: center; gap: 6px; }
/* The rank number, as the reference numbers its lines: production order is a
   real thing here -- it is what the resource allocator walks. */
.panel-line-rank {
  min-width: 18px; text-align: center;
  color: var(--ink-dim); font-size: 11px;
}
.panel-line-name { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--ink); }
.panel-line-body { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.panel-line-art {
  display: flex; align-items: center; justify-content: center;
  width: 44px; height: 36px; flex: 0 0 auto;
  background: rgba(0,0,0,0.28); border: 1px solid #100f0d; border-radius: 2px;
}
.panel-line-icon { width: 28px; height: 28px; opacity: 0.92; }
.panel-line-figures { flex: 1 1 auto; min-width: 0; }
/* The output a day is the number a player is here for, so it is the biggest
   thing in the row. */
.panel-line-rate { color: var(--accent); font-size: 15px; font-weight: 700; line-height: 1.2; }
.panel-line-eff { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
.panel-line-eff .panel-bar { flex: 1 1 auto; }
.panel-line-effv { font-size: 11px; color: var(--ink-dim); min-width: 30px; text-align: right; }
.panel-line-stock { font-size: 11px; color: var(--ink-dim); }
.panel-line-stock.is-short { color: #d8574a; }
.panel-line-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 4px;
}
.panel-blocks {
  display: flex; flex-wrap: wrap; align-content: center; gap: 2px;
  flex: 1 1 auto; min-width: 0;
}
.panel-block {
  width: 7px; height: 11px;
  background: linear-gradient(180deg, #8fd48f 0%, #4f8f4f 100%);
  border: 1px solid #14200f; border-radius: 1px;
}
.panel-blocks-more { font-size: 11px; color: var(--ink-dim); margin-left: 3px; }
.panel-build-icon { width: 22px; height: 22px; opacity: 0.9; margin-bottom: 2px; }
/* A type the army is already short of: the line worth opening next. */
.panel-build.is-wanted { border-color: var(--accent); }

/* --- division designer --------------------------------------------------- */
/* The reference puts support companies in a column down the left and the line
   battalions in a grid to their right, and that arrangement carries the whole
   distinction between the two before any label does. It survives on a phone
   because it is a grid either way -- only the proportions change. */
.panel-board {
  display: grid; grid-template-columns: auto 1fr; gap: 6px;
  margin-bottom: 8px;
}
.panel-board-support {
  display: grid; grid-auto-rows: 44px; align-content: start; gap: 4px;
  padding-right: 6px; border-right: 1px solid var(--edge-lo, #0f0e0c);
}
.panel-board-combat {
  display: grid; grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: 44px; gap: 4px;
}
.panel-slot {
  display: flex; align-items: center; justify-content: center;
  min-height: 44px; padding: 2px 4px;
  background: linear-gradient(180deg, #35322b 0%, #24221d 100%);
  border: 1px solid #100f0d; box-shadow: var(--bevel); border-radius: 3px;
  color: var(--ink); font: inherit; font-size: 11px; line-height: 1.15;
  text-align: center; cursor: pointer;
}
/* A filled slot stacks its silhouette over its name, which is the only way to
   fit both into a 44px square. */
.panel-slot { flex-direction: column; gap: 1px; }
.panel-slot-icon { width: 20px; height: 20px; opacity: 0.9; }
.panel-slot-name { overflow: hidden; font-size: 10px; }
.panel-chip-icon { width: 16px; height: 16px; opacity: 0.9; margin-right: 4px; vertical-align: -3px; }
/* An empty slot is a hole in the establishment, not a button with a label:
   quieter ground, a lighter plus, no bevel to suggest something is there. */
.panel-slot.is-empty {
  background: rgba(0,0,0,0.22); box-shadow: none;
  border-style: dashed; border-color: #3a352c; color: var(--ink-dim);
  font-size: 15px;
}
/* Establishment the division has not used. Present, so the grid still says how
   big a division may be, but quiet enough not to look like 23 buttons. */
.panel-slot.is-spare {
  background: rgba(0,0,0,0.14); box-shadow: none;
  border-style: dashed; border-color: #2a251e; cursor: default;
}

/* Three columns of numbers, as the reference has them: what the division is,
   what it does in a fight, and what it costs. They wrap to two on a narrow
   screen rather than shrinking the type. */
.panel-stattable {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 6px; margin-bottom: 8px;
}
.panel-statcol {
  background: var(--panel, #23221e);
  border: 1px solid #100f0d; box-shadow: var(--bevel); border-radius: 3px;
  padding: 5px 7px 6px;
}
.panel-statcol-h {
  font-size: 11px; color: var(--accent); letter-spacing: 0.06em;
  padding-bottom: 3px; margin-bottom: 3px;
  border-bottom: 1px solid #100f0d;
}
.panel-statline {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 11px; line-height: 1.6;
}
.panel-statline-k { color: var(--ink-dim); }
/* Numbers large and light, names small and dark -- the rule the reference
   follows everywhere and the one that makes a dense table readable. */
.panel-statline-v { color: var(--ink); font-weight: 600; }
.panel-statline-v.is-short { color: var(--bad, #d8574a); }
/* What a mark has changed, beside the number it changed. The reference puts a
   green triangle here and it is the only reason the window is worth opening
   twice: the second visit is to see what the last decision bought. */
.panel-delta { font-size: 10px; min-width: 42px; text-align: right; }
.panel-delta.is-up { color: #7fe07f; }
.panel-delta.is-down { color: #d8574a; }

/* The Adjusters box. */
.panel-adjusters {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 5px; margin-bottom: 8px;
}
.panel-adjuster {
  background: var(--panel, #23221e);
  border: 1px solid #100f0d; box-shadow: var(--bevel); border-radius: 3px;
  padding: 4px 6px 5px;
}
.panel-adjuster-h { font-size: 11px; color: var(--ink); margin-bottom: 2px; }
.panel-adjuster-nums {
  display: flex; flex-wrap: wrap; gap: 2px 7px; font-size: 11px;
}
/* Each figure stays whole. Without this the row broke between the label and
   its number and the box read "攻-10% 防 / +0% 速 +0%". */
.panel-adjuster-n { color: var(--ink-dim); white-space: nowrap; }
.panel-adjuster-n.is-good { color: #7fe07f; }
.panel-adjuster-n.is-bad { color: #d8574a; }
.panel-adjuster-fit { font-size: 10px; color: var(--ink-dim); margin-top: 2px; }
/* A garrison row the player has picked out of the stack. Splitting one
   formation off a province was impossible from anywhere before this. */
.panel-row.is-picked {
  background: linear-gradient(180deg, rgba(211,171,99,0.16) 0%, rgba(211,171,99,0.05) 100%);
  box-shadow: inset 2px 0 0 var(--accent);
}
.panel-row.is-picked .panel-row-title { color: var(--accent); }
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
/* Declaring war is the one row on the relations sheet that cannot be undone,
   so it is coloured the way the button that used to carry it was. */
.panel-row.wide-row.is-danger .panel-row-title { color: #f0a49a; }
/* A country at war with the player, in the list. The is-hostile plate above
   cannot be used here: wide-row declares a transparent background at the same
   specificity and later in the sheet, so it wins and the enemies stopped
   standing out. A marker down the edge works on a borderless row and does not
   fight the plate rules at all. */
.panel-row.wide-row.is-hostile { box-shadow: inset 2px 0 0 #b4544a; }
.panel-row.wide-row.is-hostile .panel-row-title { color: #f0a49a; }
/* The country card at the head of the relations sheet: the flag at a size
   that can actually be recognised, which the 26px list swatch cannot. */
.panel-nation {
  display: flex; align-items: flex-start; gap: 10px; padding: 9px 8px;
  background: linear-gradient(180deg, #35312a 0%, #272420 100%);
  border: 1px solid #100f0d; box-shadow: var(--bevel); border-radius: 2px;
}
.panel-nation-flag {
  width: 64px; height: 42px; flex: 0 0 auto; object-fit: cover;
  border: 1px solid #8a7f6a;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.75);
}
.panel-nation-body { flex: 1 1 auto; min-width: 0; }
.panel-nation-name {
  font-size: 16px; font-weight: 700; letter-spacing: var(--track);
  overflow-wrap: anywhere;
}

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
  background: linear-gradient(180deg, #3a352c 0%, #2a261f 100%);
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
/* Measured at 3.05:1 against the plate behind it while the comment beside it
   claimed it kept its full strength. This is the one line a player who cannot
   press the button actually needs, so it is the one that has to clear the
   floor. */
.panel-focus-block { margin-top: 6px; font-size: 12px; color: #f0a294; }
.panel-focus-meta { margin-top: 4px; font-size: 11px; color: var(--ink-dim); }
.panel-focus .panel-btn.wide { margin-top: 9px; width: 100%; min-height: 46px; }

/* --- the focus tree ------------------------------------------------------ */
/* A grid of icons joined by lines, which is what a focus tree is. Three
   collapsible lists carried the same facts with the shape removed, and the
   shape is the point: from a list a player cannot see that the one focus they
   may start leads to the sixteen they may not. */
.panel-tree-scroll {
  overflow: auto; scrollbar-width: none;
  /* The tree is 590px wide on a 412px screen, so it pans in both axes; the
     sheet under it owns the vertical scroll, so say so explicitly or the two
     fight over every drag. */
  touch-action: pan-x pan-y;
  margin: 0 -12px; padding: 0 12px 4px;
  background:
    linear-gradient(180deg, rgba(10,10,9,0.5) 0%, rgba(10,10,9,0.22) 100%);
  border-top: 1px solid #100f0d; border-bottom: 1px solid #100f0d;
  box-shadow: inset 0 1px 0 var(--edge-hi);
}
.panel-tree-scroll::-webkit-scrollbar { display: none; }
.panel-tree { position: relative; }
.panel-tree-links { position: absolute; inset: 0; pointer-events: none; }
/* Locked branches are drawn, not hidden: seeing where a path goes before it
   opens is the reason to look at a tree at all. */
.panel-tree-link { fill: none; stroke: #4a453b; stroke-width: 2; }
.panel-tree-link.is-open { stroke: var(--good); stroke-width: 2.4; }
.panel-tree-link.is-exclusive {
  stroke: var(--danger); stroke-width: 2; stroke-dasharray: 4 4;
}

.panel-focus-node {
  position: absolute; width: 84px; height: 72px;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  gap: 3px; padding: 6px 4px 4px;
  background: linear-gradient(180deg, #3a352c 0%, #2a261f 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
  color: var(--ink); font: inherit; text-align: center; cursor: pointer;
}
.panel-focus-node-icon {
  display: block; width: 22px; height: 22px; flex: 0 0 auto;
  background-color: var(--accent);
  -webkit-mask: var(--icon) center / contain no-repeat;
          mask: var(--icon) center / contain no-repeat;
}
.panel-focus-node-name {
  font-size: 9px; line-height: 1.25; color: var(--ink);
  overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.panel-focus-node.is-done { border-color: #4d6b30; }
.panel-focus-node.is-done .panel-focus-node-icon { background-color: var(--good); }
.panel-focus-node.is-current {
  border-color: var(--accent);
  background: linear-gradient(180deg, #3f3722 0%, #2a2416 100%);
}
/* Dimmed by token, not opacity: at the 1936 start every focus but one is
   locked, and compositing the whole node at half strength made most of the
   tree unreadable. */
.panel-focus-node.is-locked {
  background: linear-gradient(180deg, #262420 0%, #1c1b18 100%);
}
.panel-focus-node.is-locked .panel-focus-node-name { color: #8b8371; }
.panel-focus-node.is-locked .panel-focus-node-icon { background-color: #6d6656; }
.panel-focus-node.is-picked {
  box-shadow: var(--bevel), 0 0 0 2px var(--accent);
}
.panel-focus-node-bar {
  display: block; width: 100%; height: 3px; margin-top: auto;
  background: #16150f; border: 1px solid #100f0d;
}
.panel-focus-node-bar > i { display: block; height: 100%; background: var(--accent); }

/* The card under the tree, which is where a focus is actually read and
   started. A popover over a tree this size would cover the thing it is
   describing. */
.panel-focus-detail {
  padding: 11px 12px; margin-top: 10px;
  background: linear-gradient(180deg, #3a352c 0%, #2a261f 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
}
.panel-focus-detail .panel-btn.wide { margin-top: 9px; width: 100%; min-height: 46px; }
.panel-focus-detail .panel-bar { margin-top: 7px; }

/* --- the technology grid -------------------------------------------------- */
/* The year across, the branch down, the generations of one weapon joined by a
   line -- which is how HOI4 draws it, and how the data was already shaped. A
   branch chooser over a flat list told a player what a technology cost but not
   that it sat three steps down a chain they had not started. */
.panel-tech-node {
  position: absolute; width: 88px; height: 50px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 4px 5px;
  background: linear-gradient(180deg, #3a352c 0%, #2a261f 100%);
  border: 1px solid #100f0d; border-radius: 2px; box-shadow: var(--bevel);
  color: var(--ink); font: inherit; text-align: center; cursor: pointer;
}
.panel-tech-node-name {
  font-size: 10px; line-height: 1.25;
  overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.panel-tech-node.is-done {
  border-color: #4d6b30;
  background: linear-gradient(180deg, #313a26 0%, #232a1b 100%);
}
.panel-tech-node.is-current {
  border-color: var(--accent);
  background: linear-gradient(180deg, #3f3722 0%, #2a2416 100%);
}
.panel-tech-node.is-locked {
  background: linear-gradient(180deg, #262420 0%, #1c1b18 100%);
}
.panel-tech-node.is-locked .panel-tech-node-name { color: #8b8371; }
.panel-tech-node.is-picked { box-shadow: var(--bevel), 0 0 0 2px var(--accent); }
.panel-tech-node .panel-focus-node-bar { margin-top: 4px; }

/* Headings live inside the scrolled grid so they travel with their column and
   row rather than drifting off the technologies they name. */
.panel-tech-year {
  position: absolute; top: 0; width: 88px; height: 18px;
  font-size: 11px; color: var(--ink-dim); letter-spacing: var(--track);
  text-align: center;
}
/* The rail does not pan with the grid: inside it, the row labels slid off the
   left edge the moment the player looked at 1940, which is the one place a row
   label is needed. */
.panel-tech-frame { display: flex; align-items: stretch; margin: 0 -12px; padding-left: 12px; }
.panel-tech-rail { position: relative; flex: 0 0 46px; }
.panel-tech-frame > .panel-tree-scroll { flex: 1 1 auto; min-width: 0; margin: 0; padding-left: 0; }
.panel-tech-branch {
  position: absolute; left: 0; width: 46px; height: 50px;
  display: flex; align-items: center;
  font-size: 11px; color: var(--accent); letter-spacing: 0;
}

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
/* The order of battle. Rows are buttons: tapping one takes that division out
   of the formation's hands and into the player's, without dissolving the
   formation around it. */
.panel-oob { margin-top: 6px; }
.panel-oob-row {
  display: flex; align-items: center; width: 100%;
  min-height: 44px; padding: 5px 8px; margin-bottom: 3px;
  background: rgba(0,0,0,0.18);
  border: 1px solid #100f0d; border-left: 2px solid #3a352c; border-radius: 2px;
  color: var(--ink); font: inherit; text-align: left; cursor: pointer;
}
.panel-oob-row.is-fighting { border-left-color: #d8574a; }
/* A division following an order of its own rather than the army's plan. */
.panel-oob-row.is-detached { border-left-color: var(--accent); }

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
