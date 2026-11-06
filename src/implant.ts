import { Vec3, addScaled, neg } from './math';

/** Generic multi-unit abutment (MUA). */
export interface Abutment {
  /** angulation relative to the implant axis (0, 17, 30°) */
  angle: number;
  /** gingival (collar) height in mm */
  gingivalHeight: number;
  /** rotation of the angled head around the implant axis, degrees (0 = buccal) */
  rotation: number;
}

/** Generic MUA profile (mm): narrow at the implant, widest at the gingiva, tapering to the top. */
export const MUA_BASE_DIAMETER = 3.5; // at the implant platform
export const MUA_DIAMETER = 4.8; // at gingival level
export const MUA_HEAD_HEIGHT = 2.5; // protrusion above the gingival level
export const MUA_TOP_DIAMETER = 3; // most coronal part of the abutment
/** Prosthetic axis drawn from the top of the MUA (screw channel / path of insertion). */
export const PROSTHETIC_AXIS_DIAMETER = 3;
export const PROSTHETIC_AXIS_LENGTH = 15;
export const MUA_ANGLES = [0, 17, 30];
export const MUA_HEIGHTS = [1, 2, 3, 4, 5];

export interface Implant {
  id: number;
  name: string;
  /** centre of the cylinder (world mm) */
  center: Vec3;
  /** unit axis direction pointing from the platform (coronal) towards the apex */
  axis: Vec3;
  /** diameter at the platform (coronal) */
  diameter: number;
  /** diameter at the apex for tapered implants; null = same as `diameter` (cylindrical) */
  apicalDiameter: number | null;
  length: number;
  abutment: Abutment | null;
  /** draw the Ø3 × 15 mm prosthetic axis (from the MUA top, or from the platform without an MUA) */
  showProstheticAxis: boolean;
  /** hidden implants (with their abutment and axis) are not drawn and cannot be clicked */
  hidden: boolean;
  /** hide only the abutment (MUA) */
  abutmentHidden: boolean;
}

export const MIN_APICAL_DIAMETER = 1.5;
/** longest implant that can be planned (zygomatic implants: ~30–57.5 mm) */
export const MAX_IMPLANT_LENGTH = 60;

export function apicalDiameterOf(imp: Implant): number {
  return imp.apicalDiameter ?? imp.diameter;
}

export function isTapered(imp: Implant): boolean {
  return imp.apicalDiameter !== null && imp.apicalDiameter < imp.diameter;
}

/** Implant radius at axial coordinate h (0 = centre, + = towards the apex). */
export function implantRadiusAt(imp: Implant, h: number): number {
  const t = Math.min(1, Math.max(0, (h + imp.length / 2) / imp.length));
  return (imp.diameter + (apicalDiameterOf(imp) - imp.diameter) * t) / 2;
}

/** Set the platform diameter; a tapered apex is kept no wider than the platform. */
export function setCoronalDiameter(imp: Implant, d: number) {
  imp.diameter = d;
  if (imp.apicalDiameter !== null && imp.apicalDiameter > d) imp.apicalDiameter = d;
}

/** Set the apical diameter (makes the implant tapered); clamped to [1.5, platform]. */
export function setApicalDiameter(imp: Implant, d: number) {
  imp.apicalDiameter = Math.min(imp.diameter, Math.max(MIN_APICAL_DIAMETER, d));
}

/**
 * A cylinder or truncated cone used for drawing / hit testing. Radius r0 is at
 * centre - axis*half, r1 at centre + axis*half.
 */
export interface Cylinder {
  center: Vec3;
  /** unit axis */
  axis: Vec3;
  /** largest radius (for bounds) */
  radius: number;
  r0: number;
  r1: number;
  half: number;
  /** 'prosthetic' = prosthetic axis guide (drawn translucent, not clickable) */
  kind: 'implant' | 'abutment' | 'prosthetic';
  implant: Implant;
}

/** Part along `dir` from point `from`, `len` long, radius rStart → rEnd. */
function cone(from: Vec3, dir: Vec3, len: number, rStart: number, rEnd: number, kind: Cylinder['kind'], implant: Implant): Cylinder {
  return {
    center: addScaled(from, dir, len / 2),
    axis: dir,
    radius: Math.max(rStart, rEnd),
    r0: rStart,
    r1: rEnd,
    half: len / 2,
    kind,
    implant,
  };
}

/** Radius of a part at axial coordinate h (0 = centre). */
export function radiusAt(c: Cylinder, h: number): number {
  const t = c.half > 0 ? (h + c.half) / (2 * c.half) : 0.5;
  return c.r0 + (c.r1 - c.r0) * Math.min(1, Math.max(0, t));
}

let nextId = 1;

/** Make sure new implants get ids above the restored ones. */
export function reserveImplantIds(maxId: number) {
  nextId = Math.max(nextId, maxId + 1);
}

export function createImplant(center: Vec3, axis: Vec3, diameter = 4, length = 10): Implant {
  const id = nextId++;
  return { id, name: `Implant ${id}`, center, axis, diameter, apicalDiameter: null, length, abutment: null, showProstheticAxis: false, hidden: false, abutmentHidden: false };
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
  if (imp.hidden) return [];
  const r = imp.diameter / 2;
  const ra = apicalDiameterOf(imp) / 2; // r0 = platform end, r1 = apex end
  const parts: Cylinder[] = [
    { center: imp.center, axis: imp.axis, radius: Math.max(r, ra), r0: r, r1: ra, half: imp.length / 2, kind: 'implant', implant: imp },
  ];
  const up = neg(imp.axis);
  const p = platformOf(imp);
  // where the prosthetic axis starts and which way it points
  let axisStart = p;
  let axisDir = up;
  const ab = imp.abutment;
  if (ab) {
    const gh = ab.gingivalHeight;
    // transmucosal collar: Ø3.5 at the implant -> Ø4.8 at the gingiva
    if (!imp.abutmentHidden) parts.push(cone(p, up, gh, MUA_BASE_DIAMETER / 2, MUA_DIAMETER / 2, 'abutment', imp));
    // head: 2.5 mm above the gingiva, Ø4.8 -> Ø3 (follows the abutment angulation)
    const dir = abutmentDir ?? up;
    const gingiva = addScaled(p, up, gh);
    if (!imp.abutmentHidden) parts.push(cone(gingiva, dir, MUA_HEAD_HEIGHT, MUA_DIAMETER / 2, MUA_TOP_DIAMETER / 2, 'abutment', imp));
    axisStart = addScaled(gingiva, dir, MUA_HEAD_HEIGHT);
    axisDir = dir;
  }
  if (imp.showProstheticAxis) {
    // prosthetic axis: Ø3, 15 mm from the top of the MUA (or from the implant platform)
    const pr = PROSTHETIC_AXIS_DIAMETER / 2;
    parts.push(cone(axisStart, axisDir, PROSTHETIC_AXIS_LENGTH, pr, pr, 'prosthetic', imp));
  }
  return parts;
}

export const IMPLANT_COLOR: [number, number, number] = [64, 214, 128];
export const IMPLANT_SELECTED_COLOR: [number, number, number] = [255, 184, 28];
export const ABUTMENT_COLOR: [number, number, number] = [140, 180, 230];
export const ABUTMENT_SELECTED_COLOR: [number, number, number] = [200, 225, 255];
export const PROSTHETIC_COLOR: [number, number, number] = [232, 121, 249];
