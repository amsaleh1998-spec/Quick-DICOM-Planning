// WebGL2 renderer for triangle meshes (intraoral scans, CBCT surfaces in the alignment view).
// Two-sided headlight shading, optional vertex colours, per-draw colour / opacity.

import type { Vec3 } from './math';

const VS = `#version 300 es
in vec3 aPos;
in vec3 aNrm;
in vec3 aCol;
uniform mat4 uMVP;
out vec3 vPos;
out vec3 vNrm;
out vec3 vCol;
void main() {
  vPos = aPos;
  vNrm = aNrm;
  vCol = aCol;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNrm;
in vec3 vCol;
uniform vec3 uEye;
uniform vec3 uColor;
uniform float uOpacity;
uniform int uUseVertexColor;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNrm);
  vec3 L = normalize(uEye - vPos);
  float d = dot(n, L);
  // two-sided: scans are open surfaces; back faces a little darker
  float diff = abs(d) * (d < 0.0 ? 0.75 : 1.0);
  vec3 base = uUseVertexColor == 1 ? vCol : uColor;
  vec3 h = normalize(L + L);
  float spec = pow(max(abs(dot(n, h)), 0.0), 40.0) * 0.18;
  outColor = vec4(base * (0.28 + 0.72 * diff) + spec, uOpacity);
}`;

// picking: distance from the eye packed into rgb (24 bit), mesh id in alpha
const PICK_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNrm;
in vec3 vCol;
uniform vec3 uEye;
uniform float uFar;
uniform float uId;
out vec4 outColor;
void main() {
  float v = floor(clamp(length(vPos - uEye) / uFar, 0.0, 1.0) * 16777215.0);
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  outColor = vec4(r / 255.0, g / 255.0, b / 255.0, uId / 255.0);
}`;

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  bufs: WebGLBuffer[];
  colBuf: WebGLBuffer;
  count: number;
  hasCol: boolean;
}

export class MeshGL {
  private prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private pickProg: WebGLProgram;
  private pickLoc: Record<string, WebGLUniformLocation | null> = {};
  private meshes = new Map<unknown, GpuMesh>();

  constructor(readonly gl: WebGL2RenderingContext) {
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'mesh shader error');
      return sh;
    };
    const link = (fs: string) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.bindAttribLocation(p, 1, 'aNrm');
      gl.bindAttribLocation(p, 2, 'aCol');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'mesh link error');
      return p;
    };
    this.prog = link(FS);
    for (const n of ['uMVP', 'uEye', 'uColor', 'uOpacity', 'uUseVertexColor']) this.loc[n] = gl.getUniformLocation(this.prog, n);
    this.pickProg = link(PICK_FS);
    for (const n of ['uMVP', 'uEye', 'uFar', 'uId']) this.pickLoc[n] = gl.getUniformLocation(this.pickProg, n);
  }

  has(key: unknown) {
    return this.meshes.has(key);
  }

  /** Upload (or replace) a mesh. Colours: rgb bytes per vertex, or null. */
  upload(key: unknown, pos: Float32Array, nrm: Float32Array, idx: Uint32Array, col: Uint8Array | null) {
    this.delete(key);
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attr = (loc: number, data: ArrayBufferView, size: number, type: number, normalized: boolean) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
      return b;
    };
    const b0 = attr(0, pos, 3, gl.FLOAT, false);
    const b1 = attr(1, nrm, 3, gl.FLOAT, false);
    const colData = col ?? new Uint8Array(pos.length).fill(200);
    const b2 = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b2);
    gl.bufferData(gl.ARRAY_BUFFER, colData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    const bi = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bi);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshes.set(key, { vao, bufs: [b0, b1, b2, bi], colBuf: b2, count: idx.length, hasCol: !!col });
  }

  /** Replace the per-vertex colours (e.g. painted selection). */
  updateColors(key: unknown, col: Uint8Array) {
    const m = this.meshes.get(key);
    if (!m) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.colBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, col);
    m.hasCol = true;
  }

  delete(key: unknown) {
    const m = this.meshes.get(key);
    if (!m) return;
    const gl = this.gl;
    gl.deleteVertexArray(m.vao);
    for (const b of m.bufs) gl.deleteBuffer(b);
    this.meshes.delete(key);
  }

  /** Drop meshes whose keys are not in `keep`. */
  prune(keep: Set<unknown>) {
    for (const k of [...this.meshes.keys()]) if (!keep.has(k)) this.delete(k);
  }

  pickDraw(key: unknown, mvp: Float32Array, eye: Vec3, far: number, id: number) {
    const m = this.meshes.get(key);
    if (!m) return;
    const gl = this.gl;
    gl.useProgram(this.pickProg);
    gl.uniformMatrix4fv(this.pickLoc.uMVP, false, mvp);
    gl.uniform3fv(this.pickLoc.uEye, eye);
    gl.uniform1f(this.pickLoc.uFar, far);
    gl.uniform1f(this.pickLoc.uId, id);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  draw(key: unknown, mvp: Float32Array, eye: Vec3, opts: { color: [number, number, number]; opacity: number; vertexColors: boolean }) {
    const m = this.meshes.get(key);
    if (!m) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMVP, false, mvp);
    gl.uniform3fv(this.loc.uEye, eye);
    gl.uniform3f(this.loc.uColor, opts.color[0] / 255, opts.color[1] / 255, opts.color[2] / 255);
    gl.uniform1f(this.loc.uOpacity, opts.opacity);
    gl.uniform1i(this.loc.uUseVertexColor, opts.vertexColors && m.hasCol ? 1 : 0);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}

/** Draw a mesh into the current (pick) target: distance from the eye / far, and the id (1..255). */
export function drawPick(mg: MeshGL, key: unknown, mvp: Float32Array, eye: Vec3, far: number, id: number) {
  (mg as unknown as { pickDraw: (k: unknown, m: Float32Array, e: Vec3, f: number, i: number) => void }).pickDraw(key, mvp, eye, far, id);
}

/** Column-major view-projection for a camera given by position and right/up/forward vectors. */
export function viewProjection(pos: Vec3, right: Vec3, up: Vec3, fwd: Vec3, fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  // view matrix rows: right, up, -fwd
  const V = [
    [right[0], right[1], right[2], -(right[0] * pos[0] + right[1] * pos[1] + right[2] * pos[2])],
    [up[0], up[1], up[2], -(up[0] * pos[0] + up[1] * pos[1] + up[2] * pos[2])],
    [-fwd[0], -fwd[1], -fwd[2], fwd[0] * pos[0] + fwd[1] * pos[1] + fwd[2] * pos[2]],
    [0, 0, 0, 1],
  ];
  const P = [
    [f / aspect, 0, 0, 0],
    [0, f, 0, 0],
    [0, 0, (far + near) / (near - far), (2 * far * near) / (near - far)],
    [0, 0, -1, 0],
  ];
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += P[r][k] * V[k][c];
      out[c * 4 + r] = s; // column-major
    }
  return out;
}

/** Orthographic-free picking: ray through a pixel of a perspective camera. */
export function pixelRay(px: number, py: number, w: number, h: number, pos: Vec3, right: Vec3, up: Vec3, fwd: Vec3, fovY: number): { o: Vec3; d: Vec3 } {
  const t = Math.tan(fovY / 2);
  const nx = (2 * px) / w - 1;
  const ny = 1 - (2 * py) / h;
  const a = w / Math.max(1, h);
  const d: Vec3 = [
    fwd[0] + right[0] * nx * t * a + up[0] * ny * t,
    fwd[1] + right[1] * nx * t * a + up[1] * ny * t,
    fwd[2] + right[2] * nx * t * a + up[2] * ny * t,
  ];
  const l = Math.hypot(d[0], d[1], d[2]);
  return { o: pos, d: [d[0] / l, d[1] / l, d[2] / l] };
}

/** Nearest triangle hit along a ray (Möller–Trumbore), or null. Returns the hit point and triangle. */
export function rayMesh(pos: Float32Array, idx: Uint32Array, o: Vec3, d: Vec3): { p: Vec3; t: number; tri: number } | null {
  let best = Infinity;
  let bestTri = -1;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const tx = o[0] - pos[a], ty = o[1] - pos[a + 1], tz = o[2] - pos[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt > 1e-6 && tt < best) {
      best = tt;
      bestTri = t / 3;
    }
  }
  if (bestTri < 0) return null;
  return { p: [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best], t: best, tri: bestTri };
}
