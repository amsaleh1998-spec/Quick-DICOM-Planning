export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
/** Orthonormal frame given as its three axis vectors (columns of a rotation matrix). */
export type Frame = [Vec3, Vec3, Vec3];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
/** a + b * s */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/** Rodrigues rotation of v around the unit axis by angle (radians, right-handed). */
export function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d,
  ];
}

export function rotateFrame(f: Frame, axis: Vec3, angle: number): Frame {
  return reorthonormalize([rotate(f[0], axis, angle), rotate(f[1], axis, angle), rotate(f[2], axis, angle)]);
}

/** Gram-Schmidt to avoid drift after many incremental rotations. */
export function reorthonormalize(f: Frame): Frame {
  const e1 = normalize(f[0]);
  const e2 = normalize(addScaled(f[1], e1, -dot(f[1], e1)));
  const e3 = cross(e1, e2);
  return [e1, e2, e3];
}

export const identityFrame = (): Frame => [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** World point -> coordinates in frame (relative to origin). */
export function toFrame(p: Vec3, origin: Vec3, f: Frame): Vec3 {
  const q = sub(p, origin);
  return [dot(q, f[0]), dot(q, f[1]), dot(q, f[2])];
}

/** Frame coordinates -> world point. */
export function fromFrame(c: Vec3, origin: Vec3, f: Frame): Vec3 {
  return [
    origin[0] + f[0][0] * c[0] + f[1][0] * c[1] + f[2][0] * c[2],
    origin[1] + f[0][1] * c[0] + f[1][1] * c[1] + f[2][1] * c[2],
    origin[2] + f[0][2] * c[0] + f[1][2] * c[1] + f[2][2] * c[2],
  ];
}

/** Any unit vector perpendicular to n. */
export function perpendicular(n: Vec3): Vec3 {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(n, a));
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function distToSegment2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;
