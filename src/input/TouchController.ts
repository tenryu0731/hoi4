import type { Camera } from '../render/Camera';

/**
 * Pointer gesture recognition.
 *
 * One state machine drives touch, pen and mouse alike -- the browser reports
 * all three as PointerEvents, and using the same path everywhere means the
 * scripted tests exercise the code a phone actually runs.
 *
 *   IDLE ──down(1)──▶ PENDING ──moved >SLOP──▶ PAN ──up──▶ IDLE (with inertia)
 *                       │  └─held >HOLD_MS──▶ HOLD (context action)
 *                       └──up, still──────────▶ tap
 *   PENDING/PAN ──down(2)──▶ PINCH ──one up──▶ PAN
 *   PENDING over a unit stack ──moved──▶ DRAG_ORDER ──up──▶ issue move order
 *   PENDING with the marquee armed ──moved──▶ BOX ──up──▶ select what is inside
 */

export type GesturePhase = 'start' | 'move' | 'end' | 'cancel';

export interface TouchCallbacks {
  /** A discrete selection tap. */
  onTap?: (worldX: number, worldY: number, screenX: number, screenY: number) => void;
  onLongPress?: (worldX: number, worldY: number, screenX: number, screenY: number) => void;
  /** Returns true to begin an order drag from this point instead of panning. */
  canStartOrderDrag?: (worldX: number, worldY: number) => boolean;
  onOrderDrag?: (
    phase: GesturePhase,
    fromX: number, fromY: number,
    toX: number, toY: number,
  ) => void;
  /**
   * Whether a marquee may start here.
   *
   * This has to be a tool the player picks up, not a gesture the recogniser
   * infers. Hold-then-drag was tried and is wrong: a finger that rests before
   * it moves is the ordinary way a thumb pans a map -- the comment on the
   * hold-to-pan branch below records that it is "most of the time on a phone,
   * and every time under a remote test harness" -- so inferring a marquee
   * from it took panning away. Measured: the pan test moved the camera 0px.
   */
  canStartBoxSelect?: (screenX: number, screenY: number) => boolean;
  /** Marquee corners in screen (CSS pixel) space. */
  onBoxSelect?: (
    phase: GesturePhase,
    x0: number, y0: number,
    x1: number, y1: number,
  ) => void;
  /**
   * Whether a stroke here paints on the map instead of panning it.
   *
   * The same shape of contract as the marquee, and for the same reason: a
   * tool the player picks up, never a gesture inferred from how a finger
   * happens to move. Drawing a battle plan is what this is for -- 「前線は国
   * ごとの選択じゃなくて自分で国境などに引く」 -- and the reference draws one
   * by dragging along the ground it runs over.
   */
  canStartPaint?: (screenX: number, screenY: number) => boolean;
  /** Every point the stroke passes through, in world space. */
  onPaint?: (phase: GesturePhase, worldX: number, worldY: number) => void;
  /** Fired whenever the camera moved, so the app can mark itself dirty. */
  onCameraChange?: () => void;
}

/** Movement past this many CSS pixels turns a press into a drag. */
const SLOP_PX = 10;
const HOLD_MS = 480;
/** Velocity is averaged over this window so a flick is not judged on one frame. */
const VELOCITY_WINDOW_MS = 90;

type State = 'idle' | 'pending' | 'pan' | 'pinch' | 'order' | 'hold' | 'box' | 'paint';

interface PointerRec {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
}

export class TouchController {
  private el: HTMLElement | null = null;
  private camera: Camera;
  private cb: TouchCallbacks;

  private pointers = new Map<number, PointerRec>();
  private state: State = 'idle';
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  private pinchStartDist = 0;
  private pinchStartZoom = 1;

  private orderFromX = 0;
  private orderFromY = 0;
  /**
   * Whether the press landed somewhere an order drag may begin. Decided once,
   * at press time: asking again after the finger has moved would consult a
   * point the user is no longer touching, and would disagree with itself if the
   * selection changed mid-gesture.
   */
  private orderCandidate = false;

  /** Marquee anchor, in screen space, while the state is `box`. */
  private boxFromX = 0;
  private boxFromY = 0;
  /**
   * Whether the press landed with the marquee tool armed. Decided once, at
   * press time, for the same reason `orderCandidate` is: asking again after
   * the finger has moved would consult a state the player may have changed
   * mid-gesture.
   */
  private boxCandidate = false;

  /** Whether the press landed with a plan tool armed. Decided once, as above. */
  private paintCandidate = false;

  private history: { t: number; x: number; y: number }[] = [];
  private detachFns: (() => void)[] = [];

  /** Exposed for tests and for the HUD's debug readout. */
  get currentState(): State {
    return this.state;
  }

  constructor(camera: Camera, callbacks: TouchCallbacks = {}) {
    this.camera = camera;
    this.cb = callbacks;
  }

  attach(el: HTMLElement): void {
    this.detach();
    this.el = el;
    // Without this the browser claims the gesture for scrolling or its own
    // pinch-zoom and the map only moves when the page happens not to.
    el.style.touchAction = 'none';
    (el.style as unknown as Record<string, string>).webkitUserSelect = 'none';
    el.style.userSelect = 'none';

    const add = <K extends keyof HTMLElementEventMap>(
      type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.detachFns.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    add('pointerdown', this.onPointerDown, { passive: false });
    add('pointermove', this.onPointerMove, { passive: false });
    add('pointerup', this.onPointerUp, { passive: false });
    add('pointercancel', this.onPointerCancel, { passive: false });
    add('pointerleave', this.onPointerCancel, { passive: false });
    add('wheel', this.onWheel, { passive: false });
    add('contextmenu', (e) => e.preventDefault());
    add('dblclick', (e) => e.preventDefault());
  }

  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.clearHold();
    this.pointers.clear();
    this.state = 'idle';
    this.el = null;
  }

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.el?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  }

  private clearHold(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.el?.setPointerCapture?.(e.pointerId);
    const { x, y } = this.localPoint(e);
    this.pointers.set(e.pointerId, {
      id: e.pointerId, x, y, startX: x, startY: y, startTime: performance.now(),
    });
    // A pointerup can go missing -- a lost contact, a cancelled gesture, a
    // browser quirk. Without this, one stale entry would wedge the recogniser
    // out of pinch for the rest of the session.
    while (this.pointers.size > 2) {
      let oldest: PointerRec | null = null;
      for (const r of this.pointers.values()) {
        if (!oldest || r.startTime < oldest.startTime) oldest = r;
      }
      if (!oldest) break;
      this.pointers.delete(oldest.id);
    }

    if (this.pointers.size === 1) {
      this.state = 'pending';
      this.history = [{ t: performance.now(), x, y }];
      this.camera.velocityX = 0;
      this.camera.velocityY = 0;
      this.orderCandidate = this.cb.canStartOrderDrag?.(
        this.camera.screenToWorldX(x), this.camera.screenToWorldY(y),
      ) ?? false;
      this.boxCandidate = this.cb.canStartBoxSelect?.(x, y) ?? false;
    this.paintCandidate = this.cb.canStartPaint?.(x, y) ?? false;
      this.clearHold();
      // The timer only records that the press became a hold. The action fires
      // on release, so a press that turns into a drag never triggers it.
      this.holdTimer = setTimeout(() => {
        if (this.state === 'pending') this.state = 'hold';
      }, HOLD_MS);
    } else if (this.pointers.size >= 2) {
      this.clearHold();
      // A second finger always wins: abandon whatever the first was doing.
      if (this.state === 'order') {
        this.cb.onOrderDrag?.('cancel', this.orderFromX, this.orderFromY, this.orderFromX, this.orderFromY);
      }
      if (this.state === 'box') {
        this.cb.onBoxSelect?.('cancel', this.boxFromX, this.boxFromY, this.boxFromX, this.boxFromY);
      }
      if (this.state === 'paint') this.cb.onPaint?.('cancel', 0, 0);
      this.beginPinch();
    }
  };

  private beginPinch(): void {
    this.state = 'pinch';
    const [a, b] = [...this.pointers.values()];
    this.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchStartZoom = this.camera.zoom;
  }

  private onPointerMove = (e: PointerEvent): void => {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    e.preventDefault();
    const { x, y } = this.localPoint(e);
    const prevX = rec.x;
    const prevY = rec.y;
    rec.x = x;
    rec.y = y;

    const now = performance.now();
    this.history.push({ t: now, x, y });
    while (this.history.length > 2 && now - this.history[0].t > VELOCITY_WINDOW_MS) {
      this.history.shift();
    }

    switch (this.state) {
      // A long press that then moves must become a pan. Without this the map
      // locks up whenever a finger rests for half a second before dragging --
      // which is most of the time on a phone, and every time under a remote
      // test harness where event delivery is not instant.
      case 'hold':
      case 'pending': {
        const moved = Math.hypot(x - rec.startX, y - rec.startY);
        if (moved <= SLOP_PX) return;
        this.clearHold();
        // The marquee first, when the player has picked the tool up. It wins
        // over both of the others: having armed it, the next stroke is the
        // rectangle, wherever it starts.
        if (this.boxCandidate) {
          this.state = 'box';
          this.boxFromX = rec.startX;
          this.boxFromY = rec.startY;
          this.cb.onBoxSelect?.('start', rec.startX, rec.startY, x, y);
          return;
        }
        const wx = this.camera.screenToWorldX(rec.startX);
        const wy = this.camera.screenToWorldY(rec.startY);
        // A plan tool wins over an order drag: having picked the tool up, the
        // next stroke draws with it, wherever it starts.
        if (this.paintCandidate) {
          this.state = 'paint';
          this.cb.onPaint?.('start', wx, wy);
          this.cb.onPaint?.(
            'move', this.camera.screenToWorldX(x), this.camera.screenToWorldY(y),
          );
          return;
        }
        if (this.orderCandidate) {
          this.state = 'order';
          this.orderFromX = wx;
          this.orderFromY = wy;
          this.cb.onOrderDrag?.('start', wx, wy, wx, wy);
        } else {
          this.state = 'pan';
          this.camera.panByScreen(x - rec.startX, y - rec.startY);
          this.camera.clampHard();
          this.cb.onCameraChange?.();
        }
        return;
      }
      case 'pan': {
        this.camera.panByScreen(x - prevX, y - prevY);
        this.camera.clampHard();
        this.cb.onCameraChange?.();
        return;
      }
      case 'order': {
        this.cb.onOrderDrag?.(
          'move', this.orderFromX, this.orderFromY,
          this.camera.screenToWorldX(x), this.camera.screenToWorldY(y),
        );
        return;
      }
      case 'box': {
        this.cb.onBoxSelect?.('move', this.boxFromX, this.boxFromY, x, y);
        return;
      }
      case 'paint': {
        this.cb.onPaint?.(
          'move', this.camera.screenToWorldX(x), this.camera.screenToWorldY(y),
        );
        return;
      }
      case 'pinch': {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const targetZoom = this.camera.clampZoom(this.pinchStartZoom * (dist / this.pinchStartDist));
        this.camera.zoomAt(midX, midY, targetZoom / this.camera.zoom);
        this.camera.clampHard();
        this.cb.onCameraChange?.();
        return;
      }
      default:
        return;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    e.preventDefault();
    this.el?.releasePointerCapture?.(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.clearHold();

    const { x, y } = this.localPoint(e);
    const moved = Math.hypot(x - rec.startX, y - rec.startY);

    switch (this.state) {
      case 'pending':
        // Any release from `pending` without movement is a tap. Requiring it to
        // also be under TAP_MS left a dead window between that and the hold
        // timer at HOLD_MS: a finger down for a third of a second and lifted
        // cleanly produced neither a tap nor a long press, and a tap that
        // slightly overstays is the most ordinary thing a thumb does.
        if (moved <= SLOP_PX) {
          this.cb.onTap?.(
            this.camera.screenToWorldX(x), this.camera.screenToWorldY(y), x, y,
          );
        }
        break;
      case 'hold':
        // Held in place and released: a deliberate long press.
        if (moved <= SLOP_PX) {
          this.cb.onLongPress?.(
            this.camera.screenToWorldX(x), this.camera.screenToWorldY(y), x, y,
          );
        }
        break;
      case 'pan':
        this.applyFlick();
        break;
      case 'order':
        this.cb.onOrderDrag?.(
          'end', this.orderFromX, this.orderFromY,
          this.camera.screenToWorldX(x), this.camera.screenToWorldY(y),
        );
        break;
      case 'box':
        this.cb.onBoxSelect?.('end', this.boxFromX, this.boxFromY, x, y);
        break;
      case 'paint':
        this.cb.onPaint?.(
          'end', this.camera.screenToWorldX(x), this.camera.screenToWorldY(y),
        );
        break;
      default:
        break;
    }

    if (this.pointers.size >= 2) {
      // Still multi-touch: re-anchor the pinch on the contacts that remain.
      this.beginPinch();
    } else if (this.pointers.size === 1) {
      // Dropping from two fingers to one resumes panning from the survivor,
      // rather than snapping the map to wherever that finger happens to be.
      const remaining = [...this.pointers.values()][0];
      remaining.startX = remaining.x;
      remaining.startY = remaining.y;
      this.state = 'pan';
      this.history = [{ t: performance.now(), x: remaining.x, y: remaining.y }];
    } else {
      this.state = 'idle';
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.clearHold();
    if (this.state === 'order') {
      this.cb.onOrderDrag?.('cancel', this.orderFromX, this.orderFromY, this.orderFromX, this.orderFromY);
    }
    if (this.state === 'box') {
      this.cb.onBoxSelect?.('cancel', this.boxFromX, this.boxFromY, this.boxFromX, this.boxFromY);
    }
    if (this.state === 'paint') this.cb.onPaint?.('cancel', 0, 0);
    if (this.pointers.size === 0) this.state = 'idle';
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { x, y } = this.localPoint(e);
    // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel
    // arrives as large ones. Normalising keeps both usable.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const factor = Math.exp(-e.deltaY * unit * 0.0016);
    this.camera.zoomAt(x, y, factor);
    this.camera.clampHard();
    this.cb.onCameraChange?.();
  };

  private applyFlick(): void {
    if (this.history.length < 2) return;
    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return;
    // Per-frame pixel velocity at 60Hz, capped so a hard flick stays readable.
    const vx = ((last.x - first.x) / dt) * 16.667;
    const vy = ((last.y - first.y) / dt) * 16.667;
    const cap = 90;
    this.camera.velocityX = Math.max(-cap, Math.min(cap, vx));
    this.camera.velocityY = Math.max(-cap, Math.min(cap, vy));
  }

  /** Called once per frame to run inertia and the out-of-bounds spring. */
  update(dtMs: number): void {
    // A marquee counts as dragging: the spring must not slide the map out
    // from under a rectangle the player is still drawing on it.
    const dragging = this.state === 'pan' || this.state === 'pinch'
      || this.state === 'pending' || this.state === 'box';
    const beforeX = this.camera.x;
    const beforeY = this.camera.y;
    this.camera.update(dtMs, dragging);
    if (this.camera.x !== beforeX || this.camera.y !== beforeY) this.cb.onCameraChange?.();
  }
}
