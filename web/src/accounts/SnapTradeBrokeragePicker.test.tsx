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
  it('renders one card per brokerage', () => {
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    expect(screen.getByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charles Schwab/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Robinhood/i })).toBeInTheDocument();
  });

  it('filters case-insensitively by name', async () => {
    const user = userEvent.setup();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    await user.type(screen.getByPlaceholderText(/search brokerages/i), 'schw');
    expect(screen.queryByRole('button', { name: /Interactive Brokers/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Charles Schwab/i })).toBeInTheDocument();
  });

  it('calls onPick(slug) when a card is clicked', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={onPick} />);
    await user.click(screen.getByRole('button', { name: /Interactive Brokers/i }));
    expect(onPick).toHaveBeenCalledWith('INTERACTIVE_BROKERS');
  });

  it('shows an empty state when the filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<SnapTradeBrokeragePicker brokerages={SAMPLE} onPick={() => {}} />);
    await user.type(screen.getByPlaceholderText(/search brokerages/i), 'xyzzy');
    expect(screen.getByText(/no brokerages match/i)).toBeInTheDocument();
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
});
