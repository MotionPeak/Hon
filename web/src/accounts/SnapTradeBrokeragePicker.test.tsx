import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SnapTradeBrokeragePicker } from './SnapTradeBrokeragePicker';
import type { BrokerageOption } from './types';

const SAMPLE: BrokerageOption[] = [
  { slug: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers', logoUrl: '/ibkr.png' },
  { slug: 'SCHWAB',              name: 'Charles Schwab',     logoUrl: '/schwab.png' },
  { slug: 'ROBINHOOD',           name: 'Robinhood',          logoUrl: '/rh.png' },
];

describe('SnapTradeBrokeragePicker', () => {
  it('renders one row per brokerage', () => {
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    expect(screen.getByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charles Schwab/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Robinhood/i })).toBeInTheDocument();
  });

  it('calls onPick(slug, name) when a row is clicked', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={onPick} />);
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));
    expect(onPick).toHaveBeenCalledWith('INTERACTIVE_BROKERS', 'Interactive Brokers');
  });

  it('shows an empty hint when the list is empty', () => {
    render(<SnapTradeBrokeragePicker brokerages={[]} onPick={() => {}} />);
    expect(screen.getByText(/no brokerages/i)).toBeInTheDocument();
  });

  it('flags IBKR as pre-focused via data attribute', () => {
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    const ibkr = screen.getByRole('button', { name: /Interactive Brokers/i });
    expect(ibkr).toHaveAttribute('data-pre-focused', 'true');
  });

  it('does not pre-focus anything when IBKR is absent', () => {
    const noIbkr = SAMPLE.filter((b) => b.slug !== 'INTERACTIVE_BROKERS');
    render(<SnapTradeBrokeragePicker brokerages={noIbkr} onPick={() => {}} />);
    expect(document.querySelector('[data-pre-focused="true"]')).toBeNull();
  });

  it('filters the list as the user types (case-insensitive substring)', async () => {
    const user = userEvent.setup();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    await user.type(screen.getByRole('searchbox', { name: /search brokerages/i }), 'schw');
    expect(screen.getByRole('button', { name: /Charles Schwab/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Interactive Brokers/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Robinhood/i })).toBeNull();
  });

  it('shows the no-match hint when the query matches nothing', async () => {
    const user = userEvent.setup();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    await user.type(screen.getByRole('searchbox', { name: /search brokerages/i }), 'zzz');
    expect(screen.getByText(/no brokerages/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Charles Schwab/i })).toBeNull();
  });

  it('clearing the query restores the full list', async () => {
    const user = userEvent.setup();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    const box = screen.getByRole('searchbox', { name: /search brokerages/i });
    await user.type(box, 'schw');
    expect(screen.queryByRole('button', { name: /Robinhood/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /clear search/i }));
    expect(screen.getByRole('button', { name: /Robinhood/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
  });
});
