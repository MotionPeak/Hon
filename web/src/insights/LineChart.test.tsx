import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LineChart } from './LineChart';

const SERIES = [
  { date: '2026-01-01', value: 100 },
  { date: '2026-02-01', value: 120 },
  { date: '2026-03-01', value: 90 },
  { date: '2026-04-01', value: 150 },
];

describe('LineChart — static render', () => {
  it('renders an svg tagged for the brokerage chart', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    expect(screen.getByTestId('brokerage-chart')).toBeInTheDocument();
  });

  it('renders 4 horizontal grid lines', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const svg = screen.getByTestId('brokerage-chart');
    expect(svg.querySelectorAll('line.lc-grid')).toHaveLength(4);
  });

  it('renders glow + area + line paths', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const svg = screen.getByTestId('brokerage-chart');
    expect(svg.querySelector('path.lc-glow')).not.toBeNull();
    expect(svg.querySelector('path.lc-area')).not.toBeNull();
    expect(svg.querySelector('path.lc-line')).not.toBeNull();
  });

  it('the line path is a smooth (cubic) path', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const d = screen.getByTestId('brokerage-chart')
      .querySelector('path.lc-line')!.getAttribute('d')!;
    expect(d).toContain(' C ');
  });

  it('applies the tone class on the wrapper', () => {
    const { rerender, container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    expect(container.querySelector('.lc-wrap.lc-good')).not.toBeNull();
    rerender(<LineChart series={SERIES} currency="USD" tone="bad" />);
    expect(container.querySelector('.lc-wrap.lc-bad')).not.toBeNull();
  });

  it('renders a start + end date axis by default', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" />);
    const axis = screen.getByTestId('brokerage-chart-axis');
    // Two spans: first + last date.
    expect(axis.children).toHaveLength(2);
  });

  it('omits the axis when showAxis is false', () => {
    render(<LineChart series={SERIES} currency="USD" tone="good" showAxis={false} />);
    expect(screen.queryByTestId('brokerage-chart-axis')).toBeNull();
  });

  it('renders a single moveto for a one-point series without crashing', () => {
    render(<LineChart series={[{ date: '2026-01-01', value: 100 }]} currency="USD" tone="good" />);
    expect(screen.getByTestId('brokerage-chart')).toBeInTheDocument();
  });

  it('renders without a broken path for an empty series', () => {
    render(<LineChart series={[]} currency="USD" tone="good" />);
    const svg = screen.getByTestId('brokerage-chart');
    const area = svg.querySelector('path.lc-area')?.getAttribute('d') ?? '';
    // No area path, or a well-formed one starting with a moveto.
    expect(area === '' || area.startsWith('M')).toBe(true);
    // And it doesn't crash — chart still in the DOM.
    expect(svg).toBeInTheDocument();
  });
});

describe('LineChart — hover', () => {
  // jsdom gives every element a 0x0 box; stub a real width so the
  // hover math (clientX → xPct → nearest index) has something to chew on.
  function stubBox(el: Element, width = 400, left = 0) {
    el.getBoundingClientRect = () => ({
      width, height: 200, left, top: 0, right: left + width, bottom: 200,
      x: left, y: 0, toJSON: () => ({}),
    });
  }

  it('shows crosshair + dot + tooltip on mouse move and hides on leave', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    // Move near the far right → last point (value 150).
    fireEvent.mouseMove(wrap, { clientX: 398 });
    expect(container.querySelector('.lc-cross.on')).not.toBeNull();
    expect(container.querySelector('.lc-dot.on')).not.toBeNull();
    const tip = container.querySelector('.lc-tip.on')!;
    expect(tip).not.toBeNull();
    expect(tip.querySelector('.lc-tip-val')!.textContent).toMatch(/150/);
    // Leave clears.
    fireEvent.mouseLeave(wrap);
    expect(container.querySelector('.lc-cross.on')).toBeNull();
    expect(container.querySelector('.lc-tip.on')).toBeNull();
  });

  it('tooltip shows the matching date and a "Since start" extra', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    fireEvent.mouseMove(wrap, { clientX: 398 });
    const tip = container.querySelector('.lc-tip')!;
    expect(tip.querySelector('.lc-tip-date')!.textContent).toMatch(/Apr/);
    // Since start: 150 vs first 100 → +50 / +50%.
    const extras = tip.querySelector('.lc-tip-extras')!;
    expect(extras.textContent).toMatch(/Since start/i);
    expect(extras.textContent).toMatch(/50/);
  });

  it('flips the tooltip to .right near the right edge and .left near the left', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    fireEvent.mouseMove(wrap, { clientX: 398 }); // ~99% → right
    expect(container.querySelector('.lc-tip.right')).not.toBeNull();
    fireEvent.mouseMove(wrap, { clientX: 2 });   // ~0% → left
    expect(container.querySelector('.lc-tip.left')).not.toBeNull();
  });

  it('responds to touchmove and clears on touchend', () => {
    const { container } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    fireEvent.touchMove(wrap, { touches: [{ clientX: 398 }] });
    expect(container.querySelector('.lc-tip.on')).not.toBeNull();
    fireEvent.touchEnd(wrap);
    expect(container.querySelector('.lc-tip.on')).toBeNull();
  });

  it('drops a stale hover when the series shrinks out from under it', () => {
    const { container, rerender } = render(
      <LineChart series={SERIES} currency="USD" tone="good" />,
    );
    const wrap = container.querySelector('.lc-wrap')!;
    stubBox(wrap);
    // Hover the last point (index 3) of the 4-point series.
    fireEvent.mouseMove(wrap, { clientX: 398 });
    expect(container.querySelector('.lc-tip.on')).not.toBeNull();
    // Parent swaps in a shorter 2-point series; index 3 is now out of range.
    rerender(
      <LineChart series={SERIES.slice(0, 2)} currency="USD" tone="good" />,
    );
    // No crash, and the overlay is hidden because the index is invalid.
    expect(container.querySelector('.lc-tip.on')).toBeNull();
  });
});
