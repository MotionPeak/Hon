import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PiggyView } from './PiggyView';
import { installFetchMock } from '../test/mockFetch';

const REPORT = {
  piggy: {
    month: '2026-05',
    banks: [
      {
        id: 'p-1', name: 'Japan trip', emoji: '✈️', kind: 'monthly',
        targetAmount: 12000, monthlyAmount: 1000, currency: 'ILS',
        saved: 5000, remaining: 7000, progress: 5000 / 12000,
        complete: false, onHold: false,
        thisMonth: { amount: 1000, status: 'funded' },
        monthsLeft: 7,
      },
      {
        id: 'p-2', name: 'Emergency fund', emoji: '🛟', kind: 'monthly',
        targetAmount: 30000, monthlyAmount: 500, currency: 'ILS',
        saved: 30000, remaining: 0, progress: 1,
        complete: true, onHold: false,
        thisMonth: { amount: 0, status: 'complete' },
        monthsLeft: 0,
      },
      {
        id: 'p-3', name: 'New laptop', emoji: '💻', kind: 'monthly',
        targetAmount: 8000, monthlyAmount: 800, currency: 'ILS',
        saved: 1600, remaining: 6400, progress: 0.2,
        complete: false, onHold: false,
        thisMonth: { amount: 0, status: 'skipped' },
        monthsLeft: 8,
      },
      {
        id: 'p-4', name: 'Camera kit', emoji: '📷', kind: 'monthly',
        targetAmount: 5000, monthlyAmount: 400, currency: 'ILS',
        saved: 800, remaining: 4200, progress: 0.16,
        complete: false, onHold: true,
        thisMonth: { amount: 0, status: 'onhold' },
        monthsLeft: 11,
      },
    ],
    fundedTotal: 1000,
    headroom: 3500,
    projected: true,
  },
  currency: 'ILS',
};

const EMPTY_REPORT = {
  piggy: {
    month: '2026-05', banks: [], fundedTotal: 0, headroom: 0, projected: false,
  },
  currency: 'ILS',
};

describe('PiggyView — read-only', () => {
  it('shows the empty state when there are no piggy banks', async () => {
    installFetchMock({ 'GET /api/budget': () => EMPTY_REPORT });
    render(<PiggyView />);
    expect(await screen.findByText(/no piggy banks yet/i)).toBeInTheDocument();
  });

  it('renders each piggy bank by name + emoji', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    expect(await screen.findByText('Japan trip')).toBeInTheDocument();
    expect(screen.getByText('Emergency fund')).toBeInTheDocument();
    expect(screen.getByText('New laptop')).toBeInTheDocument();
    // Emoji renders inside the card.
    expect(screen.getByText('✈️')).toBeInTheDocument();
  });

  it('renders the progress percent for each bank', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    // Japan trip: 5000/12000 = ~42%
    expect(await screen.findByText('42%')).toBeInTheDocument();
    // Emergency fund complete: 100%
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('shows a "Goal reached" badge on completed banks', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    const emergency = (await screen.findByText('Emergency fund')).closest('.piggy-card')!;
    expect(within(emergency as HTMLElement).getByText(/goal reached/i)).toBeInTheDocument();
  });

  it('shows a "Paused" / "On hold" badge on appropriate banks', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    const laptop = (await screen.findByText('New laptop')).closest('.piggy-card')!;
    expect(within(laptop as HTMLElement).getByText(/doesn'?t fit/i)).toBeInTheDocument();
    const camera = (await screen.findByText('Camera kit')).closest('.piggy-card')!;
    expect(within(camera as HTMLElement).getByText(/on hold/i)).toBeInTheDocument();
  });

  it('renders the headroom strip with the funded total + saving room', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    const strip = await screen.findByTestId('piggy-headroom');
    expect(within(strip).getByText(/3,?500/)).toBeInTheDocument();
    // Funded total this month
    expect(within(strip).getByText(/1,?000/)).toBeInTheDocument();
  });
});

describe('PiggyView — CRUD', () => {
  it('shows a "New piggy bank" button at the top', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    render(<PiggyView />);
    expect(await screen.findByRole('button', { name: /new piggy bank/i }))
      .toBeInTheDocument();
  });

  it('opens the new-piggy dialog with empty fields when clicked', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    const user = userEvent.setup();
    render(<PiggyView />);
    await user.click(await screen.findByRole('button', { name: /new piggy bank/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /new piggy bank/i }))
      .toBeInTheDocument();
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('');
  });

  it('POSTs to /api/piggy with the form values then refetches', async () => {
    const post = vi.fn((_body: unknown) => ({ piggy: { id: 'new' } }));
    let budgetCalls = 0;
    installFetchMock({
      'GET /api/budget': () => { budgetCalls += 1; return REPORT; },
      'POST /api/piggy': post,
    });
    const user = userEvent.setup();
    render(<PiggyView />);
    await user.click(await screen.findByRole('button', { name: /new piggy bank/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Camera');
    await user.clear(within(dialog).getByLabelText(/goal amount/i));
    await user.type(within(dialog).getByLabelText(/goal amount/i), '5000');
    await user.clear(within(dialog).getByLabelText(/monthly set-aside/i));
    await user.type(within(dialog).getByLabelText(/monthly set-aside/i), '500');
    await user.click(within(dialog).getByRole('button', { name: /create piggy bank/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.name).toBe('Camera');
    expect(body.targetAmount).toBe(5000);
    expect(body.monthlyAmount).toBe(500);
    expect(body.kind).toBe('monthly');
    // Dialog closes and budget refetched.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(budgetCalls).toBeGreaterThan(1);
  });

  it('shows a per-card actions menu with Edit / Pause / Delete', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    const user = userEvent.setup();
    render(<PiggyView />);
    const japan = (await screen.findByText('Japan trip')).closest('.piggy-card')!;
    await user.click(within(japan as HTMLElement).getByRole('button', { name: /actions/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /edit/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /pause/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });

  it('shows "Resume" instead of "Pause" on an on-hold bank', async () => {
    installFetchMock({ 'GET /api/budget': () => REPORT });
    const user = userEvent.setup();
    render(<PiggyView />);
    const camera = (await screen.findByText('Camera kit')).closest('.piggy-card')!;
    await user.click(within(camera as HTMLElement).getByRole('button', { name: /actions/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /resume/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^pause/i })).not.toBeInTheDocument();
  });

  it('Edit pre-fills the dialog with the bank values and PUTs on save', async () => {
    const put = vi.fn((_body: unknown) => ({ piggy: {} }));
    installFetchMock({
      'GET /api/budget': () => REPORT,
      'PUT /api/piggy/p-1': put,
    });
    const user = userEvent.setup();
    render(<PiggyView />);
    const japan = (await screen.findByText('Japan trip')).closest('.piggy-card')!;
    await user.click(within(japan as HTMLElement).getByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /edit/i }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Japan trip');
    expect((within(dialog).getByLabelText(/goal amount/i) as HTMLInputElement).value).toBe('12000');
    await user.clear(within(dialog).getByLabelText(/goal amount/i));
    await user.type(within(dialog).getByLabelText(/goal amount/i), '15000');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.targetAmount).toBe(15000);
  });

  it('Pause PUTs { onHold: true }', async () => {
    const put = vi.fn((_body: unknown) => ({ piggy: {} }));
    installFetchMock({
      'GET /api/budget': () => REPORT,
      'PUT /api/piggy/p-1': put,
    });
    const user = userEvent.setup();
    render(<PiggyView />);
    const japan = (await screen.findByText('Japan trip')).closest('.piggy-card')!;
    await user.click(within(japan as HTMLElement).getByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /pause/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.onHold).toBe(true);
  });

  it('Resume PUTs { onHold: false }', async () => {
    const put = vi.fn((_body: unknown) => ({ piggy: {} }));
    installFetchMock({
      'GET /api/budget': () => REPORT,
      'PUT /api/piggy/p-4': put,
    });
    const user = userEvent.setup();
    render(<PiggyView />);
    const camera = (await screen.findByText('Camera kit')).closest('.piggy-card')!;
    await user.click(within(camera as HTMLElement).getByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /resume/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.onHold).toBe(false);
  });

  it('Delete opens a confirm dialog and DELETEs on confirm', async () => {
    const del = vi.fn(() => ({ ok: true }));
    installFetchMock({
      'GET /api/budget': () => REPORT,
      'DELETE /api/piggy/p-1': del,
    });
    const user = userEvent.setup();
    render(<PiggyView />);
    const japan = (await screen.findByText('Japan trip')).closest('.piggy-card')!;
    await user.click(within(japan as HTMLElement).getByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(/delete japan trip/i)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(del).toHaveBeenCalled());
  });

  it('Delete confirm dialog Cancel button does not DELETE', async () => {
    const del = vi.fn(() => ({ ok: true }));
    installFetchMock({
      'GET /api/budget': () => REPORT,
      'DELETE /api/piggy/p-1': del,
    });
    const user = userEvent.setup();
    render(<PiggyView />);
    const japan = (await screen.findByText('Japan trip')).closest('.piggy-card')!;
    await user.click(within(japan as HTMLElement).getByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
  });
});
