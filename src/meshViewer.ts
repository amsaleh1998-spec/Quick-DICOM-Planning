// Small interactive 3D viewer for meshes (used by the scan alignment workspace):
// orbit / pan / zoom, click to pick a surface point, drag to paint, numbered markers.

import { cross, normalize, rotate, Vec3 } from './math';
import { MeshGL, drawPick, pixelRay, rayMesh, viewProjection } from './meshgl';

const FOV = (30 * Math.PI) / 180;

export interface ViewerMesh {
  key: unknown;
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
  col: Uint8Array | null;
  color: [number, number, number];
  opacity: number;
  vertexColors: boolean;
  /** can be clicked / painted */
  pickable: boolean;
  visible?: boolean;
}

/** A camera position, to repeat a view-dependent edit (a lasso) later. */
export interface Camera {
  target: Vec3;
  dist: number;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  /** viewer size (CSS px) */
  w: number;
  h: number;
}

/** Screen position (CSS px) of a world point seen from a camera; null behind it. */
export function projectWith(cam: Camera, p: Vec3): [number, number] | null {
  const c = [cam.target[0] - cam.fwd[0] * cam.dist, cam.target[1] - cam.fwd[1] * cam.dist, cam.target[2] - cam.fwd[2] * cam.dist];
  const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const z = q[0] * cam.fwd[0] + q[1] * cam.fwd[1] + q[2] * cam.fwd[2];
  if (z <= 0) return null;
  const t = Math.tan(FOV / 2);
  const x = (q[0] * cam.right[0] + q[1] * cam.right[1] + q[2] * cam.right[2]) / (z * t * (cam.w / cam.h));
  const y = (q[0] * cam.up[0] + q[1] * cam.up[1] + q[2] * cam.up[2]) / (z * t);
  return [(cam.w / 2) * (1 + x), (cam.h / 2) * (1 - y)];
}

/** Camera position (world) of a camera. */
export function eyeOf(cam: Camera): Vec3 {
  return [cam.target[0] - cam.fwd[0] * cam.dist, cam.target[1] - cam.fwd[1] * cam.dist, cam.target[2] - cam.fwd[2] * cam.dist];
}

export interface Marker {
  p: Vec3;
  label: string;
  color: string;
}

export class MeshViewer {
  /** viewers currently on screen (the SpaceMouse drives the one under the pointer) */
  static active = new Set<MeshViewer>();
  /** the 3Dconnexion driver also sends wheel events while the cap moves: ignore them meanwhile */
  static wheelBlockedUntil = 0;
  /** wheel over the viewer: return true when handled (otherwise it zooms); dir > 0 = scroll down */
  onWheel: ((dir: number, e: WheelEvent) => boolean) | null = null;
  /** left press on the surface: return true to drag something (e.g. a patch) instead of rotating */
  onGrab: ((p: Vec3) => boolean) | null = null;
  /** while grabbing: the surface point under the pointer */
  onGrabMove: ((p: Vec3) => void) | null = null;
  onGrabEnd: (() => void) | null = null;
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ov: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private mg: MeshGL | null = null;
  meshes: ViewerMesh[] = [];
  markers: Marker[] = [];
  /** left button paints instead of orbiting */
  paintMode = false;
  /** while painting: a stroke ended */
  onPaintEnd: (() => void) | null = null;
  /** painting with a brush of this radius (mm): its ring follows the pointer on the surface */
  brushRadius: number | null = null;
  private ring: Vec3 | null = null;
  /** left button draws a lasso (closed on release, then onLasso) instead of orbiting */
  lassoMode = false;
  onLasso: ((poly: [number, number][]) => void) | null = null;
  private lasso: [number, number][] | null = null;
  /** lines drawn over the meshes (world, pairs of points as x0 y0 z0 x1 y1 z1 …) */
  lines: { seg: Float32Array; color: string }[] = [];
  onPick: ((p: Vec3, mesh: ViewerMesh) => void) | null = null;
  onPaint: ((p: Vec3, mesh: ViewerMesh, erase: boolean) => void) | null = null;
  onHover: ((p: Vec3 | null) => void) | null = null;
  // camera
  private target: Vec3 = [0, 0, 0];
  private dist = 100;
  private right: Vec3 = [1, 0, 0];
  private up: Vec3 = [0, 0, 1];
  private fwd: Vec3 = [0, 1, 0];
  private pending = false;
  readonly error: string | null = null;

  constructor(title: string) {
    this.el = document.createElement('div');
    this.el.className = 'mv';
    this.el.innerHTML = `<div class="mv-title">${title}</div>`;
    this.canvas = document.createElement('canvas');
    this.ov = document.createElement('canvas');
    this.ov.className = 'mv-ov';
    this.el.append(this.canvas, this.ov);
    this.gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!this.gl) (this as { error: string | null }).error = 'WebGL2 is not available.';
    else
      try {
        this.mg = new MeshGL(this.gl);
      } catch (e) {
        (this as { error: string | null }).error = (e as Error).message;
      }
    this.bind();
    new ResizeObserver(() => this.request()).observe(this.el);
    MeshViewer.active.add(this);
  }

  /** Free the GPU resources and stop receiving SpaceMouse input. */
  dispose() {
    MeshViewer.active.delete(this);
    if (this.mg) this.mg.prune(new Set());
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** SpaceMouse ("object mode": the model follows the cap), like the main 3D view. */
  spaceMotion(t: Vec3, r: Vec3, dt: number) {
    const s = this.dist * Math.tan(FOV / 2) * 1.6 * dt;
    for (let k = 0; k < 3; k++) this.target[k] -= (this.right[k] * t[0] + this.up[k] * t[1]) * s;
    this.dist *= Math.exp(-t[2] * 1.6 * dt); // pulling the cap towards you brings the model closer
    const axis: Vec3 = [
      this.right[0] * r[0] + this.up[0] * r[1] - this.fwd[0] * r[2],
      this.right[1] * r[0] + this.up[1] * r[1] - this.fwd[1] * r[2],
      this.right[2] * r[0] + this.up[2] * r[1] - this.fwd[2] * r[2],
    ];
    const mag = Math.hypot(axis[0], axis[1], axis[2]);
    if (mag > 1e-6) {
      const a: Vec3 = [axis[0] / mag, axis[1] / mag, axis[2] / mag];
      const ang = -mag * 2.2 * dt;
      this.fwd = normalize(rotate(this.fwd, a, ang));
      this.right = normalize(rotate(this.right, a, ang));
      this.up = cross(this.right, this.fwd);
    }
    this.request();
  }

  spaceButton(i: number) {
    if (i === 0) this.fit();
  }

  setTitle(t: string) {
    this.el.querySelector('.mv-title')!.textContent = t;
  }

  /** Replace the meshes (uploads what changed) and optionally frame them. */
  setMeshes(list: ViewerMesh[], fit = false) {
    if (this.mg) {
      const keep = new Set(list.map((m) => m.key));
      this.mg.prune(keep);
      for (const m of list) if (!this.mg.has(m.key) || !this.meshes.includes(m)) this.mg.upload(m.key, m.pos, m.nrm, m.idx, m.col);
    }
    this.meshes = list;
    if (fit) this.fit();
    this.request();
  }

  updateColors(m: ViewerMesh, col: Uint8Array) {
    m.col = col;
    this.mg?.updateColors(m.key, col);
    this.request();
  }

  /** Frame all meshes; `occlusalUp` (world) is shown pointing up when given. */
  fit(viewDir?: Vec3, upHint?: Vec3) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const m of this.meshes)
      for (let i = 0; i < m.pos.length; i += 3)
        for (let k = 0; k < 3; k++) {
          if (m.pos[i + k] < min[k]) min[k] = m.pos[i + k];
          if (m.pos[i + k] > max[k]) max[k] = m.pos[i + k];
        }
    if (!Number.isFinite(min[0])) return;
    this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const r = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
    this.dist = (r / Math.tan(FOV / 2)) * 1.15;
    if (viewDir) {
      this.fwd = normalize(viewDir);
      const u0 = upHint ?? (Math.abs(this.fwd[2]) < 0.9 ? [0, 0, 1] : [0, -1, 0]);
      this.right = normalize(cross(this.fwd, u0 as Vec3));
      this.up = cross(this.right, this.fwd);
    }
    this.request();
  }

  setView(fwd: Vec3, up: Vec3) {
    this.fwd = normalize(fwd);
    this.right = normalize(cross(this.fwd, up));
    this.up = cross(this.right, this.fwd);
    this.request();
  }

  private camPos(): Vec3 {
    return [this.target[0] - this.fwd[0] * this.dist, this.target[1] - this.fwd[1] * this.dist, this.target[2] - this.fwd[2] * this.dist];
  }

  request() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  private render() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
    for (const c of [this.canvas, this.ov]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
    }
    const gl = this.gl;
    const pos = this.camPos();
    if (gl && this.mg) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.06, 0.08, 0.12, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const mvp = viewProjection(pos, this.right, this.up, this.fwd, FOV, w / h, Math.max(0.1, this.dist * 0.01), this.dist * 20);
      // opaque first, then translucent with blending
      const opaque = this.meshes.filter((m) => m.visible !== false && m.opacity >= 0.99);
      const trans = this.meshes.filter((m) => m.visible !== false && m.opacity < 0.99);
      gl.disable(gl.BLEND);
      for (const m of opaque) this.mg.draw(m.key, mvp, pos, m);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const m of trans) this.mg.draw(m.key, mvp, pos, m);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    // markers
    const o = this.ov.getContext('2d')!;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.ov.width, this.ov.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.error) {
      o.fillStyle = '#f88';
      o.font = '13px system-ui';
      o.fillText(this.error, 12, 40);
    }
    for (const l of this.lines) {
      o.strokeStyle = l.color;
      o.lineWidth = 2;
      o.beginPath();
      const g = l.seg;
      for (let i = 0; i + 5 < g.length; i += 6) {
        const a = this.project([g[i], g[i + 1], g[i + 2]], w, h), b = this.project([g[i + 3], g[i + 4], g[i + 5]], w, h);
        if (!a || !b) continue;
        o.moveTo(a[0], a[1]);
        o.lineTo(b[0], b[1]);
      }
      o.stroke();
    }
    if (this.ring && this.brushRadius && this.paintMode) {
      const r = this.brushRadius;
      o.beginPath();
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2, c = Math.cos(a) * r, d = Math.sin(a) * r;
        const s = this.project([this.ring[0] + this.right[0] * c + this.up[0] * d, this.ring[1] + this.right[1] * c + this.up[1] * d, this.ring[2] + this.right[2] * c + this.up[2] * d], w, h);
        if (!s) continue;
        if (i) o.lineTo(s[0], s[1]);
        else o.moveTo(s[0], s[1]);
      }
      o.strokeStyle = 'rgba(255,255,255,0.9)';
      o.lineWidth = 1.5;
      o.stroke();
    }
    if (this.lasso && this.lasso.length > 1) {
      o.beginPath();
      o.moveTo(this.lasso[0][0], this.lasso[0][1]);
      for (const [x, y] of this.lasso) o.lineTo(x, y);
      o.closePath();
      o.fillStyle = 'rgba(255, 138, 92, 0.15)';
      o.fill();
      o.setLineDash([5, 4]);
      o.strokeStyle = '#ff8a5c';
      o.lineWidth = 1.5;
      o.stroke();
      o.setLineDash([]);
    }
    for (const mk of this.markers) {
      const s = this.project(mk.p, w, h);
      if (!s) continue;
      o.beginPath();
      o.arc(s[0], s[1], 9, 0, Math.PI * 2);
      o.fillStyle = mk.color;
      o.fill();
      o.lineWidth = 2;
      o.strokeStyle = '#000';
      o.stroke();
      o.fillStyle = '#000';
      o.font = 'bold 11px system-ui';
      o.textAlign = 'center';
      o.textBaseline = 'middle';
      o.fillText(mk.label, s[0], s[1] + 0.5);
    }
  }

  /** Screen position (CSS px in the viewer) of a world point; null behind the camera. */
  screenOf(p: Vec3): [number, number] | null {
    return this.project(p, this.el.clientWidth, this.el.clientHeight);
  }

  /** Camera position (world). */
  eye(): Vec3 {
    return this.camPos();
  }

  /** The triangle (of a pickable mesh) under a screen position, by casting a ray. */
  triangleAt(x: number, y: number): { mesh: ViewerMesh; tri: number; p: Vec3 } | null {
    const ray = pixelRay(x, y, this.el.clientWidth, this.el.clientHeight, this.camPos(), this.right, this.up, this.fwd, FOV);
    let best: { mesh: ViewerMesh; tri: number; p: Vec3; t: number } | null = null;
    for (const m of this.meshes) {
      if (!m.pickable || m.visible === false) continue;
      const hit = rayMesh(m.pos, m.idx, ray.o, ray.d);
      if (hit && (!best || hit.t < best.t)) best = { mesh: m, tri: hit.tri, p: hit.p, t: hit.t };
    }
    return best;
  }

  /** The current camera. */
  camera(): Camera {
    return { target: [...this.target], dist: this.dist, right: [...this.right], up: [...this.up], fwd: [...this.fwd], w: this.el.clientWidth, h: this.el.clientHeight };
  }

  /**
   * Distance from a camera to the nearest surface of a mesh, per screen position of that camera
   * (rendered off screen and read back once): for "only what can be seen" edits. Null without WebGL.
   */
  depthMapFor(cam: Camera, pos: Float32Array, idx: Uint32Array): ((x: number, y: number) => number | null) | null {
    const gl = this.gl;
    if (!gl || !this.mg) return null;
    const W = this.canvas.width, H = this.canvas.height;
    if (!this.pickFbo) {
      this.pickFbo = gl.createFramebuffer();
      this.pickTex = gl.createTexture();
      this.pickDepth = gl.createRenderbuffer();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    if (`${W}x${H}` !== this.pickSize) {
      gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
      this.pickSize = `${W}x${H}`;
    }
    const key = {};
    this.mg.upload(key, pos, new Float32Array(pos.length), idx, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const eye = eyeOf(cam);
    const far = cam.dist * 20;
    const mvp = viewProjection(eye, cam.right, cam.up, cam.fwd, FOV, cam.w / cam.h, Math.max(0.1, cam.dist * 0.01), far);
    drawPick(this.mg, key, mvp, eye, far, 1);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.mg.delete(key);
    this.request();
    const { w, h } = cam;
    return (x, y) => {
      const i = Math.floor((x / w) * W), j = H - 1 - Math.floor((y / h) * H);
      if (i < 0 || j < 0 || i >= W || j >= H) return null;
      // the nearest of a 3×3 neighbourhood (a triangle centre may sit at a pixel's edge)
      let best: number | null = null;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= W || b >= H) continue;
          const o = (a + b * W) * 4;
          if (!px[o + 3]) continue;
          const d = ((px[o] * 65536 + px[o + 1] * 256 + px[o + 2]) / 16777215) * far;
          if (best === null || d < best) best = d;
        }
      return best;
    };
  }

  private project(p: Vec3, w: number, h: number): [number, number] | null {
    const c = this.camPos();
    const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const z = q[0] * this.fwd[0] + q[1] * this.fwd[1] + q[2] * this.fwd[2];
    if (z <= 0) return null;
    const t = Math.tan(FOV / 2);
    const x = (q[0] * this.right[0] + q[1] * this.right[1] + q[2] * this.right[2]) / (z * t * (w / h));
    const y = (q[0] * this.up[0] + q[1] * this.up[1] + q[2] * this.up[2]) / (z * t);
    return [(w / 2) * (1 + x), (h / 2) * (1 - y)];
  }

  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickSize = '';

  /** Surface point under a screen position (pickable meshes only), read back from the GPU. */
  pickAt(x: number, y: number): { p: Vec3; mesh: ViewerMesh } | null {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const gl = this.gl;
    const pickable = this.meshes.filter((m) => m.pickable && m.visible !== false);
    if (!pickable.length) return null;
    const ray = pixelRay(x, y, w, h, this.camPos(), this.right, this.up, this.fwd, FOV);
    if (!gl || !this.mg) {
      // no WebGL: CPU ray test
      let best: { p: Vec3; mesh: ViewerMesh; t: number } | null = null;
      for (const m of pickable) {
        const hit = rayMesh(m.pos, m.idx, ray.o, ray.d);
        if (hit && (!best || hit.t < best.t)) best = { p: hit.p, mesh: m, t: hit.t };
      }
      return best;
    }
    const W = this.canvas.width, H = this.canvas.height;
    const size = `${W}x${H}`;
    if (!this.pickFbo) {
      this.pickFbo = gl.createFramebuffer();
      this.pickTex = gl.createTexture();
      this.pickDepth = gl.createRenderbuffer();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    if (size !== this.pickSize) {
      gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
      this.pickSize = size;
    }
    const px = Math.min(W - 1, Math.max(0, Math.floor((x / w) * W)));
    const py = Math.min(H - 1, Math.max(0, H - 1 - Math.floor((y / h) * H)));
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px, py, 1, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const pos = this.camPos();
    const far = this.dist * 20;
    const mvp = viewProjection(pos, this.right, this.up, this.fwd, FOV, w / h, Math.max(0.1, this.dist * 0.01), far);
    pickable.forEach((m, i) => drawPick(this.mg!, m.key, mvp, pos, far, i + 1));
    const px4 = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!px4[3]) return null;
    const d = ((px4[0] * 65536 + px4[1] * 256 + px4[2]) / 16777215) * far;
    return { p: [pos[0] + ray.d[0] * d, pos[1] + ray.d[1] * d, pos[2] + ray.d[2] * d], mesh: pickable[px4[3] - 1] };
  }

  private bind() {
    const el = this.el;
    let drag: { btn: number; x: number; y: number; moved: boolean; erase: boolean; grab: boolean } | null = null;
    let grabQueued: PointerEvent | null = null;
    const local = (e: PointerEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      drag = { btn: e.button, x: e.clientX, y: e.clientY, moved: false, erase: e.altKey || (e.button === 0 && e.ctrlKey), grab: false };
      if (this.lassoMode && e.button === 0) {
        this.lasso = [local(e)];
        this.request();
      } else if (this.paintMode && e.button === 0) this.paintAt(e, drag.erase);
      else if (e.button === 0 && !e.shiftKey && this.onGrab) {
        const hit = this.pickAt(...local(e));
        if (hit && this.onGrab(hit.p)) drag.grab = true;
      }
    });
    let paintQueued: PointerEvent | null = null;
    let hoverQueued: PointerEvent | null = null;
    const hoverRing = (e: PointerEvent) => {
      if (!this.paintMode || !this.brushRadius) {
        if (this.ring) {
          this.ring = null;
          this.request();
        }
        return;
      }
      if (!hoverQueued)
        requestAnimationFrame(() => {
          const ev = hoverQueued;
          hoverQueued = null;
          if (!ev) return;
          this.ring = this.pickAt(...local(ev))?.p ?? null;
          this.request();
        });
      hoverQueued = e;
    };
    el.addEventListener('pointerleave', () => {
      this.ring = null;
      this.request();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || (this.paintMode && drag.btn === 0)) hoverRing(e);
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.grab) {
        // slide the grabbed item along the surface (one pick per frame)
        if (!drag.moved) return;
        if (!grabQueued)
          requestAnimationFrame(() => {
            const ev = grabQueued;
            grabQueued = null;
            if (!ev || !drag?.grab) return;
            const hit = this.pickAt(...local(ev));
            if (hit) this.onGrabMove?.(hit.p);
          });
        grabQueued = e;
        return;
      }
      if (this.lassoMode && drag.btn === 0) {
        if (this.lasso) {
          const q = local(e), last = this.lasso[this.lasso.length - 1];
          if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 2) this.lasso.push(q);
          this.request();
        }
        return;
      }
      if (this.paintMode && drag.btn === 0) {
        if (!paintQueued) {
          paintQueued = e;
          requestAnimationFrame(() => {
            if (paintQueued) this.paintAt(paintQueued, drag?.erase ?? false);
            paintQueued = null;
          });
        } else paintQueued = e;
        return;
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      const orbit = this.paintMode || this.lassoMode ? drag.btn === 2 : drag.btn === 0 && !e.shiftKey;
      if (orbit) {
        // orbit around the target
        const a = 0.006;
        let f = rotate(this.fwd, this.up, -dx * a);
        let r = rotate(this.right, this.up, -dx * a);
        f = rotate(f, r, -dy * a);
        const u = rotate(this.up, r, -dy * a);
        this.fwd = normalize(f);
        this.right = normalize(r);
        this.up = normalize(u);
      } else {
        // pan (middle button; right button / Shift+left when not painting)
        const s = (this.dist * Math.tan(FOV / 2) * 2) / Math.max(1, el.clientHeight);
        for (let k = 0; k < 3; k++) this.target[k] -= (this.right[k] * dx - this.up[k] * dy) * s;
      }
      this.request();
    });
    el.addEventListener('pointerup', (e) => {
      if (this.lasso) {
        const poly = this.lasso;
        this.lasso = null;
        this.request();
        drag = null;
        if (poly.length >= 3) this.onLasso?.(poly);
        return;
      }
      if (drag?.grab) {
        grabQueued = null;
        if (drag.moved) {
          this.onGrabEnd?.();
          drag = null;
          return;
        }
      }
      if (drag && drag.btn === 0 && this.paintMode) this.onPaintEnd?.();
      if (drag && !drag.moved && drag.btn === 0 && !this.paintMode && this.onPick) {
        const r = el.getBoundingClientRect();
        const hit = this.pickAt(e.clientX - r.left, e.clientY - r.top);
        if (hit) this.onPick(hit.p, hit.mesh);
      }
      drag = null;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (performance.now() < MeshViewer.wheelBlockedUntil) return;
        // Ctrl / Cmd + wheel (and trackpad pinch) always zooms
        if (!e.ctrlKey && !e.metaKey && this.onWheel?.(Math.sign(e.deltaY), e)) return;
        this.dist *= Math.exp(Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100) * 0.12);
        this.request();
      },
      { passive: false },
    );
  }

  private paintAt(e: PointerEvent, erase: boolean) {
    const r = this.el.getBoundingClientRect();
    const hit = this.pickAt(e.clientX - r.left, e.clientY - r.top);
    if (hit && this.onPaint) this.onPaint(hit.p, hit.mesh, erase);
  }
}
