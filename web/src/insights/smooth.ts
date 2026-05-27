// Catmull-Rom-like cubic-bezier path smoother. Ported from the legacy
// SPA's smoothPath() (sidecar/public/app.html ~line 6571) with the same
// tension so the React chart matches the original. Pure function — no
// React, no SVG nodes — so it can be unit-tested without a DOM.

export interface Pt {
  x: number;
  y: number;
}

const TENSION = 0.18;

// Coordinates emitted into the `d` string are rounded so SVG attributes
// stay short and tests can pin exact values without floating-point noise.
// Two decimal places is plenty for the chart's pixel grid and matches
// the legacy SPA's smoothPath formatting.
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Builds an SVG path `d` from a sequence of points using a
 *  Catmull-Rom-like cubic Bezier. Returns an empty string for an empty
 *  input and a bare moveto for a single point. */
export function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${r(pts[0]!.x)} ${r(pts[0]!.y)}`;
  let d = `M ${r(pts[0]!.x)} ${r(pts[0]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * TENSION;
    const c1y = p1.y + (p2.y - p0.y) * TENSION;
    const c2x = p2.x - (p3.x - p1.x) * TENSION;
    const c2y = p2.y - (p3.y - p1.y) * TENSION;
    d += ` C ${r(c1x)} ${r(c1y)} ${r(c2x)} ${r(c2y)} ${r(p2.x)} ${r(p2.y)}`;
  }
  return d;
}
