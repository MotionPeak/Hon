import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SubscriptionsSection } from './SubscriptionsSection';

const today = new Date();
function daysAgo(n: number): string {
  return new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
}
function txn(over: Partial<{ id: string; date: string; description: string; amount: number }>) {
  return {
    id: over.id ?? 't', accountId: 'a', externalId: 'x',
    date: over.date ?? daysAgo(10), processedDate: null,
    amount: over.amount ?? -50, currency: 'ILS',
    description: over.description ?? 'Netflix', memo: null,
    kind: null, status: null, category: 'Subscriptions', createdAt: '2025-01-01',
  };
}

describe('SubscriptionsSection — cancel / restore', () => {
  it('marks an active subscription cancelled by its merchant key', () => {
    const onCancel = vi.fn();
    render(
      <SubscriptionsSection
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transactions={[txn({ id: 't1', description: 'Netflix', date: daysAgo(5), amount: -55 })] as any}
        frequencies={{}}
        cancelled={{}}
        onCancel={onCancel}
        onRestore={vi.fn()}
      />,
    );
    const active = screen.getByRole('heading', { name: /^active$/i }).closest('section')!;
    const btn = within(active as HTMLElement).getByRole('button', { name: /mark cancelled/i });
    fireEvent.click(btn);
    expect(onCancel).toHaveBeenCalledWith('netflix');
  });

  it('restores a cancelled subscription by its merchant key', () => {
    const onRestore = vi.fn();
    render(
      <SubscriptionsSection
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transactions={[txn({ id: 't1', description: 'Spotify', date: daysAgo(120), amount: -20 })] as any}
        frequencies={{}}
        cancelled={{ spotify: daysAgo(60) }}
        onCancel={vi.fn()}
        onRestore={onRestore}
      />,
    );
    const section = screen.getByRole('heading', { name: /^cancelled$/i }).closest('section')!;
    const btn = within(section as HTMLElement).getByRole('button', { name: /restore/i });
    fireEvent.click(btn);
    expect(onRestore).toHaveBeenCalledWith('spotify');
  });
});
