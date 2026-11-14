import { describe, expect, it } from 'vitest';
import { type Segment, isNerveSegment, segmentInSlices } from '../../src/segment';

const seg = (o: Partial<Segment>): Segment => ({ id: 1, name: 'Mandible', color: [0, 0, 0], visible: true, seeds: [], voxels: 1, ...o });

describe('segments in the slices', () => {
  it('shows only nerve canals by default', () => {
    expect(segmentInSlices(seg({ ai: { cls: 5, model: 'DentalSegmentator' }, name: 'Mandibular canal' }))).toBe(true);
    expect(segmentInSlices(seg({ name: 'Nerve right' }))).toBe(true);
    for (const cls of [1, 2, 3, 4]) expect(segmentInSlices(seg({ ai: { cls, model: 'DentalSegmentator' } }))).toBe(false);
    expect(segmentInSlices(seg({ name: 'Tooth' }))).toBe(false);
  });
  it('follows the segment’s own setting', () => {
    expect(segmentInSlices(seg({ slices: true }))).toBe(true);
    expect(segmentInSlices(seg({ ai: { cls: 5, model: 'x' }, slices: false }))).toBe(false);
    expect(isNerveSegment(seg({ name: 'Mandibular canal' }))).toBe(true);
  });
});
