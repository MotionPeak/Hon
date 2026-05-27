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
const BROKERAGE = {
  holdings: [
    { accountId: 'a-brk-1', symbol: 'AAPL', description: 'Apple Inc.',
      units: 10, price: 200, currency: 'USD',
      costBasis: 150, openPnl: null, value: 2000, updatedAt: '2026-05-25' },
    { accountId: 'a-brk-1', symbol: 'VOO', description: 'Vanguard S&P 500',
      units: 5, price: 460, currency: 'USD',
      costBasis: 400, openPnl: null, value: 2300, updatedAt: '2026-05-25' },
  ],
  snapshots: [], holdingSnapshots: [], performance: [], ilsRates: null,
};
const ACCOUNTS_WITH_BROKERAGE = {
  accounts: [
    ...ACCOUNTS.accounts,
    { id: 'a-brk-1', connectionId: 'c-brk-1', companyId: 'snaptrade',
      connectionName: 'IBKR', accountNumber: 'IBKR-001',
      label: 'IBKR Main', balance: 4300, currency: 'USD',
      updatedAt: '2026-05-25', excluded: false, inceptionDate: null },
  ],
};
const FULL = {
  'GET /api/companies': () => COMPANIES,
  'GET /api/connections': () => CONNECTIONS,
  'GET /api/accounts': () => ACCOUNTS,
  'GET /api/assets': () => ASSETS,
  'GET /api/loans': () => LOANS,
  'GET /api/brokerage': () => BROKERAGE,
};

describe('AccountsView — section grouping', () => {
  it('renders the 5 section headers in order when each section has content', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    await screen.findByRole('heading', { name: /banks/i });
    const headers = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent || '');
    // Section labels come with an emoji + count chip; check ordering ignoring chrome.
    // Loans deliberately omitted — they live in the Loans tab now.
    const order = ['Banks', 'Credit cards', 'Investments', 'Pension', 'Other assets'];
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

  // Loan net-worth toggle test removed: loans no longer render in Assets.
  // The Loans-tab card retains its own toggle and its own dedicated tests.
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

describe('AccountsView — sync flow', () => {
  it('renders a "Sync" button on every connection with credentials', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    await screen.findByText('Hapoalim main');
    expect(screen.getAllByRole('button', { name: /^sync$/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('clicking sync POSTs to /connections/:id/scrape and polls until success', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => ({ runId: 'r-1' }));
    let poll = 0;
    const status = vi.fn(() => {
      poll += 1;
      if (poll < 2) {
        return { run: {
          runId: 'r-1', connectionId: 'c-bank-1', status: 'running',
          message: 'Logging in…', accountsCount: 0, transactionsCount: 0,
          startedAt: '2026-05-26',
        } };
      }
      return { run: {
        runId: 'r-1', connectionId: 'c-bank-1', status: 'success',
        message: 'Done', accountsCount: 1, transactionsCount: 10,
        startedAt: '2026-05-26', finishedAt: '2026-05-26',
      } };
    });
    const get = vi.fn(() => ACCOUNTS);
    installFetchMock({
      ...FULL,
      'GET /api/accounts': get,
      'POST /api/connections/c-bank-1/scrape': post,
      'GET /api/scrape/r-1': status,
    });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^sync$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(status).toHaveBeenCalled());
    // Successful run causes a refetch of accounts.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('surfaces the run message while in-progress and shows error on failure', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...FULL,
      'POST /api/connections/c-bank-1/scrape': () => ({ runId: 'r-1' }),
      'GET /api/scrape/r-1': () => ({ run: {
        runId: 'r-1', connectionId: 'c-bank-1', status: 'error',
        message: 'login failed', accountsCount: 0, transactionsCount: 0,
        startedAt: '2026-05-26', finishedAt: '2026-05-26',
      } }),
    });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^sync$/i }));
    expect(await within(card as HTMLElement).findByText(/login failed/i)).toBeInTheDocument();
  });

  it('shows an OTP prompt when the run reports needs-otp; submitting POSTs the code', async () => {
    const user = userEvent.setup();
    const submitOtp = vi.fn((_body: unknown) => ({ ok: true }));
    let polls = 0;
    installFetchMock({
      ...FULL,
      'POST /api/connections/c-bank-1/scrape': () => ({ runId: 'r-1' }),
      'GET /api/scrape/r-1': () => {
        polls += 1;
        if (polls === 1) {
          return { run: {
            runId: 'r-1', connectionId: 'c-bank-1', status: 'needs-otp',
            message: 'Enter the code', accountsCount: 0, transactionsCount: 0,
            startedAt: '2026-05-26',
          } };
        }
        return { run: {
          runId: 'r-1', connectionId: 'c-bank-1', status: 'success',
          message: 'Done', accountsCount: 1, transactionsCount: 10,
          startedAt: '2026-05-26', finishedAt: '2026-05-26',
        } };
      },
      'POST /api/scrape/r-1/otp': submitOtp,
    });
    render(<AccountsView />);
    const card = (await screen.findByText('Hapoalim main')).closest('.conn-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /^sync$/i }));
    const otpDialog = await screen.findByRole('dialog', { name: /one-time code/i });
    await user.type(within(otpDialog).getByLabelText(/code/i), '123456');
    await user.click(within(otpDialog).getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(submitOtp).toHaveBeenCalledTimes(1));
    expect(submitOtp.mock.calls[0]?.[0]).toEqual({ code: '123456' });
  });
});

describe('AccountsView — brokerage holdings', () => {
  it('shows an expand toggle on brokerage account rows when holdings exist', async () => {
    installFetchMock({
      ...FULL,
      'GET /api/accounts': () => ACCOUNTS_WITH_BROKERAGE,
    });
    render(<AccountsView />);
    const ibkr = await screen.findByText('IBKR Main');
    const row = ibkr.closest('li')!;
    expect(within(row).getByRole('button', { name: /expand holdings/i })).toBeInTheDocument();
  });

  it('does not show an expand toggle on bank/card account rows', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    const checking = await screen.findByText('Checking');
    const row = checking.closest('li')!;
    expect(within(row).queryByRole('button', { name: /expand holdings/i })).not.toBeInTheDocument();
  });

  it('expanding renders each holding with symbol, value, and units', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/accounts': () => ACCOUNTS_WITH_BROKERAGE });
    render(<AccountsView />);
    const ibkr = await screen.findByText('IBKR Main');
    await user.click(within(ibkr.closest('li')!).getByRole('button', { name: /expand holdings/i }));
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('VOO')).toBeInTheDocument();
    // Value, units @ price somewhere on screen for AAPL (10 × $200).
    expect(screen.getByText(/2,?000/)).toBeInTheDocument();
  });

  it('shows gain% with the correct sign when cost basis is present', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/accounts': () => ACCOUNTS_WITH_BROKERAGE });
    render(<AccountsView />);
    const ibkr = await screen.findByText('IBKR Main');
    await user.click(within(ibkr.closest('li')!).getByRole('button', { name: /expand holdings/i }));
    // AAPL: value 2000, cost 10*150=1500, gain 500, pct = 500/1500 = 33.3%
    expect(await screen.findByText(/33\.3%/)).toBeInTheDocument();
  });

  it('collapse toggle hides the holdings list', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/accounts': () => ACCOUNTS_WITH_BROKERAGE });
    render(<AccountsView />);
    const ibkr = await screen.findByText('IBKR Main');
    const row = ibkr.closest('li')!;
    const toggle = within(row).getByRole('button', { name: /expand holdings/i });
    await user.click(toggle);
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /collapse holdings/i }));
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });
});

describe('AccountsView — assets', () => {
  it('renders each manual asset by name in the Other assets section', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    expect(await screen.findByText('2018 Mazda 3')).toBeInTheDocument();
    expect(screen.getByText(/45,?000/)).toBeInTheDocument();
  });

  it('does NOT render loans in Assets (they live in the Loans tab)', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    await screen.findByText('Hapoalim main');
    expect(screen.queryByText('Mortgage')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /loans/i })).not.toBeInTheDocument();
  });
});

describe('AccountsView — add connection (picker + bank/card form)', () => {
  const COMPANIES_FULL = {
    companies: [
      { id: 'hapoalim', name: 'Bank Hapoalim',
        loginFields: ['userCode', 'password'], type: 'bank', domain: 'bankhapoalim.co.il' },
      { id: 'leumi', name: 'Bank Leumi',
        loginFields: ['username', 'password'], type: 'bank', domain: 'leumi.co.il' },
      { id: 'max', name: 'Max',
        loginFields: ['username', 'password'], type: 'card', domain: 'max.co.il' },
      { id: 'snaptrade', name: 'SnapTrade',
        loginFields: [], type: 'brokerage' },
      { id: 'harel', name: 'Harel',
        loginFields: ['id'], type: 'pension' },
    ],
  };

  it('renders an "Add asset" button in the header', async () => {
    installFetchMock(FULL);
    render(<AccountsView />);
    await screen.findByText('Hapoalim main');
    expect(screen.getByRole('button', { name: /add asset/i })).toBeInTheDocument();
  });

  it('clicking + Add asset opens a category-tile picker', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const dialog = screen.getByRole('dialog', { name: /add an asset/i });
    expect(within(dialog).getByRole('button', { name: /banks/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /credit cards/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /brokerages/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^loan/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /other asset/i })).toBeInTheDocument();
  });

  it('the brokerage drilldown shows SnapTrade; Pension and Car tiles render disabled (flows live in legacy)', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const dialog = screen.getByRole('dialog', { name: /add an asset/i });
    // Pension + Car tiles are visible but disabled until their flows are ported.
    const pension = within(dialog).getByRole('button', { name: /pension/i });
    const car = within(dialog).getByRole('button', { name: /^car/i });
    expect(pension).toBeDisabled();
    expect(car).toBeDisabled();
    // Drill into Brokerages → SnapTrade row appears.
    await user.click(within(dialog).getByRole('button', { name: /brokerages/i }));
    expect(within(dialog).getByText(/SnapTrade/i)).toBeInTheDocument();
  });

  it('drilling into Banks shows the bank list and a back button', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const dialog = screen.getByRole('dialog', { name: /add an asset/i });
    await user.click(within(dialog).getByRole('button', { name: /banks/i }));
    expect(within(dialog).getByText('Bank Hapoalim')).toBeInTheDocument();
    expect(within(dialog).getByText('Bank Leumi')).toBeInTheDocument();
    // Card companies are NOT in the banks drilldown.
    expect(within(dialog).queryByText('Max')).toBeNull();
    // Back button returns to the category step.
    await user.click(within(dialog).getByRole('button', { name: /all categories/i }));
    expect(within(dialog).getByRole('button', { name: /banks/i })).toBeInTheDocument();
  });

  it('picking a bank opens a credential form with display name + login fields', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const picker = screen.getByRole('dialog', { name: /add an asset/i });
    await user.click(within(picker).getByRole('button', { name: /banks/i }));
    await user.click(within(picker).getByText('Bank Hapoalim'));
    const dialog = screen.getByRole('dialog', { name: /add bank hapoalim/i });
    const displayName = within(dialog).getByLabelText(/display name/i) as HTMLInputElement;
    expect(displayName.value).toBe('Bank Hapoalim');
    expect(within(dialog).getByLabelText(/userCode/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('the picker has an "Other asset" tile (car/property/cash/etc)', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const dialog = screen.getByRole('dialog', { name: /add an asset/i });
    expect(within(dialog).getByRole('button', { name: /other asset/i })).toBeInTheDocument();
  });

  it('picking "Other asset" opens a form with kind / name / value / currency', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const picker = screen.getByRole('dialog', { name: /add an asset/i });
    await user.click(within(picker).getByRole('button', { name: /other asset/i }));
    const form = screen.getByRole('dialog', { name: /add a manual asset/i });
    expect(within(form).getByLabelText(/kind/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/name/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/value/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/currency/i)).toBeInTheDocument();
  });

  it('the picker has a "Loan" tile', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const dialog = screen.getByRole('dialog', { name: /add an asset/i });
    expect(within(dialog).getByRole('button', { name: /^loan/i })).toBeInTheDocument();
  });

  it('picking "Loan" opens a form with required fields', async () => {
    const user = userEvent.setup();
    installFetchMock({ ...FULL, 'GET /api/companies': () => COMPANIES_FULL });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const picker = screen.getByRole('dialog', { name: /add an asset/i });
    await user.click(within(picker).getByRole('button', { name: /^loan/i }));
    const form = screen.getByRole('dialog', { name: /add a loan/i });
    expect(within(form).getByLabelText(/name/i)).toBeInTheDocument();
    expect(within(form).getByLabelText('Principal')).toBeInTheDocument();
    expect(within(form).getByLabelText(/start date/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/term/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/rate.*%/i)).toBeInTheDocument();
    // Rate-track radios — all four engine-supported tracks.
    expect(within(form).getByRole('radio', { name: 'Fixed' })).toBeInTheDocument();
    expect(within(form).getByRole('radio', { name: 'Prime' })).toBeInTheDocument();
    expect(within(form).getByRole('radio', { name: 'CPI-linked fixed' })).toBeInTheDocument();
    expect(within(form).getByRole('radio', { name: 'CPI-linked prime' })).toBeInTheDocument();
  });

  it('save POSTs /loans with the full body and refetches', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => ({ loan: { id: 'new-l' } }));
    const get = vi.fn(() => LOANS);
    installFetchMock({
      ...FULL,
      'GET /api/companies': () => COMPANIES_FULL,
      'GET /api/loans': get,
      'POST /api/loans': post,
    });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const picker = screen.getByRole('dialog', { name: /add an asset/i });
    await user.click(within(picker).getByRole('button', { name: /^loan/i }));
    const form = screen.getByRole('dialog', { name: /add a loan/i });
    await user.type(within(form).getByLabelText(/name/i), 'Car loan');
    await user.type(within(form).getByLabelText('Principal'), '60000');
    await user.clear(within(form).getByLabelText(/start date/i));
    await user.type(within(form).getByLabelText(/start date/i), '2024-01-01');
    await user.clear(within(form).getByLabelText(/term/i));
    await user.type(within(form).getByLabelText(/term/i), '36');
    await user.click(within(form).getByRole('radio', { name: 'Prime' }));
    await user.type(within(form).getByLabelText(/rate.*%/i), '1.5');
    await user.click(within(form).getByRole('button', { name: /add$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      name: 'Car loan',
      principal: 60000,
      startDate: '2024-01-01',
      termMonths: 36,
      rateType: 'prime',
      rateValue: 1.5,
      currency: 'ILS',
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('save POSTs /assets with kind/name/value/currency and refetches', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => ({ asset: {
      id: 'new-as', kind: 'cash', name: 'Emergency fund', value: 50000,
      currency: 'ILS', details: null, createdAt: 'now', updatedAt: 'now', excluded: false,
    } }));
    const get = vi.fn(() => ASSETS);
    installFetchMock({
      ...FULL,
      'GET /api/companies': () => COMPANIES_FULL,
      'GET /api/assets': get,
      'POST /api/assets': post,
    });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const picker = screen.getByRole('dialog', { name: /add an asset/i });
    await user.click(within(picker).getByRole('button', { name: /other asset/i }));
    const form = screen.getByRole('dialog', { name: /add a manual asset/i });
    await user.selectOptions(within(form).getByLabelText(/kind/i), 'cash');
    await user.type(within(form).getByLabelText(/name/i), 'Emergency fund');
    await user.type(within(form).getByLabelText(/value/i), '50000');
    await user.click(within(form).getByRole('button', { name: /add$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      kind: 'cash', name: 'Emergency fund', value: 50000, currency: 'ILS',
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('save POSTs /connections with companyId + displayName + credentials, then refetches', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => ({ connection: {
      id: 'new-1', companyId: 'hapoalim', displayName: 'My Hapoalim',
      createdAt: '2026-05-26', lastScrapeAt: null, lastStatus: null, hasCredentials: true,
    } }));
    const get = vi.fn(() => CONNECTIONS);
    installFetchMock({
      ...FULL,
      'GET /api/companies': () => COMPANIES_FULL,
      'GET /api/connections': get,
      'POST /api/connections': post,
    });
    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    const picker = screen.getByRole('dialog', { name: /add an asset/i });
    await user.click(within(picker).getByRole('button', { name: /banks/i }));
    await user.click(within(picker).getByText('Bank Hapoalim'));
    const dialog = screen.getByRole('dialog', { name: /add bank hapoalim/i });
    const displayName = within(dialog).getByLabelText(/display name/i);
    await user.clear(displayName);
    await user.type(displayName, 'My Hapoalim');
    await user.type(within(dialog).getByLabelText(/userCode/i), '12345');
    await user.type(within(dialog).getByLabelText(/password/i), 'secret');
    await user.click(within(dialog).getByRole('button', { name: /add$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toEqual({
      companyId: 'hapoalim',
      displayName: 'My Hapoalim',
      credentials: { userCode: '12345', password: 'secret' },
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe('AccountsView — asset edit + remove', () => {
  it('opens an edit modal pre-filled with the asset name and value', async () => {
    const user = userEvent.setup();
    installFetchMock(FULL);
    render(<AccountsView />);
    const mazda = await screen.findByText('2018 Mazda 3');
    await user.click(within(mazda.closest('.asset-card') as HTMLElement)
      .getByRole('button', { name: /^edit$/i }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(/name/i) as HTMLInputElement).value).toBe('2018 Mazda 3');
    expect((within(dialog).getByLabelText(/value/i) as HTMLInputElement).value).toBe('45000');
  });

  it('save PUTs /assets/:id with the changed fields and refetches', async () => {
    const user = userEvent.setup();
    const put = vi.fn((_body: unknown) => ({ asset: { id: 'as-1' } }));
    const get = vi.fn(() => ASSETS);
    installFetchMock({ ...FULL, 'GET /api/assets': get, 'PUT /api/assets/as-1': put });
    render(<AccountsView />);
    const mazda = await screen.findByText('2018 Mazda 3');
    await user.click(within(mazda.closest('.asset-card') as HTMLElement)
      .getByRole('button', { name: /^edit$/i }));
    const dialog = screen.getByRole('dialog');
    const valueInput = within(dialog).getByLabelText(/value/i);
    await user.clear(valueInput);
    await user.type(valueInput, '48000');
    await user.click(within(dialog).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]?.[0]).toMatchObject({ name: '2018 Mazda 3', value: 48000 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('remove opens a confirmation; confirm DELETEs and refetches', async () => {
    const user = userEvent.setup();
    const del = vi.fn(() => ({ ok: true }));
    const get = vi.fn(() => ASSETS);
    installFetchMock({ ...FULL, 'GET /api/assets': get, 'DELETE /api/assets/as-1': del });
    render(<AccountsView />);
    const mazda = await screen.findByText('2018 Mazda 3');
    await user.click(within(mazda.closest('.asset-card') as HTMLElement)
      .getByRole('button', { name: /^remove$/i }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /confirm remove/i }),
    );
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

// Loan edit / remove flows are now part of the Loans tab (LoansView).
// The Assets tab no longer renders loans, so these tests were removed.
// The Loans-tab implementation still owns the edit / remove flows; if
// they need test coverage, those tests belong in LoansView.test.tsx.

describe('AccountsView — SnapTrade link flow', () => {
  const SNAPTRADE_COMPANIES = {
    companies: [
      { id: 'hapoalim', name: 'Bank Hapoalim', loginFields: [], type: 'bank', domain: 'bankhapoalim.co.il' },
      { id: 'snaptrade', name: 'SnapTrade (brokerages)', loginFields: ['clientId', 'consumerKey'], type: 'brokerage', domain: 'snaptrade.com' },
    ],
  };

  const SNAPTRADE_ROUTES = {
    ...FULL,
    'GET /api/companies': () => SNAPTRADE_COMPANIES,
    'GET /api/connections': () => ({ connections: [] }),
    'GET /api/accounts': () => ({ accounts: [] }),
    'POST /api/connections': () => ({
      connection: {
        id: 'new-st-conn', companyId: 'snaptrade', displayName: 'SnapTrade (brokerages)',
        createdAt: '2026-05-27T00:00:00Z', lastScrapeAt: null, lastStatus: null, hasCredentials: true,
      },
    }),
    'POST /api/snaptrade/brokerages': () => ({
      brokerages: [
        { slug: 'INTERACTIVE_BROKERS', name: 'Interactive Brokers' },
        { slug: 'SCHWAB', name: 'Charles Schwab' },
      ],
    }),
  };

  it('Add Account → Brokerages → inline credentials form → inline brokerage list', async () => {
    const user = userEvent.setup();
    installFetchMock(SNAPTRADE_ROUTES);

    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    await user.click(await screen.findByRole('button', { name: /brokerages/i }));

    // No SnapTrade connection exists yet → inline credentials form appears
    // ('Connect a brokerage' header, no separate modal).
    expect(await screen.findByRole('heading', { name: /connect a brokerage/i })).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/clientId/i), 'demo-cid');
    await user.type(screen.getByLabelText(/consumerKey/i), 'demo-key');
    await user.click(screen.getByRole('button', { name: /^connect$/i }));

    // Inline brokerage list takes over the same modal.
    expect(await screen.findByRole('heading', { name: /^brokerages$/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
  });

  it('Add Account → Brokerages with existing SnapTrade conn → skips creds, shows brokerage list', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...SNAPTRADE_ROUTES,
      'GET /api/connections': () => ({
        connections: [
          {
            id: 'existing-st', companyId: 'snaptrade', displayName: 'SnapTrade',
            createdAt: '2026-05-27T00:00:00Z', lastScrapeAt: null, lastStatus: null, hasCredentials: true,
          },
        ],
      }),
    });

    render(<AccountsView />);
    await user.click(await screen.findByRole('button', { name: /add asset/i }));
    await user.click(await screen.findByRole('button', { name: /brokerages/i }));

    // Skips credentials step entirely.
    expect(screen.queryByRole('heading', { name: /connect a brokerage/i })).toBeNull();
    expect(await screen.findByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
  });

  it('SnapTrade ConnectionCard renders a Link button that opens the flow', async () => {
    const user = userEvent.setup();
    installFetchMock({
      ...SNAPTRADE_ROUTES,
      'GET /api/connections': () => ({
        connections: [
          {
            id: 'existing-st', companyId: 'snaptrade', displayName: 'SnapTrade',
            createdAt: '2026-05-27T00:00:00Z', lastScrapeAt: null, lastStatus: null, hasCredentials: true,
          },
        ],
      }),
    });

    render(<AccountsView />);

    await user.click(await screen.findByRole('button', { name: /link a brokerage/i }));
    expect(await screen.findByRole('dialog', { name: /link a brokerage/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Interactive Brokers/i })).toBeInTheDocument();
  });
});

import { AddManualAssetForm } from './AccountsView';

describe('AddManualAssetForm — initialKind prop', () => {
  it('defaults the Kind dropdown to "cash" when no initialKind is given', () => {
    installFetchMock({});
    render(<AddManualAssetForm onClose={() => {}} onSaved={async () => {}} />);
    const kind = screen.getByLabelText(/kind/i) as HTMLSelectElement;
    expect(kind.value).toBe('cash');
  });

  it('preselects the Kind dropdown to the provided initialKind', () => {
    installFetchMock({});
    render(
      <AddManualAssetForm
        initialKind="pension"
        onClose={() => {}}
        onSaved={async () => {}}
      />,
    );
    const kind = screen.getByLabelText(/kind/i) as HTMLSelectElement;
    expect(kind.value).toBe('pension');
  });
});
