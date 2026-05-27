import { describe, expect, it } from 'vitest';
import { smoothPath } from './smooth';

describe('smoothPath', () => {
  it('returns an empty string for an empty input', () => {
    expect(smoothPath([])).toBe('');
  });

  it('returns just a moveto for a single point', () => {
    expect(smoothPath([{ x: 10, y: 20 }])).toBe('M 10 20');
  });

  it('emits exactly one cubic segment for two points', () => {
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.match(/C /g)?.length).toBe(1);
  });

  it('emits N-1 cubic segments for N points', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 }, { x: 30, y: 12 },
    ];
    const d = smoothPath(pts);
    expect(d.match(/C /g)?.length).toBe(pts.length - 1);
  });

  it('starts with a moveto to the first point', () => {
    const d = smoothPath([{ x: 5, y: 7 }, { x: 9, y: 11 }]);
    expect(d.startsWith('M 5 7')).toBe(true);
  });

  it('uses the legacy SPA tension (0.18) — known 4-point case', () => {
    // pts = [(0,0),(10,10),(20,5),(30,12)], T=0.18
    // segment 0 → 1 with p0=p1 clamp:
    //   c1 = p1 + (p2 - p0)*0.18 = (0+10*0.18, 0+10*0.18) = (1.8, 1.8)
    //   c2 = p2 - (p3 - p1)*0.18 = (10-20*0.18, 10-5*0.18) = (6.4, 9.1)
    //   end = (10, 10)
    const d = smoothPath([
      { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 }, { x: 30, y: 12 },
    ]);
    expect(d).toContain('C 1.8 1.8 6.4 9.1 10 10');
  });

  it('does not overshoot beyond the data bounds for a monotonic series', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 30 },
    ];
    const min = 0;
    const max = 30;
    const slack = (max - min) * 0.05;
    const d = smoothPath(pts);
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // After the leading "M x y", every pair is (x, y).
    for (let i = 3; i < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(min - slack);
      expect(nums[i]).toBeLessThanOrEqual(max + slack);
    }
  });
});
