/**
 * The bottom sheet's own view state: how large its contents are drawn, and how
 * much of the screen it occupies.
 *
 * Phones vary from 320 to 480 CSS pixels across and are held at whatever
 * distance suits their owner, so one fixed type size cannot serve everyone.
 * HOI4 solves this the same way -- its focus tree carries a minus and a plus
 * in the panel header -- and this is that control, plus the pinch gesture a
 * touch screen implies.
 *
 * Zoom is CSS `zoom` rather than `transform: scale`, because zoom participates
 * in layout: text rewraps, the scroll height is recomputed, and hit testing
 * lands where the pixels are. A scaled transform would draw the panel larger
 * while leaving it laid out for the old size, so the bottom of a zoomed panel
 * would be unreachable.
 */

const ZOOM_KEY = 'hoi4.sheet.zoom';
const HEIGHT_KEY = 'hoi4.sheet.height';

export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.8;
const ZOOM_STEP = 0.1;

/** As a fraction of the viewport height. */
const HEIGHT_MIN = 0.3;
const HEIGHT_MAX = 0.86;
const HEIGHT_DEFAULT = 0.52;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Storage is unavailable in private mode on some browsers; never fatal. */
function read(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

export interface SheetView {
  readonly zoom: number;
  setZoom(v: number): void;
  stepZoom(delta: number): void;
  setHeight(fraction: number): void;
  /** Attach the pinch handler to the scrolling body. Returns a detacher. */
  bindPinch(body: HTMLElement): () => void;
}

/**
 * @param sheet   the sheet element, which carries the custom properties
 * @param onZoom  called whenever the zoom changes, to relabel the control
 */
export function createSheetView(sheet: HTMLElement, onZoom: (z: number) => void): SheetView {
  let zoom = clamp(read(ZOOM_KEY, 1), ZOOM_MIN, ZOOM_MAX);
  let height = clamp(read(HEIGHT_KEY, HEIGHT_DEFAULT), HEIGHT_MIN, HEIGHT_MAX);

  function applyZoom(): void {
    sheet.style.setProperty('--sheet-zoom', String(zoom));
    onZoom(zoom);
  }

  function applyHeight(): void {
    sheet.style.setProperty('--sheet-h', `${(height * 100).toFixed(1)}vh`);
  }

  function setZoom(v: number): void {
    const next = clamp(Math.round(v * 100) / 100, ZOOM_MIN, ZOOM_MAX);
    if (next === zoom) return;
    zoom = next;
    applyZoom();
    write(ZOOM_KEY, zoom);
  }

  applyZoom();
  applyHeight();

  return {
    get zoom() {
      return zoom;
    },
    setZoom,
    stepZoom(delta: number) {
      // Snapped to the step grid so repeated presses land on round numbers
      // even after a pinch has left the zoom at 1.13.
      setZoom((Math.round(zoom / ZOOM_STEP) + delta) * ZOOM_STEP);
    },
    setHeight(fraction: number) {
      height = clamp(fraction, HEIGHT_MIN, HEIGHT_MAX);
      applyHeight();
      write(HEIGHT_KEY, Math.round(height * 1000) / 1000);
    },
    bindPinch(body: HTMLElement) {
      const points = new Map<number, { x: number; y: number }>();
      let startSpan = 0;
      let startZoom = 1;

      const span = (): number => {
        const [a, b] = [...points.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
      };

      const down = (e: PointerEvent): void => {
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (points.size === 2) {
          startSpan = span();
          startZoom = zoom;
        }
      };
      const move = (e: PointerEvent): void => {
        if (!points.has(e.pointerId)) return;
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (points.size !== 2 || startSpan <= 0) return;
        // A pinch is two fingers on the panel; the browser would otherwise
        // read the same movement as a scroll and do both at once.
        e.preventDefault();
        setZoom(startZoom * (span() / startSpan));
      };
      const up = (e: PointerEvent): void => {
        points.delete(e.pointerId);
        if (points.size < 2) startSpan = 0;
      };

      body.addEventListener('pointerdown', down);
      body.addEventListener('pointermove', move, { passive: false });
      body.addEventListener('pointerup', up);
      body.addEventListener('pointercancel', up);
      return () => {
        body.removeEventListener('pointerdown', down);
        body.removeEventListener('pointermove', move);
        body.removeEventListener('pointerup', up);
        body.removeEventListener('pointercancel', up);
      };
    },
  };
}
