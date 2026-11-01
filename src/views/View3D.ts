import type { App } from '../app';
import { ABUTMENT_COLOR, ABUTMENT_SELECTED_COLOR, IMPLANT_COLOR, IMPLANT_SELECTED_COLOR, PROSTHETIC_COLOR } from '../implant';
import { Frame, Vec3, add, cross, dot, fromFrame, neg, reorthonormalize, rotate, scale } from '../math';
import { Volume } from '../volume';
import { Pt, View, drawLabel } from './View';

const MAX_CYL = 48;
const FOV = (30 * Math.PI) / 180;

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform vec3 uTexScale, uTexOffset, uTexel, uBoxMax;
uniform vec3 uCam, uRight, uUp, uFwd;
uniform float uTanHalf;
uniform vec2 uRes;
uniform mat3 uFrame;
uniform vec3 uOrigin, uCropMin, uCropMax;
uniform float uLo, uHi, uStep, uOpac, uWC, uWW;
uniform int uMode;
uniform int uNumCyl;
uniform vec4 uCyl[${MAX_CYL * 3}];
out vec4 outColor;

float vol(vec3 p) { return texture(uVol, p * uTexScale + uTexOffset).r; }
vec3 grad(vec3 p) {
  vec3 tc = p * uTexScale + uTexOffset;
  vec3 g = vec3(
    texture(uVol, tc + vec3(uTexel.x, 0.0, 0.0)).r - texture(uVol, tc - vec3(uTexel.x, 0.0, 0.0)).r,
    texture(uVol, tc + vec3(0.0, uTexel.y, 0.0)).r - texture(uVol, tc - vec3(0.0, uTexel.y, 0.0)).r,
    texture(uVol, tc + vec3(0.0, 0.0, uTexel.z)).r - texture(uVol, tc - vec3(0.0, 0.0, uTexel.z)).r);
  return g * (uTexScale / uTexel);
}
vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
float dot2(vec3 v) { return dot(v, v); }
// capped cone, radius ra at pa and rb at pb (Inigo Quilez); returns (t, normal)
vec4 coneHit(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float ra, float rb) {
  vec3 ba = pb - pa;
  vec3 oa = ro - pa;
  vec3 ob = ro - pb;
  float m0 = dot(ba, ba);
  float m1 = dot(oa, ba);
  float m2 = dot(rd, ba);
  float m3 = dot(rd, oa);
  float m5 = dot(oa, oa);
  float m9 = dot(ob, ba);
  if (m1 < 0.0) {
    if (dot2(oa * m2 - rd * m1) < (ra * ra * m2 * m2)) return vec4(-m1 / m2, -ba * inversesqrt(m0));
  } else if (m9 > 0.0) {
    float t = -m9 / m2;
    if (dot2(ob + rd * t) < (rb * rb)) return vec4(t, ba * inversesqrt(m0));
  }
  float rr = ra - rb;
  float hy = m0 + rr * rr;
  float k2 = m0 * m0 - m2 * m2 * hy;
  float k1 = m0 * m0 * m3 - m1 * m2 * hy + m0 * ra * (rr * m2);
  float k0 = m0 * m0 * m5 - m1 * m1 * hy + m0 * ra * (rr * m1 * 2.0 - m0 * ra);
  float h = k1 * k1 - k2 * k0;
  if (h < 0.0) return vec4(-1.0);
  float t = (-k1 - sqrt(h)) / k2;
  float y = m1 + t * m2;
  if (y < 0.0 || y > m0) return vec4(-1.0);
  return vec4(t, normalize(m0 * (m0 * (oa + t * rd) + rr * ba * ra) - ba * hy * y));
}
vec3 shade(vec3 base, vec3 n, vec3 rd, vec3 L, float specK) {
  if (dot(n, rd) > 0.0) n = -n;
  float diff = max(dot(n, L), 0.0);
  vec3 H = normalize(L - rd);
  float spec = pow(max(dot(n, H), 0.0), 40.0) * specK;
  return base * (0.22 + 0.78 * diff) + spec;
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  float aspect = uRes.x / uRes.y;
  vec3 rd = normalize(uFwd + ndc.x * uTanHalf * aspect * uRight + ndc.y * uTanHalf * uUp);
  vec3 ro = uCam;
  vec3 bg = mix(vec3(0.02, 0.03, 0.05), vec3(0.10, 0.13, 0.19), gl_FragCoord.y / uRes.y);
  vec3 L = normalize(-rd + 0.35 * uUp - 0.25 * uRight);

  // A = (centre, r0), B = (axis, half; negative = translucent guide), C = (colour, r1)
  float tImp = 1e20;
  vec3 nImp = vec3(0.0);
  vec3 cImp = vec3(0.0);
  float tGuide = 1e20;
  vec3 nGuide = vec3(0.0);
  vec3 cGuide = vec3(0.0);
  for (int i = 0; i < ${MAX_CYL}; i++) {
    if (i >= uNumCyl) break;
    vec4 A = uCyl[i * 3];
    vec4 B = uCyl[i * 3 + 1];
    vec4 C = uCyl[i * 3 + 2];
    float half_ = abs(B.w);
    vec4 h = coneHit(ro, rd, A.xyz - B.xyz * half_, A.xyz + B.xyz * half_, A.w, C.w);
    if (h.x <= 0.0) continue;
    if (B.w < 0.0) {
      if (h.x < tGuide) { tGuide = h.x; nGuide = h.yzw; cGuide = C.rgb; }
    } else if (h.x < tImp) { tImp = h.x; nImp = h.yzw; cImp = C.rgb; }
  }
  float tSurf = 1e20;

  vec2 b1 = boxHit(ro, rd, vec3(0.0), uBoxMax);
  mat3 Ft = transpose(uFrame);
  vec2 b2 = boxHit(Ft * (ro - uOrigin), Ft * rd, uCropMin, uCropMax);
  float tn = max(max(b1.x, b2.x), 0.0);
  float tf = min(min(b1.y, b2.y), tImp);
  vec4 acc = vec4(0.0);
  if (tn < tf) {
    if (uMode == 0) {
      float t = tn;
      bool hit = false;
      bool first = true;
      for (int i = 0; i < 4096; i++) {
        if (t > tf) break;
        float v = vol(ro + rd * t);
        if (v >= uLo && v <= uHi) { hit = true; break; }
        first = false;
        t += uStep;
      }
      if (hit) {
        vec3 n = -rd;
        if (!first) {
          float a = t - uStep;
          float b = t;
          for (int k = 0; k < 6; k++) {
            float m = 0.5 * (a + b);
            float v = vol(ro + rd * m);
            if (v >= uLo && v <= uHi) b = m; else a = m;
          }
          t = b;
          tSurf = t;
          vec3 g = grad(ro + rd * t);
          if (length(g) > 1e-6) n = -normalize(g);
        }
        acc = vec4(shade(vec3(0.93, 0.88, 0.79), n, rd, L, 0.25), 1.0);
      }
    } else if (uMode == 1) {
      float t = tn;
      for (int i = 0; i < 4096; i++) {
        if (t > tf || acc.a > 0.97) break;
        vec3 p = ro + rd * t;
        float v = vol(p);
        float a = clamp((v - uLo) / max(1.0, uHi - uLo), 0.0, 1.0);
        if (a > 0.0 && v <= uHi * 1.0001 + 1.0) {
          vec3 g = grad(p);
          vec3 n = length(g) > 1e-6 ? -normalize(g) : -rd;
          vec3 col = shade(mix(vec3(0.85, 0.55, 0.45), vec3(1.0, 0.97, 0.9), a), n, rd, L, 0.1);
          float al = min(1.0, (0.08 + a * a) * uOpac);
          acc.rgb += (1.0 - acc.a) * al * col;
          acc.a += (1.0 - acc.a) * al;
        }
        t += uStep;
      }
    } else {
      float m = -1e9;
      float t = tn;
      for (int i = 0; i < 4096; i++) {
        if (t > tf) break;
        m = max(m, vol(ro + rd * t));
        t += uStep;
      }
      float g = clamp((m - (uWC - uWW * 0.5)) / uWW, 0.0, 1.0);
      acc = vec4(vec3(g), g);
    }
  }
  vec3 col = acc.rgb;
  float rem = 1.0 - acc.a;
  if (rem > 0.0) {
    vec3 tail = bg;
    if (tImp < 1e19) tail = shade(cImp, nImp, rd, L, 0.45);
    col += rem * tail;
  }
  // prosthetic axis guides: translucent, in front of whatever they cover
  if (tGuide < min(tImp, tSurf)) col = mix(col, shade(cGuide, nGuide, rd, L, 0.3), 0.42);
  outColor = vec4(col, 1.0);
}`;

let halfLut: Uint16Array | null = null;
/** float16 bit patterns for every int16 value */
function getHalfLut(): Uint16Array {
  if (halfLut) return halfLut;
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  halfLut = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    f32[0] = i - 32768;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 127 + 15;
    const m = x & 0x7fffff;
    if (f32[0] === 0) halfLut[i] = 0;
    else if (e <= 0) halfLut[i] = sign;
    else if (e >= 31) halfLut[i] = sign | 0x7c00;
    else halfLut[i] = sign | (e << 10) | ((m + 0x1000) >> 13); // round
  }
  return halfLut;
}

type Preset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/** GPU ray-cast volume rendering with thresholds; implants are ray-traced cylinders. */
export class View3D extends View {
  private glCanvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private tex: WebGLTexture | null = null;
  private texVolId = -1;
  private texDims: [number, number, number] = [1, 1, 1];
  private texFactor = 1;
  private error = '';
  private lastKey = '';
  // camera basis (world)
  private right: Vec3 = [1, 0, 0];
  private up: Vec3 = [0, 0, 1];
  private fwd: Vec3 = [0, 1, 0];
  private target: Vec3 = [0, 0, 0];
  // draft quality while interacting
  private draft = false;
  private lastChange = 0;
  private refineTimer = 0;

  constructor(app: App) {
    super(app, '3D', '#9ad0ff');
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.className = 'img';
    this.imgCanvas.style.display = 'none';
    this.el.insertBefore(this.glCanvas, this.ovCanvas);
    this.shiftPans = true;
    try {
      this.gl = this.glCanvas.getContext('webgl2', { antialias: false, depth: false, alpha: false });
    } catch {
      this.gl = null;
    }
    if (!this.gl) this.error = 'WebGL2 is not available in this browser – 3D rendering disabled.';
    else this.initGl();
  }

  private initGl() {
    const gl = this.gl!;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
      return sh;
    };
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
      this.prog = p;
      const names = [
        'uVol', 'uTexScale', 'uTexOffset', 'uTexel', 'uBoxMax', 'uCam', 'uRight', 'uUp', 'uFwd', 'uTanHalf', 'uRes',
        'uFrame', 'uOrigin', 'uCropMin', 'uCropMax', 'uLo', 'uHi', 'uStep', 'uOpac', 'uWC', 'uWW', 'uMode', 'uNumCyl', 'uCyl',
      ];
      for (const n of names) this.uni[n] = gl.getUniformLocation(p, n);
      gl.bindVertexArray(gl.createVertexArray());
    } catch (e) {
      console.error(e);
      this.error = '3D shader failed to compile: ' + (e as Error).message;
    }
  }

  private uploadVolume(vol: Volume) {
    const gl = this.gl!;
    if (this.tex) gl.deleteTexture(this.tex);
    const maxDim = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    let f = 1;
    const dimsFor = (f: number): [number, number, number] => [Math.ceil(vol.nx / f), Math.ceil(vol.ny / f), Math.ceil(vol.nz / f)];
    while (true) {
      const d = dimsFor(f);
      if (d[0] * d[1] * d[2] <= 48_000_000 && Math.max(...d) <= maxDim) break;
      f++;
    }
    const [tx, ty, tz] = dimsFor(f);
    const lut = getHalfLut();
    const out = new Uint16Array(tx * ty * tz);
    const src = vol.data;
    const nx = vol.nx;
    const nxy = vol.nx * vol.ny;
    let o = 0;
    for (let k = 0; k < tz; k++) {
      for (let j = 0; j < ty; j++) {
        const row = k * f * nxy + j * f * nx;
        for (let i = 0; i < tx; i++) out[o++] = lut[src[row + i * f] + 32768];
      }
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, tx, ty, tz, 0, gl.RED, gl.HALF_FLOAT, out);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    this.tex = tex;
    this.texVolId = vol.id;
    this.texDims = [tx, ty, tz];
    this.texFactor = f;
  }

  // ---- camera ---------------------------------------------------------------

  /** Camera state for saving / restoring a project. */
  getCamera() {
    return { right: this.right, up: this.up, fwd: this.fwd, target: this.target };
  }

  setCamera(c: { right: Vec3; up: Vec3; fwd: Vec3; target: Vec3 }) {
    this.right = c.right;
    this.up = c.up;
    this.fwd = c.fwd;
    this.target = c.target;
    this.app.requestRender();
  }

  setPreset(p: Preset) {
    const F = this.app.frame;
    const [e1, e2, e3] = F;
    const presets: Record<Preset, [Vec3, Vec3]> = {
      front: [e2, e3],
      back: [neg(e2), e3],
      left: [neg(e1), e3],
      right: [e1, e3],
      top: [neg(e3), neg(e2)],
      bottom: [e3, neg(e2)],
    };
    const [fwd, up] = presets[p];
    this.fwd = fwd;
    this.up = up;
    this.right = cross(fwd, up);
    this.vs.panU = 0;
    this.vs.panV = 0;
    this.app.requestRender();
  }

  fit() {
    const app = this.app;
    if (!app.vol) return;
    const { min, max } = app.crop;
    this.target = fromFrame([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], app.O, app.frame);
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    this.vs.scale = (diag * 0.7) / Math.max(1, Math.min(this.w, this.h));
    this.setPreset('front');
  }

  private camera() {
    const dist = (this.h * this.vs.scale) / 2 / Math.tan(FOV / 2);
    const t = add(add(this.target, scale(this.right, this.vs.panU)), scale(this.up, -this.vs.panV));
    return { pos: add(t, scale(this.fwd, -dist)), target: t };
  }

  protected onLeftDown(): boolean {
    return true;
  }

  protected onLeftDrag(p: Pt, last: Pt) {
    this.orbit(p[0] - last[0], p[1] - last[1]);
  }

  /** Trackpad: two-finger swipe orbits (content follows the fingers). */
  protected onSwipe(dx: number, dy: number): boolean {
    this.orbit(-dx * 0.8, -dy * 0.8);
    return true;
  }

  private orbit(dx: number, dy: number) {
    const axis = this.app.frame[2];
    const a = -dx * 0.008;
    const b = -dy * 0.008;
    let f = rotate(this.fwd, axis, a);
    let u = rotate(this.up, axis, a);
    let r = rotate(this.right, axis, a);
    f = rotate(f, r, b);
    u = rotate(u, r, b);
    const fr = reorthonormalize([r, u, f] as Frame);
    // reorthonormalize keeps r exact, u orthogonal; fwd = r x u flipped for our convention
    this.right = fr[0];
    this.up = fr[1];
    this.fwd = neg(fr[2]);
    this.app.requestRender();
  }

  protected onScroll(dir: number, p: Pt) {
    this.zoomAt(p, Math.exp(dir * 0.12));
  }

  protected onDoubleClick() {
    this.fit();
  }

  protected geometryKey(): string | null {
    return null;
  }
  protected computeValues() {}
  protected drawOverlay() {}

  // ---- rendering ------------------------------------------------------------

  override render() {
    if (!this.visible) return;
    const app = this.app;
    const vol = app.vol;
    if (!this.vs.fitted && vol) {
      this.fit();
      this.vs.fitted = true;
    }
    const gl = this.gl;
    if (vol && gl && this.prog && !this.error) {
      if (this.texVolId !== vol.id) {
        try {
          this.uploadVolume(vol);
        } catch (e) {
          this.error = '3D upload failed: ' + (e as Error).message;
        }
      }
      const cam = this.camera();
      const base = JSON.stringify([
        vol.id, this.w, this.h, this.right, this.up, this.fwd, cam.pos, app.vr, app.crop, app.frame, app.O,
        app.vr.mode === 'mip' ? app.wl : 0, app.implantsKey(),
      ]);
      if (base !== this.lastKey) {
        const now = performance.now();
        if (this.lastKey && now - this.lastChange < 300) {
          this.draft = true;
          clearTimeout(this.refineTimer);
          this.refineTimer = window.setTimeout(() => {
            this.draft = false;
            this.lastKey = '';
            this.app.requestRender();
          }, 250);
        }
        this.lastChange = now;
        this.lastKey = base;
        this.draw(vol, cam);
      }
    } else if (gl) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.lastKey = '';
    }
    this.drawOverlay3d();
  }

  private draw(vol: Volume, cam: { pos: Vec3 }) {
    const gl = this.gl!;
    const app = this.app;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let ratio = Math.min(dpr, Math.sqrt(900_000 / Math.max(1, this.w * this.h)));
    if (this.draft) ratio *= 0.5;
    const W = Math.max(1, Math.round(this.w * ratio));
    const H = Math.max(1, Math.round(this.h * ratio));
    if (this.glCanvas.width !== W || this.glCanvas.height !== H) {
      this.glCanvas.width = W;
      this.glCanvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    const u = this.uni;
    const f = this.texFactor;
    const [tx, ty, tz] = this.texDims;
    const sp = vol.spacing;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.tex);
    gl.uniform1i(u.uVol, 0);
    gl.uniform3f(u.uTexScale, 1 / (sp[0] * f * tx), 1 / (sp[1] * f * ty), 1 / (sp[2] * f * tz));
    gl.uniform3f(u.uTexOffset, 0.5 / tx, 0.5 / ty, 0.5 / tz);
    gl.uniform3f(u.uTexel, 1 / tx, 1 / ty, 1 / tz);
    gl.uniform3f(u.uBoxMax, (tx - 1) * f * sp[0], (ty - 1) * f * sp[1], (tz - 1) * f * sp[2]);
    gl.uniform3fv(u.uCam, cam.pos);
    gl.uniform3fv(u.uRight, this.right);
    gl.uniform3fv(u.uUp, this.up);
    gl.uniform3fv(u.uFwd, this.fwd);
    gl.uniform1f(u.uTanHalf, Math.tan(FOV / 2));
    gl.uniform2f(u.uRes, W, H);
    const F = app.frame;
    gl.uniformMatrix3fv(u.uFrame, false, [...F[0], ...F[1], ...F[2]]);
    gl.uniform3fv(u.uOrigin, app.O);
    gl.uniform3fv(u.uCropMin, app.crop.min);
    gl.uniform3fv(u.uCropMax, app.crop.max);
    gl.uniform1f(u.uLo, app.vr.lo);
    gl.uniform1f(u.uHi, Math.max(app.vr.lo + 1, app.vr.hi));
    const step = Math.min(sp[0], sp[1], sp[2]) * f * (this.draft ? 1.2 : 0.6);
    gl.uniform1f(u.uStep, step);
    gl.uniform1f(u.uOpac, Math.min(1, (0.12 * step) / 0.3));
    gl.uniform1f(u.uWC, app.wl.center);
    gl.uniform1f(u.uWW, Math.max(1, app.wl.width));
    gl.uniform1i(u.uMode, app.vr.mode === 'surface' ? 0 : app.vr.mode === 'translucent' ? 1 : 2);
    const parts = app.allParts().slice(0, MAX_CYL);
    const cyl = new Float32Array(MAX_CYL * 12);
    parts.forEach((c, i) => {
      const sel = c.implant.id === app.selectedId;
      const col =
        c.kind === 'implant'
          ? sel
            ? IMPLANT_SELECTED_COLOR
            : IMPLANT_COLOR
          : c.kind === 'prosthetic'
            ? PROSTHETIC_COLOR
            : sel
              ? ABUTMENT_SELECTED_COLOR
              : ABUTMENT_COLOR;
      const half = c.kind === 'prosthetic' ? -c.half : c.half; // sign marks translucent guides
      cyl.set([...c.center, c.r0, ...c.axis, half, col[0] / 255, col[1] / 255, col[2] / 255, c.r1], i * 12);
    });
    gl.uniform1i(u.uNumCyl, parts.length);
    gl.uniform4fv(u.uCyl, cyl);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawOverlay3d() {
    const o = this.ovCtx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.ovCanvas.width, this.ovCanvas.height);
    o.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawTitle(o);
    const app = this.app;
    if (this.error || !app.vol) {
      o.fillStyle = '#8a94a6';
      o.font = '13px system-ui, sans-serif';
      o.textAlign = 'center';
      o.fillText(this.error || 'No volume loaded', this.w / 2, this.h / 2);
      o.textAlign = 'left';
      return;
    }
    const modeName = { surface: 'Surface', translucent: 'Translucent', mip: 'MIP' }[app.vr.mode];
    const thr = app.vr.mode === 'mip' ? `W ${Math.round(app.wl.width)} L ${Math.round(app.wl.center)}` : `${Math.round(app.vr.lo)} – ${Math.round(app.vr.hi)}`;
    drawLabel(o, `${modeName} · ${thr}`, this.w - 34, 16, '#9fb0c8', 'right');
    if (this.texFactor > 1) drawLabel(o, `rendered at 1/${this.texFactor} resolution`, this.w - 8, this.h - 10, '#9fb0c8', 'right');
    // orientation triad
    const cx = 34;
    const cy = this.h - 34;
    const axes: [Vec3, string, string][] = [
      [[1, 0, 0], 'L', '#e8524a'],
      [[0, -1, 0], 'A', '#58c95a'],
      [[0, 0, 1], 'S', '#4fb3ff'],
    ];
    for (const [d, label, col] of axes) {
      const x = dot(d, this.right) * 22;
      const y = -dot(d, this.up) * 22;
      o.strokeStyle = col;
      o.lineWidth = 2;
      o.beginPath();
      o.moveTo(cx, cy);
      o.lineTo(cx + x, cy + y);
      o.stroke();
      o.fillStyle = col;
      o.font = '600 11px system-ui, sans-serif';
      o.fillText(label, cx + x * 1.25 - 3, cy + y * 1.25 + 4);
    }
  }
}
