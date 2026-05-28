import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
