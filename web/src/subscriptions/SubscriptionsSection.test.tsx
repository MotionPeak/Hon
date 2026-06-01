import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SubscriptionsSection } from './SubscriptionsSection';

const today = new Date();
function daysAgo(n: number): string {
  const d = new Date(today.getTime() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
function txn(over: Partial<{ id: string; date: string; description: string; amount: number; category: string | null }>) {
  return {
    id: over.id ?? 't', accountId: 'a', externalId: 'x',
    date: over.date ?? daysAgo(10), processedDate: null,
    amount: over.amount ?? -50, currency: 'ILS',
    description: over.description ?? 'Netflix', memo: null,
    kind: null, status: null,
    category: over.category ?? 'Subscriptions', createdAt: '2025-01-01',
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render_ = (transactions: any[], frequencies: Record<string, string> = {}, cancelled: Record<string, string> = {}) =>
  render(<SubscriptionsSection transactions={transactions as any} frequencies={frequencies as any} cancelled={cancelled} />);

describe('SubscriptionsSection', () => {
  it('shows the empty state when no Subscriptions txns exist', () => {
    render_([]);
    expect(screen.getByText(/no subscription charges/i)).toBeInTheDocument();
  });

  it('groups active subs (recent charge) under the Active section', () => {
    render_([txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 })]);
    const active = screen.getByRole('heading', { name: /^active$/i }).closest('section')!;
    expect(within(active as HTMLElement).getByText('Netflix')).toBeInTheDocument();
  });

  it('separates "Probably cancelled" subs with last charge > 40 days old', () => {
    render_([txn({ id: 't1', description: 'OldGym', date: daysAgo(120), amount: -200 })]);
    const lapsed = screen.getByRole('heading', { name: /probably cancelled/i }).closest('section')!;
    expect(within(lapsed as HTMLElement).getByText('OldGym')).toBeInTheDocument();
  });

  it('treats yearly-frequency subs as active for ~13 months', () => {
    render_([txn({ id: 't1', description: 'Domain Renewal', date: daysAgo(200), amount: -120 })],
      { 'domain renewal': 'yearly' });
    const active = screen.getByRole('heading', { name: /^active$/i }).closest('section')!;
    expect(within(active as HTMLElement).getByText('Domain Renewal')).toBeInTheDocument();
  });

  it('puts user-cancelled subs in the Cancelled section', () => {
    render_([txn({ id: 't1', description: 'Spotify', date: daysAgo(120), amount: -20 })],
      {}, { spotify: daysAgo(60) });
    const cancelled = screen.getByRole('heading', { name: /^cancelled$/i }).closest('section')!;
    expect(within(cancelled as HTMLElement).getByText('Spotify')).toBeInTheDocument();
  });

  it('flags subs charged AFTER the user marked cancelled', () => {
    render_([txn({ id: 't1', description: 'YouTube Premium', date: daysAgo(5), amount: -45 })],
      {}, { 'youtube premium': daysAgo(20) });
    expect(screen.getByRole('heading', { name: /charged after/i })).toBeInTheDocument();
    expect(screen.getByText('YouTube Premium')).toBeInTheDocument();
  });

  it('renders the monthly total of active subs', () => {
    render_([
      txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 }),
      txn({ id: 't2', description: 'Disney Plus', date: daysAgo(10), amount: -45 }),
    ]);
    const summary = screen.getByTestId('sub-summary');
    expect(within(summary).getByText(/100/)).toBeInTheDocument();
  });

  it('counts only the summed currency so the count reconciles with the total', () => {
    // 2 ILS subs (₪55 + ₪45 = ₪100) + 1 USD sub. The headline sums the
    // dominant ILS currency, so the count must be 2 — not 3.
    render_([
      txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 }),
      txn({ id: 't2', description: 'Disney Plus', date: daysAgo(10), amount: -45 }),
      { ...txn({ id: 't3', description: 'Github', date: daysAgo(7), amount: -8 }), currency: 'USD' },
    ]);
    const summary = screen.getByTestId('sub-summary');
    expect(within(summary).getByText(/₪100/)).toBeInTheDocument();
    expect(summary.querySelector('.sub-meta')?.textContent).toMatch(/2 active subscriptions/);
  });

  it('includes a charge that arrived after cancellation (still within active window) in the total', () => {
    // Marked cancelled 20d ago but charged again 5d ago → flagged, yet still
    // an ongoing ₪45/mo cost that the headline total must include.
    render_([txn({ id: 't1', description: 'YouTube Premium', date: daysAgo(5), amount: -45 })],
      {}, { 'youtube premium': daysAgo(20) });
    const summary = screen.getByTestId('sub-summary');
    expect(within(summary).getByText(/₪45/)).toBeInTheDocument();
    expect(summary.querySelector('.sub-meta')?.textContent).toMatch(/1 active subscription/);
  });
});
