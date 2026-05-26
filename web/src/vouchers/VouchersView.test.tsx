import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VouchersView } from './VouchersView';
import { installFetchMock } from '../test/mockFetch';

function fixture(over: Partial<{ vouchers: Array<Partial<{ id: string; name: string; provider: string; balance: number; currency: string; expiresOn: string | null; notes: string | null; excluded: boolean; connectionId: string | null; externalId: string | null; nameOverridden: boolean; createdAt: string; updatedAt: string; }>> }> = {}): {
  vouchers: Array<{ id: string; name: string; provider: string; balance: number; currency: string; expiresOn: string | null; notes: string | null; excluded: boolean; connectionId: string | null; externalId: string | null; nameOverridden: boolean; createdAt: string; updatedAt: string; }>;
} {
  const base = [
    { id: 'v-1', name: 'Tav HaZahav', provider: 'Shufersal', balance: 250,
      currency: 'ILS', expiresOn: '2027-12-31', notes: null, excluded: false,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
    { id: 'v-2', name: 'BuyMe ALL - מגוון אדיר במתנה אחת', provider: 'BuyMe',
      balance: 100, currency: 'ILS', expiresOn: '2026-06-15', notes: 'Birthday gift',
      excluded: false, connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
    { id: 'v-3', name: 'Old voucher', provider: 'Cibus', balance: 50,
      currency: 'ILS', expiresOn: '2026-05-01', notes: null, excluded: false,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
    { id: 'v-4', name: 'Excluded voucher', provider: 'Other', balance: 999,
      currency: 'ILS', expiresOn: null, notes: null, excluded: true,
      connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2025-01-01', updatedAt: '2026-05-26' },
  ];
  return { vouchers: over.vouchers as any ?? base };
}

describe('VouchersView — read-only', () => {
  it('shows the empty state when there are no vouchers', async () => {
    installFetchMock({ 'GET /api/vouchers': () => ({ vouchers: [] }) });
    render(<VouchersView />);
    expect(await screen.findByText(/no vouchers yet/i)).toBeInTheDocument();
  });

  it('renders each voucher card with name, provider, balance, and currency', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText('Tav HaZahav')).toBeInTheDocument();
    // BuyMe titles split on " - " into headline + description.
    expect(screen.getByText('BuyMe ALL')).toBeInTheDocument();
    expect(screen.getByText(/מגוון אדיר במתנה אחת/)).toBeInTheDocument();
    // Provider labels.
    expect(screen.getByText(/Shufersal/i)).toBeInTheDocument();
    expect(screen.getAllByText(/BuyMe/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders a per-currency total strip excluding excluded vouchers', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    const strip = await screen.findByTestId('voucher-totals');
    // 250 + 100 + 50 = 400 (excludes the 999 excluded one).
    expect(within(strip).getByText(/400/)).toBeInTheDocument();
  });

  it('marks expired vouchers with an expired badge', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });

  it('renders the expiry date for vouchers that expire later', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText(/2027-12-31/)).toBeInTheDocument();
  });

  it('renders the notes when present', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByText('Birthday gift')).toBeInTheDocument();
  });
});

describe('VouchersView — CRUD', () => {
  it('Add voucher button is in the header', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    expect(await screen.findByRole('button', { name: /add voucher/i })).toBeInTheDocument();
  });

  it('clicking Add opens a source picker with Custom + provider tiles', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    const picker = await screen.findByRole('dialog', { name: /add a voucher/i });
    expect(within(picker).getByRole('button', { name: /shufersal/i })).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /buyme/i })).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /hi-?tech zone/i })).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /custom voucher/i })).toBeInTheDocument();
  });

  it('Shufersal sync POSTs /start with the phone + remember', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => ({ syncId: 'sync-1' }));
    installFetchMock({
      'GET /api/vouchers': () => fixture(),
      'GET /api/vouchers/sync/shufersal/saved-phone': () => ({ phone: null }),
      'POST /api/vouchers/sync/shufersal/start': post,
      'GET /api/vouchers/sync/shufersal/status/sync-1': () => ({
        status: 'signing-in', message: 'Opening…', error: null,
        vouchers: null, finished: false,
      }),
    });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /^Shufersal/i }));
    const dialog = await screen.findByRole('dialog', { name: /sync shufersal/i });
    await user.type(within(dialog).getByLabelText(/phone/i), '0501234567');
    await user.click(within(dialog).getByRole('button', { name: /^sync$/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.phone).toBe('0501234567');
    expect(body.remember).toBe(true);
    // After start, the dialog moves to the progress step.
    expect(await within(dialog).findByText(/opening/i)).toBeInTheDocument();
  });

  it('Shufersal awaiting-otp status transitions the dialog to the code-entry step', async () => {
    const user = userEvent.setup();
    let statusCalls = 0;
    installFetchMock({
      'GET /api/vouchers': () => fixture(),
      'GET /api/vouchers/sync/shufersal/saved-phone': () => ({ phone: null }),
      'POST /api/vouchers/sync/shufersal/start': () => ({ syncId: 'sync-2' }),
      'GET /api/vouchers/sync/shufersal/status/sync-2': () => {
        statusCalls += 1;
        // First poll: still signing in. After: awaiting OTP.
        if (statusCalls <= 1) {
          return { status: 'signing-in', message: 'Opening…', error: null,
            vouchers: null, finished: false };
        }
        return { status: 'awaiting-otp',
          message: 'Enter the code that was SMSed to your phone.',
          error: null, vouchers: null, finished: false };
      },
      'POST /api/vouchers/sync/shufersal/otp': () => ({ ok: true }),
    });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /^Shufersal/i }));
    const dialog = await screen.findByRole('dialog', { name: /sync shufersal/i });
    await user.type(within(dialog).getByLabelText(/phone/i), '0501234567');
    await user.click(within(dialog).getByRole('button', { name: /^sync$/i }));
    // Poll picks up the awaiting-otp status (default poll interval 1500ms).
    expect(
      await within(dialog).findByLabelText(/verification code/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('picking Shufersal opens the Shufersal sync dialog with a phone input', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/vouchers': () => fixture(),
      'GET /api/vouchers/sync/shufersal/saved-phone': () => ({ phone: null }),
    });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /^Shufersal/i }));
    const dialog = await screen.findByRole('dialog', { name: /sync shufersal/i });
    expect(within(dialog).getByLabelText(/phone/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^sync$/i })).toBeInTheDocument();
  });

  it('Shufersal sync dialog pre-fills the phone from the vault when one is saved', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/vouchers': () => fixture(),
      'GET /api/vouchers/sync/shufersal/saved-phone': () => ({ phone: '0501234567' }),
    });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /^Shufersal/i }));
    const dialog = await screen.findByRole('dialog', { name: /sync shufersal/i });
    const input = await within(dialog).findByLabelText(/phone/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('0501234567'));
  });

  it('each provider sync dialog has an HTZ-specific captcha instruction', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/vouchers': () => fixture(),
      'GET /api/vouchers/sync/htzone/saved-code': () => ({ code: null }),
      'GET /api/vouchers/sync/shufersal/saved-phone': () => ({ phone: null }),
      'GET /api/vouchers/sync/buyme/saved-email': () => ({ email: null }),
    });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /hi-?tech zone/i }));
    const htz = await screen.findByRole('dialog', { name: /sync hi-?tech zone/i });
    // HTZ should mention the reCAPTCHA the user has to solve in the
    // visible browser window — not the generic "signs in for you" copy.
    expect(within(htz).getAllByText(/reCAPTCHA/i).length).toBeGreaterThan(0);
    expect(within(htz).getAllByText(/שלח/).length).toBeGreaterThan(0);
    // Close + re-pick Shufersal to verify its copy talks about SMS / OTP.
    await user.click(within(htz).getByRole('button', { name: /^cancel$/i }));
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /^Shufersal/i }));
    const shuf = await screen.findByRole('dialog', { name: /sync shufersal/i });
    expect(within(shuf).getAllByText(/SMS|text/i).length).toBeGreaterThan(0);
  });

  it('Hi-Tech Zone sync validates the 8–9 digit code before POSTing', async () => {
    const user = userEvent.setup();
    const post = vi.fn(() => ({ syncId: 'sync-h' }));
    installFetchMock({
      'GET /api/vouchers': () => fixture(),
      'GET /api/vouchers/sync/htzone/saved-code': () => ({ code: null }),
      'POST /api/vouchers/sync/htzone/start': post,
    });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /hi-?tech zone/i }));
    const dialog = await screen.findByRole('dialog', { name: /sync hi-?tech zone/i });
    await user.type(within(dialog).getByLabelText(/digital code/i), '1234');
    await user.click(within(dialog).getByRole('button', { name: /^sync$/i }));
    // Inline validation error shows in .form-error.
    expect(within(dialog).getByText(/code must be 8.{1,3}9/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('picking "Custom voucher" opens the manual-entry form', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /custom voucher/i }));
    const dialog = await screen.findByRole('dialog', { name: /custom voucher/i });
    expect(within(dialog).getByLabelText(/provider/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/balance/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/currency/i)).toBeInTheDocument();
  });

  it('save POSTs /vouchers and refetches', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => ({ voucher: { id: 'new', name: 'X' } }));
    const get = vi.fn(() => fixture());
    installFetchMock({
      'GET /api/vouchers': get,
      'POST /api/vouchers': post,
    });
    render(<VouchersView />);
    await user.click(await screen.findByRole('button', { name: /add voucher/i }));
    await user.click(await screen.findByRole('button', { name: /custom voucher/i }));
    const dialog = await screen.findByRole('dialog', { name: /custom voucher/i });
    await user.type(within(dialog).getByLabelText(/provider/i), 'Shufersal');
    await user.type(within(dialog).getByLabelText('Name'), 'Birthday gift');
    await user.type(within(dialog).getByLabelText(/balance/i), '500');
    await user.click(within(dialog).getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      provider: 'Shufersal', name: 'Birthday gift', balance: 500, currency: 'ILS',
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('voucher card has Edit / Exclude / Delete buttons', async () => {
    installFetchMock({ 'GET /api/vouchers': () => fixture() });
    render(<VouchersView />);
    const card = (await screen.findByText('Tav HaZahav')).closest('.voucher-card')!;
    expect(within(card as HTMLElement).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(card as HTMLElement).getByRole('button', { name: /^exclude$/i })).toBeInTheDocument();
    expect(within(card as HTMLElement).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('Edit opens a pre-filled modal and saves via PATCH', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ voucher: { id: 'v-1' } }));
    const get = vi.fn(() => fixture());
    installFetchMock({
      'GET /api/vouchers': get,
      'PATCH /api/vouchers/v-1': patch,
    });
    render(<VouchersView />);
    const card = (await screen.findByText('Tav HaZahav')).closest('.voucher-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^edit$/i }));
    const dialog = screen.getByRole('dialog', { name: /edit voucher/i });
    const balanceInput = within(dialog).getByLabelText(/balance/i);
    await user.clear(balanceInput);
    await user.type(balanceInput, '300');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toMatchObject({ balance: 300 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('Exclude toggles the excluded flag via PATCH', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ voucher: { id: 'v-1' } }));
    installFetchMock({
      'GET /api/vouchers': () => fixture(),
      'PATCH /api/vouchers/v-1': patch,
    });
    render(<VouchersView />);
    const card = (await screen.findByText('Tav HaZahav')).closest('.voucher-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^exclude$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toEqual({ excluded: true });
  });

  it('Delete opens a confirmation; confirm DELETEs and refetches', async () => {
    const user = userEvent.setup();
    const del = vi.fn(() => ({ ok: true }));
    const get = vi.fn(() => fixture());
    installFetchMock({
      'GET /api/vouchers': get,
      'DELETE /api/vouchers/v-1': del,
    });
    render(<VouchersView />);
    const card = (await screen.findByText('Tav HaZahav')).closest('.voucher-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^delete$/i }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /confirm/i }),
    );
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
