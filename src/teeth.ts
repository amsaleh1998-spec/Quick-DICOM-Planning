// Tooth positions (FDI) for implants: the tooth an implant replaces, guessed from where it sits
// along the panoramic curve, and what the tooth chart in the Implants panel is laid out with.

import type { App, Jaw } from './app';
import type { Implant } from './implant';
import { toFrame } from './math';
import { curveMidline } from './waxup/waxup';

/** Mean mesiodistal crown widths (mm), central incisor -> third molar. */
export const TOOTH_WIDTH: Record<Jaw, number[]> = {
  upper: [8.6, 6.6, 7.6, 7.0, 6.6, 10.2, 9.2, 8.6],
  lower: [5.3, 5.9, 6.8, 7.0, 7.1, 11.0, 10.5, 10.0],
};

export const isFdi = (n: number) => Number.isInteger(n) && n >= 11 && n <= 48 && n % 10 >= 1 && n % 10 <= 8 && Math.floor(n / 10) <= 4;

/** The tooth an implant's name stands for (implants named after their tooth: "36"), or null. */
export function toothOfName(name: string): number | null {
  const n = /^\s*(\d\d)\s*$/.exec(name)?.[1];
  return n && isFdi(Number(n)) ? Number(n) : null;
}

/** FDI teeth of a jaw, patient right -> left (as seen in the panoramic). */
export function jawTeeth(jaw: Jaw): number[] {
  const [r, l] = jaw === 'upper' ? [1, 2] : [4, 3];
  return [...[8, 7, 6, 5, 4, 3, 2, 1].map((k) => r * 10 + k), ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => l * 10 + k)];
}

/**
 * The tooth at an implant's place: its distance along the curve from the midline (the front of
 * the arch), counted off in mean tooth widths, on the side and in the jaw it points to.
 */
export function guessTooth(app: App, imp: Implant): number | null {
  const curve = app.curve;
  if (!curve) return null;
  const f = toFrame(imp.center, app.O, app.frame);
  const d = curve.nearest(f[0], f[1]).s - curveMidline(curve); // < 0: patient right
  const jaw = app.implantJaw(imp);
  let acc = 0;
  let k = 8;
  for (let i = 0; i < 8; i++) {
    acc += TOOTH_WIDTH[jaw][i];
    if (Math.abs(d) < acc) {
      k = i + 1;
      break;
    }
  }
  const q = jaw === 'upper' ? (d < 0 ? 1 : 2) : d < 0 ? 4 : 3;
  return q * 10 + k;
}

/** Name for a new implant: its tooth when no other implant has it, else "Implant n". */
export function nameForTooth(app: App, imp: Implant): string {
  const t = guessTooth(app, imp);
  return t && !app.implants.some((o) => o !== imp && toothOfName(o.name) === t) ? String(t) : imp.name;
}
