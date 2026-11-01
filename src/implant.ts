import { Vec3, dot, sub } from './math';

export interface Implant {
  id: number;
  name: string;
  /** centre of the cylinder (world mm) */
  center: Vec3;
  /** unit axis direction */
  axis: Vec3;
  diameter: number;
  length: number;
}

let nextId = 1;

export function createImplant(center: Vec3, axis: Vec3, diameter = 4, length = 10): Implant {
  const id = nextId++;
  return { id, name: `Implant ${id}`, center, axis, diameter, length };
}

/**
 * Approximate signed distance from p to the implant surface (negative inside)
 * plus the axial coordinate h of p (0 at the centre).
 */
export function implantDistance(imp: Implant, p: Vec3): { d: number; h: number } {
  const q = sub(p, imp.center);
  const h = dot(q, imp.axis);
  const rad = Math.sqrt(Math.max(0, dot(q, q) - h * h));
  const dr = rad - imp.diameter / 2;
  const dh = Math.abs(h) - imp.length / 2;
  return { d: Math.max(dr, dh), h };
}

export const IMPLANT_COLOR: [number, number, number] = [64, 214, 128];
export const IMPLANT_SELECTED_COLOR: [number, number, number] = [255, 184, 28];
