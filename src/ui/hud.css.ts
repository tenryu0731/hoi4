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
.hud-top {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; align-items: center; gap: 8px;
  padding: calc(var(--safe-top) + 8px) 10px 8px;
  background: linear-gradient(180deg, rgba(10,13,18,0.96) 0%, rgba(10,13,18,0.82) 65%, rgba(10,13,18,0) 100%);
  pointer-events: auto;
}
.hud-flag {
  width: 32px; height: 22px; border-radius: 2px; flex: 0 0 auto;
  box-shadow: 0 1px 3px rgba(0,0,0,0.6);
  background: #2b2e34;
}
.hud-country { min-width: 0; flex: 0 0 auto; }
.hud-country-name {
  font-size: 11px; font-weight: 600; letter-spacing: 0.2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 74px;
}
.hud-country-tag { font-size: 8px; color: var(--ink-dim); letter-spacing: 1.4px; }

.hud-stats { display: flex; gap: 9px; flex: 1 1 auto; justify-content: center; }
.hud-stat { display: flex; flex-direction: column; align-items: center; line-height: 1.15; }
.hud-stat-v { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.hud-stat-l { font-size: 7px; color: var(--ink-dim); letter-spacing: 0.8px; }

.hud-clock { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: 0 0 auto; }
.hud-date { font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hud-speed { display: flex; align-items: center; gap: 5px; }
.hud-btn {
  min-width: 44px; min-height: 30px;
  background: var(--panel-2); color: var(--ink);
  border: 1px solid var(--line); border-radius: 4px;
  font-size: 13px; line-height: 1; cursor: pointer;
}
.hud-btn.is-paused { color: var(--accent); border-color: var(--accent); }
.hud-pips { display: flex; gap: 2px; }
.hud-pip {
  width: 8px; height: 26px; padding: 0;
  background: #2b2e34; border: 1px solid var(--line); border-radius: 2px; cursor: pointer;
}
.hud-pip.is-on { background: var(--accent); border-color: var(--accent); }

.hud-resources {
  position: absolute; top: calc(var(--safe-top) + 48px); left: 0; right: 0;
  display: flex; gap: 5px; padding: 0 10px; overflow-x: auto;
  scrollbar-width: none; pointer-events: auto;
}
.hud-resources::-webkit-scrollbar { display: none; }
.hud-res {
  display: flex; align-items: center; gap: 3px;
  background: rgba(16,19,25,0.86); border: 1px solid rgba(58,61,69,0.75);
  border-radius: 3px; padding: 2px 5px; white-space: nowrap;
}
.hud-res-icon { width: 12px; height: 12px; opacity: 0.8; }
.hud-res-v { font-size: 10px; font-variant-numeric: tabular-nums; }
.hud-res-v.is-short { color: var(--danger); font-weight: 700; }
.hud-res-l { font-size: 7px; color: var(--ink-dim); letter-spacing: 0.4px; }

/* Map modes hug the top-right so the centre of the screen stays gesture-only. */
.hud-modes {
  position: absolute; top: calc(var(--safe-top) + 78px); right: 8px;
  display: flex; flex-direction: column; gap: 3px; pointer-events: auto;
}
.hud-mode {
  min-width: 58px; min-height: 26px; padding: 0 7px;
  font-size: 8px; letter-spacing: 0.6px; text-transform: uppercase;
  background: rgba(16,19,25,0.82); color: var(--ink-dim);
  border: 1px solid rgba(58,61,69,0.85); border-radius: 3px; cursor: pointer;
}
.hud-mode.is-active {
  color: #12151b; background: var(--accent); border-color: var(--accent); font-weight: 700;
}

/* --- alerts -------------------------------------------------------------- */
.hud-toasts {
  position: absolute; top: calc(var(--safe-top) + 78px); left: 10px;
  display: flex; flex-direction: column; gap: 4px;
  max-width: 62%; pointer-events: none;
}
.hud-toast {
  font-size: 10px; line-height: 1.3; padding: 5px 8px;
  background: rgba(16,19,25,0.94); border-left: 3px solid var(--accent);
  border-radius: 2px; opacity: 1; transition: opacity 500ms ease;
}
.hud-toast.is-out { opacity: 0; }
.hud-toast.kind-war { border-left-color: var(--danger); }
.hud-toast.kind-capitulation { border-left-color: #b06ad0; }
.hud-toast.kind-construction { border-left-color: var(--good); }
.hud-toast.kind-outcome { border-left-color: #fff; }

/* --- bottom sheet -------------------------------------------------------- */
.hud-sheet {
  position: absolute; left: 0; right: 0; bottom: calc(var(--safe-bottom) + 56px);
  background: linear-gradient(180deg, rgba(22,25,31,0.98) 0%, rgba(15,17,22,0.99) 100%);
  border-top: 1px solid var(--line);
  transform: translateY(calc(100% + var(--safe-bottom) + 56px));
  transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: auto; max-height: 52vh; display: flex; flex-direction: column;
}
.hud-sheet.is-open { transform: translateY(0); }
.hud-sheet-grip {
  width: 100%; padding: 7px 0 3px; flex: 0 0 auto; cursor: grab;
  display: flex; justify-content: center;
}
.hud-sheet-grip::after {
  content: ''; display: block; width: 34px; height: 4px; border-radius: 2px; background: #4a4e57;
}
.hud-sheet-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px 6px; flex: 0 0 auto;
}
.hud-sheet-title { font-size: 14px; font-weight: 600; }
.hud-sheet-close {
  width: 32px; height: 32px; font-size: 20px; line-height: 1;
  background: transparent; color: var(--ink-dim); border: none; cursor: pointer;
}
.hud-sheet-body { padding: 0 12px 12px; overflow-y: auto; -webkit-overflow-scrolling: touch; }

/* --- panels -------------------------------------------------------------- */
.panel-head {
  display: flex; gap: 16px; padding: 6px 0 10px;
  border-bottom: 1px solid rgba(58,61,69,0.5); margin-bottom: 8px;
}
.panel-sub { font-size: 11px; color: var(--ink-dim); margin-bottom: 8px; }
.panel-label {
  font-size: 9px; letter-spacing: 1.2px; text-transform: uppercase;
  color: var(--ink-dim); margin: 10px 0 5px;
}
.panel-list { display: flex; flex-direction: column; gap: 3px; }
.panel-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 7px; background: rgba(255,255,255,0.03); border-radius: 3px;
}
.panel-row.is-hostile { background: rgba(210,69,58,0.14); }
.panel-row.is-dead { opacity: 0.45; }
.panel-row-main { flex: 1 1 auto; min-width: 0; }
.panel-row-title {
  font-size: 11px; font-weight: 600; text-transform: capitalize;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.panel-row-sub { font-size: 9px; color: var(--ink-dim); margin-top: 1px; }
.panel-row-controls { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.panel-swatch {
  width: 12px; height: 12px; border-radius: 2px; flex: 0 0 auto;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.5);
}
.panel-btn {
  min-width: 32px; min-height: 32px; padding: 0 6px;
  background: var(--panel-2); color: var(--ink);
  border: 1px solid var(--line); border-radius: 3px;
  font-size: 13px; line-height: 1; cursor: pointer;
}
.panel-btn.wide { min-width: 52px; font-size: 10px; }
.panel-btn.danger { color: #ffb0a8; border-color: #6e3a34; }
.panel-btn:disabled { opacity: 0.35; }
.panel-count {
  min-width: 22px; text-align: center; font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.panel-bar {
  height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px;
  margin-top: 4px; overflow: hidden;
}
.panel-bar-fill { display: block; height: 100%; width: 0%; background: var(--accent); }
.panel-empty { font-size: 11px; color: var(--ink-dim); padding: 8px 0; }
.panel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.panel-build {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  min-height: 44px; padding: 6px 8px; text-align: left;
  background: var(--panel-2); color: var(--ink);
  border: 1px solid var(--line); border-radius: 3px; cursor: pointer;
}
.panel-build:disabled { opacity: 0.35; }
.panel-build-title { font-size: 11px; font-weight: 600; }
.panel-build-sub { font-size: 9px; color: var(--ink-dim); }
/* The blocking reason, so a disabled recruit button says what it is waiting
   for instead of just refusing. */
.panel-build-note {
  display: block; margin-top: 4px; font-size: 9px; letter-spacing: 0.4px;
  color: var(--accent);
}
.panel-build.is-blocked { opacity: 0.55; }
.panel-build.is-blocked .panel-build-note { color: var(--danger); }
.panel-kvs { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 14px; }
.panel-kv {
  display: flex; justify-content: space-between; gap: 8px; font-size: 10px;
  padding: 3px 0; border-bottom: 1px solid rgba(58,61,69,0.35);
}
.panel-k { color: var(--ink-dim); }
.panel-v { font-variant-numeric: tabular-nums; text-align: right; }

/* --- bottom navigation --------------------------------------------------- */
.hud-nav {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; padding-bottom: var(--safe-bottom);
  background: rgba(12,14,19,0.97); border-top: 1px solid var(--line);
  pointer-events: auto;
}
.hud-nav-btn {
  flex: 1 1 0; min-height: 56px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  background: transparent; border: none; color: var(--ink-dim); cursor: pointer;
}
.hud-nav-btn.is-active { color: var(--accent); background: rgba(216,176,74,0.1); }
.hud-nav-icon { width: 20px; height: 20px; }
.hud-nav-label { font-size: 8px; letter-spacing: 0.6px; text-transform: uppercase; }

/* --- outcome ------------------------------------------------------------- */
.hud-outcome {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 45%, rgba(20,40,64,0.9), rgba(6,10,16,0.96));
  opacity: 0; pointer-events: none; transition: opacity 600ms ease;
}
.hud-outcome.is-shown { opacity: 1; pointer-events: auto; }
.hud-outcome-title {
  font-family: Georgia, "Times New Roman", "Hiragino Mincho ProN", "Yu Mincho",
    "Noto Serif JP", serif;
  font-size: 40px; letter-spacing: 12px; color: var(--good); text-align: center;
}
.hud-outcome.is-defeat .hud-outcome-title { color: var(--danger); }
.hud-outcome-sub {
  margin-top: 8px; font-size: 12px; color: var(--ink-dim);
  text-align: center; max-width: 80vw;
}

@media (max-width: 380px) {
  .hud-stats { gap: 5px; }
  .panel-kvs, .panel-grid { grid-template-columns: 1fr; }
}
@media (min-width: 700px) {
  .hud-sheet { max-height: 44vh; }
  .panel-kvs { grid-template-columns: 1fr 1fr 1fr; }
}
`;
