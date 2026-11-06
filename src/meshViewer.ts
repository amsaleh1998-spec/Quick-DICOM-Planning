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
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ov: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private mg: MeshGL | null = null;
  meshes: ViewerMesh[] = [];
  markers: Marker[] = [];
  /** left button paints instead of orbiting */
  paintMode = false;
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
    let drag: { btn: number; x: number; y: number; moved: boolean; erase: boolean } | null = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      drag = { btn: e.button, x: e.clientX, y: e.clientY, moved: false, erase: e.altKey || e.button === 0 && e.ctrlKey };
      if (this.paintMode && e.button === 0) this.paintAt(e, drag.erase);
    });
    let paintQueued: PointerEvent | null = null;
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
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
      const orbit = this.paintMode ? drag.btn === 2 : drag.btn === 0 && !e.shiftKey;
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
