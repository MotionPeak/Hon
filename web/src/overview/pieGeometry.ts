import type { PieCat } from './spend';

export interface Slice {
  category: string;
  amount: number;
  /** SVG path string for the donut segment. */
  d: string;
  /** Outward push offset (px) along the slice mid-angle — drives the hover
   *  lift via the `--mx` / `--my` custom properties. */
  mx: number;
  my: number;
}

/**
 * SVG path for one donut segment between two angles (radians). Outer arc
 * sweeps clockwise, inner arc back — a closed ring slice. Lifted verbatim from
 * the legacy SPA's `donutArcPath` so the geometry matches pixel-for-pixel.
 */
export function donutArcPath(
  cx: number, cy: number, rO: number, rI: number, a0: number, a1: number,
): string {
  const x0o = cx + Math.cos(a0) * rO, y0o = cy + Math.sin(a0) * rO;
  const x1o = cx + Math.cos(a1) * rO, y1o = cy + Math.sin(a1) * rO;
  const x0i = cx + Math.cos(a1) * rI, y0i = cy + Math.sin(a1) * rI;
  const x1i = cx + Math.cos(a0) * rI, y1i = cy + Math.sin(a0) * rI;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return 'M ' + x0o + ' ' + y0o
    + ' A ' + rO + ' ' + rO + ' 0 ' + large + ' 1 ' + x1o + ' ' + y1o
    + ' L ' + x0i + ' ' + y0i
    + ' A ' + rI + ' ' + rI + ' 0 ' + large + ' 0 ' + x1i + ' ' + y1i
    + ' Z';
}

/** Single-category special case: a full ring drawn as two opposed half-arcs,
 *  since a 360° slice is degenerate for the arc formula above. */
export function donutFullPath(cx: number, cy: number, rO: number, rI: number): string {
  return 'M ' + (cx - rO) + ' ' + cy
    + ' A ' + rO + ' ' + rO + ' 0 1 0 ' + (cx + rO) + ' ' + cy
    + ' A ' + rO + ' ' + rO + ' 0 1 0 ' + (cx - rO) + ' ' + cy + ' Z'
    + ' M ' + (cx - rI) + ' ' + cy
    + ' A ' + rI + ' ' + rI + ' 0 1 1 ' + (cx + rI) + ' ' + cy
    + ' A ' + rI + ' ' + rI + ' 0 1 1 ' + (cx - rI) + ' ' + cy + ' Z';
}

/**
 * Turn sorted category spend into renderable donut slices. Angles start at
 * 12 o'clock (−π/2) and sweep clockwise, proportional to each category's share
 * of the total. A lone category gets the full-ring path with no push offset.
 */
export function buildSlices(
  cats: PieCat[],
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  pushPx: number,
): Slice[] {
  const total = cats.reduce((s, c) => s + c.amount, 0);
  if (total <= 0) return [];

  if (cats.length === 1) {
    return [{
      category: cats[0].category,
      amount: cats[0].amount,
      d: donutFullPath(cx, cy, rOuter, rInner),
      mx: 0,
      my: 0,
    }];
  }

  let acc = 0;
  return cats.map((c) => {
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += c.amount;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const mid = (a0 + a1) / 2;
    return {
      category: c.category,
      amount: c.amount,
      d: donutArcPath(cx, cy, rOuter, rInner, a0, a1),
      mx: Number((Math.cos(mid) * pushPx).toFixed(2)),
      my: Number((Math.sin(mid) * pushPx).toFixed(2)),
    };
  });
}
