export const TEST_SERIES: { cols: number; rows: number; slices: number; ps: number; dz: number; intercept: number; topZ: number };
export function makeTestSeries(opts?: {
  noExt?: boolean;
  raw?: 'implicit' | 'explicit' | null;
  /** the made-up patient written into the files */
  patient?: { name?: string; id?: string; birth?: string; sex?: string } | null;
  /** series UID (another series needs its own) */
  uid?: string | null;
  /** file name prefix */
  prefix?: string;
  slices?: number;
}): { name: string; data: Uint8Array }[];
