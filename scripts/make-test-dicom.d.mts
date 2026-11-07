export const TEST_SERIES: { cols: number; rows: number; slices: number; ps: number; dz: number; intercept: number; topZ: number };
export function makeTestSeries(opts?: { noExt?: boolean; raw?: 'implicit' | 'explicit' | null }): { name: string; data: Uint8Array }[];
