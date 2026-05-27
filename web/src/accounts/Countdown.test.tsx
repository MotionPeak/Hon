import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Countdown } from './Countdown';

describe('Countdown', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 4, 27, 12, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders MM:SS remaining', () => {
    const deadlineMs = Date.now() + 4 * 60 * 1000 + 30 * 1000; // 4:30
    render(<Countdown deadlineMs={deadlineMs} />);
    expect(screen.getByText('4:30')).toBeInTheDocument();
  });

  it('ticks down every second', () => {
    const deadlineMs = Date.now() + 5_000;
    render(<Countdown deadlineMs={deadlineMs} />);
    expect(screen.getByText('0:05')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByText('0:04')).toBeInTheDocument();
  });

  it('clamps to 0:00 once the deadline has passed', () => {
    const deadlineMs = Date.now() - 1_000;
    render(<Countdown deadlineMs={deadlineMs} />);
    expect(screen.getByText('0:00')).toBeInTheDocument();
  });
});
