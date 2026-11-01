import { Vec3, addScaled, dot, neg, sub } from './math';

/** Generic multi-unit abutment (MUA). */
export interface Abutment {
  /** angulation relative to the implant axis (0, 17, 30°) */
  angle: number;
  /** gingival (collar) height in mm */
  gingivalHeight: number;
  /** rotation of the angled head around the implant axis, degrees (0 = buccal) */
  rotation: number;
}

export const MUA_DIAMETER = 4.8;
export const MUA_HEAD_HEIGHT = 3;
export const MUA_ANGLES = [0, 17, 30];
export const MUA_HEIGHTS = [1, 2, 3, 4, 5];

export interface Implant {
  id: number;
  name: string;
  /** centre of the cylinder (world mm) */
  center: Vec3;
  /** unit axis direction pointing from the platform (coronal) towards the apex */
  axis: Vec3;
  diameter: number;
  length: number;
  abutment: Abutment | null;
}

/** A cylinder primitive used for drawing / hit testing. */
export interface Cylinder {
  center: Vec3;
  /** unit axis */
  axis: Vec3;
  radius: number;
  half: number;
  kind: 'implant' | 'abutment';
  implant: Implant;
}

let nextId = 1;

/** Make sure new implants get ids above the restored ones. */
export function reserveImplantIds(maxId: number) {
  nextId = Math.max(nextId, maxId + 1);
}

export function createImplant(center: Vec3, axis: Vec3, diameter = 4, length = 10): Implant {
  const id = nextId++;
  return { id, name: `Implant ${id}`, center, axis, diameter, length, abutment: null };
}

/** Centre of the implant platform (coronal end). */
export function platformOf(imp: Implant): Vec3 {
  return addScaled(imp.center, imp.axis, -imp.length / 2);
}

export function apexOf(imp: Implant): Vec3 {
  return addScaled(imp.center, imp.axis, imp.length / 2);
}

/** Change the length keeping the platform fixed (only the apical part grows/shrinks). */
export function setImplantLength(imp: Implant, length: number) {
  const p = platformOf(imp);
  imp.length = length;
  imp.center = addScaled(p, imp.axis, length / 2);
}

/** Set a new axis, rotating the implant around its platform. */
export function setImplantAxis(imp: Implant, axis: Vec3) {
  const p = platformOf(imp);
  imp.axis = axis;
  imp.center = addScaled(p, axis, imp.length / 2);
}

/**
 * Cylinders making up the implant and its abutment. `abutmentDir` is the
 * coronal direction of the abutment head (computed by the app).
 */
export function implantParts(imp: Implant, abutmentDir: Vec3 | null): Cylinder[] {
  const parts: Cylinder[] = [
    { center: imp.center, axis: imp.axis, radius: imp.diameter / 2, half: imp.length / 2, kind: 'implant', implant: imp },
  ];
  const ab = imp.abutment;
  if (ab) {
    const up = neg(imp.axis);
    const p = platformOf(imp);
    const gh = ab.gingivalHeight;
    parts.push({
      center: addScaled(p, up, gh / 2),
      axis: up,
      radius: MUA_DIAMETER / 2,
      half: gh / 2,
      kind: 'abutment',
      implant: imp,
    });
    const dir = abutmentDir ?? up;
    const top = addScaled(p, up, gh);
    parts.push({
      center: addScaled(top, dir, MUA_HEAD_HEIGHT / 2),
      axis: dir,
      radius: MUA_DIAMETER / 2,
      half: MUA_HEAD_HEIGHT / 2,
      kind: 'abutment',
      implant: imp,
    });
  }
  return parts;
}

/**
 * Approximate signed distance from p to a cylinder surface (negative inside)
 * plus the axial coordinate h of p (0 at the centre).
 */
export function cylinderDistance(c: { center: Vec3; axis: Vec3; radius: number; half: number }, p: Vec3): { d: number; h: number } {
  const q = sub(p, c.center);
  const h = dot(q, c.axis);
  const rad = Math.sqrt(Math.max(0, dot(q, q) - h * h));
  return { d: Math.max(rad - c.radius, Math.abs(h) - c.half), h };
}

export const IMPLANT_COLOR: [number, number, number] = [64, 214, 128];
export const IMPLANT_SELECTED_COLOR: [number, number, number] = [255, 184, 28];
export const ABUTMENT_COLOR: [number, number, number] = [140, 180, 230];
export const ABUTMENT_SELECTED_COLOR: [number, number, number] = [200, 225, 255];
