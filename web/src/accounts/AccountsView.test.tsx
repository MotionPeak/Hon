import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountsView } from './AccountsView';
import { installFetchMock, jsonResponse } from '../test/mockFetch';

const COMPANIES = {
  companies: [
    { id: 'hapoalim', name: 'Bank Hapoalim', loginFields: [], type: 'bank', domain: 'bankhapoalim.co.il' },
    { id: 'max', name: 'Max', loginFields: [], type: 'card', domain: 'max.co.il' },
    { id: 'snaptrade', name: 'SnapTrade', loginFields: [], type: 'brokerage' },
    { id: 'harel', name: 'Harel', loginFields: [], type: 'pension' },
  ],
};
const CONNECTIONS = {
  connections: [
    { id: 'c-bank-1', companyId: 'hapoalim', displayName: 'Hapoalim main',
      createdAt: '2025-01-01', lastScrapeAt: '2026-05-25', lastStatus: 'success', hasCredentials: true },
    { id: 'c-card-1', companyId: 'max', displayName: 'Max card',
      createdAt: '2025-01-01', lastScrapeAt: '2026-05-25', lastStatus: 'success', hasCredentials: true },
    { id: 'c-brk-1', companyId: 'snaptrade', displayName: 'IBKR',
      createdAt: '2025-01-01', lastScrapeAt: '2026-05-25', lastStatus: 'success', hasCredentials: true },
    { id: 'c-pen-1', companyId: 'harel', displayName: 'Harel pension',
      createdAt: '2025-01-01', lastScrapeAt: '2026-05-25', lastStatus: 'success', hasCredentials: true },
  ],
};
const ACCOUNTS = {
  accounts: [
    { id: 'a-bank-1', connectionId: 'c-bank-1', companyId: 'hapoalim', connectionName: 'Hapoalim main',
      accountNumber: '12345', label: 'Checking', balance: 18250.5, currency: 'ILS',
      updatedAt: '2026-05-25', excluded: false, inceptionDate: null },
    { id: 'a-card-1', connectionId: 'c-card-1', companyId: 'max', connectionName: 'Max card',
      accountNumber: '****1234', label: 'Max', balance: -1234.5, currency: 'ILS',
      updatedAt: '2026-05-25', excluded: false, inceptionDate: null },
  ],
};
const ASSETS = {
  assets: [
    { id: 'as-1', kind: 'car', name: '2018 Mazda 3', value: 45000, currency: 'ILS',
      details: null, createdAt: '2025-01-01', updatedAt: '2026-05-25', excluded: false },
  ],
};
const LOANS = {
  loans: [
    { id: 'l-1', name: 'Mortgage', principal: 800000, startDate: '2020-01-01', termMonths: 240,
      isPrime: false, isCpiLinked: true, rateValue: 3.5, cpiStart: 100, currency: 'ILS',
      excluded: false, notes: null, connectionId: null, externalId: null, nameOverridden: false,
      createdAt: '2020-01-01', updatedAt: '2026-05-25' },
  ],
};
const FULL = {
  'GET /api/companies': () => COMPANIES,
  'GET /api/connections': () => CONNECTIONS,
  'GET /api/accounts': () => ACCOUNTS,
  'GET /api/assets': () => ASSETS,
  'GET /api/loans': () => LOANS,
};

describe('AccountsView — section grouping', () => {
  it('renders the 6 section headers in order when each section has content', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    await screen.findByRole('heading', { name: /banks/i });
    const headers = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent || '');
    // Section labels come with an emoji + count chip; check ordering ignoring chrome.
    const order = ['Banks', 'Credit cards', 'Investments', 'Pension', 'Other assets', 'Loans'];
    const seen = headers.filter((t) => order.some((o) => t.includes(o)));
    expect(seen.map((t) => order.find((o) => t.includes(o)))).toEqual(order);
  });

  it('omits sections that have no items', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/assets': () => ({ assets: [] }),
      'GET /api/loans': () => ({ loans: [] }),
    });
    render(<AccountsView />);
    await screen.findByRole('heading', { name: /banks/i });
    expect(screen.queryByRole('heading', { name: /other assets/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /loans/i })).not.toBeInTheDocument();
  });

  it('shows a count badge with the number of items per section', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    const header = await screen.findByRole('heading', { name: /banks/i });
    expect(within(header).getByText('1')).toBeInTheDocument();
  });

  it('renders an empty hint when there are no connections, assets, or loans', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/connections': () => ({ connections: [] }),
      'GET /api/accounts': () => ({ accounts: [] }),
      'GET /api/assets': () => ({ assets: [] }),
      'GET /api/loans': () => ({ loans: [] }),
    });
    render(<AccountsView />);
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });
});

describe('AccountsView — connection cards', () => {
  it('renders each connection by displayName under its section', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    expect(await screen.findByText('Hapoalim main')).toBeInTheDocument();
    expect(screen.getByText('Max card')).toBeInTheDocument();
    expect(screen.getByText('IBKR')).toBeInTheDocument();
    expect(screen.getByText('Harel pension')).toBeInTheDocument();
  });

  it('renders the company name as connection meta', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    expect(await screen.findByText(/bank hapoalim/i)).toBeInTheDocument();
  });

  it('renders each account row with its label and formatted balance', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    const row = checking.closest('li')!;
    expect(within(row).getByText(/18,?250(\.50?)?/)).toBeInTheDocument();
  });

  it('marks negative balances with a "neg" class for styling', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    // Single account row → exactly one .conn-account .neg amount.
    await screen.findByText('Max card');
    const negAmounts = document.querySelectorAll('.conn-account .amount.neg');
    expect(negAmounts.length).toBeGreaterThanOrEqual(1);
    expect(negAmounts[0].textContent).toMatch(/1,?234/);
  });
});

describe('AccountsView — edit balance', () => {
  it('clicking a balance opens a dialog pre-filled with the current value', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    const amount = within(checking.closest('li')!).getByText(/18,?250/);
    await user.click(amount);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /account balance/i })).toBeInTheDocument();
    const input = within(dialog).getByLabelText(/balance/i) as HTMLInputElement;
    expect(input.value).toBe('18250.5'); // 2dp-rounded (no float artefact)
  });

  it('cancel closes without calling the engine', async () => {
    const user = userEvent.setup();
    const get = vi.fn(() => ACCOUNTS);
    installFetchMock({ ...FULL, 'GET /api/accounts': get });
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    await user.click(within(checking.closest('li')!).getByText(/18,?250/));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1); // initial load only
  });

  it('save PATCHes /accounts/:id/balance with the new value + refetches', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true }));
    const get = vi.fn(() => ACCOUNTS);
    installFetchMock({
      ...FULL,
      'GET /api/accounts': get,
      'PATCH /api/accounts/a-bank-1/balance': patch,
    });
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    await user.click(within(checking.closest('li')!).getByText(/18,?250/));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText(/balance/i);
    await user.clear(input);
    await user.type(input, '22000');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toEqual({ balance: 22000 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a validation error for non-numeric input and does not call the engine', async () => {
    const user = userEvent.setup();
    const patch = vi.fn();
    installFetchMock({ ...FULL, 'PATCH /api/accounts/a-bank-1/balance': patch });
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    await user.click(within(checking.closest('li')!).getByText(/18,?250/));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText(/balance/i);
    await user.clear(input);
    await user.type(input, 'abc');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    expect(await within(dialog).findByText(/enter a number/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it('surfaces server errors inline without closing the dialog', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...FULL,
      'PATCH /api/accounts/a-bank-1/balance':
        () => jsonResponse(503, { error: 'database unavailable' }),
    });
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    await user.click(within(checking.closest('li')!).getByText(/18,?250/));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/database unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('AccountsView — net-worth toggle', () => {
  it('shows a "Net worth" pill checked for each non-excluded account', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    await screen.findByText('Checking');
    const pills = screen.getAllByRole('checkbox', { name: /net worth/i });
    expect(pills.length).toBeGreaterThanOrEqual(2); // bank + card accounts
    pills.forEach((p) => expect(p).toBeChecked());
  });

  it('renders the pill unchecked when the account is excluded', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/accounts': () => ({
        accounts: [{ ...ACCOUNTS.accounts[0], excluded: true }],
      }),
    });
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    const pill = within(checking.closest('li')!).getByRole('checkbox', { name: /net worth/i });
    expect(pill).not.toBeChecked();
  });

  it('toggling the pill PATCHes /accounts/:id/excluded with the new value', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true }));
    const get = vi.fn(() => ACCOUNTS);
    installFetchMock({
      ...FULL,
      'GET /api/accounts': get,
      'PATCH /api/accounts/a-bank-1/excluded': patch,
    });
    render(<AccountsView />);
    await screen.findByText('Checking');
    const checking = screen.getByText('Checking').closest('li')!;
    await user.click(within(checking).getByRole('checkbox', { name: /net worth/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toEqual({ excluded: true });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('asset cards have a net-worth pill that PUTs /assets/:id', async () => {
    const user = userEvent.setup();
    const put = vi.fn((_body: unknown) => ({ ok: true }));
    installFetchMock({
      ...FULL,
      'PUT /api/assets/as-1': put,
    });
    render(<AccountsView />);
    const mazda = await screen.findByText('2018 Mazda 3');
    const card = mazda.closest('.asset-card')!;
    await user.click(within(card as HTMLElement).getByRole('checkbox', { name: /net worth/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]?.[0]).toEqual({ excluded: true });
  });

  it('loan cards have a net-worth pill that PATCHes /loans/:id/excluded', async () => {
    const user = userEvent.setup();
    const patch = vi.fn((_body: unknown) => ({ ok: true }));
    installFetchMock({
      ...FULL,
      'PATCH /api/loans/l-1/excluded': patch,
    });
    render(<AccountsView />);
    const mortgage = await screen.findByText('Mortgage');
    const card = mortgage.closest('.loan-card')!;
    await user.click(within(card as HTMLElement).getByRole('checkbox', { name: /net worth/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[0]).toEqual({ excluded: true });
  });
});

describe('AccountsView — remove connection', () => {
  it('renders a "Remove" button on every connection card', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    await screen.findByText('Hapoalim main');
    expect(screen.getAllByRole('button', { name: /^remove$/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('clicking remove opens a confirmation dialog naming the connection', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^remove$/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /hapoalim main/i })).toBeInTheDocument();
  });

  it('cancel closes without calling the engine', async () => {
    const user = userEvent.setup();
    const del = vi.fn();
    installFetchMock({ ...FULL, 'DELETE /api/connections/c-bank-1': del });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^remove$/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it('confirm DELETEs /connections/:id and refetches', async () => {
    const user = userEvent.setup();
    const del = vi.fn(() => ({ ok: true }));
    const get = vi.fn(() => CONNECTIONS);
    installFetchMock({
      ...FULL,
      'GET /api/connections': get,
      'DELETE /api/connections/c-bank-1': del,
    });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^remove$/i }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /confirm remove/i }),
    );
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('AccountsView — set credentials', () => {
  const COMPANIES_WITH_LOGIN = {
    companies: [{
      id: 'hapoalim', name: 'Bank Hapoalim',
      loginFields: ['userCode', 'password'],
      type: 'bank' as const, domain: 'bankhapoalim.co.il',
    }, ...COMPANIES.companies.slice(1)],
  };
  const NO_CREDS = {
    connections: [{ ...CONNECTIONS.connections[0], hasCredentials: false },
      ...CONNECTIONS.connections.slice(1)],
  };

  it('shows "Set credentials" only when hasCredentials is false', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/companies': () => COMPANIES_WITH_LOGIN,
      'GET /api/connections': () => NO_CREDS,
    });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    expect(within(card as HTMLElement).getByRole('button', { name: /set credentials/i }))
      .toBeInTheDocument();
    // The other connections (Max, IBKR, Harel) have hasCredentials: true.
    const maxCard = screen.getByText('Max card').closest('.conn-card')!;
    expect(within(maxCard as HTMLElement).queryByRole('button', { name: /set credentials/i }))
      .not.toBeInTheDocument();
  });

  it('clicking opens a form with one input per loginField from the company catalog', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...FULL,
      'GET /api/companies': () => COMPANIES_WITH_LOGIN,
      'GET /api/connections': () => NO_CREDS,
    });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /set credentials/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/userCode/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('save PUTs /connections/:id/credentials with a credentials map', async () => {
    const user = userEvent.setup();
    const put = vi.fn((_body: unknown) => ({ ok: true }));
    installFetchMock({
      ...FULL,
      'GET /api/companies': () => COMPANIES_WITH_LOGIN,
      'GET /api/connections': () => NO_CREDS,
      'PUT /api/connections/c-bank-1/credentials': put,
    });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /set credentials/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/userCode/i), '12345');
    await user.type(within(dialog).getByLabelText(/password/i), 'secret');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]?.[0]).toEqual({
      credentials: { userCode: '12345', password: 'secret' },
    });
  });
});

describe('AccountsView — assets + loans', () => {
  it('renders each manual asset by name in the Other assets section', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    expect(await screen.findByText('2018 Mazda 3')).toBeInTheDocument();
    expect(screen.getByText(/45,?000/)).toBeInTheDocument();
  });

  it('renders each loan by name in the Loans section', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    expect(await screen.findByText('Mortgage')).toBeInTheDocument();
  });
});
