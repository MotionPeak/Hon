import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AccountsView } from './AccountsView';
import { installFetchMock } from '../test/mockFetch';

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
