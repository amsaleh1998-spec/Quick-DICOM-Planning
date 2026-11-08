import type { App, SegTool } from '../app';
import type { Measurement } from '../app';
import type { Nerve } from '../nerve';
import type { NewCut } from '../segment';
import { CUT_CSS, composeNerveSection, composeSegmentation } from './overlays';
import { drawPlaneScans } from './scanContours';
import { drawPlaneWax, waxAt } from './waxContours';
import { WaxupEditor, intoScreen } from './waxupEdit';
import { ABUTMENT_COLOR, ABUTMENT_SELECTED_COLOR, IMPLANT_COLOR, IMPLANT_SELECTED_COLOR, Implant, PROSTHETIC_COLOR, radiusAt } from '../implant';
import { ImplantEditor } from './implantEdit';
import { Vec3, add, cross, distToSegment2, dot, length, scale, sub } from '../math';
import { CropSpec, SlabSpec, samplePlane, windowToBytes } from '../render';

export type Pt = [number, number];

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** Zoom/pan state; can be shared between views (e.g. the cross-sections). */
export interface ViewState {
  /** mm per CSS pixel */
  scale: number;
  /** offset (mm) of the screen centre along the view's u / v axes */
  panU: number;
  panV: number;
  fitted: boolean;
  /**
   * min(width, height) in px the scale belongs to: when the view is resized
   * (maximize / restore / window) the scale follows, so the same anatomy fills it.
   */
  sizeRef?: number;
}

/** Vertical scroll bar of a view: value range from the top to the bottom of the bar. */
export interface ScrollInfo {
  top: number;
  bottom: number;
  value: number;
}

export const newViewState = (): ViewState => ({ scale: 0.3, panU: 0, panV: 0, fitted: false });

type DragKind = 'none' | 'right' | 'pan' | 'left' | 'ruler' | 'nerve' | 'wax';

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
  /** the current pan drag was started with the middle button */
  private middleDown = false;
  private last: Pt = [0, 0];
  private downPos: Pt = [0, 0];
  /** Shift+left drag pans (disabled where Shift has another meaning). */
  protected shiftPans = true;
  /** waxup teeth editing in this view (views that show teeth set it) */
  protected waxEditor: WaxupEditor | null = null;
  /** teeth can be grabbed even while another panel is open (3D view: the waxup's workspace) */
  protected waxAnyPanel(_p: Pt): boolean {
    return false;
  }
  /** Which kind of measurements this view shows/creates (null = no ruler). */
  protected measureKind: 'plane' | 'pano' | null = null;
  private rulerDrag: { m: Measurement; end: 'a' | 'b'; created: boolean } | null = null;
  /** time the last ruler was completed (ignore the dblclick of a fast double click) */
  private rulerDoneAt = 0;
  /** nerve control point being dragged */
  private nerveDrag: { nerve: Nerve; idx: number } | null = null;
  /** mouse position while a segmentation tool is active (rubber band) */
  private toolHover: Pt | null = null;
  /** max distance (mm) from the slice at which nerve points are shown / editable */
  protected nervePointDepth = 1.5;
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
    const maxBtn = document.createElement('button');
    maxBtn.className = 'max-btn';
    maxBtn.title = 'Maximize / restore (M)';
    maxBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
    maxBtn.onclick = () => this.app.toggleMaximize(this);
    // vertical scroll bar (slice position etc.); hidden for views without one
    this.sbar = document.createElement('div');
    this.sbar.className = 'view-scroll hidden';
    this.sthumb = document.createElement('div');
    this.sthumb.className = 'view-scroll-thumb';
    this.sbar.append(this.sthumb);
    this.bindScrollbar();
    this.el.append(this.imgCanvas, this.ovCanvas, maxBtn, this.sbar);
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
    this.syncSize();
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

  /** Keep the field of view when the view size changes (maximize, restore, window resize). */
  syncSize() {
    if (!this.w || !this.h) return; // hidden
    const b = Math.min(this.w, this.h);
    const vs = this.vs;
    if (vs.fitted && vs.sizeRef && Math.abs(vs.sizeRef - b) > 0.5) vs.scale = Math.min(5, Math.max(0.005, (vs.scale * vs.sizeRef) / b));
    vs.sizeRef = b;
  }

  // ---- vertical scroll bar ------------------------------------------------------

  private sbar: HTMLDivElement;
  private sthumb: HTMLDivElement;
  private sbarDrag: { grab: number } | null = null;
  private static readonly THUMB = 30;

  /** Range and value shown by the scroll bar (null = no scroll bar). */
  protected scrollInfo(): ScrollInfo | null {
    return null;
  }
  /** Scroll bar moved to value v. */
  protected setScroll(_v: number): void {}

  private bindScrollbar() {
    const bar = this.sbar;
    const fromY = (clientY: number) => {
      const info = this.scrollInfo();
      if (!info) return;
      const r = bar.getBoundingClientRect();
      const span = Math.max(1, r.height - View.THUMB);
      const f = Math.min(1, Math.max(0, (clientY - r.top - View.THUMB / 2 - (this.sbarDrag?.grab ?? 0)) / span));
      this.setScroll(info.top + f * (info.bottom - info.top));
    };
    bar.addEventListener('pointerdown', (e) => {
      if (!this.app.vol) return;
      e.preventDefault();
      e.stopPropagation();
      bar.setPointerCapture(e.pointerId);
      // grabbing the thumb keeps its offset; clicking the track jumps there
      const t = this.sthumb.getBoundingClientRect();
      const onThumb = e.clientY >= t.top && e.clientY <= t.bottom;
      this.sbarDrag = { grab: onThumb ? e.clientY - (t.top + t.height / 2) : 0 };
      bar.classList.add('dragging');
      fromY(e.clientY);
    });
    bar.addEventListener('pointermove', (e) => {
      if (this.sbarDrag) fromY(e.clientY);
    });
    const end = (e: PointerEvent) => {
      this.sbarDrag = null;
      bar.classList.remove('dragging');
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    bar.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const dir = Math.sign(e.deltaY);
        if (dir && this.app.vol) this.onScroll(dir, [this.w / 2, this.h / 2], e);
      },
      { passive: false },
    );
  }

  /** Position the thumb (called on every render). */
  protected updateScrollbar() {
    const info = this.app.vol ? this.scrollInfo() : null;
    this.sbar.classList.toggle('hidden', !info);
    if (!info) return;
    const span = info.bottom - info.top;
    const f = span ? Math.min(1, Math.max(0, (info.value - info.top) / span)) : 0;
    const track = Math.max(0, this.sbar.clientHeight - View.THUMB);
    this.sthumb.style.transform = `translateY(${(f * track).toFixed(1)}px)`;
  }

  // ---- to implement -------------------------------------------------------

  /** Key describing the sampled geometry; null when there is nothing to show. */
  protected abstract geometryKey(): string | null;
  protected abstract computeValues(out: Float32Array, w: number, h: number): void;
  protected abstract drawOverlay(ctx: CanvasRenderingContext2D): void;
  /** Outlines of intraoral scans (planar / panoramic views). */
  protected drawScanOverlay(_ctx: CanvasRenderingContext2D): void {}
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

  /**
   * 3Dconnexion SpaceMouse over a 2D view ("object mode": the image follows the cap):
   * sliding the cap pans along the slice, pushing / pulling zooms. t in screen axes
   * (X right, Y up, Z towards the user), ±1 = full deflection.
   */
  spaceMotion(t: Vec3, _r: Vec3, dt: number) {
    if (!this.app.vol) return;
    const pan = this.h * this.vs.scale * 0.8 * dt;
    this.vs.panU -= t[0] * pan;
    this.vs.panV += t[1] * pan;
    this.vs.scale = Math.min(5, Math.max(0.005, this.vs.scale * Math.exp(-t[2] * 1.6 * dt)));
    this.app.requestRender();
  }

  /** SpaceMouse button: left = fit the view. */
  spaceButton(i: number) {
    if (i !== 0 || !this.app.vol) return;
    this.fit();
    this.app.requestRender();
  }
  /** Horizontal trackpad swipe step; defaults to the vertical action. */
  protected onScrollH(dir: number, p: Pt, e: WheelEvent): void {
    this.onScroll(dir, p, e);
  }
  /** Horizontal one-finger swipe step in the touch UI (dir > 0 = finger moved left). */
  protected onTouchScrollH(dir: number, p: Pt): void {
    this.onScrollH(dir, p, noWheel());
  }
  /** Continuous trackpad swipe (px); return true when handled (e.g. 3D orbit). */
  protected onSwipe(_dx: number, _dy: number, _p: Pt, _e: WheelEvent): boolean {
    return false;
  }
  protected onDoubleClick(_p: Pt, _e: MouseEvent): void {}
  /** Middle button pressed and released without moving (a middle drag pans). */
  protected onMiddleClick(_p: Pt): void {}
  /** Touch UI: a one-finger touch starting at p drags (like a left drag) instead of scrolling. */
  protected touchDragAt(_p: Pt): boolean {
    return false;
  }
  protected onHover(_p: Pt, _e: PointerEvent): void {}
  /** World point under the cursor for the status bar. */
  worldAt(_p: Pt): Vec3 | null {
    return null;
  }

  // ---- segmentation / nerve tools ---------------------------------------------

  /** Segmentation tools handled by clicks in this view. */
  protected supportsTool(_t: SegTool): boolean {
    return false;
  }
  /** Screen position of a world point plus its distance from the view surface (mm). */
  screenOf(_w: Vec3): [number, number, number] | null {
    return null;
  }
  /** Build a separation cut from points clicked in this view. */
  makeCut(_pts: Vec3[], _depth: number | null): NewCut | null {
    return null;
  }
  /** New position of a dragged nerve point. */
  protected nervePointAt(p: Pt, _old: Vec3): Vec3 | null {
    return this.worldAt(p);
  }

  private hitNervePoint(p: Pt): { nerve: Nerve; idx: number } | null {
    const n = this.app.activeNerve();
    if (!n || !n.visible) return null;
    for (let i = n.pts.length - 1; i >= 0; i--) {
      const s = this.screenOf(n.pts[i]);
      if (s && Math.abs(s[2]) <= this.nervePointDepth && Math.hypot(s[0] - p[0], s[1] - p[1]) < 8) return { nerve: n, idx: i };
    }
    return null;
  }

  /** Left click with a segmentation tool; returns true when a nerve point drag starts. */
  private toolDown(p: Pt): boolean {
    const app = this.app;
    const w = this.worldAt(p);
    switch (app.segTool) {
      case 'grow':
        if (w) app.growAt(w);
        return false;
      case 'cut':
        if (w) app.addCutPoint(this, w);
        return false;
      case 'nerve': {
        const hit = this.hitNervePoint(p);
        if (hit) {
          this.nerveDrag = hit;
          return true;
        }
        const n = app.activeNerve();
        if (!w || !n) return false;
        const idx = app.addNervePoint(w);
        this.nerveDrag = { nerve: n, idx };
        return true;
      }
    }
    return false;
  }

  private toolDoubleClick(p: Pt) {
    const app = this.app;
    if (app.segTool === 'cut') {
      // (duplicate points from the double click are already skipped when added)
      app.finishCut();
    } else if (app.segTool === 'nerve') {
      const hit = this.hitNervePoint(p);
      if (hit) app.deleteNervePoint(hit.nerve.id, hit.idx);
    }
  }

  /** Cut being drawn, nerve control points and the tool hint. */
  private drawToolOverlay(o: CanvasRenderingContext2D) {
    const app = this.app;
    const tool = app.segTool;
    if (!tool || !this.supportsTool(tool)) return;
    const d = app.cutDraft;
    if (tool === 'cut' && d && d.view === this) {
      const pts = d.pts.map((w) => this.screenOf(w)).filter((s): s is [number, number, number] => !!s);
      o.save();
      o.strokeStyle = CUT_CSS;
      o.fillStyle = CUT_CSS;
      o.lineWidth = 2;
      o.setLineDash([6, 4]);
      o.beginPath();
      pts.forEach((s, i) => (i ? o.lineTo(s[0], s[1]) : o.moveTo(s[0], s[1])));
      if (this.toolHover && pts.length) o.lineTo(this.toolHover[0], this.toolHover[1]);
      o.stroke();
      o.setLineDash([]);
      for (const s of pts) {
        o.beginPath();
        o.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
        o.fill();
      }
      o.restore();
    }
    const n = app.activeNerve();
    if (tool === 'nerve' && n) {
      o.save();
      for (const w of n.pts) {
        const s = this.screenOf(w);
        if (!s || Math.abs(s[2]) > this.nervePointDepth) continue;
        o.beginPath();
        o.arc(s[0], s[1], 4, 0, Math.PI * 2);
        o.fillStyle = '#ffd60a';
        o.fill();
        o.strokeStyle = '#000';
        o.lineWidth = 1.2;
        o.stroke();
      }
      o.restore();
    }
    const seg = app.activeSegment();
    const name = seg ? seg.name : 'the structure';
    const [long, short] =
      tool === 'grow'
        ? [`Click ${name} to add it (threshold ${Math.round(app.vr.lo)}–${Math.round(app.vr.hi)}) · Esc = done`, `Click ${name} to add it`]
        : tool === 'cut'
          ? ['Cut: click points along the gap, crossing the contact · double-click / Enter = finish · Esc = cancel', 'Cut: click points · double-click = finish']
          : [`${n ? n.name : 'Nerve'}: click the canal centre · drag a point to move it · double-click a point to delete · Esc = done`, 'Click the canal centre'];
    o.font = '12px system-ui, sans-serif';
    drawLabel(o, o.measureText(long).width < this.w - 24 ? long : short, 8, this.h - 28, '#ffd34f');
  }

  // ---- measurements ---------------------------------------------------------

  /** World point for a ruler end at screen point p. */
  protected measureAt(p: Pt): Vec3 | null {
    return this.worldAt(p);
  }
  /** Screen position of a ruler end, or null when it is not on this slice. */
  protected measureScreen(_w: Vec3): Pt | null {
    return null;
  }
  protected measureDistance(a: Vec3, b: Vec3): number {
    return length(sub(a, b));
  }

  private visibleMeasurements(): { m: Measurement; a: Pt; b: Pt }[] {
    if (!this.measureKind) return [];
    const out: { m: Measurement; a: Pt; b: Pt }[] = [];
    for (const m of this.app.measurements) {
      if (m.kind !== this.measureKind) continue;
      const a = this.measureScreen(m.a);
      const b = this.measureScreen(m.b);
      if (a && b) out.push({ m, a, b });
    }
    return out;
  }

  private drawMeasurements(o: CanvasRenderingContext2D) {
    for (const { m, a, b } of this.visibleMeasurements()) {
      const d = this.measureDistance(m.a, m.b);
      o.save();
      o.strokeStyle = 'rgba(0,0,0,0.7)';
      o.lineWidth = 3.5;
      o.beginPath();
      o.moveTo(a[0], a[1]);
      o.lineTo(b[0], b[1]);
      o.stroke();
      const hot = m.id === this.app.hoverMeasurementId || m === this.app.pendingMeasurement?.m;
      o.strokeStyle = '#ffe14d';
      o.lineWidth = hot ? 2.5 : 1.5;
      o.stroke();
      // end ticks
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      const nx = (-dy / l) * 6;
      const ny = (dx / l) * 6;
      o.beginPath();
      for (const q of [a, b]) {
        o.moveTo(q[0] - nx, q[1] - ny);
        o.lineTo(q[0] + nx, q[1] + ny);
      }
      o.stroke();
      // end handles (draggable)
      o.fillStyle = '#ffe14d';
      for (const q of m === this.app.pendingMeasurement?.m ? [a] : [a, b]) {
        o.beginPath();
        o.arc(q[0], q[1], hot ? 3.5 : 2.5, 0, Math.PI * 2);
        o.fill();
      }
      o.restore();
      drawLabel(o, `${d.toFixed(1)} mm`, (a[0] + b[0]) / 2 + nx * 1.6, (a[1] + b[1]) / 2 + ny * 1.6 + 4, '#ffe14d', 'center');
    }
  }

  /** Ruler end point near the screen point (for dragging). */
  private hitMeasureEnd(p: Pt): { m: Measurement; end: 'a' | 'b' } | null {
    for (const v of this.visibleMeasurements()) {
      if (v.m === this.app.pendingMeasurement?.m) continue;
      for (const end of ['a', 'b'] as const) {
        const q = v[end];
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) < (this.app.touchUi ? 18 : 8)) return { m: v.m, end };
      }
    }
    return null;
  }

  private hitMeasureLine(p: Pt): Measurement | null {
    for (const v of this.visibleMeasurements()) {
      if (v.m === this.app.pendingMeasurement?.m) continue;
      if (distToSegment2(p[0], p[1], v.a[0], v.a[1], v.b[0], v.b[1]) < (this.app.touchUi ? 14 : 6)) return v.m;
    }
    return null;
  }

  /**
   * Ruler tool click: the first click places the start point, the second click
   * the end point (a click-drag-release also works). Then the tool switches off.
   */
  private rulerClick(p: Pt): boolean {
    const app = this.app;
    const w = this.measureAt(p);
    if (!w) return false;
    const pend = app.pendingMeasurement;
    if (pend && pend.view === this) {
      pend.m.b = w;
      this.finishMeasurement();
      return false;
    }
    if (pend) app.cancelPendingMeasurement();
    const hitEnd = this.hitMeasureEnd(p);
    if (hitEnd) {
      this.rulerDrag = { ...hitEnd, created: false };
      return true;
    }
    const m = app.addMeasurement(this.measureKind!, w);
    app.pendingMeasurement = { m, view: this };
    this.rulerDrag = { m, end: 'b', created: true };
    app.changed();
    return true;
  }

  private finishMeasurement() {
    const app = this.app;
    const pend = app.pendingMeasurement;
    if (!pend) return;
    app.pendingMeasurement = null;
    if (this.measureDistance(pend.m.a, pend.m.b) < 0.2) app.deleteMeasurement(pend.m.id);
    this.rulerDoneAt = performance.now();
    app.setRuler(false);
  }

  private deleteMeasurementAt(p: Pt): boolean {
    const m = this.hitMeasureLine(p);
    if (!m) return false;
    this.app.deleteMeasurement(m.id);
    return true;
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
      this.drawScanOverlay(o);
      this.drawOverlay(o);
      this.waxEditor?.draw(o);
      this.drawMeasurements(o);
      this.drawToolOverlay(o);
    }
    this.drawTitle(o);
    this.updateScrollbar();
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
      if (this.app.touchUi && e.pointerType === 'touch') {
        this.touchDown(e);
        return;
      }
      const p = this.pos(e);
      this.last = p;
      this.downPos = p;
      this.app.activeView = this;
      // macOS: Control+click arrives as a right click – treat it as a modified left click
      const button = IS_MAC && e.button === 2 && e.ctrlKey ? 0 : e.button;
      this.middleDown = button === 1;
      const wax = this.app.wax;
      if (button === 2) this.drag = 'right';
      // waxup panel open: a press on a tooth goes to the waxup first (Shift = scale, Ctrl = rotate)
      else if (
        button === 0 &&
        this.waxEditor &&
        !this.app.ruler &&
        (wax.editing || (!this.app.segTool && this.waxAnyPanel(p))) &&
        this.waxEditor.start(p, e)
      )
        this.drag = 'wax';
      else if (button === 1 || (button === 0 && ((e.shiftKey && this.shiftPans) || (e.altKey && !e.ctrlKey && !e.metaKey)))) this.drag = 'pan';
      else if (button === 0 && this.app.segTool && this.supportsTool(this.app.segTool)) this.drag = this.toolDown(p) ? 'nerve' : 'none';
      else if (button === 0 && this.app.ruler && this.measureKind) this.drag = this.rulerClick(p) ? 'ruler' : 'none';
      else if (button === 0 && this.measureKind && this.hitMeasureEnd(p)) {
        // edit an existing ruler end without the tool
        this.rulerDrag = { ...this.hitMeasureEnd(p)!, created: false };
        this.drag = 'ruler';
      } else if (button === 0) this.drag = this.onLeftDown(p, e) ? 'left' : 'none';
      if (this.drag !== 'none') {
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (this.touches.has(e.pointerId)) {
        this.touchMove(e);
        return;
      }
      const p = this.pos(e);
      const dx = p[0] - this.last[0];
      const dy = p[1] - this.last[1];
      switch (this.drag) {
        case 'right': {
          if (this.app.rightDrag === 'zoom') {
            // drag down = zoom in, up = zoom out, around the pressed point
            this.zoomAt(this.downPos, Math.exp(-dy * 0.008));
          } else {
            const wl = this.app.wl;
            const k = Math.max(1, wl.width) * 0.004;
            this.app.setWindow(wl.center + dy * k, Math.max(1, wl.width + dx * k));
          }
          break;
        }
        case 'ruler': {
          const r = this.rulerDrag;
          const w = r && this.measureAt(p);
          if (r && w) {
            r.m[r.end] = w;
            this.app.requestRender();
          }
          break;
        }
        case 'nerve': {
          const d = this.nerveDrag;
          const w = d && this.nervePointAt(p, d.nerve.pts[d.idx]);
          if (d && w) this.app.moveNervePoint(d.nerve, d.idx, w);
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
        case 'wax':
          this.waxEditor?.move(p);
          break;
        default: {
          const app = this.app;
          const pend = app.pendingMeasurement;
          if (pend && pend.view === this) {
            // rubber band to the mouse until the second click
            const w = this.measureAt(p);
            if (w) pend.m.b = w;
            this.el.style.cursor = 'crosshair';
            app.requestRender();
            break;
          }
          if (app.segTool && this.supportsTool(app.segTool)) {
            this.toolHover = p;
            this.el.style.cursor = app.segTool === 'nerve' && this.hitNervePoint(p) ? 'move' : 'crosshair';
            if (app.cutDraft?.view === this) app.requestRender();
            break;
          }
          if (this.measureKind) {
            const hover = this.hitMeasureLine(p)?.id ?? null;
            if (hover !== app.hoverMeasurementId) {
              app.hoverMeasurementId = hover;
              app.requestRender();
            }
          }
          if (app.ruler && this.measureKind) this.el.style.cursor = 'crosshair';
          else if (this.measureKind && this.hitMeasureEnd(p)) this.el.style.cursor = 'move';
          else {
            const wc = !this.waxEditor ? null : app.wax.editing ? this.waxEditor.hover(p) : this.waxAnyPanel(p) ? this.waxEditor.peek(p) : null;
            if (wc) this.el.style.cursor = wc;
            else this.onHover(p, e);
          }
        }
      }
      this.last = p;
      this.app.activeView = this;
      this.app.reportCursor(this, p);
    });
    const end = (e: PointerEvent) => {
      if (this.touches.has(e.pointerId)) {
        this.touchUp(e);
        return;
      }
      if (this.drag === 'ruler' && this.rulerDrag) {
        const { created } = this.rulerDrag;
        this.rulerDrag = null;
        const p = this.pos(e);
        const moved = Math.hypot(p[0] - this.downPos[0], p[1] - this.downPos[1]) > 4;
        // click-drag-release measures in one gesture; a plain click waits for the second click
        if (created && moved) this.finishMeasurement();
        this.app.changed();
      }
      if (this.drag === 'nerve') {
        this.nerveDrag = null;
        this.app.changed();
      }
      if (this.drag === 'wax') this.waxEditor?.end();
      if (this.drag === 'left') {
        const p = this.pos(e);
        const moved = Math.hypot(p[0] - this.downPos[0], p[1] - this.downPos[1]) > 3;
        this.onLeftUp(p, e, moved);
      }
      if (this.drag === 'pan' && this.middleDown && e.type === 'pointerup') {
        const p = this.pos(e);
        if (Math.hypot(p[0] - this.downPos[0], p[1] - this.downPos[1]) <= 3) this.onMiddleClick(p);
      }
      this.middleDown = false;
      this.drag = 'none';
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.app.reportCursor(this, null);
      this.waxEditor?.leave();
      if (this.toolHover) {
        this.toolHover = null;
        this.app.requestRender();
      }
      if (this.app.hoverMeasurementId !== null) {
        this.app.hoverMeasurementId = null;
        this.app.requestRender();
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.app.vol) return;
        e.preventDefault();
        if (this.gestureActive) return; // Safari pinch is handled by the gesture events
        // synthetic scroll/zoom from the SpaceMouse driver while the cap is moved
        if (performance.now() < this.app.wheelBlockedUntil) return;
        const p = this.pos(e);
        const trackpad = this.app.input === 'trackpad';
        if (e.ctrlKey || (e.metaKey && !trackpad)) {
          // pinch (trackpads report it as ctrl+wheel) or ctrl/cmd + mouse wheel
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
          const d = Math.max(-100, Math.min(100, e.deltaY * unit));
          this.zoomAt(p, Math.exp(d * (trackpad ? 0.01 : 0.0025)));
        } else if (trackpad) {
          this.trackpadWheel(e, p);
        } else {
          const dir = Math.sign(e.deltaY || e.deltaX);
          if (dir) this.onScroll(dir, p, e);
        }
      },
      { passive: false },
    );
    // Safari reports trackpad pinch as gesture events
    let gScale = 1;
    const gesture = (name: string, fn: (e: Event & { scale: number; clientX: number; clientY: number }) => void) =>
      c.addEventListener(name, (e) => {
        e.preventDefault();
        // the touch UI handles pinch itself (Safari also reports it as gesture events)
        if (this.app.vol && !this.app.touchUi) fn(e as Event & { scale: number; clientX: number; clientY: number });
      });
    gesture('gesturestart', () => {
      this.gestureActive = true;
      gScale = 1;
    });
    gesture('gesturechange', (e) => {
      if (!e.scale) return;
      this.zoomAt(this.pos(e as unknown as MouseEvent), gScale / e.scale);
      gScale = e.scale;
    });
    gesture('gestureend', () => {
      this.gestureActive = false;
    });
    c.addEventListener('dblclick', (e) => {
      // the touch UI has its own double-tap; browsers also turn quick taps into dblclick
      if (!this.app.vol || this.app.touchUi) return;
      if (this.app.segTool && this.supportsTool(this.app.segTool)) {
        this.toolDoubleClick(this.pos(e));
        return;
      }
      if (this.measureKind && !this.app.ruler && performance.now() - this.rulerDoneAt > 500) {
        if (this.deleteMeasurementAt(this.pos(e))) return;
      }
      if (this.app.ruler) return;
      this.onDoubleClick(this.pos(e), e);
    });
  }

  // ---- touch (phone UI) ---------------------------------------------------------

  private touches = new Map<number, Pt>();
  /** drag: left-drag semantics · ruler: measuring / moving a ruler end */
  private touchStart: { p: Pt; t: number; moved: boolean; drag: boolean; ruler: boolean } | null = null;
  private pinch: { dist: number; c: Pt } | null = null;
  private lastTapAt = 0;

  private pinchState(): { dist: number; c: Pt } {
    const [a, b] = [...this.touches.values()];
    return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  }

  private touchDown(e: PointerEvent) {
    e.preventDefault();
    const p = this.pos(e);
    this.ovCanvas.setPointerCapture(e.pointerId);
    this.touches.set(e.pointerId, p);
    this.app.activeView = this;
    if (this.touches.size === 1) {
      // ruler tool: drag from start to end (or tap start, then end); a ruler end can always be dragged
      const ruler = !!this.measureKind && (this.app.ruler || !!this.hitMeasureEnd(p));
      if (ruler) {
        this.downPos = p;
        const end = this.app.ruler ? null : this.hitMeasureEnd(p);
        if (end) this.rulerDrag = { ...end, created: false };
        else if (!this.rulerClick(p)) this.rulerDrag = null; // second tap finished a ruler
      }
      const drag = !ruler && this.touchDragAt(p) && this.onLeftDown(p, e);
      this.touchStart = { p, t: performance.now(), moved: false, drag, ruler };
      this.accX = 0;
      this.accY = 0;
    } else {
      const st = this.touchStart;
      if (st) {
        st.moved = true; // no tap once a second finger lands
        if (st.drag) {
          st.drag = false;
          this.onLeftUp(p, e, true);
        }
        // pinching mid-measurement: keep the start point, finish with a tap later
        this.rulerDrag = null;
      }
      if (this.touches.size === 2) this.pinch = this.pinchState();
    }
  }

  /** One finger: scroll / orbit (like a trackpad swipe). Two fingers: pinch zoom + pan. */
  private touchMove(e: PointerEvent) {
    const prev = this.touches.get(e.pointerId)!;
    const p = this.pos(e);
    this.touches.set(e.pointerId, p);
    if (this.touches.size >= 2) {
      if (!this.pinch || this.touches.size > 2) return;
      const s = this.pinchState();
      if (s.dist > 10 && this.pinch.dist > 10) this.zoomAt(s.c, this.pinch.dist / s.dist);
      this.vs.panU -= (s.c[0] - this.pinch.c[0]) * this.vs.scale;
      this.vs.panV -= (s.c[1] - this.pinch.c[1]) * this.vs.scale;
      this.pinch = s;
      this.app.requestRender();
      return;
    }
    const st = this.touchStart;
    if (!st) return;
    if (st.ruler) {
      const r = this.rulerDrag;
      const w = r && this.measureAt(p);
      if (r && w) {
        r.m[r.end] = w;
        this.app.requestRender();
      }
      return;
    }
    if (st.drag) {
      if (Math.hypot(p[0] - st.p[0], p[1] - st.p[1]) > 3) st.moved = true;
      this.onLeftDrag(p, prev, e);
      return;
    }
    if (!st.moved) {
      if (Math.hypot(p[0] - st.p[0], p[1] - st.p[1]) < 8) return;
      st.moved = true;
    }
    const dx = p[0] - prev[0];
    const dy = p[1] - prev[1];
    // content follows the finger: feed the deltas like a natural-scrolling trackpad
    if (this.onSwipe(-dx, -dy, p, noWheel())) return;
    const STEP = 6; // px of finger travel per slice step
    if (Math.abs(dx) > Math.abs(dy)) {
      if (Math.sign(-dx) !== Math.sign(this.accX)) this.accX = 0;
      this.accX -= dx;
      while (Math.abs(this.accX) >= STEP) {
        const dir = Math.sign(this.accX);
        this.onTouchScrollH(dir, p);
        this.accX -= dir * STEP;
      }
    } else {
      if (Math.sign(-dy) !== Math.sign(this.accY)) this.accY = 0;
      this.accY -= dy;
      while (Math.abs(this.accY) >= STEP) {
        const dir = Math.sign(this.accY);
        this.onScroll(dir, p, noWheel());
        this.accY -= dir * STEP;
      }
    }
  }

  /** Tap = click (e.g. move the crosshair there); double tap = fit the view. */
  private touchUp(e: PointerEvent) {
    const st = this.touchStart;
    this.touches.delete(e.pointerId);
    if (this.ovCanvas.hasPointerCapture(e.pointerId)) this.ovCanvas.releasePointerCapture(e.pointerId);
    if (this.touches.size === 0) {
      if (st?.ruler) {
        const r = this.rulerDrag;
        this.rulerDrag = null;
        const p = this.pos(e);
        // drag-release measures in one go; a plain tap waits for the second tap
        if (r?.created && Math.hypot(p[0] - this.downPos[0], p[1] - this.downPos[1]) > 6) this.finishMeasurement();
        this.app.changed();
      } else if (st?.drag) this.onLeftUp(this.pos(e), e, st.moved);
      else if (e.type === 'pointerup' && st && !st.moved && performance.now() - st.t < 450) {
        const now = performance.now();
        // (no double-tap fit while tapping out a curve)
        if (now - this.lastTapAt < 320 && !this.app.drawing) {
          this.lastTapAt = 0;
          // double-tap on a ruler deletes it, elsewhere fits the view
          const m = this.measureKind ? this.hitMeasureLine(st.p) : null;
          if (m) this.app.deleteMeasurement(m.id);
          else this.vs.fitted = false;
          this.app.requestRender();
        } else {
          this.lastTapAt = now;
          // a tap on a ruler does nothing (a second tap deletes it)
          const onRuler = this.measureKind && this.hitMeasureLine(st.p);
          if (!onRuler && this.onLeftDown(st.p, e)) this.onLeftUp(st.p, e, false);
        }
      }
      this.touchStart = null;
      this.pinch = null;
    } else if (this.touches.size === 1) {
      // continue with the remaining finger without a jump
      this.pinch = null;
      this.touchStart = { p: [...this.touches.values()][0], t: 0, moved: true, drag: false, ruler: false };
    } else if (this.touches.size === 2) this.pinch = this.pinchState();
  }

  // ---- trackpad --------------------------------------------------------------

  private gestureActive = false;
  private accX = 0;
  private accY = 0;
  private lastWheel = 0;

  /**
   * Two-finger swipe: scroll in steps (accumulated so a swipe is smooth, not a
   * burst), ⌘ + swipe pans, ⇧ + swipe adjusts brightness / contrast.
   */
  private trackpadWheel(e: WheelEvent, p: Pt) {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.metaKey) {
      this.vs.panU += dx * this.vs.scale;
      this.vs.panV += dy * this.vs.scale;
      this.app.requestRender();
      return;
    }
    if (e.shiftKey) {
      const wl = this.app.wl;
      const k = Math.max(1, wl.width) * 0.002;
      // some browsers turn shift+vertical scroll into horizontal: use whichever axis dominates
      this.app.setWindow(wl.center - dy * k, Math.max(1, wl.width + dx * k));
      return;
    }
    if (this.onSwipe(dx, dy, p, e)) return;
    const now = performance.now();
    if (now - this.lastWheel > 250) {
      this.accX = 0;
      this.accY = 0;
    }
    this.lastWheel = now;
    const STEP = 28; // px of finger travel per slice step
    if (Math.abs(dx) > Math.abs(dy)) {
      if (Math.sign(dx) !== Math.sign(this.accX)) this.accX = 0;
      this.accX += dx;
      while (Math.abs(this.accX) >= STEP) {
        const dir = Math.sign(this.accX);
        this.onScrollH(dir, p, e);
        this.accX -= dir * STEP;
      }
    } else {
      if (Math.sign(dy) !== Math.sign(this.accY)) this.accY = 0;
      this.accY += dy;
      while (Math.abs(this.accY) >= STEP) {
        const dir = Math.sign(this.accY);
        this.onScroll(dir, p, e);
        this.accY -= dir * STEP;
      }
    }
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
  protected measureKind: 'plane' | 'pano' | null = 'plane';
  protected editor = new ImplantEditor(this.app, {
    project: (w) => {
      const s = this.worldToScreen(w)!;
      return { x: s[0], y: s[1], depth: s[2] };
    },
    basis: () => {
      const pl = this.currentPlane()!;
      return { u: pl.u, v: pl.v, n: cross(pl.u, pl.v) };
    },
    scale: () => this.vs.scale,
    radialAxial: (p, imp) => {
      const q = sub(this.screenToWorld(p)!, imp.center);
      const h = dot(q, imp.axis);
      return { rad: length(sub(q, scale(imp.axis, h))), h };
    },
    hitBody: (p) => this.hitBody(p),
    visible: (imp) => {
      const s = this.worldToScreen(imp.center);
      return !!s && Math.abs(s[2]) < imp.diameter / 2 + 1;
    },
    container: this.el,
  });

  protected override waxEditor: WaxupEditor | null = new WaxupEditor(this.app, {
    pick: (p) => {
      const fdi = waxAt(this, p);
      const w = fdi !== null ? this.screenToWorld(p) : null;
      return fdi !== null && w ? { fdi, w } : null;
    },
    // in the slice, at the anchor's distance from it
    planePoint: (p, anchor) => {
      const pl = this.currentPlane();
      const w = this.screenToWorld(p, pl ?? undefined);
      const s = this.worldToScreen(anchor, pl ?? undefined);
      if (!pl || !w || !s) return null;
      return add(w, scale(intoScreen(pl.u, pl.v), s[2]));
    },
    project: (w) => {
      const s = this.worldToScreen(w);
      return s ? [s[0], s[1]] : null;
    },
    viewAxis: () => {
      const pl = this.currentPlane()!;
      return intoScreen(pl.u, pl.v);
    },
    near: (w) => {
      const s = this.worldToScreen(w);
      return !!s && Math.abs(s[2]) < 3;
    },
    mmPerPx: () => this.vs.scale,
    sculpt: false,
  });

  protected measureScreen(w: Vec3): Pt | null {
    const s = this.worldToScreen(w);
    return s && Math.abs(s[2]) < 0.75 ? [s[0], s[1]] : null;
  }

  protected supportsTool(_t: SegTool): boolean {
    return true;
  }

  override screenOf(w: Vec3) {
    return this.worldToScreen(w);
  }

  /** Cut drawn on this slice: the polyline extruded along the slice normal. */
  override makeCut(pts: Vec3[], depth: number | null): NewCut | null {
    const pl = this.currentPlane();
    if (!pl) return null;
    return { kind: 'plane', pts: pts.map((p) => [...p] as Vec3), u: pl.u, v: pl.v, n: cross(pl.u, pl.v), depth, viewName: this.title };
  }

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

  protected override drawScanOverlay(o: CanvasRenderingContext2D) {
    const pl = this.currentPlane();
    if (!pl) return;
    if (this.app.scans.length) drawPlaneScans(this, this.app, o, pl.center, pl.u, pl.v, this.vs.scale, this.w, this.h);
    drawPlaneWax(this, this.app, o, pl.center, pl.u, pl.v, this.vs.scale, this.w, this.h);
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
    return this.app.implantsKey() + this.app.segKey();
  }

  /** Segments, cut traces, implant/abutment and nerve intersections with the plane. */
  protected composePixels(rgba: Uint8ClampedArray, w: number, h: number) {
    const pl = this.currentPlane();
    if (!pl) return;
    const k = 1 / this.imgScale;
    const pxmm = this.vs.scale * k;
    const p0 = this.screenToWorld([0.5 * k, 0.5 * k], pl)!;
    const du = scale(pl.u, pxmm);
    const dv = scale(pl.v, pxmm);
    const crop = this.crop();
    composeSegmentation(this.app, rgba, w, h, (i, j, out) => {
      out[0] = p0[0] + du[0] * i + dv[0] * j;
      out[1] = p0[1] + du[1] * i + dv[1] * j;
      out[2] = p0[2] + du[2] * i + dv[2] * j;
      return !crop || inCrop(crop, out);
    });
    this.composeImplants(rgba, w, h, pl, p0, du, dv, pxmm, k);
    composeNerveSection(this.app, rgba, w, h, p0, du, dv, pxmm);
  }

  /** Rasterise exact implant/abutment intersections with the plane into the image. */
  private composeImplants(rgba: Uint8ClampedArray, w: number, h: number, pl: Plane, p0: Vec3, du: Vec3, dv: Vec3, pxmm: number, k: number) {
    if (!this.app.implants.length) return;
    const n = cross(pl.u, pl.v);
    const edge = Math.max(0.12, pxmm * 1.3);
    for (const part of this.app.allParts()) {
      const r = part.radius;
      const hl = part.half;
      if (Math.abs(dot(sub(part.center, pl.center), n)) > hl + r) continue;
      const sel = part.implant.id === this.app.selectedId;
      const isImplant = part.kind === 'implant';
      const isGuide = part.kind === 'prosthetic';
      const col = isImplant
        ? sel
          ? IMPLANT_SELECTED_COLOR
          : IMPLANT_COLOR
        : isGuide
          ? PROSTHETIC_COLOR
          : sel
            ? ABUTMENT_SELECTED_COLOR
            : ABUTMENT_COLOR;
      // translucent fill so the guide never hides anatomy
      const fillAlpha = isImplant ? 0.32 : isGuide ? 0.12 : 0.45;
      const edgeAlpha = isGuide ? 0.75 : 0.95;
      const r0 = part.r0;
      const dr = part.half > 0 ? (part.r1 - part.r0) / (2 * part.half) : 0; // radius change per mm
      // bounding box in image pixels
      const sc = this.worldToScreen(part.center, pl)!;
      const R = Math.hypot(hl, r) / pxmm + 2;
      const cx = sc[0] / k;
      const cy = sc[1] / k;
      const i0 = Math.max(0, Math.floor(cx - R));
      const i1 = Math.min(w - 1, Math.ceil(cx + R));
      const j0 = Math.max(0, Math.floor(cy - R));
      const j1 = Math.min(h - 1, Math.ceil(cy + R));
      const a = part.axis;
      const c = part.center;
      const r2 = r * r;
      // platform band (coronal 0.6 mm of the implant body) drawn brighter
      const platformH = -hl + 0.6;
      for (let j = j0; j <= j1; j++) {
        let qx = p0[0] + du[0] * i0 + dv[0] * j - c[0];
        let qy = p0[1] + du[1] * i0 + dv[1] * j - c[1];
        let qz = p0[2] + du[2] * i0 + dv[2] * j - c[2];
        for (let i = i0; i <= i1; i++) {
          const hh = qx * a[0] + qy * a[1] + qz * a[2];
          const ah = Math.abs(hh);
          if (ah <= hl) {
            const rad2 = qx * qx + qy * qy + qz * qz - hh * hh;
            const rh = r0 + dr * (hh + hl); // radius at this height (cone)
            if (rad2 <= rh * rh && rad2 <= r2) {
              const d = Math.max(Math.sqrt(Math.max(0, rad2)) - rh, ah - hl);
              let alpha = d > -edge ? edgeAlpha : fillAlpha;
              if (isImplant && hh < platformH) alpha = Math.max(alpha, 0.7);
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

  /** Dashed implant axes and rotation handles. */
  protected drawImplantAxes(o: CanvasRenderingContext2D) {
    if (this.implantsEditable) this.editor.draw(o);
  }

  // ---- implant manipulation ----------------------------------------------

  private hitBody(p: Pt): Implant | null {
    const w = this.screenToWorld(p);
    if (!w) return null;
    const tol = 4 * this.vs.scale;
    let best: { imp: Implant; d: number } | null = null;
    for (const part of this.app.allParts()) {
      if (part.kind === 'prosthetic') continue; // guide only, not clickable
      const q = sub(w, part.center);
      const h = dot(q, part.axis);
      const rad = length(sub(q, scale(part.axis, h)));
      if (Math.abs(h) <= part.half + tol && rad <= radiusAt(part, h) + tol) {
        const d = rad + (part.kind === 'implant' ? 0 : 0.5);
        if (!best || d < best.d) best = { imp: part.implant, d };
      }
    }
    return best?.imp ?? null;
  }

  /** Returns true when an implant drag started. */
  protected startImplantDrag(p: Pt): boolean {
    if (!this.implantsEditable) return false;
    return this.editor.start(p);
  }

  protected dragImplant(p: Pt, last: Pt) {
    return this.editor.move(p, last);
  }

  protected endImplantDrag() {
    return this.editor.end();
  }

  protected updateHoverCursor(p: Pt) {
    if (!this.implantsEditable) return false;
    const c = this.editor.hoverCursor(p);
    this.el.style.cursor = c ?? '';
    return !!c;
  }
}

function inCrop(c: CropSpec, p: Vec3): boolean {
  const q = sub(p, c.origin);
  for (let a = 0; a < 3; a++) {
    const f = dot(q, c.frame[a]);
    if (f < c.min[a] || f > c.max[a]) return false;
  }
  return true;
}

let noWheelEvent: WheelEvent | null = null;
/** Placeholder event (no modifier keys) for scroll handlers driven by touch. */
function noWheel(): WheelEvent {
  return (noWheelEvent ??= new WheelEvent('wheel'));
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
