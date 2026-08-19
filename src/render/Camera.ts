/**
 * Maps world kilometres to screen pixels.
 *
 * The camera is the single owner of pan/zoom state. Input writes to it, the
 * renderer reads from it, and the map container's transform is derived from it
 * once per frame -- nothing else may touch container.position or .scale.
 */

export interface CameraBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Camera {
  /** World coordinate shown at the centre of the viewport. */
  x = 0;
  y = 0;
  /** Screen pixels per world kilometre. */
  zoom = 0.1;

  viewportW = 1;
  viewportH = 1;

  minZoom = 0.02;
  maxZoom = 2.5;

  /** How far past the map edge the view may be dragged, as a fraction. */
  overscroll = 0.18;

  velocityX = 0;
  velocityY = 0;

  constructor(public bounds: CameraBounds) {}

  resize(w: number, h: number): void {
    this.viewportW = Math.max(1, w);
    this.viewportH = Math.max(1, h);
    // Never allow zooming out past the point where the map is smaller than the
    // viewport in both axes, otherwise the world floats in a void.
    const fitX = this.viewportW / (this.bounds.maxX - this.bounds.minX);
    const fitY = this.viewportH / (this.bounds.maxY - this.bounds.minY);
    this.minZoom = Math.min(fitX, fitY) * 0.85;
    this.maxZoom = Math.max(this.minZoom * 40, 2.5);
    this.zoom = this.clampZoom(this.zoom);
  }

  clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }

  worldToScreenX(wx: number): number {
    return (wx - this.x) * this.zoom + this.viewportW / 2;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.y) * this.zoom + this.viewportH / 2;
  }

  screenToWorldX(sx: number): number {
    return (sx - this.viewportW / 2) / this.zoom + this.x;
  }

  screenToWorldY(sy: number): number {
    return (sy - this.viewportH / 2) / this.zoom + this.y;
  }

  /** Zooms about a fixed screen point, so pinch anchors stay under the fingers. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const wx = this.screenToWorldX(screenX);
    const wy = this.screenToWorldY(screenY);
    const before = this.zoom;
    this.zoom = this.clampZoom(this.zoom * factor);
    if (this.zoom === before) return;
    // Solve for the camera position that keeps (wx, wy) under (screenX, screenY).
    this.x = wx - (screenX - this.viewportW / 2) / this.zoom;
    this.y = wy - (screenY - this.viewportH / 2) / this.zoom;
  }

  panByScreen(dxPx: number, dyPx: number): void {
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
  }

  centerOn(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
  }

  /** Fits a world rectangle, leaving `pad` fraction of margin. */
  fit(rect: CameraBounds, pad = 0.08): void {
    const w = rect.maxX - rect.minX;
    const h = rect.maxY - rect.minY;
    const zx = this.viewportW / (w * (1 + pad * 2));
    const zy = this.viewportH / (h * (1 + pad * 2));
    this.zoom = this.clampZoom(Math.min(zx, zy));
    this.x = (rect.minX + rect.maxX) / 2;
    this.y = (rect.minY + rect.maxY) / 2;
  }

  /** The world rectangle currently visible, useful for culling. */
  visibleRect(): CameraBounds {
    const halfW = this.viewportW / 2 / this.zoom;
    const halfH = this.viewportH / 2 / this.zoom;
    return {
      minX: this.x - halfW, maxX: this.x + halfW,
      minY: this.y - halfH, maxY: this.y + halfH,
    };
  }

  /** How far the camera is outside its legal range, in world units. */
  private overshoot(): { dx: number; dy: number } {
    const halfW = this.viewportW / 2 / this.zoom;
    const halfH = this.viewportH / 2 / this.zoom;
    const mapW = this.bounds.maxX - this.bounds.minX;
    const mapH = this.bounds.maxY - this.bounds.minY;
    const slackX = mapW * this.overscroll;
    const slackY = mapH * this.overscroll;

    let dx = 0;
    let dy = 0;
    // When the map is narrower than the viewport, lock it to the centre.
    if (halfW * 2 >= mapW) {
      dx = (this.bounds.minX + this.bounds.maxX) / 2 - this.x;
    } else {
      const minCx = this.bounds.minX + halfW - slackX;
      const maxCx = this.bounds.maxX - halfW + slackX;
      if (this.x < minCx) dx = minCx - this.x;
      else if (this.x > maxCx) dx = maxCx - this.x;
    }
    if (halfH * 2 >= mapH) {
      dy = (this.bounds.minY + this.bounds.maxY) / 2 - this.y;
    } else {
      const minCy = this.bounds.minY + halfH - slackY;
      const maxCy = this.bounds.maxY - halfH + slackY;
      if (this.y < minCy) dy = minCy - this.y;
      else if (this.y > maxCy) dy = maxCy - this.y;
    }
    return { dx, dy };
  }

  /** Hard clamp, used while a finger is down so the drag cannot run away. */
  clampHard(): void {
    const { dx, dy } = this.overshoot();
    this.x += dx;
    this.y += dy;
  }

  /**
   * Momentum plus a spring back into bounds. Called once per frame with the
   * real frame delta so the feel is frame-rate independent.
   */
  update(dtMs: number, dragging: boolean): void {
    const steps = Math.min(4, Math.max(1, Math.round(dtMs / 16.667)));
    for (let i = 0; i < steps; i++) {
      if (!dragging) {
        this.x -= this.velocityX / this.zoom;
        this.y -= this.velocityY / this.zoom;
        this.velocityX *= 0.9;
        this.velocityY *= 0.9;
        if (Math.abs(this.velocityX) < 0.02) this.velocityX = 0;
        if (Math.abs(this.velocityY) < 0.02) this.velocityY = 0;
      }
      const { dx, dy } = this.overshoot();
      if (dx !== 0 || dy !== 0) {
        const k = dragging ? 0.12 : 0.28;
        this.x += dx * k;
        this.y += dy * k;
        // Bleed momentum fast once the spring engages, so it settles quickly.
        this.velocityX *= 0.6;
        this.velocityY *= 0.6;
      }
    }
  }
}
