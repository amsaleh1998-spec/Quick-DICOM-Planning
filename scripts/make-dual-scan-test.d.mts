type V3 = [number, number, number];
/** denture -> patient, 3×4 row-major */
export const T: number[];
export function applyT(p: number[], m?: number[]): V3;
export const MARKERS: V3[];
export const MARKER_R: number;
export const DENTURE_GRID: { cols: number; rows: number; slices: number; ps: number; dz: number };
export const PATIENT_GRID: { cols: number; rows: number; slices: number; ps: number; dz: number };
export function dentureValue(x: number, y: number, z: number): number;
export function patientValue(x: number, y: number, z: number): number;
export function makeDualScanSeries(): { denture: { name: string; data: Uint8Array }[]; patient: { name: string; data: Uint8Array }[] };
