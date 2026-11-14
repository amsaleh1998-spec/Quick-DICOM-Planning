import { describe, expect, it } from 'vitest';
import { guessJaw, guessKind } from '../../src/scans';

describe('scan names', () => {
  it('give the kind and the jaw', () => {
    expect(guessKind('Lower_scan.stl')).toBe('lower');
    expect(guessKind('UpperJaw.stl')).toBe('upper');
    expect(guessKind('Waxup_lower.stl')).toBe('waxup');
    expect(guessJaw('Waxup_lower.stl')).toBe('lower');
    expect(guessJaw('Antagonist maxilla.ply')).toBe('upper');
    expect(guessJaw('bite.stl')).toBeNull();
  });
});
