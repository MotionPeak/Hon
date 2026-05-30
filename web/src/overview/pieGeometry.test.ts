import { describe, it, expect } from 'vitest';
import { buildSlices, donutArcPath } from './pieGeometry';
import type { PieCat } from './spend';

function cat(category: string, amount: number): PieCat {
  return { category, amount, changePct: null, color: '#000', emoji: '🏷️' };
}

describe('buildSlices', () => {
  it('returns nothing for an empty / zero total', () => {
    expect(buildSlices([], 120, 120, 104, 68, 9)).toEqual([]);
    expect(buildSlices([cat('A', 0)], 120, 120, 104, 68, 9)).toEqual([]);
  });

  it('draws a single category as one full-ring slice with no push', () => {
    const slices = buildSlices([cat('Only', 500)], 120, 120, 104, 68, 9);
    expect(slices).toHaveLength(1);
    expect(slices[0].category).toBe('Only');
    expect(slices[0].mx).toBe(0);
    expect(slices[0].my).toBe(0);
    expect(slices[0].d.startsWith('M ')).toBe(true);
  });

  it('emits one slice per category, each pushed along its own mid-angle', () => {
    const slices = buildSlices(
      [cat('A', 100), cat('B', 100), cat('C', 100), cat('D', 100)],
      120, 120, 104, 68, 9,
    );
    expect(slices.map((s) => s.category)).toEqual(['A', 'B', 'C', 'D']);
    // Push offset magnitude equals pushPx for every slice (it sits on a circle
    // of radius pushPx around the centre).
    for (const s of slices) {
      expect(Math.hypot(s.mx, s.my)).toBeCloseTo(9, 1);
    }
  });
});

describe('donutArcPath', () => {
  it('flags the large-arc sweep for segments over 180°', () => {
    const big = donutArcPath(120, 120, 104, 68, 0, Math.PI * 1.5);
    expect(big).toContain(' 1 1 '); // large-arc-flag set on the outer arc
    const small = donutArcPath(120, 120, 104, 68, 0, Math.PI * 0.5);
    expect(small).toContain(' 0 1 '); // large-arc-flag clear
  });
});
