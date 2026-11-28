export const TEST_SERIES: { cols: number; rows: number; slices: number; ps: number; dz: number; intercept: number; topZ: number };
export function makeTestSeries(opts?: {
  noExt?: boolean;
  raw?: 'implicit' | 'explicit' | null;
  /** the made-up patient written into the files (the name may be bytes in `charset`) */
  patient?: { name?: string | Uint8Array; id?: string; birth?: string; sex?: string } | null;
  /** series UID (another series needs its own) */
  uid?: string | null;
  /** file name prefix */
  prefix?: string;
  slices?: number;
  cols?: number;
  rows?: number;
  /** pixel and slice spacing (mm) */
  ps?: number;
  dz?: number;
  /** custom content: HU at (x, y, height above the lowest slice), mm */
  voxel?: ((x: number, y: number, z: number) => number) | null;
  description?: string;
  /** Specific Character Set (0008,0005), e.g. 'ISO_IR 192' */
  charset?: string | null;
}): { name: string; data: Uint8Array }[];
