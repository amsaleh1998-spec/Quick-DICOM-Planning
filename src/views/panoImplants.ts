// Implants in the panoramic, in its two modes:
// - Slice: what the curved panoramic surface cuts of each implant and abutment, drawn exactly as the
//   cross-sections draw it (the filled section with its outline – threads and all for library
//   implants; the tinted cone for the others).
// - Slab: every implant (and abutment) whole, as a shaded 3D model over the image, seen from the
//   buccal side along the curve's normal (rendered with WebGL into a small sprite per implant).

import type { App } from '../app';
import type { ArchCurve } from '../curve';
import { ABUTMENT_COLOR, ABUTMENT_SELECTED_COLOR, Cylinder, IMPLANT_COLOR, IMPLANT_SELECTED_COLOR, Implant, PROSTHETIC_COLOR, platformOf } from '../implant';
import { libraryShape, meshOf, meshWorld } from '../implantLibrary';
import { Frame, Vec3, addScaled, cross, normalize, scale as scaleV } from '../math';
import { segmentLoops } from './implantSections';
import { nearestGrid } from './scanContours';

type RGB = [number, number, number];

// ---- the solids ------------------------------------------------------------------------------

export interface Solid {
  /** world vertex positions */
  pos: Float32Array;
  idx: Uint32Array;
  color: RGB;
  kind: 'implant' | 'abutment';
}

/** Colour of a part, as the slices draw it. */
export function partColor(app: App, part: Cylinder): RGB {
  const sel = part.implant.id === app.selectedId;
  if (part.kind === 'implant') return sel ? IMPLANT_SELECTED_COLOR : IMPLANT_COLOR;
  if (part.kind === 'prosthetic') return PROSTHETIC_COLOR;
  return sel ? ABUTMENT_SELECTED_COLOR : ABUTMENT_COLOR;
}

/** A closed tapered solid for a generic implant or an abutment part. */
const frustumCache = new Map<string, { pos: Float32Array; idx: Uint32Array }>();
function frustum(part: Cylinder): { pos: Float32Array; idx: Uint32Array } {
  const key = [part.center, part.axis, part.half, part.r0, part.r1].flat().map((v) => v.toFixed(4)).join(',');
  const hit = frustumCache.get(key);
  if (hit) return hit;
  const N = 48;
  const a = normalize(part.axis);
  const e1 = normalize(Math.abs(a[2]) < 0.9 ? cross(a, [0, 0, 1]) : cross(a, [1, 0, 0]));
  const e2 = cross(a, e1);
  // rings: +half (r1) and -half (r0), twice each (sides and caps get their own normals)
  const ring = (h: number, r: number): Vec3[] => {
    const c = addScaled(part.center, a, h);
    const out: Vec3[] = [];
    for (let i = 0; i < N; i++) {
      const t = (2 * Math.PI * i) / N;
      out.push(addScaled(addScaled(c, e1, r * Math.cos(t)), e2, r * Math.sin(t)));
    }
    return out;
  };
  const top = ring(part.half, part.r1), bot = ring(-part.half, part.r0);
  const pts: Vec3[] = [...top, ...bot, ...top, ...bot, addScaled(part.center, a, part.half), addScaled(part.center, a, -part.half)];
  const idx: number[] = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(i, N + i, j, j, N + i, N + j); // side
    idx.push(4 * N, 2 * N + j, 2 * N + i); // +half cap
    idx.push(4 * N + 1, 3 * N + i, 3 * N + j); // -half cap
  }
  const out = { pos: Float32Array.from(pts.flat()), idx: Uint32Array.from(idx) };
  if (frustumCache.size > 200) frustumCache.clear();
  frustumCache.set(key, out);
  return out;
}

/** The solids of an implant: its body (library mesh or tapered solid) and its abutment parts. */
export function implantSolids(app: App, imp: Implant, parts: Cylinder[]): Solid[] {
  const out: Solid[] = [];
  for (const part of parts) {
    if (part.implant !== imp || part.kind === 'prosthetic') continue;
    if (part.kind === 'implant' && imp.lib) {
      const m = meshOf(imp.lib.id);
      if (m) out.push({ pos: meshWorld(imp, m, platformOf(imp), imp.axis), idx: m.idx, color: partColor(app, part), kind: 'implant' });
      else if (libraryShape(imp.lib.id) !== 'pending') out.push({ ...frustum(part), color: partColor(app, part), kind: 'implant' });
      continue;
    }
    out.push({ ...frustum(part), color: partColor(app, part), kind: part.kind === 'implant' ? 'implant' : 'abutment' });
  }
  return out;
}

// ---- slice: the cut of the curved surface ---------------------------------------------------

/** Arc length, height and offset from the curve of every vertex (cached per vertex array). */
const panoCache = new WeakMap<Float32Array, { key: string; s: Float32Array; c: Float32Array; off: Float32Array }>();
function panoCoords(pos: Float32Array, curve: ArchCurve, O: Vec3, F: Frame) {
  const key = JSON.stringify([curve.ctrl, O, F]);
  const hit = panoCache.get(pos);
  if (hit && hit.key === key) return hit;
  const nv = pos.length / 3;
  const S = new Float32Array(nv), C = new Float32Array(nv), OFF = new Float32Array(nv);
  const grid = nearestGrid(curve, 0.75, 20);
  for (let i = 0; i < nv; i++) {
    const qx = pos[i * 3] - O[0], qy = pos[i * 3 + 1] - O[1], qz = pos[i * 3 + 2] - O[2];
    const a = qx * F[0][0] + qy * F[0][1] + qz * F[0][2];
    const b = qx * F[1][0] + qy * F[1][1] + qz * F[1][2];
    C[i] = qx * F[2][0] + qy * F[2][1] + qz * F[2][2];
    const sv = grid.s(a, b);
    if (Number.isNaN(sv)) {
      S[i] = OFF[i] = NaN;
      continue;
    }
    const cp = curve.at(sv);
    S[i] = sv + (a - cp.p[0]) * cp.t[0] + (b - cp.p[1]) * cp.t[1];
    OFF[i] = (a - cp.p[0]) * cp.n[0] + (b - cp.p[1]) * cp.n[1];
  }
  const out = { key, s: S, c: C, off: OFF };
  panoCache.set(pos, out);
  return out;
}

/** The section of a solid with the panoramic surface at `offset`: screen segments x0 y0 x1 y1 … */
function cutSegments(sd: Solid, curve: ArchCurve, O: Vec3, F: Frame, offset: number, xOf: (s: number) => number, yOf: (c: number) => number): Float32Array {
  const { s: S, c: C, off: OFF } = panoCoords(sd.pos, curve, O, F);
  const idx = sd.idx;
  const seg: number[] = [];
  const pt = (a: number, b: number) => {
    const da = OFF[a] - offset, db = OFF[b] - offset;
    const t = da / (da - db);
    seg.push(xOf(S[a] + (S[b] - S[a]) * t), yOf(C[a] + (C[b] - C[a]) * t));
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (Number.isNaN(S[a] + S[b] + S[c])) continue;
    const sa = OFF[a] > offset, sb = OFF[b] > offset, sc = OFF[c] > offset;
    if (sa === sb && sb === sc) continue;
    if (sa === sb) {
      pt(c, a);
      pt(c, b);
    } else if (sa === sc) {
      pt(b, a);
      pt(b, c);
    } else {
      pt(a, b);
      pt(a, c);
    }
  }
  return Float32Array.from(seg);
}

const css = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Slice mode: the cut of every implant and abutment, filled and outlined like in the cross-sections. */
export function drawPanoCuts(app: App, o: CanvasRenderingContext2D, xOf: (s: number) => number, yOf: (c: number) => number) {
  const curve = app.curve;
  if (!curve) return;
  const parts = app.allParts();
  for (const imp of app.implants) {
    if (imp.hidden) continue;
    for (const sd of implantSolids(app, imp, parts)) {
      const seg = cutSegments(sd, curve, app.O, app.frame, app.panoOffset, xOf, yOf);
      if (!seg.length) continue;
      o.beginPath();
      for (const l of segmentLoops(seg)) {
        o.moveTo(l[0], l[1]);
        for (let i = 2; i < l.length; i += 2) o.lineTo(l[i], l[i + 1]);
        o.closePath();
      }
      o.fillStyle = css(sd.color, sd.kind === 'implant' ? 0.32 : 0.45);
      o.fill('evenodd');
      o.lineWidth = 1.5;
      o.lineJoin = 'round';
      o.strokeStyle = css(sd.color, 0.95);
      o.stroke();
    }
  }
}

// ---- slab: the implants whole, shaded --------------------------------------------------------

const VS = `#version 300 es
in vec3 aPos;
in vec3 aNrm;
uniform mat4 uMVP;
out vec3 vNrm;
void main() {
  vNrm = aNrm;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;
// metal: a key light from the viewer's upper left, a soft fill, a tight highlight and a rim
const FS = `#version 300 es
precision highp float;
in vec3 vNrm;
uniform vec3 uColor;
uniform vec3 uView;   // towards the viewer
uniform vec3 uKey;    // towards the key light
out vec4 outColor;
void main() {
  vec3 n = normalize(vNrm);
  if (dot(n, uView) < 0.0) n = -n;
  // machined metal in the implant's colour: a strong key light across the body, a little fill,
  // tight highlights on the thread crests and a darker rim, so the shape and threads read
  vec3 base = mix(uColor, vec3(0.78), 0.28);
  float key = max(dot(n, uKey), 0.0);
  float fill = max(dot(n, uView), 0.0);
  vec3 h = normalize(uKey + uView);
  float spec = pow(max(dot(n, h), 0.0), 36.0);
  float rim = pow(1.0 - fill, 2.0);
  vec3 c = base * (0.10 + 0.78 * key + 0.22 * fill) * (1.0 - 0.45 * rim) + vec3(0.65) * spec;
  outColor = vec4(min(c, vec3(1.0)), 1.0);
}`;

class SpriteRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private buf = new Map<Float32Array, { vao: WebGLVertexArrayObject; bufs: WebGLBuffer[]; count: number; idx: Uint32Array }>();

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('no WebGL2');
    this.gl = gl;
    const sh = (t: number, s: string) => {
      const x = gl.createShader(t)!;
      gl.shaderSource(x, s);
      gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? 'shader');
      return x;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aNrm');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    for (const n of ['uMVP', 'uColor', 'uView', 'uKey']) this.loc[n] = gl.getUniformLocation(p, n);
  }

  /** GPU buffers of a solid (smooth vertex normals), kept while the vertex array is in use. */
  private mesh(sd: Solid) {
    const hit = this.buf.get(sd.pos);
    if (hit && hit.idx === sd.idx) return hit;
    const gl = this.gl;
    const { pos, idx } = sd;
    const nrm = new Float32Array(pos.length);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        nrm[v] += nx;
        nrm[v + 1] += ny;
        nrm[v + 2] += nz;
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attr = (loc: number, data: Float32Array) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      return b;
    };
    const b0 = attr(0, pos), b1 = attr(1, nrm);
    const bi = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bi);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const m = { vao, bufs: [b0, b1, bi], count: idx.length, idx };
    if (hit) this.free(sd.pos);
    this.buf.set(sd.pos, m);
    return m;
  }

  private free(key: Float32Array) {
    const m = this.buf.get(key);
    if (!m) return;
    this.gl.deleteVertexArray(m.vao);
    for (const b of m.bufs) this.gl.deleteBuffer(b);
    this.buf.delete(key);
  }

  /** Drop buffers of solids no longer drawn. */
  prune(keep: Set<Float32Array>) {
    for (const k of [...this.buf.keys()]) if (!keep.has(k)) this.free(k);
  }

  /**
   * Render solids with an orthographic camera at `center` (right, up, towards-viewer axes, mm per
   * pixel `mmPx`) into a `pw`×`ph` px image (device pixels). Returns the canvas holding it.
   */
  render(solids: Solid[], center: Vec3, right: Vec3, up: Vec3, toViewer: Vec3, mmPx: number, pw: number, ph: number, depth: number): HTMLCanvasElement {
    const gl = this.gl;
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    // ortho: x = right·(p-c) / (pw/2·mmPx), y = up·(p-c) / (ph/2·mmPx), z = -toViewer·(p-c) / depth
    const sx = 2 / (pw * mmPx), sy = 2 / (ph * mmPx), sz = -1 / depth;
    const row = (v: Vec3, k: number): [number, number, number, number] => [v[0] * k, v[1] * k, v[2] * k, -(v[0] * center[0] + v[1] * center[1] + v[2] * center[2]) * k];
    const R = row(right, sx), U = row(up, sy), Z = row(toViewer, sz);
    // column-major
    const mvp = new Float32Array([R[0], U[0], Z[0], 0, R[1], U[1], Z[1], 0, R[2], U[2], Z[2], 0, R[3], U[3], Z[3], 1]);
    gl.uniformMatrix4fv(this.loc.uMVP, false, mvp);
    gl.uniform3fv(this.loc.uView, toViewer);
    const key = normalize(addScaled(addScaled(scaleV(toViewer, 0.7), up, 0.55), right, -0.75));
    gl.uniform3fv(this.loc.uKey, key);
    for (const sd of solids) {
      const m = this.mesh(sd);
      gl.uniform3f(this.loc.uColor, sd.color[0] / 255, sd.color[1] / 255, sd.color[2] / 255);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
    return this.canvas;
  }
}

let renderer: SpriteRenderer | null | undefined;
function getRenderer(): SpriteRenderer | null {
  if (renderer === undefined) {
    try {
      renderer = new SpriteRenderer();
    } catch {
      renderer = null; // no WebGL: the outline is drawn instead
    }
  }
  return renderer;
}

/**
 * Slab mode: each implant (with its abutment) as a shaded 3D model, seen along the curve's normal
 * at the implant. `place(w)` maps a world point to the panoramic (screen px); `mmPx` = mm per
 * screen px; `dpr` = device pixels per screen px. Returns false where 3D could not be drawn.
 */
export function drawPanoSolids(
  app: App,
  o: CanvasRenderingContext2D,
  place: (w: Vec3) => { x: number; y: number; s: number },
  mmPx: number,
  dpr: number,
): boolean {
  const curve = app.curve;
  if (!curve) return true;
  const r = getRenderer();
  if (!r) return false;
  const parts = app.allParts();
  const F = app.frame;
  const keep = new Set<Float32Array>();
  for (const imp of app.implants) {
    if (imp.hidden) continue;
    const solids = implantSolids(app, imp, parts);
    if (!solids.length) continue;
    for (const sd of solids) keep.add(sd.pos);
    // bounds of the implant and its abutment
    let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const sd of solids)
      for (let i = 0; i < sd.pos.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], sd.pos[i + k]);
          max[k] = Math.max(max[k], sd.pos[i + k]);
        }
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const half = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 + 0.5;
    // the panoramic's own directions at the implant: along the curve, up, and towards the viewer (buccal)
    const pc = place(center);
    const cp = curve.at(pc.s);
    const right: Vec3 = normalize([F[0][0] * cp.t[0] + F[1][0] * cp.t[1], F[0][1] * cp.t[0] + F[1][1] * cp.t[1], F[0][2] * cp.t[0] + F[1][2] * cp.t[1]]);
    const toViewer: Vec3 = normalize([F[0][0] * cp.n[0] + F[1][0] * cp.n[1], F[0][1] * cp.n[0] + F[1][1] * cp.n[1], F[0][2] * cp.n[0] + F[1][2] * cp.n[1]]);
    const up: Vec3 = F[2];
    const sizeCss = (2 * half) / mmPx;
    const px = Math.max(8, Math.min(2048, Math.round(sizeCss * dpr)));
    const img = r.render(solids, center, right, up, toViewer, (2 * half) / px, px, px, half * 2);
    o.drawImage(img, pc.x - sizeCss / 2, pc.y - sizeCss / 2, sizeCss, sizeCss);
  }
  r.prune(keep);
  return true;
}
