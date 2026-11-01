import type { App } from '../app';
import { IMPLANT_COLOR, IMPLANT_SELECTED_COLOR, Implant } from '../implant';
import { Vec3, add, cross, dot, length, rotate, scale, sub } from '../math';
import { CropSpec, SlabSpec, samplePlane, windowToBytes } from '../render';

export type Pt = [number, number];

/** Zoom/pan state; can be shared between views (e.g. the cross-sections). */
export interface ViewState {
  /** mm per CSS pixel */
  scale: number;
  /** offset (mm) of the screen centre along the view's u / v axes */
  panU: number;
  panV: number;
  fitted: boolean;
}

export const newViewState = (): ViewState => ({ scale: 0.3, panU: 0, panV: 0, fitted: false });

type DragKind = 'none' | 'wl' | 'pan' | 'left';

/**
 * Base class: two stacked canvases (image at <= CSS resolution, overlay at
 * device resolution), generic window/level, pan and zoom handling.
 */
export abstract class View {
  readonly el: HTMLDivElement;
  protected imgCanvas: HTMLCanvasElement;
  protected ovCanvas: HTMLCanvasElement;
  protected imgCtx: CanvasRenderingContext2D;
  protected ovCtx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  protected dpr = 1;
  protected imgW = 0;
  protected imgH = 0;
  /** image pixels per CSS pixel */
  protected imgScale = 1;
  protected values: Float32Array | null = null;
  private valuesKey = '';
  private composeKey = '';
  private imageData: ImageData | null = null;
  protected maxPixels = 450_000;
  private drag: DragKind = 'none';
  private last: Pt = [0, 0];
  private downPos: Pt = [0, 0];
  vs: ViewState;

  constructor(
    protected app: App,
    public title: string,
    public color: string,
    vs?: ViewState,
  ) {
    this.vs = vs ?? newViewState();
    this.el = document.createElement('div');
    this.el.className = 'view';
    this.el.style.setProperty('--view-color', color);
    this.imgCanvas = document.createElement('canvas');
    this.imgCanvas.className = 'img';
    this.ovCanvas = document.createElement('canvas');
    this.ovCanvas.className = 'ov';
    this.el.append(this.imgCanvas, this.ovCanvas);
    this.imgCtx = this.imgCanvas.getContext('2d')!;
    this.ovCtx = this.ovCanvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindEvents();
  }

  get visible() {
    return this.w > 0 && this.h > 0 && this.el.offsetParent !== null;
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(0, Math.floor(r.width));
    const h = Math.max(0, Math.floor(r.height));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.ovCanvas.width = Math.max(1, Math.round(w * this.dpr));
    this.ovCanvas.height = Math.max(1, Math.round(h * this.dpr));
    this.imgScale = Math.min(1, Math.sqrt(this.maxPixels / Math.max(1, w * h)));
    this.imgW = Math.max(1, Math.round(w * this.imgScale));
    this.imgH = Math.max(1, Math.round(h * this.imgScale));
    this.imgCanvas.width = this.imgW;
    this.imgCanvas.height = this.imgH;
    this.imageData = null;
    this.valuesKey = '';
    this.app.requestRender();
  }

  // ---- to implement -------------------------------------------------------

  /** Key describing the sampled geometry; null when there is nothing to show. */
  protected abstract geometryKey(): string | null;
  protected abstract computeValues(out: Float32Array, w: number, h: number): void;
  protected abstract drawOverlay(ctx: CanvasRenderingContext2D): void;
  /** Fit zoom/pan to the content. */
  abstract fit(): void;
  protected emptyMessage(): string {
    return this.app.vol ? '' : 'No volume loaded';
  }
  /** Additional per-pixel overlays (e.g. implants) composed into the image. */
  protected composePixels(_rgba: Uint8ClampedArray, _w: number, _h: number): void {}
  protected composeExtraKey(): string {
    return '';
  }

  protected onLeftDown(_p: Pt, _e: PointerEvent): boolean {
    return false;
  }
  protected onLeftDrag(_p: Pt, _last: Pt, _e: PointerEvent): void {}
  protected onLeftUp(_p: Pt, _e: PointerEvent, _moved: boolean): void {}
  protected onScroll(_dir: number, _p: Pt, _e: WheelEvent): void {}
  protected onDoubleClick(_p: Pt, _e: MouseEvent): void {}
  protected onHover(_p: Pt): void {}
  /** World point under the cursor for the status bar. */
  worldAt(_p: Pt): Vec3 | null {
    return null;
  }

  // ---- rendering ----------------------------------------------------------

  render() {
    if (!this.visible) return;
    if (!this.vs.fitted && this.app.vol) {
      this.fit();
      this.vs.fitted = true;
    }
    const key = this.app.vol ? this.geometryKey() : null;
    const ctx = this.imgCtx;
    if (key === null) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.imgW, this.imgH);
      this.values = null;
      this.valuesKey = '';
      this.composeKey = '';
    } else {
      const fullKey = `${key}|${this.imgW}x${this.imgH}|${this.app.vol!.id}`;
      if (fullKey !== this.valuesKey || !this.values) {
        if (!this.values || this.values.length !== this.imgW * this.imgH) this.values = new Float32Array(this.imgW * this.imgH);
        this.computeValues(this.values, this.imgW, this.imgH);
        this.valuesKey = fullKey;
        this.composeKey = '';
      }
      const ck = `${fullKey}|${this.app.wl.center}|${this.app.wl.width}|${this.composeExtraKey()}`;
      if (ck !== this.composeKey) {
        if (!this.imageData || this.imageData.width !== this.imgW || this.imageData.height !== this.imgH)
          this.imageData = ctx.createImageData(this.imgW, this.imgH);
        windowToBytes(this.values, this.imageData.data, this.app.wl.center, this.app.wl.width);
        this.composePixels(this.imageData.data, this.imgW, this.imgH);
        ctx.putImageData(this.imageData, 0, 0);
        this.composeKey = ck;
      }
    }
    const o = this.ovCtx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.ovCanvas.width, this.ovCanvas.height);
    o.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (key === null) {
      const msg = this.emptyMessage();
      if (msg) {
        o.fillStyle = '#8a94a6';
        o.font = '13px system-ui, sans-serif';
        o.textAlign = 'center';
        wrapText(o, msg, this.w / 2, this.h / 2, this.w - 30, 18);
        o.textAlign = 'left';
      }
    } else {
      this.drawOverlay(o);
    }
    this.drawTitle(o);
  }

  protected drawTitle(o: CanvasRenderingContext2D) {
    o.font = '600 12px system-ui, sans-serif';
    o.fillStyle = this.color;
    o.fillText(this.title, 8, 16);
  }

  /** Drop cached samples (e.g. after the volume changed). */
  invalidate() {
    this.valuesKey = '';
    this.composeKey = '';
  }

  // ---- events -------------------------------------------------------------

  protected pos(e: MouseEvent): Pt {
    const r = this.ovCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private bindEvents() {
    const c = this.ovCanvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!this.app.vol) return;
      const p = this.pos(e);
      this.last = p;
      this.downPos = p;
      this.app.activeView = this;
      if (e.button === 2) this.drag = 'wl';
      else if (e.button === 1 || (e.button === 0 && e.shiftKey)) this.drag = 'pan';
      else if (e.button === 0) this.drag = this.onLeftDown(p, e) ? 'left' : 'none';
      if (this.drag !== 'none') {
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pos(e);
      const dx = p[0] - this.last[0];
      const dy = p[1] - this.last[1];
      switch (this.drag) {
        case 'wl': {
          const wl = this.app.wl;
          const k = Math.max(1, wl.width) * 0.004;
          this.app.setWindow(wl.center + dy * k, Math.max(1, wl.width + dx * k));
          break;
        }
        case 'pan':
          this.vs.panU -= dx * this.vs.scale;
          this.vs.panV -= dy * this.vs.scale;
          this.app.requestRender();
          break;
        case 'left':
          this.onLeftDrag(p, this.last, e);
          break;
        default:
          this.onHover(p);
      }
      this.last = p;
      this.app.reportCursor(this, p);
    });
    const end = (e: PointerEvent) => {
      if (this.drag === 'left') {
        const p = this.pos(e);
        const moved = Math.hypot(p[0] - this.downPos[0], p[1] - this.downPos[1]) > 3;
        this.onLeftUp(p, e, moved);
      }
      this.drag = 'none';
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => this.app.reportCursor(this, null));
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.app.vol) return;
        e.preventDefault();
        const p = this.pos(e);
        if (e.ctrlKey || e.metaKey) {
          const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.0025 * (e.deltaMode ? 30 : 1));
          this.zoomAt(p, f);
        } else {
          const dir = Math.sign(e.deltaY || e.deltaX);
          if (dir) this.onScroll(dir, p, e);
        }
      },
      { passive: false },
    );
    c.addEventListener('dblclick', (e) => {
      if (!this.app.vol) return;
      this.onDoubleClick(this.pos(e), e);
    });
  }

  zoomAt(p: Pt, factor: number) {
    const s0 = this.vs.scale;
    const s1 = Math.min(5, Math.max(0.01, s0 * factor));
    this.vs.panU += (p[0] - this.w / 2) * (s0 - s1);
    this.vs.panV += (p[1] - this.h / 2) * (s0 - s1);
    this.vs.scale = s1;
    this.app.requestRender();
  }
}

export interface Plane {
  /** world point shown at the screen centre before panning */
  center: Vec3;
  /** unit world direction of screen +x */
  u: Vec3;
  /** unit world direction of screen +y (down) */
  v: Vec3;
}

/** A view that shows a planar reslice. */
export abstract class PlaneView extends View {
  protected abstract plane(): Plane | null;
  protected crop(): CropSpec | null {
    return null;
  }
  protected slab(): SlabSpec | null {
    return null;
  }
  /** Whether implants can be dragged in this view. */
  protected implantsEditable = false;
  private implantDrag: { imp: Implant; mode: 'move' | 'rotate'; plane: Plane } | null = null;

  /** Current plane including pan offsets (screen centre). */
  currentPlane(): Plane | null {
    const pl = this.plane();
    if (!pl) return null;
    return {
      center: add(add(pl.center, scale(pl.u, this.vs.panU)), scale(pl.v, this.vs.panV)),
      u: pl.u,
      v: pl.v,
    };
  }

  screenToWorld(p: Pt, pl = this.currentPlane()): Vec3 | null {
    if (!pl) return null;
    const s = this.vs.scale;
    return add(add(pl.center, scale(pl.u, (p[0] - this.w / 2) * s)), scale(pl.v, (p[1] - this.h / 2) * s));
  }

  /** World -> [x, y, signed distance from plane in mm]. */
  worldToScreen(w: Vec3, pl = this.currentPlane()): [number, number, number] | null {
    if (!pl) return null;
    const q = sub(w, pl.center);
    const s = this.vs.scale;
    return [this.w / 2 + dot(q, pl.u) / s, this.h / 2 + dot(q, pl.v) / s, dot(q, cross(pl.u, pl.v))];
  }

  override worldAt(p: Pt) {
    return this.screenToWorld(p);
  }

  protected geometryKey(): string | null {
    const pl = this.currentPlane();
    if (!pl) return null;
    const c = this.crop();
    const sl = this.slab();
    return JSON.stringify([pl, this.vs.scale, this.w, this.h, c && [c.min, c.max, c.frame, c.origin], sl]);
  }

  protected computeValues(out: Float32Array, w: number, h: number) {
    const pl = this.currentPlane()!;
    const k = 1 / this.imgScale;
    const p0 = this.screenToWorld([0.5 * k, 0.5 * k], pl)!;
    const s = this.vs.scale * k;
    samplePlane(this.app.vol!, out, w, h, p0, scale(pl.u, s), scale(pl.v, s), this.crop(), this.slab(), this.app.vol!.min);
  }

  protected composeExtraKey() {
    return this.app.implantsKey();
  }

  /** Rasterise exact implant/plane intersections into the image. */
  protected composePixels(rgba: Uint8ClampedArray, w: number, h: number) {
    const pl = this.currentPlane();
    if (!pl || !this.app.implants.length) return;
    const n = cross(pl.u, pl.v);
    const k = 1 / this.imgScale;
    const pxmm = this.vs.scale * k;
    const p0 = this.screenToWorld([0.5 * k, 0.5 * k], pl)!;
    const du = scale(pl.u, pxmm);
    const dv = scale(pl.v, pxmm);
    const edge = Math.max(0.12, pxmm * 1.3);
    for (const imp of this.app.implants) {
      const r = imp.diameter / 2;
      const hl = imp.length / 2;
      if (Math.abs(dot(sub(imp.center, pl.center), n)) > hl + r) continue;
      const sel = imp.id === this.app.selectedId;
      const col = sel ? IMPLANT_SELECTED_COLOR : IMPLANT_COLOR;
      // bounding box in image pixels
      const sc = this.worldToScreen(imp.center, pl)!;
      const R = Math.hypot(hl, r) / pxmm + 2;
      const cx = sc[0] / k;
      const cy = sc[1] / k;
      const i0 = Math.max(0, Math.floor(cx - R));
      const i1 = Math.min(w - 1, Math.ceil(cx + R));
      const j0 = Math.max(0, Math.floor(cy - R));
      const j1 = Math.min(h - 1, Math.ceil(cy + R));
      const a = imp.axis;
      const c = imp.center;
      const r2 = r * r;
      for (let j = j0; j <= j1; j++) {
        let qx = p0[0] + du[0] * i0 + dv[0] * j - c[0];
        let qy = p0[1] + du[1] * i0 + dv[1] * j - c[1];
        let qz = p0[2] + du[2] * i0 + dv[2] * j - c[2];
        for (let i = i0; i <= i1; i++) {
          const hh = qx * a[0] + qy * a[1] + qz * a[2];
          const ah = Math.abs(hh);
          if (ah <= hl) {
            const rad2 = qx * qx + qy * qy + qz * qz - hh * hh;
            if (rad2 <= r2) {
              const d = Math.max(Math.sqrt(Math.max(0, rad2)) - r, ah - hl);
              const alpha = d > -edge ? 0.95 : 0.32;
              const o = (j * w + i) * 4;
              rgba[o] += (col[0] - rgba[o]) * alpha;
              rgba[o + 1] += (col[1] - rgba[o + 1]) * alpha;
              rgba[o + 2] += (col[2] - rgba[o + 2]) * alpha;
            }
          }
          qx += du[0];
          qy += du[1];
          qz += du[2];
        }
      }
    }
  }

  /** Draw the projected implant axis (dashed) for implants near the plane. */
  protected drawImplantAxes(o: CanvasRenderingContext2D) {
    const pl = this.currentPlane();
    if (!pl) return;
    for (const imp of this.app.implants) {
      const a = this.worldToScreen(add(imp.center, scale(imp.axis, imp.length / 2)), pl)!;
      const b = this.worldToScreen(add(imp.center, scale(imp.axis, -imp.length / 2)), pl)!;
      const near = Math.min(Math.abs(a[2]), Math.abs(b[2])) < imp.length;
      if (!near) continue;
      const sel = imp.id === this.app.selectedId;
      o.strokeStyle = sel ? 'rgba(255,184,28,0.9)' : 'rgba(64,214,128,0.7)';
      o.setLineDash([4, 4]);
      o.lineWidth = 1;
      o.beginPath();
      o.moveTo(a[0], a[1]);
      o.lineTo(b[0], b[1]);
      o.stroke();
      o.setLineDash([]);
    }
  }

  // ---- implant manipulation ----------------------------------------------

  protected hitImplant(p: Pt): { imp: Implant; mode: 'move' | 'rotate' } | null {
    const w = this.screenToWorld(p);
    if (!w) return null;
    const tol = 4 * this.vs.scale;
    let best: { imp: Implant; mode: 'move' | 'rotate'; d: number } | null = null;
    for (const imp of this.app.implants) {
      const q = sub(w, imp.center);
      const h = dot(q, imp.axis);
      const rad = length(sub(q, scale(imp.axis, h)));
      if (Math.abs(h) <= imp.length / 2 + tol && rad <= imp.diameter / 2 + tol) {
        const capZone = Math.max(1.2, imp.length * 0.2);
        const mode = Math.abs(h) > imp.length / 2 - capZone ? 'rotate' : 'move';
        const d = rad;
        if (!best || d < best.d) best = { imp, mode, d };
      }
    }
    return best;
  }

  /** Returns true when an implant drag started. */
  protected startImplantDrag(p: Pt): boolean {
    if (!this.implantsEditable) return false;
    const hit = this.hitImplant(p);
    if (!hit) return false;
    const pl = this.currentPlane()!;
    this.implantDrag = { imp: hit.imp, mode: hit.mode, plane: pl };
    this.app.selectImplant(hit.imp.id, false);
    this.el.style.cursor = hit.mode === 'rotate' ? 'grabbing' : 'move';
    return true;
  }

  protected get draggingImplant() {
    return this.implantDrag !== null;
  }

  protected dragImplant(p: Pt, last: Pt) {
    const d = this.implantDrag;
    if (!d) return false;
    const pl = d.plane;
    const s = this.vs.scale;
    if (d.mode === 'move') {
      const delta = add(scale(pl.u, (p[0] - last[0]) * s), scale(pl.v, (p[1] - last[1]) * s));
      d.imp.center = add(d.imp.center, delta);
    } else {
      const c = this.worldToScreen(d.imp.center, pl)!;
      const a0 = Math.atan2(last[1] - c[1], last[0] - c[0]);
      const a1 = Math.atan2(p[1] - c[1], p[0] - c[0]);
      let da = a1 - a0;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      d.imp.axis = rotate(d.imp.axis, cross(pl.u, pl.v), da);
    }
    this.app.implantChanged(d.imp);
    return true;
  }

  protected endImplantDrag() {
    if (!this.implantDrag) return false;
    this.implantDrag = null;
    this.el.style.cursor = '';
    this.app.implantChanged(null, true);
    return true;
  }

  protected updateHoverCursor(p: Pt) {
    if (!this.implantsEditable) return false;
    const hit = this.hitImplant(p);
    this.el.style.cursor = hit ? (hit.mode === 'rotate' ? 'grab' : 'move') : '';
    return !!hit;
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  const y0 = y - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh));
}

/** Orientation letter for a world direction (LPS patient axes). */
export function orientationLabel(d: Vec3): string {
  const ax = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  const i = ax[0] >= ax[1] && ax[0] >= ax[2] ? 0 : ax[1] >= ax[2] ? 1 : 2;
  const letters = [
    ['R', 'L'],
    ['A', 'P'],
    ['I', 'S'],
  ];
  return letters[i][d[i] >= 0 ? 1 : 0];
}

export function drawLabel(o: CanvasRenderingContext2D, text: string, x: number, y: number, color = '#cfd6e4', align: CanvasTextAlign = 'left') {
  o.font = '12px system-ui, sans-serif';
  o.textAlign = align;
  o.fillStyle = 'rgba(0,0,0,0.55)';
  const w = o.measureText(text).width;
  const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  o.fillRect(bx - 3, y - 11, w + 6, 15);
  o.fillStyle = color;
  o.fillText(text, x, y);
  o.textAlign = 'left';
}
