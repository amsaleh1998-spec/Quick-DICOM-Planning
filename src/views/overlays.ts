import type { App } from '../app';
import { NERVE_COLOR, nervePath } from '../nerve';
import { Vec3, cross, normalize } from '../math';

export const CUT_COLOR: [number, number, number] = [255, 122, 40];
export const CUT_CSS = 'rgb(255,122,40)';

/**
 * Tint segment voxels (with a stronger outline) and draw the traces of the
 * separation cuts into a 2D image. `worldOf` writes the world position of
 * image pixel (i, j) into `out` and returns false for pixels outside the image content.
 */
export function composeSegmentation(
  app: App,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  worldOf: (i: number, j: number, out: Vec3) => boolean,
) {
  const seg = app.seg;
  const colors: ([number, number, number] | null)[] = new Array(128).fill(null);
  let anyLabel = false;
  if (app.showSegOverlay && seg.labels) {
    for (const s of seg.segments) {
      if (s.voxels && app.segmentInSlices(s)) {
        colors[s.id] = s.color;
        anyLabel = true;
      }
    }
  }
  const cuts = seg.cuts;
  if (!anyLabel && !cuts.length) return;
  const n = w * h;
  const lab = anyLabel ? new Uint8Array(n) : null;
  const sides = cuts.map(() => new Int8Array(n));
  const q: Vec3 = [0, 0, 0];
  for (let j = 0, idx = 0; j < h; j++) {
    for (let i = 0; i < w; i++, idx++) {
      if (!worldOf(i, j, q)) continue;
      if (lab) {
        const l = seg.labelAt(q[0], q[1], q[2]);
        if (colors[l]) lab[idx] = l;
      }
      for (let c = 0; c < cuts.length; c++) sides[c][idx] = seg.cutSide(cuts[c], q[0], q[1], q[2]);
    }
  }
  if (lab) {
    for (let j = 0, idx = 0; j < h; j++) {
      for (let i = 0; i < w; i++, idx++) {
        const l = lab[idx];
        if (!l) continue;
        const edge =
          (i > 0 && lab[idx - 1] !== l) || (i < w - 1 && lab[idx + 1] !== l) || (j > 0 && lab[idx - w] !== l) || (j < h - 1 && lab[idx + w] !== l);
        const a = edge ? 0.85 : 0.28;
        const col = colors[l]!;
        const o = idx * 4;
        rgba[o] += (col[0] - rgba[o]) * a;
        rgba[o + 1] += (col[1] - rgba[o + 1]) * a;
        rgba[o + 2] += (col[2] - rgba[o + 2]) * a;
      }
    }
  }
  for (const s of sides) {
    for (let j = 0, idx = 0; j < h; j++) {
      for (let i = 0; i < w; i++, idx++) {
        const a = s[idx];
        if (!a) continue;
        const r = i < w - 1 ? s[idx + 1] : 0;
        const d = j < h - 1 ? s[idx + w] : 0;
        if ((r && r !== a) || (d && d !== a)) {
          const o = idx * 4;
          rgba[o] = CUT_COLOR[0];
          rgba[o + 1] = CUT_COLOR[1];
          rgba[o + 2] = CUT_COLOR[2];
        }
      }
    }
  }
}

/**
 * Exact intersection of the nerve tubes with a planar image:
 * pixel (i, j) -> p0 + i*du + j*dv, `pxmm` = mm per image pixel.
 */
export function composeNerveSection(
  app: App,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  p0: Vec3,
  du: Vec3,
  dv: Vec3,
  pxmm: number,
) {
  const nerves = app.nerves.filter((n) => n.visible && n.pts.length >= 2);
  if (!nerves.length) return;
  const nrm = normalize(cross(du, dv));
  const k2 = 1 / (pxmm * pxmm);
  const dist = new Float32Array(w * h);
  const edge = Math.max(0.15, pxmm * 1.3);
  const col = NERVE_COLOR;
  for (const nerve of nerves) {
    const path = nervePath(nerve);
    const r = nerve.diameter / 2;
    dist.fill(Infinity);
    let bi0 = w;
    let bi1 = -1;
    let bj0 = h;
    let bj1 = -1;
    for (let s = 0; s + 1 < path.length; s++) {
      const a = path[s];
      const b = path[s + 1];
      const ax = a[0] - p0[0];
      const ay = a[1] - p0[1];
      const az = a[2] - p0[2];
      const bx = b[0] - p0[0];
      const by = b[1] - p0[1];
      const bz = b[2] - p0[2];
      const da = ax * nrm[0] + ay * nrm[1] + az * nrm[2];
      const db = bx * nrm[0] + by * nrm[1] + bz * nrm[2];
      if (Math.min(da, db) > r || Math.max(da, db) < -r) continue;
      // pixel coordinates of the ends
      const ia = (ax * du[0] + ay * du[1] + az * du[2]) * k2;
      const ja = (ax * dv[0] + ay * dv[1] + az * dv[2]) * k2;
      const ib = (bx * du[0] + by * du[1] + bz * du[2]) * k2;
      const jb = (bx * dv[0] + by * dv[1] + bz * dv[2]) * k2;
      const rp = r / pxmm + 2;
      const i0 = Math.max(0, Math.floor(Math.min(ia, ib) - rp));
      const i1 = Math.min(w - 1, Math.ceil(Math.max(ia, ib) + rp));
      const j0 = Math.max(0, Math.floor(Math.min(ja, jb) - rp));
      const j1 = Math.min(h - 1, Math.ceil(Math.max(ja, jb) + rp));
      if (i0 > i1 || j0 > j1) continue;
      bi0 = Math.min(bi0, i0);
      bi1 = Math.max(bi1, i1);
      bj0 = Math.min(bj0, j0);
      bj1 = Math.max(bj1, j1);
      const ex = bx - ax;
      const ey = by - ay;
      const ez = bz - az;
      const l2 = ex * ex + ey * ey + ez * ez || 1e-9;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          // pixel position relative to a
          const qx = du[0] * i + dv[0] * j - ax;
          const qy = du[1] * i + dv[1] * j - ay;
          const qz = du[2] * i + dv[2] * j - az;
          let t = (qx * ex + qy * ey + qz * ez) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = qx - ex * t;
          const dy = qy - ey * t;
          const dz = qz - ez * t;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const idx = j * w + i;
          if (d < dist[idx]) dist[idx] = d;
        }
      }
    }
    for (let j = bj0; j <= bj1; j++) {
      for (let i = bi0; i <= bi1; i++) {
        const idx = j * w + i;
        const d = dist[idx];
        if (d > r) continue;
        const a = d > r - edge ? 0.95 : 0.35;
        const o = idx * 4;
        rgba[o] += (col[0] - rgba[o]) * a;
        rgba[o + 1] += (col[1] - rgba[o + 1]) * a;
        rgba[o + 2] += (col[2] - rgba[o + 2]) * a;
      }
    }
  }
}

/** Nerve tubes projected into a 2D view (panoramic): translucent band with outlines. */
export function drawNervesProjected(app: App, o: CanvasRenderingContext2D, project: (w: Vec3) => { x: number; y: number }, mmPerPx: number) {
  const css = `rgb(${NERVE_COLOR[0]},${NERVE_COLOR[1]},${NERVE_COLOR[2]})`;
  for (const nerve of app.nerves) {
    if (!nerve.visible || nerve.pts.length < 2) continue;
    const pts = nervePath(nerve).map(project);
    const r = nerve.diameter / 2 / mmPerPx;
    o.save();
    o.lineJoin = 'round';
    o.lineCap = 'round';
    o.strokeStyle = `rgba(${NERVE_COLOR[0]},${NERVE_COLOR[1]},${NERVE_COLOR[2]},0.3)`;
    o.lineWidth = Math.max(2, 2 * r);
    o.beginPath();
    pts.forEach((p, i) => (i ? o.lineTo(p.x, p.y) : o.moveTo(p.x, p.y)));
    o.stroke();
    o.strokeStyle = css;
    o.lineWidth = 1.3;
    for (const side of [-1, 1]) {
      o.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        const x = pts[i].x + (-dy / l) * r * side;
        const y = pts[i].y + (dx / l) * r * side;
        if (i) o.lineTo(x, y);
        else o.moveTo(x, y);
      }
      o.stroke();
    }
    o.restore();
  }
}
