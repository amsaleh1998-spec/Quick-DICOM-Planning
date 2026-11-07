import { MeshGL, rayMesh, viewProjection } from '../meshgl';
import { WaxupEditor } from './waxupEdit';
import { scanWorld } from '../scans';
import { WaxTooth, toothKey, toothWorld } from '../waxup/waxup';
import { falloff } from '../waxup/sculpt';
import type { App } from '../app';
import { ABUTMENT_COLOR, ABUTMENT_SELECTED_COLOR, IMPLANT_COLOR, IMPLANT_SELECTED_COLOR, PROSTHETIC_COLOR } from '../implant';
import { NERVE_COLOR, nervePath } from '../nerve';
import { Frame, Vec3, add, cross, dot, fromFrame, neg, normalize, reorthonormalize, rotate, scale, sub, toFrame } from '../math';
import { Volume } from '../volume';
import { Pt, View, drawLabel } from './View';
import { ImplantEditor } from './implantEdit';
import { Implant, implantParts } from '../implant';

const MAX_CYL = 48;
const MAX_NERVE_SEG = 1024;
const FOV = (30 * Math.PI) / 180;
const SCAN_NEAR = 0.5;
const SCAN_FAR = 10000;

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
// segmentation: label grid (nearest voxel), segment table (row 0 colour + visible, row 1 threshold)
uniform highp usampler3D uLab;
uniform sampler2D uSegTab;
uniform vec3 uLabInv;
uniform ivec3 uLabMax;
uniform int uSegOn;
uniform int uShowUnseg;
// automatic (AI) segments: logit margin per label voxel (×16); their surface is the zero level of
// a smooth signed field instead of a CT threshold
uniform highp usampler3D uMarg;
// nerve canals: capsules (a.xyz, r) (b.xyz, 0) in a float texture
uniform sampler2D uNerve;
uniform int uNumNerve;
uniform vec3 uNerveMin, uNerveMax, uNerveCol;
// intraoral scans, rasterised beforehand: colour (alpha = opacity) and depth
uniform sampler2D uScanCol;
uniform sampler2D uScanDepth;
uniform int uScanOn;
uniform float uNear, uFar;
out vec4 outColor;

float vol(vec3 p) { return texture(uVol, p * uTexScale + uTexOffset).r; }
uint labAt(vec3 p) {
  ivec3 ic = clamp(ivec3(floor(p * uLabInv + 0.5)), ivec3(0), uLabMax);
  return texelFetch(uLab, ic, 0).r & 127u;
}
vec4 segInfo(uint l) { return texelFetch(uSegTab, ivec2(int(l), 0), 0); }
float segLo(uint l) { return texelFetch(uSegTab, ivec2(int(l), 1), 0).r; }
bool segAi(uint l) { return texelFetch(uSegTab, ivec2(int(l), 1), 0).g > 0.5; }
float segOpacity(uint l) { return texelFetch(uSegTab, ivec2(int(l), 1), 0).b; }
// trilinear blend of the eight voxels around p: +margin where the voxel is segment l, -margin elsewhere
float aiField(vec3 p, uint l) {
  vec3 g = clamp(p * uLabInv, vec3(0.0), vec3(uLabMax));
  ivec3 i0 = ivec3(floor(g));
  ivec3 i1 = min(i0 + 1, uLabMax);
  vec3 f = g - vec3(i0);
  float acc = 0.0;
  for (int c = 0; c < 8; c++) {
    bvec3 hi = bvec3((c & 1) != 0, (c & 2) != 0, (c & 4) != 0);
    ivec3 ic = ivec3(hi.x ? i1.x : i0.x, hi.y ? i1.y : i0.y, hi.z ? i1.z : i0.z);
    vec3 w = mix(1.0 - f, f, vec3(hi));
    float m = float(texelFetch(uMarg, ic, 0).r);
    acc += w.x * w.y * w.z * (texelFetch(uLab, ic, 0).r == l ? m : -m);
  }
  return acc;
}
vec3 aiGrad(vec3 p, uint l) {
  vec3 e = 0.5 / uLabInv;
  return vec3(
    aiField(p + vec3(e.x, 0.0, 0.0), l) - aiField(p - vec3(e.x, 0.0, 0.0), l),
    aiField(p + vec3(0.0, e.y, 0.0), l) - aiField(p - vec3(0.0, e.y, 0.0), l),
    aiField(p + vec3(0.0, 0.0, e.z), l) - aiField(p - vec3(0.0, 0.0, e.z), l));
}
vec3 labGrad(vec3 p, uint l) {
  vec3 e = 1.0 / uLabInv;
  return vec3(
    float(labAt(p + vec3(e.x, 0.0, 0.0)) == l) - float(labAt(p - vec3(e.x, 0.0, 0.0)) == l),
    float(labAt(p + vec3(0.0, e.y, 0.0)) == l) - float(labAt(p - vec3(0.0, e.y, 0.0)) == l),
    float(labAt(p + vec3(0.0, 0.0, e.z)) == l) - float(labAt(p - vec3(0.0, 0.0, e.z)) == l));
}
// capsule a-b with radius r (Inigo Quilez)
float capHit(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float ra) {
  vec3 ba = pb - pa;
  vec3 oa = ro - pa;
  float baba = dot(ba, ba);
  float bard = dot(ba, rd);
  float baoa = dot(ba, oa);
  float rdoa = dot(rd, oa);
  float oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - ra * ra * baba;
  float h = b * b - a * c;
  if (h >= 0.0 && abs(a) > 1e-9) {
    float t = (-b - sqrt(h)) / a;
    float y = baoa + t * bard;
    if (y > 0.0 && y < baba) return t;
    vec3 oc = (y <= 0.0) ? oa : ro - pb;
    b = dot(rd, oc);
    c = dot(oc, oc) - ra * ra;
    h = b * b - c;
    if (h > 0.0) return -b - sqrt(h);
  }
  return -1.0;
}
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
  // nerve canals: opaque in front, shown through the bone when hidden
  float tNerve = 1e20;
  vec3 nNerve = vec3(0.0);
  if (uNumNerve > 0) {
    vec2 nb = boxHit(ro, rd, uNerveMin, uNerveMax);
    if (nb.x <= nb.y && nb.y > 0.0) {
      vec3 na = vec3(0.0), nbb = vec3(0.0);
      float nr = 1.0;
      for (int i = 0; i < ${MAX_NERVE_SEG}; i++) {
        if (i >= uNumNerve) break;
        vec4 A = texelFetch(uNerve, ivec2(i * 2, 0), 0);
        vec4 B = texelFetch(uNerve, ivec2(i * 2 + 1, 0), 0);
        float t = capHit(ro, rd, A.xyz, B.xyz, A.w);
        if (t > 0.0 && t < tNerve) { tNerve = t; na = A.xyz; nbb = B.xyz; nr = A.w; }
      }
      if (tNerve < 1e19) {
        vec3 pos = ro + rd * tNerve;
        vec3 ba = nbb - na;
        float hh = clamp(dot(pos - na, ba) / max(1e-9, dot(ba, ba)), 0.0, 1.0);
        nNerve = (pos - na - hh * ba) / nr;
        if (tNerve < tImp) { tImp = tNerve; nImp = nNerve; cImp = uNerveCol; }
      }
    }
  }
  float tSurf = 1e20;
  // first opaque surface, and the translucent layers in front of it (depth, opacity)
  float tOpaque = 1e20;
  vec4 layT = vec4(1e20);
  vec4 layA = vec4(0.0);

  vec2 b1 = boxHit(ro, rd, vec3(0.0), uBoxMax);
  mat3 Ft = transpose(uFrame);
  vec2 b2 = boxHit(Ft * (ro - uOrigin), Ft * rd, uCropMin, uCropMax);
  float tn = max(max(b1.x, b2.x), 0.0);
  float tf = min(min(b1.y, b2.y), tImp);
  vec4 acc = vec4(0.0);
  if (tn < tf) {
    if (uMode == 0) {
      // surfaces front to back: a translucent segment adds its shaded surface weighted by its
      // opacity, then the ray passes through it; the first opaque surface ends the ray
      float t = tn;
      bool first = true;
      float trans = 1.0;
      uint skipLab = 0u;
      int steps = 0;
      for (int layer = 0; layer < 4; layer++) {
        bool hit = false;
        vec3 base = vec3(0.93, 0.88, 0.79);
        float lo = uLo;
        float hi = uHi;
        uint lab = 0u;
        bool aiHit = false;
        float alpha = 1.0;
        for (int i = 0; i < 4096; i++) {
          if (t > tf || steps >= 4096) break;
          steps++;
          vec3 p = ro + rd * t;
          float v = vol(p);
          if (uSegOn == 1) {
            uint l = labAt(p);
            // inside the translucent segment just drawn: go on until the ray leaves it
            if (skipLab != 0u) {
              if (l == skipLab) { t += uStep; continue; }
              skipLab = 0u;
            }
            if (l == 0u) {
              if (uShowUnseg == 1 && v >= uLo && v <= uHi) { hit = true; break; }
            } else {
              vec4 si = segInfo(l);
              if (si.w > 0.5) {
                if (segAi(l)) {
                  if (aiField(p, l) >= 0.0) { hit = true; base = si.rgb; lab = l; aiHit = true; alpha = segOpacity(l); break; }
                } else {
                  float slo = segLo(l);
                  if (v >= slo) { hit = true; base = si.rgb; lo = slo; hi = 1e9; lab = l; alpha = segOpacity(l); break; }
                }
              }
            }
          } else if (v >= uLo && v <= uHi) { hit = true; break; }
          first = false;
          t += uStep;
        }
        if (!hit) break;
        vec3 n = -rd;
        if (!first) {
          float a = t - uStep;
          float b = t;
          if (aiHit) {
            for (int k = 0; k < 6; k++) {
              float m = 0.5 * (a + b);
              if (aiField(ro + rd * m, lab) >= 0.0) b = m; else a = m;
            }
            t = b;
            vec3 g = aiGrad(ro + rd * t, lab);
            if (length(g) > 1e-6) n = -normalize(g);
          } else {
            float va = vol(ro + rd * a);
            // inner face (cut between two segments / a hidden neighbour): voxel shading
            bool inner = lab != 0u && va >= lo;
            if (!inner) {
              for (int k = 0; k < 6; k++) {
                float m = 0.5 * (a + b);
                float v = vol(ro + rd * m);
                if (v >= lo && v <= hi) b = m; else a = m;
              }
            }
            t = b;
            vec3 g = inner ? labGrad(ro + rd * t, lab) : grad(ro + rd * t);
            if (length(g) > 1e-6) n = -normalize(g);
          }
        }
        if (layer == 0) tSurf = t;
        if (layer < 4) { layT[layer] = t; layA[layer] = alpha; }
        acc.rgb += trans * alpha * shade(base, n, rd, L, 0.25);
        trans *= 1.0 - alpha;
        if (alpha > 0.995 || trans < 0.03) { tOpaque = t; break; }
        skipLab = lab;
        first = false;
        t += uStep;
      }
      acc.a = 1.0 - trans;
    } else if (uMode == 1) {
      float t = tn;
      for (int i = 0; i < 4096; i++) {
        if (t > tf || acc.a > 0.97) break;
        vec3 p = ro + rd * t;
        float v = vol(p);
        float lo = uLo;
        vec3 tint = vec3(-1.0);
        if (uSegOn == 1) {
          uint l = labAt(p);
          if (l == 0u) {
            if (uShowUnseg == 0) { t += uStep; continue; }
          } else {
            vec4 si = segInfo(l);
            if (si.w < 0.5) { t += uStep; continue; }
            tint = si.rgb;
            lo = segAi(l) ? uLo : segLo(l);
          }
        }
        float a = clamp((v - lo) / max(1.0, uHi - lo), 0.0, 1.0);
        if (a > 0.0 && (tint.x >= 0.0 || v <= uHi * 1.0001 + 1.0)) {
          vec3 g = grad(p);
          vec3 n = length(g) > 1e-6 ? -normalize(g) : -rd;
          vec3 baseCol = tint.x >= 0.0 ? mix(tint * 0.75, tint, a) : mix(vec3(0.85, 0.55, 0.45), vec3(1.0, 0.97, 0.9), a);
          vec3 col = shade(baseCol, n, rd, L, 0.1);
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
        vec3 p = ro + rd * t;
        t += uStep;
        if (uSegOn == 1) {
          uint l = labAt(p);
          if (l == 0u ? uShowUnseg == 0 : segInfo(l).w < 0.5) continue;
        }
        m = max(m, vol(p));
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
  // nerve hidden behind opaque bone: still visible as a ghost
  if (tNerve < 1e19 && tNerve > tOpaque) col = mix(col, shade(uNerveCol, nNerve, rd, L, 0.3), 0.45);
  if (uScanOn == 1) {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec4 sc = texture(uScanCol, uv);
    if (sc.a > 0.0) {
      float zn = texture(uScanDepth, uv).r * 2.0 - 1.0;
      float ze = 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear));
      float tS = ze / dot(rd, uFwd);
      // a scan lying on the bone/teeth surface wins the tie (0.2 mm)
      if (tS < min(tImp, tSurf + 0.2)) col = mix(col, sc.rgb, sc.a);
      else if (tS < min(tImp, tOpaque + 0.2)) {
        // behind translucent segments: seen through the layers in front of it
        float tr = 1.0;
        for (int k = 0; k < 4; k++) if (layT[k] < tS) tr *= 1.0 - layA[k];
        col = mix(col, sc.rgb, sc.a * tr);
      }
    }
  }
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
  /** max voxels of the 3D texture (lower on phones) */
  static textureBudget = 48_000_000;
  /** max rendered pixels per frame (lower on phones) */
  static pixelBudget = 900_000;
  private glCanvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private tex: WebGLTexture | null = null;
  private texVolId = -1;
  private texDims: [number, number, number] = [1, 1, 1];
  private texFactor = 1;
  private error = '';
  private segError = '';
  private lastKey = '';
  private labTex: WebGLTexture | null = null;
  private margTex: WebGLTexture | null = null;
  private margSrc: Uint8Array | null = null;
  // intraoral scans: mesh renderer + offscreen colour/depth target
  private meshGl: MeshGL | null = null;
  private scanFbo: WebGLFramebuffer | null = null;
  private scanColTex: WebGLTexture | null = null;
  private scanDepthTex: WebGLTexture | null = null;
  private scanFboSize = '';
  private uploaded = new WeakMap<object, string>();
  /** tooth whose part highlight is in its vertex colours, and which part */
  private partColored = new WeakMap<WaxTooth, string>();
  private segTabTex: WebGLTexture | null = null;
  private nerveTex: WebGLTexture | null = null;
  private labVersion = -1;
  private nerveKey = '';
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
    // reset button next to the maximize button
    const reset = document.createElement('button');
    reset.className = 'view-reset-btn';
    reset.title = 'Reset view: initial position and rotation centre (double-click also works)';
    reset.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.2 6.2A5 5 0 1 1 3 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M2.6 2.6v3.8h3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    reset.onclick = () => this.fit();
    this.el.append(reset);
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
        'uLab', 'uSegTab', 'uLabInv', 'uLabMax', 'uSegOn', 'uShowUnseg', 'uMarg', 'uNerve', 'uNumNerve', 'uNerveMin', 'uNerveMax', 'uNerveCol',
        'uScanCol', 'uScanDepth', 'uScanOn', 'uNear', 'uFar',
      ];
      for (const n of names) this.uni[n] = gl.getUniformLocation(p, n);
      gl.bindVertexArray(gl.createVertexArray());
      // placeholders so every sampler always has a texture of the right type
      this.labTex = this.makeTex(gl.TEXTURE_3D);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, 1, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
      this.margTex = this.makeTex(gl.TEXTURE_3D);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, 1, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
      this.segTabTex = this.makeTex(gl.TEXTURE_2D);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 128, 2, 0, gl.RGBA, gl.FLOAT, new Float32Array(128 * 2 * 4));
      this.nerveTex = this.makeTex(gl.TEXTURE_2D);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(8));
      try {
        this.meshGl = new MeshGL(gl);
        this.scanFbo = gl.createFramebuffer();
        this.scanColTex = this.makeTex(gl.TEXTURE_2D);
        this.scanDepthTex = this.makeTex(gl.TEXTURE_2D);
      } catch (e) {
        console.warn('Scan rendering unavailable', e);
        this.meshGl = null;
      }
    } catch (e) {
      console.error(e);
      this.error = '3D shader failed to compile: ' + (e as Error).message;
    }
  }

  /** Texture with nearest filtering (integer / float lookup tables). */
  private makeTex(target: number): WebGLTexture {
    const gl = this.gl!;
    const t = gl.createTexture()!;
    gl.bindTexture(target, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Bind segmentation and nerve data; returns whether segments are rendered. */
  private bindSegmentation(): boolean {
    const gl = this.gl!;
    const app = this.app;
    const u = this.uni;
    const seg = app.seg;
    this.segError = '';
    let segOn = !!seg.labels && seg.segments.some((g) => g.voxels > 0);
    if (segOn) {
      const maxDim = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
      if (Math.max(seg.nx, seg.ny, seg.nz) > maxDim) {
        segOn = false;
        this.segError = 'segments cannot be shown in 3D on this GPU (volume too large)';
      }
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.labTex);
    if (segOn && this.labVersion !== seg.version) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, seg.nx, seg.ny, seg.nz, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, seg.labels);
      this.labVersion = seg.version;
    }
    gl.uniform1i(u.uLab, 1);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, this.margTex);
    const marg = segOn && seg.segments.some((g) => g.ai) ? seg.aiMargin : null;
    if (marg && marg !== this.margSrc) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, seg.nx, seg.ny, seg.nz, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, marg);
      this.margSrc = marg;
    }
    gl.uniform1i(u.uMarg, 4);
    gl.activeTexture(gl.TEXTURE1);
    gl.uniform3f(u.uLabInv, 1 / seg.gs[0], 1 / seg.gs[1], 1 / seg.gs[2]);
    gl.uniform3i(u.uLabMax, Math.max(0, seg.nx - 1), Math.max(0, seg.ny - 1), Math.max(0, seg.nz - 1));
    gl.uniform1i(u.uSegOn, segOn ? 1 : 0);
    gl.uniform1i(u.uShowUnseg, app.showUnsegmented ? 1 : 0);
    // segment table: row 0 = colour + visible, row 1 = threshold
    const tab = new Float32Array(128 * 2 * 4);
    for (const g of seg.segments) {
      tab.set([g.color[0] / 255, g.color[1] / 255, g.color[2] / 255, g.visible ? 1 : 0], g.id * 4);
      tab[(128 + g.id) * 4] = seg.segmentLo(g);
      tab[(128 + g.id) * 4 + 1] = g.ai ? 1 : 0;
      tab[(128 + g.id) * 4 + 2] = g.opacity ?? 1;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.segTabTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 128, 2, 0, gl.RGBA, gl.FLOAT, tab);
    gl.uniform1i(u.uSegTab, 2);

    // nerves as capsules
    const caps: number[] = [];
    const mn: Vec3 = [Infinity, Infinity, Infinity];
    const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    const nerves = app.nerves.filter((n) => n.visible && n.pts.length >= 2);
    const total = nerves.reduce((a, n) => a + nervePath(n).length, 0);
    const every = Math.max(1, Math.ceil(total / MAX_NERVE_SEG));
    for (const n of nerves) {
      const path = nervePath(n).filter((_, i, a) => i % every === 0 || i === a.length - 1);
      const r = n.diameter / 2;
      for (let i = 0; i + 1 < path.length && caps.length < MAX_NERVE_SEG * 8; i++) {
        caps.push(...path[i], r, ...path[i + 1], 0);
        for (let a = 0; a < 3; a++) {
          mn[a] = Math.min(mn[a], path[i][a] - r, path[i + 1][a] - r);
          mx[a] = Math.max(mx[a], path[i][a] + r, path[i + 1][a] + r);
        }
      }
    }
    const nSeg = caps.length / 8;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.nerveTex);
    const key = JSON.stringify(caps);
    if (key !== this.nerveKey) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, Math.max(2, nSeg * 2), 1, 0, gl.RGBA, gl.FLOAT, nSeg ? new Float32Array(caps) : new Float32Array(8));
      this.nerveKey = key;
    }
    gl.uniform1i(u.uNerve, 3);
    gl.uniform1i(u.uNumNerve, nSeg);
    gl.uniform3fv(u.uNerveMin, nSeg ? mn : [0, 0, 0]);
    gl.uniform3fv(u.uNerveMax, nSeg ? mx : [0, 0, 0]);
    gl.uniform3f(u.uNerveCol, NERVE_COLOR[0] / 255, NERVE_COLOR[1] / 255, NERVE_COLOR[2] / 255);
    gl.activeTexture(gl.TEXTURE0);
    return segOn;
  }

  private uploadVolume(vol: Volume) {
    const gl = this.gl!;
    if (this.tex) gl.deleteTexture(this.tex);
    const maxDim = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    let f = 1;
    const dimsFor = (f: number): [number, number, number] => [Math.ceil(vol.nx / f), Math.ceil(vol.ny / f), Math.ceil(vol.nz / f)];
    while (true) {
      const d = dimsFor(f);
      if (d[0] * d[1] * d[2] <= View3D.textureBudget && Math.max(...d) <= maxDim) break;
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
    this.pivotFlashUntil = 0;
    const { min, max } = app.crop;
    this.target = fromFrame([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], app.O, app.frame);
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    this.vs.scale = (diag * 0.7) / Math.max(1, Math.min(this.w, this.h));
    this.setPreset('front');
  }

  // ---- rotation centre ----------------------------------------------------------

  /** show the rotation-centre marker until then (ms) */
  private pivotFlashUntil = 0;
  private orbiting = false;

  /** Middle-click on a surface: that point becomes the centre of rotation (the view does not move). */
  protected onMiddleClick(p: Pt) {
    const w = this.pickSurface(p);
    if (!w) {
      this.app.onStatus('No surface under the cursor – middle-click on the model to set the rotation centre.', true);
      return;
    }
    this.setPivot(w);
    this.app.onStatus('Rotation centre set · Reset view (⟲ in the 3D view, or double-click) restores the initial view.');
  }

  /**
   * Make P the orbit pivot while keeping the camera exactly where it is: the
   * target moves to P, the pan offsets take up the sideways difference and the
   * zoom (distance) takes up the depth difference.
   */
  setPivot(P: Vec3) {
    const cam = this.camera();
    const tanHalf = Math.tan(FOV / 2);
    const dist = (this.h * this.vs.scale) / 2 / tanHalf;
    const d = sub(cam.target, P);
    const depth = dist - dot(d, this.fwd); // distance of P in front of the camera
    if (depth <= 1e-3) return;
    this.target = P;
    this.vs.panU = dot(d, this.right);
    this.vs.panV = -dot(d, this.up);
    this.vs.scale = (depth * 2 * tanHalf) / Math.max(1, this.h);
    this.flashPivot(1500);
  }

  private flashPivot(ms: number) {
    const until = performance.now() + ms;
    if (until <= this.pivotFlashUntil) return;
    this.pivotFlashUntil = until;
    this.app.requestRender();
    window.setTimeout(() => this.app.requestRender(), ms + 20);
  }

  /** Screen position of a world point (null when behind the camera). */
  private projectPoint(w: Vec3): Pt | null {
    const cam = this.camera();
    const q = sub(w, cam.pos);
    const z = dot(q, this.fwd);
    if (z <= 1e-6) return null;
    const th = Math.tan(FOV / 2);
    return [(this.w / 2) * (1 + dot(q, this.right) / (z * th * (this.w / Math.max(1, this.h)))), (this.h / 2) * (1 - dot(q, this.up) / (z * th))];
  }

  private drawPivot(o: CanvasRenderingContext2D) {
    if (!this.orbiting && performance.now() > this.pivotFlashUntil) return;
    const s = this.projectPoint(this.target);
    if (!s) return;
    o.save();
    o.strokeStyle = 'rgba(0,0,0,0.7)';
    o.lineWidth = 4;
    o.beginPath();
    o.arc(s[0], s[1], 7, 0, Math.PI * 2);
    o.stroke();
    o.strokeStyle = '#ff9f1c';
    o.lineWidth = 2;
    o.stroke();
    o.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      o.moveTo(s[0] + dx * 10, s[1] + dy * 10);
      o.lineTo(s[0] + dx * 15, s[1] + dy * 15);
    }
    o.stroke();
    o.fillStyle = '#fff';
    o.beginPath();
    o.arc(s[0], s[1], 2, 0, Math.PI * 2);
    o.fill();
    o.restore();
  }

  private camera() {
    const dist = (this.h * this.vs.scale) / 2 / Math.tan(FOV / 2);
    const t = add(add(this.target, scale(this.right, this.vs.panU)), scale(this.up, -this.vs.panV));
    return { pos: add(t, scale(this.fwd, -dist)), target: t };
  }

  // ---- implant editing (same handles and gestures as the 2D views) ----------------

  /** Ray through a screen point (CSS px). */
  private rayAt(p: Pt): { o: Vec3; d: Vec3 } {
    const th = Math.tan(FOV / 2);
    const nx = (p[0] / this.w) * 2 - 1;
    const ny = 1 - (p[1] / this.h) * 2;
    return { o: this.camera().pos, d: normalize(add(add(this.fwd, scale(this.right, nx * th * (this.w / this.h))), scale(this.up, ny * th))) };
  }

  /** Closest approach of a ray and the line c + axis·h: axial coordinate h, distance, ray parameter t. */
  private rayAxis(p: Pt, c: Vec3, axis: Vec3): { h: number; rad: number; t: number } {
    const { o, d } = this.rayAt(p);
    const w0 = sub(o, c);
    const b = dot(d, axis);
    const dd = dot(d, w0);
    const e = dot(axis, w0);
    const den = 1 - b * b;
    let t: number, h: number;
    if (den < 1e-9) {
      t = 0;
      h = e;
    } else {
      t = (b * e - dd) / den;
      h = (e - b * dd) / den;
    }
    const pr = add(o, scale(d, t));
    const pa = add(c, scale(axis, h));
    return { h, rad: Math.hypot(pr[0] - pa[0], pr[1] - pa[1], pr[2] - pa[2]), t };
  }

  /** mm per CSS pixel at the depth of the selected implant (or the rotation centre). */
  private mmPerPx(): number {
    const cam = this.camera();
    const sel = this.app.selectedImplant();
    const z = sel ? Math.max(1, dot(sub(sel.center, cam.pos), this.fwd)) : Math.max(1, dot(sub(cam.target, cam.pos), this.fwd));
    return (2 * z * Math.tan(FOV / 2)) / Math.max(1, this.h);
  }

  private editor = new ImplantEditor(this.app, {
    project: (w) => {
      const s = this.projectPoint(w);
      return { x: s ? s[0] : -1e5, y: s ? s[1] : -1e5, depth: 0 };
    },
    basis: () => {
      const u = this.right;
      const v = neg(this.up);
      return { u, v, n: cross(u, v) };
    },
    scale: () => this.mmPerPx(),
    radialAxial: (p, imp) => {
      const r = this.rayAxis(p, imp.center, imp.axis);
      return { rad: r.rad, h: r.h };
    },
    hitBody: (p) => this.implantAt(p),
    visible: (imp) => !imp.hidden,
    container: this.el,
  });
  private editingImplant = false;

  // ---- waxup teeth --------------------------------------------------------------------------
  protected override waxEditor: WaxupEditor | null = new WaxupEditor(this.app, {
    pick: (p) => this.toothAt(p),
    // the plane through the anchor, parallel to the screen
    planePoint: (p, anchor) => {
      const { o, d } = this.rayAt(p);
      const den = dot(d, this.fwd);
      if (Math.abs(den) < 1e-9) return null;
      return add(o, scale(d, dot(sub(anchor, o), this.fwd) / den));
    },
    project: (w) => this.projectPoint(w),
    viewAxis: () => this.fwd,
    near: () => true,
    mmPerPx: (w) => {
      const z = Math.max(1, dot(sub(w, this.camera().pos), this.fwd));
      return (2 * z * Math.tan(FOV / 2)) / Math.max(1, this.h);
    },
    sculpt: true,
  });

  /** Nearest waxup tooth along the ray through a screen point (or passing within a few pixels of it). */
  private toothAt(p: Pt): { fdi: number; w: Vec3 } | null {
    const { o, d } = this.rayAt(p);
    let best: { fdi: number; w: Vec3; t: number } | null = null;
    const teeth = this.app.wax.shown();
    for (const t of teeth) {
      const wm = toothWorld(t);
      const [tn, tf] = boxHit(o, d, wm.min, wm.max);
      if (tn > tf || tf < 0 || (best && tn > best.t)) continue;
      const h = rayMesh(wm.pos, t.idx, o, d);
      if (h && (!best || h.t < best.t)) best = { fdi: t.fdi, w: h.p, t: h.t };
    }
    if (best || !teeth.length) return best;
    // near miss: the vertex closest to the ray, within 6 px
    let near: { fdi: number; w: Vec3; d: number } | null = null;
    for (const t of teeth) {
      const wm = toothWorld(t);
      const tol = 6 * this.waxEditorScale(wm.min, wm.max);
      const lo: Vec3 = [wm.min[0] - tol, wm.min[1] - tol, wm.min[2] - tol];
      const hi: Vec3 = [wm.max[0] + tol, wm.max[1] + tol, wm.max[2] + tol];
      const [tn, tf] = boxHit(o, d, lo, hi);
      if (tn > tf || tf < 0) continue;
      const P = wm.pos;
      for (let i = 0; i < P.length; i += 3) {
        const qx = P[i] - o[0], qy = P[i + 1] - o[1], qz = P[i + 2] - o[2];
        const s = qx * d[0] + qy * d[1] + qz * d[2];
        if (s <= 0) continue;
        const dd = Math.sqrt(Math.max(0, qx * qx + qy * qy + qz * qz - s * s));
        if (dd <= tol && (!near || dd < near.d)) near = { fdi: t.fdi, w: [P[i], P[i + 1], P[i + 2]], d: dd };
      }
    }
    return near && { fdi: near.fdi, w: near.w };
  }

  /** mm per pixel at the middle of a box (for pick tolerances). */
  private waxEditorScale(min: Vec3, max: Vec3): number {
    const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const z = Math.max(1, dot(sub(c, this.camera().pos), this.fwd));
    return (2 * z * Math.tan(FOV / 2)) / Math.max(1, this.h);
  }

  /** In ② Plan a tooth can be grabbed in 3D from any panel – unless an implant is under the cursor. */
  protected override waxAnyPanel(p: Pt): boolean {
    const app = this.app;
    return app.mode === 'plan' && app.wax.model.teeth.length > 0 && !this.editor.hoverCursor(p);
  }

  /** Nearest implant (body or abutment) under a screen point. */
  private implantAt(p: Pt): Implant | null {
    let best: Implant | null = null;
    let bestT = Infinity;
    for (const imp of this.app.implants) {
      for (const part of implantParts(imp, this.app.abutmentDir(imp))) {
        if (part.kind === 'prosthetic') continue;
        const r = this.rayAxis(p, part.center, part.axis);
        if (Math.abs(r.h) > part.half || r.t <= 0) continue;
        const f = (r.h + part.half) / (2 * part.half);
        const radius = part.r0 + (part.r1 - part.r0) * f;
        if (r.rad <= radius + this.mmPerPx() * 2 && r.t < bestT) {
          bestT = r.t;
          best = imp;
        }
      }
    }
    return best;
  }

  protected onLeftDown(p: Pt): boolean {
    // implants (body = move, C/A handles = rotate, outline = resize) unless a segmentation tool is active
    if (!this.app.segTool && this.editor.start(p)) {
      this.editingImplant = true;
      return true;
    }
    this.orbiting = true;
    return true;
  }

  protected onLeftDrag(p: Pt, last: Pt) {
    if (this.editingImplant) {
      this.editor.move(p, last);
      return;
    }
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

  // ---- 3Dconnexion SpaceMouse ("object mode": the model follows the cap) ----------

  /** t / r in screen axes (X right, Y up, Z towards the user), ±1 = full deflection. */
  spaceMotion(t: Vec3, r: Vec3, dt: number) {
    if (!this.app.vol) return;
    // pan: full deflection moves the model ~0.8 view heights per second
    const pan = this.h * this.vs.scale * 0.8 * dt;
    this.vs.panU -= t[0] * pan;
    this.vs.panV += t[1] * pan;
    // zoom: pulling the cap towards you brings the model closer
    this.vs.scale = Math.min(5, Math.max(0.01, this.vs.scale * Math.exp(-t[2] * 1.6 * dt)));
    // rotation: the model turns with the cap = the camera turns the other way around the target
    const axis = add(add(scale(this.right, r[0]), scale(this.up, r[1])), scale(this.fwd, -r[2]));
    const mag = Math.hypot(axis[0], axis[1], axis[2]);
    if (mag > 1e-6) {
      this.flashPivot(400);
      const a = normalize(axis);
      const ang = -mag * 2.2 * dt; // ~125°/s at full deflection
      const fr = reorthonormalize([rotate(this.right, a, ang), rotate(this.up, a, ang), rotate(this.fwd, a, ang)] as Frame);
      this.right = fr[0];
      this.up = fr[1];
      this.fwd = neg(fr[2]);
    }
    this.app.requestRender();
  }

  private presetIdx = 0;
  /** Left button: fit / reset · right button: next standard view. */
  spaceButton(i: number) {
    if (!this.app.vol) return;
    if (i === 0) {
      this.presetIdx = 0;
      this.fit();
    }
    else {
      const order: Preset[] = ['front', 'right', 'back', 'left', 'top', 'bottom'];
      this.presetIdx = (this.presetIdx + 1) % order.length;
      this.setPreset(order[this.presetIdx]);
    }
  }

  /** A click (no drag) with the grow tool picks the surface under the cursor as a seed. */
  protected onLeftUp(p: Pt, _e: PointerEvent, moved: boolean) {
    const app = this.app;
    if (this.editingImplant) {
      this.editingImplant = false;
      this.editor.end();
      return;
    }
    this.orbiting = false;
    this.app.requestRender();
    // a click on a waxup tooth with another panel open: edit the waxup
    if (!moved && !app.segTool && !app.ruler && this.waxAnyPanel(p) && this.waxEditor?.clickToEdit(p)) return;
    if (moved || app.segTool !== 'grow') return;
    const w = this.pickSurface(p);
    if (w) app.growAt(w);
    else app.onStatus('No surface under the cursor – click on the rendered bone.', true);
  }

  protected onHover(p: Pt) {
    if (this.app.segTool) {
      this.el.style.cursor = this.app.segTool === 'grow' ? 'crosshair' : '';
      return;
    }
    this.el.style.cursor = (this.app.vol && this.editor.hoverCursor(p)) || '';
  }

  /** First rendered surface point under the screen point (CPU ray cast, same rules as the shader). */
  pickSurface(p: Pt): Vec3 | null {
    const app = this.app;
    const vol = app.vol;
    if (!vol || !this.w || !this.h) return null;
    const cam = this.camera();
    const th = Math.tan(FOV / 2);
    const nx = (p[0] / this.w) * 2 - 1;
    const ny = 1 - (p[1] / this.h) * 2;
    const rd = normalize(add(add(this.fwd, scale(this.right, nx * th * (this.w / this.h))), scale(this.up, ny * th)));
    const ro = cam.pos;
    const F = app.frame;
    const b1 = boxHit(ro, rd, [0, 0, 0], vol.extent);
    const b2 = boxHit(toFrame(ro, app.O, F), [dot(rd, F[0]), dot(rd, F[1]), dot(rd, F[2])], app.crop.min, app.crop.max);
    const tn = Math.max(b1[0], b2[0], 0);
    const tf = Math.min(b1[1], b2[1]);
    const step = vol.minSpacing * 0.5;
    const seg = app.seg;
    const segOn = !!seg.labels && seg.segments.some((g) => g.voxels > 0);
    const { lo, hi } = app.vr;
    for (let t = tn; t <= tf; t += step) {
      const q = add(ro, scale(rd, t));
      const v = vol.sample(q);
      if (segOn) {
        const l = seg.rawLabelAt(q[0], q[1], q[2]);
        if (l === 0) {
          if (app.showUnsegmented && v >= lo && v <= hi) return q;
        } else {
          const g = seg.segmentById(l);
          if (g && g.visible && seg.segmentHit(g, q, v)) return q;
        }
      } else if (v >= lo && v <= hi) return q;
    }
    return null;
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
        app.vr.mode === 'mip' ? app.wl : 0, app.implantsKey(), app.segKey(), app.scansKey(), app.wax.key(),
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
    let ratio = Math.min(dpr, Math.sqrt(View3D.pixelBudget / Math.max(1, this.w * this.h)));
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
    this.bindSegmentation();
    const scansOn = this.drawScans(cam.pos, W, H);
    gl.useProgram(this.prog);
    gl.viewport(0, 0, W, H);
    gl.uniform1i(u.uScanOn, scansOn ? 1 : 0);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.scanColTex);
    gl.uniform1i(u.uScanCol, 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.scanDepthTex);
    gl.uniform1i(u.uScanDepth, 7);
    gl.uniform1f(u.uNear, SCAN_NEAR);
    gl.uniform1f(u.uFar, SCAN_FAR);
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Rasterise the visible, placed scans and the waxup teeth into the offscreen colour/depth target. */
  private drawScans(camPos: Vec3, W: number, H: number): boolean {
    const gl = this.gl!;
    const mg = this.meshGl;
    const app = this.app;
    const scans = app.scans.filter((s) => s.visible && s.transform);
    const wax = app.wax;
    const teeth = wax.shown();
    if (!mg || !this.scanFbo) return false;
    mg.prune(new Set<unknown>([...app.scans, ...wax.model.teeth]));
    if (!scans.length && !teeth.length) return false;
    const size = `${W}x${H}`;
    if (size !== this.scanFboSize) {
      gl.bindTexture(gl.TEXTURE_2D, this.scanColTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, this.scanDepthTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, W, H, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scanFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scanColTex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.scanDepthTex, 0);
      this.scanFboSize = size;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scanFbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const mvp = viewProjection(camPos, this.right, this.up, this.fwd, FOV, W / Math.max(1, H), SCAN_NEAR, SCAN_FAR);
    type Item = { opacity: number; draw: () => void };
    const items: Item[] = scans.map((s) => ({
      opacity: s.opacity,
      draw: () => {
        const key = s.transform!.join(',');
        if (this.uploaded.get(s) !== key || !mg.has(s)) {
          const w = scanWorld(s)!;
          mg.upload(s, w.pos, w.nrm, s.mesh.idx, s.mesh.col);
          this.uploaded.set(s, key);
        }
        mg.draw(s, mvp, camPos, { color: s.color, opacity: s.opacity, vertexColors: s.vertexColors });
      },
    }));
    const jawSel = wax.scope === 'jaw' && wax.selected !== null ? wax.model.tooth(wax.selected)?.jaw : null;
    for (const t of teeth) {
      items.push({
        opacity: wax.opacity,
        draw: () => {
          const key = toothKey(t);
          if (this.uploaded.get(t) !== key || !mg.has(t)) {
            const w = toothWorld(t);
            mg.upload(t, w.pos, w.nrm, t.idx, null);
            this.uploaded.set(t, key);
            this.partColored.delete(t);
          }
          const sel = t.fdi === wax.selected || t.jaw === jawSel;
          const hov = t.fdi === wax.hover;
          const base = wax.color;
          const color: [number, number, number] = sel ? [255, 214, 150] : hov ? [Math.min(255, base[0] + 12), Math.min(255, base[1] + 18), 255] : base;
          // the region a part would move: shaded on the tooth while its handle is hovered
          const hp = wax.editing && wax.tool === 'parts' && wax.hoverPart?.fdi === t.fdi ? wax.hoverPart : null;
          let vc = false;
          if (hp) {
            const pk = `${key}|${hp.i}`;
            if (this.partColored.get(t) !== pk) {
              mg.updateColors(t, this.partColors(t, hp.i, color));
              this.partColored.set(t, pk);
            }
            vc = true;
          }
          mg.draw(t, mvp, camPos, { color, opacity: wax.opacity, vertexColors: vc });
        },
      });
    }
    // opaque first, so translucent objects in front still win the depth test with their own colour
    for (const it of items.sort((a, b) => b.opacity - a.opacity)) it.draw();
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /** Vertex colours showing the region of a tooth part (blue, by weight). */
  private partColors(t: WaxTooth, part: number, base: [number, number, number]): Uint8Array {
    const tpl = this.app.wax.model.template(t.fdi);
    const tip = tpl.parts[part];
    const R = tpl.partRadius;
    const p = t.pos;
    const col = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const f = falloff(Math.hypot(p[i] - tip[0], p[i + 1] - tip[1], p[i + 2] - tip[2]), R);
      col[i] = base[0] + (90 - base[0]) * f;
      col[i + 1] = base[1] + (170 - base[1]) * f;
      col[i + 2] = base[2] + (255 - base[2]) * f;
    }
    return col;
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
    // the desktop layout shows mode and threshold in the view's own header buttons
    if (!this.el.querySelector('.view-tools.in-view')) drawLabel(o, `${modeName} · ${thr}`, this.w - 62, 16, '#9fb0c8', 'right');
    this.drawPivot(o);
    this.editor.draw(o);
    this.waxEditor?.draw(o);
    if (this.texFactor > 1) drawLabel(o, `rendered at 1/${this.texFactor} resolution`, this.w - 8, this.h - 10, '#9fb0c8', 'right');
    if (this.segError) drawLabel(o, this.segError, this.w - 8, this.h - 28, '#ff8a8a', 'right');
    const tool = app.segTool;
    if (tool) {
      const seg = app.activeSegment();
      const hint =
        tool === 'grow'
          ? `Click ${seg ? seg.name : 'the structure'} to segment it (threshold ${Math.round(app.vr.lo)}–${Math.round(app.vr.hi)}) · drag = rotate · Esc = done`
          : tool === 'cut'
            ? 'Draw the cut in a slice or the panoramic'
            : 'Trace the nerve on cross-sections or the panoramic';
      drawLabel(o, hint, 70, this.h - 10, '#ffd34f');
    }
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

/** Ray / axis-aligned box intersection: [t near, t far]. */
function boxHit(ro: Vec3, rd: Vec3, bmin: Vec3, bmax: Vec3): [number, number] {
  let tn = -Infinity;
  let tf = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(rd[a]) < 1e-12) {
      if (ro[a] < bmin[a] || ro[a] > bmax[a]) return [1, 0];
      continue;
    }
    const t0 = (bmin[a] - ro[a]) / rd[a];
    const t1 = (bmax[a] - ro[a]) / rd[a];
    tn = Math.max(tn, Math.min(t0, t1));
    tf = Math.min(tf, Math.max(t0, t1));
  }
  return [tn, tf];
}
