import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { OverviewView } from './OverviewView';
import { installFetchMock } from '../test/mockFetch';
import { __resetSplitwiseCache } from '../splitwise/useSplitwise';
import { SettingsProvider } from '../settings/useSettings';
import { currentCycleKey } from '../cycle';

afterEach(() => { __resetSplitwiseCache(); localStorage.clear(); });

// OverviewView reads settings (card-bill exclusion list) via useSettings, so it
// must mount inside a SettingsProvider. Default settings have hideCardTotals on
// and a cardProviders list that includes 'מקס' (Max).
function renderOverview() {
  return renderWithProviders(
    <SettingsProvider>
      <OverviewView />
    </SettingsProvider>,
  );
}

const FULL_SUMMARY = {
  byCurrency: [
    { currency: 'ILS', total: 78000, accountCount: 3 },
    { currency: 'USD', total: 4300, accountCount: 1 },
  ],
  accountCount: 4,
  connectionCount: 3,
  manualAssetCount: 1,
  voucherCount: 2,
  netWorthILS: 92000,
  // Net-worth source buckets (already ILS), the shape the engine returns.
  sources: [
    { key: 'asset:car', amount: 60000 },
    { key: 'bank', amount: 16000 },
    { key: 'brokerage', amount: 4300 },
    { key: 'card', amount: -5000 },
    { key: 'loan', amount: -3000 },
  ],
};

const FULL_BUDGET = {
  currency: 'ILS',
  variable: {
    income: 12000,
    committed: 7500,
    spent: 1200,
    fixedSpent: 5400,
    essentialSpent: 2100,
    allowed: 3300,
    savings: 0,
    piggyFunded: 0,
  },
  piggy: { month: '2026-05', banks: [], fundedTotal: 0, headroom: 3500, projected: true },
  essentials: [
    { category: 'Groceries', budget: 2500, spent: 1800 },
    { category: 'Transport', budget: 800, spent: 300 },
  ],
};

const COMPANIES = {
  companies: [
    { id: 'hapoalim', name: 'Hapoalim', loginFields: ['userCode', 'password'], type: 'bank' },
    { id: 'max', name: 'Max', loginFields: ['username', 'password'], type: 'card' },
  ],
};

const ACCOUNTS = {
  accounts: [
    {
      id: 'a1', connectionId: 'c1', companyId: 'hapoalim',
      connectionName: 'Hapoalim',
      accountNumber: '12-345',
      label: null,
      balance: 15000,
      currency: 'ILS',
      updatedAt: '2026-05-25T00:00:00Z',
      excluded: false,
      inceptionDate: null,
    },
    {
      id: 'a2', connectionId: 'c1', companyId: 'hapoalim',
      connectionName: 'Hapoalim',
      accountNumber: '12-346',
      label: null,
      balance: 1000,
      currency: 'ILS',
      updatedAt: '2026-05-25T00:00:00Z',
      excluded: false,
      inceptionDate: null,
    },
    {
      // Card account — should not contribute to bank-now.
      id: 'a3', connectionId: 'c2', companyId: 'max',
      connectionName: 'Max',
      accountNumber: 'card',
      label: null,
      balance: -5000,
      currency: 'ILS',
      updatedAt: '2026-05-25T00:00:00Z',
      excluded: false,
      inceptionDate: null,
    },
  ],
};

const EMPTY_SUMMARY = {
  byCurrency: [], accountCount: 0, connectionCount: 0, manualAssetCount: 0,
  voucherCount: 0, netWorthILS: 0, sources: [],
};
const EMPTY_BUDGET = {
  currency: 'ILS',
  variable: { income: 0, committed: 0, spent: 0, fixedSpent: 0, essentialSpent: 0, allowed: 0, savings: 0, piggyFunded: 0 },
  piggy: { month: '', banks: [], fundedTotal: 0, headroom: 0, projected: false },
  essentials: [],
};

// "YYYY-MM" for the cycle `n` calendar months before now (monthStartDay=1).
function priorCycle(n: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Default recurring fixture: one ₪5,400 monthly Housing bill seen in the two
// prior cycles. expectedFixedThisCycle → 5,400 == FULL_BUDGET.fixedSpent, so
// committedDisplay == the budget's committed (7,500) and the existing
// projection/headline math tests keep their numbers.
const RECURRING_DEFAULT = {
  categories: [{ name: 'Housing', catGroup: 'fixed' }],
  transactions: [
    { id: 'h1', date: `${priorCycle(2)}-10`, amount: -5400, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
    { id: 'h2', date: `${priorCycle(1)}-10`, amount: -5400, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
  ],
};

function mocks(overrides: Record<string, unknown> = {}): Record<string, () => unknown> {
  return {
    // The engine wraps the summary in a `summary` envelope (legacy unwraps
    // `r.summary`); the mock must match that contract.
    'GET /api/summary': () => ({ summary: FULL_SUMMARY }),
    'GET /api/budget': () => FULL_BUDGET,
    'GET /api/companies': () => COMPANIES,
    'GET /api/accounts': () => ACCOUNTS,
    // Recurring endpoints feed the predicted-fixed headline (Task: predicted fixed).
    'GET /api/transactions': () => ({ transactions: RECURRING_DEFAULT.transactions }),
    'GET /api/categories': () => ({ categories: RECURRING_DEFAULT.categories }),
    'GET /api/merchant-frequencies': () => ({ frequencies: {} }),
    'GET /api/category-splits': () => ({ splits: {}, shareAmounts: {} }),
    'GET /api/subscriptions/cancelled': () => ({ cancelled: {} }),
    // OwedToYouCard's useSplitwise hook fetches on mount; stub disconnected
    // so the card renders null and no /refresh call is made.
    'GET /api/splitwise/status': () => ({ connected: false, user: null }),
    'GET /api/splitwise/links': () => ({ links: [] }),
    ...overrides,
  };
}

describe('OverviewView', () => {
  it('passes card-provider exclusions to /budget when hideCardTotals is on', async () => {
    const spy = installFetchMock(mocks());
    renderOverview();
    await screen.findByTestId('balance-card');
    // The bank-side credit-card bill lump sum (e.g. "מקס איט פיננסים") is
    // already itemised under the card account; counting it again on the bank
    // side double-counts. /budget only drops it when the client passes the
    // cardProvider exclusion list — same as Insights, Activity, legacy SPA.
    const budgetCall = spy.mock.calls.find(
      ([input]) => String(input).includes('/api/budget'),
    );
    expect(budgetCall, 'OverviewView should fetch /api/budget').toBeTruthy();
    const url = decodeURIComponent(String(budgetCall![0]));
    expect(url).toContain('cardProvider=');
    expect(url).toContain('מקס');
  });

  it('scopes /budget to the current billing cycle (start + end)', async () => {
    const spy = installFetchMock(mocks());
    renderOverview();
    await screen.findByTestId('balance-card');
    const budgetCall = spy.mock.calls.find(
      ([input]) => String(input).includes('/api/budget'),
    );
    const url = decodeURIComponent(String(budgetCall![0]));
    // Default monthStartDay = 1 → the current calendar month's bounds.
    const today = new Date();
    const start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    expect(url).toContain(`start=${start}`);
    expect(url).toContain('end=');
  });

  it('uses predicted fixed (not posted) for "Expected fixed + essentials"', async () => {
    // One detected ₪3,000 monthly Housing bill (two prior cycles) + ₪2,100
    // essentialSpent → committedDisplay = 5,100, regardless of the budget's
    // posted fixedSpent (5,400) / committed (7,500).
    installFetchMock(mocks({
      'GET /api/categories': () => ({ categories: [{ name: 'Housing', catGroup: 'fixed' }] }),
      'GET /api/transactions': () => ({
        transactions: [
          { id: 't1', date: `${priorCycle(2)}-10`, amount: -3000, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
          { id: 't2', date: `${priorCycle(1)}-10`, amount: -3000, currency: 'ILS', description: 'RENT', category: 'Housing', refundForId: null },
        ],
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('balance-card');
    // freeNet = income(12000) − committedDisplay(5100) − spent(1200) = 5700
    // The new hero is the projected bank balance; "free to spend" shows freeNet.
    const freeRow = card.querySelector('.balance-free') as HTMLElement;
    expect(freeRow.textContent).toMatch(/5,?700/);
    // The details block shows "Fixed + essentials still due" driven by predictedFixed=3000.
    // (fixedDueNotYetPosted uses the merchant rows — RENT ₪3000 not yet posted this cycle.)
    const details = card.querySelector('[data-testid="bank-projection"]') as HTMLElement;
    expect(within(details).getByText(/3,?000/)).toBeInTheDocument();
  });

  it('falls back to posted committed when the recurring fetch fails', async () => {
    installFetchMock(mocks({
      'GET /api/transactions': () => new Response('boom', { status: 500 }),
    }));
    renderOverview();
    const card = await screen.findByTestId('balance-card');
    // recurring failed → committedDisplay = variable.committed (7500);
    // freeNet = 12000 − 7500 − 1200 = 3300
    // When recurring fails, merchant rows are empty so fixedDueNotYetPosted=0.
    // The hero (.balance-num) shows futureBank; freeNet is in .balance-free.
    const freeRow = card.querySelector('.balance-free') as HTMLElement;
    expect(freeRow.textContent).toMatch(/3,?300/);
  });

  it('adds an "Owed to you (Splitwise)" line to the projection and end balance', async () => {
    // owed comes from link counterparties, not Splitwise friend balances.
    const link = {
      transactionId: 'e3', expenseId: 'x3', groupId: null, currency: 'ILS',
      owedToMe: 800, counterparties: [{ id: 5, name: 'Noga', owed: 800, paid: 0 }],
      paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
    };
    installFetchMock(mocks({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1 } }),
      'GET /api/splitwise/links': () => ({ links: [link] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [link] }),
    }));
    renderOverview();
    const card = await screen.findByTestId('bank-projection');
    // owed (ILS, >0) = 800 → its own projection line, folded into end balance.
    expect(await within(card).findByText(/Owed to you \(Splitwise\)/i)).toBeInTheDocument();
    expect(within(card).getByText(/800/)).toBeInTheDocument();
  });

  it('omits the owed line when Splitwise has no ILS balance owed', async () => {
    // A USD link: owed comes from link counterparties, filtered by currency.
    // The projection only includes same-currency (ILS) owed amounts.
    const usdLink = {
      transactionId: 'e4', expenseId: 'x4', groupId: null, currency: 'USD',
      owedToMe: 50, counterparties: [{ id: 6, name: 'Noga', owed: 50, paid: 0 }],
      paidAmount: 0, paidState: 'open', createdAt: '2026-05-01', syncedAt: null,
    };
    installFetchMock(mocks({
      'GET /api/splitwise/status': () => ({ connected: true, user: { id: 1 } }),
      'GET /api/splitwise/links': () => ({ links: [usdLink] }),
      'POST /api/splitwise/refresh': () => ({ friends: [], links: [usdLink] }),
    }));
    renderOverview();
    // Wait for Splitwise to finish loading (the OwedToYouCard shows the USD friend),
    // then assert the projection has no owed line — USD is filtered out.
    await screen.findByText('Noga');
    const card = await screen.findByTestId('bank-projection');
    expect(within(card).queryByText(/Owed to you \(Splitwise\)/i)).not.toBeInTheDocument();
  });

  it('renders the net worth card with the ILS headline', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    expect(within(card as HTMLElement).getByText(/92,?000/)).toBeInTheDocument();
  });

  it('renders per-currency chips when more than one currency is held', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    // Scope to the chips row — the breakdown rows below also show amounts.
    const chips = (card as HTMLElement).querySelector('.nw-chips') as HTMLElement;
    expect(within(chips).getByText(/78,?000/)).toBeInTheDocument();
    expect(within(chips).getByText(/4,?300/)).toBeInTheDocument();
  });

  it('renders the source breakdown (alloc bar + labelled rows incl. debt)', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = (await screen.findByText(/total net worth/i)).closest('section')!;
    // One allocation segment per positive source (car, bank, brokerage = 3).
    expect((card as HTMLElement).querySelectorAll('.nw-alloc-seg')).toHaveLength(3);
    // Labelled rows, including debt rows.
    expect(within(card as HTMLElement).getByText('Car')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('Bank accounts')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('Loans')).toBeInTheDocument();
    // Debt amount carries the `neg` class (red).
    const loanRow = within(card as HTMLElement).getByText('Loans').closest('.nw-bd-row')!;
    expect(loanRow.querySelector('.nw-bd-amt.neg')).not.toBeNull();
    // Sub line counts accounts + hand-entered assets, not connections.
    expect(within(card as HTMLElement).getByText('4 accounts · 1 asset')).toBeInTheDocument();
  });

  it('renders the projected checking balance hero and the mode picker', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = await screen.findByTestId('balance-card');
    // New hero: "Projected checking balance" (not "This month")
    expect(card.querySelector('.balance-head')!.textContent).toBe('Projected checking balance');
    // The projection-picker renders two toggle buttons (role=group, aria-pressed)
    const picker = await screen.findByTestId('projection-picker');
    expect(within(picker).getByRole('button', { name: 'Committed' })).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: '+ Variable budget' })).toBeInTheDocument();
    // "Free to spend this month" row still present (freeNet = 12000 - 7500 - 1200 = 3300)
    const freeRow = card.querySelector('.balance-free') as HTMLElement;
    expect(freeRow.textContent).toMatch(/3,?300/);
  });

  it('adds the "Variable budget left" row when + Variable budget is selected', async () => {
    // Default mocks have a bank account present, so the projected hero + picker render.
    installFetchMock(mocks());
    renderOverview();
    await screen.findByTestId('projection-picker');
    // Committed is the default (afterEach clears localStorage, so no leaked mode).
    expect(screen.queryByText(/Variable budget left/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Variable budget' }));
    expect(await screen.findByText(/Variable budget left/i)).toBeInTheDocument();
  });

  it('marks the "free to spend" row red when committed > income (in the red)', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        variable: { ...FULL_BUDGET.variable, income: 5000, committed: 7500, spent: 1200 },
      }),
    }));
    renderOverview();
    // freeNet = 5000 - 7500 - 1200 = -3700
    const card = await screen.findByTestId('balance-card');
    const freeRow = card.querySelector('.balance-free') as HTMLElement;
    expect(freeRow.textContent).toMatch(/3,?700/);
    // The amount span inside .balance-free carries 'bad' when freeNet < 0
    const amtSpan = freeRow.querySelector('span:last-child') as HTMLElement;
    expect(amtSpan.className).toMatch(/\bbad\b/);
  });

  it('shows the empty state when there are no accounts or budget data', async () => {
    installFetchMock(mocks({
      'GET /api/summary': () => ({ summary: EMPTY_SUMMARY }),
      'GET /api/budget': () => EMPTY_BUDGET,
      'GET /api/companies': () => ({ companies: [] }),
      'GET /api/accounts': () => ({ accounts: [] }),
    }));
    renderOverview();
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it('renders the projected bank balance and details breakdown', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        variable: { ...FULL_BUDGET.variable, piggyFunded: 500 },
      }),
    }));
    renderOverview();
    // bank-projection testid is now the details div inside the card.
    const details = await screen.findByTestId('bank-projection');
    // "Bank balance now" row: bankNow = 15000 + 1000 = 16000 (card account excluded)
    expect(within(details).getByText(/16,?000/)).toBeInTheDocument();
    // Set-asides (piggies) row shows 500
    expect(within(details).getByText(/500/)).toBeInTheDocument();
    // The hero (.balance-num on the balance-card) shows the projected futureBank.
    // bankNow=16000, incomeStillExpected=12000 (no income posted this cycle),
    // fixedDueNotYetPosted=5400 (RENT from recurring), piggies=500
    // futureBank = 16000 + 12000 − 5400 − 500 = 22100
    const balanceCard = await screen.findByTestId('balance-card');
    expect((balanceCard.querySelector('.balance-num') as HTMLElement).textContent).toMatch(/22,?100/);
  });

  it('excludes excluded bank accounts and non-ILS accounts from bank-now', async () => {
    installFetchMock(mocks({
      'GET /api/accounts': () => ({
        accounts: [
          ...ACCOUNTS.accounts.slice(0, 1), // 15,000 ILS bank
          {
            id: 'excluded', connectionId: 'c1', companyId: 'hapoalim',
            connectionName: 'Hapoalim', accountNumber: 'x', label: null,
            balance: 999999, currency: 'ILS',
            updatedAt: '2026-05-25T00:00:00Z',
            excluded: true, inceptionDate: null,
          },
          {
            id: 'usd', connectionId: 'c1', companyId: 'hapoalim',
            connectionName: 'Hapoalim', accountNumber: 'usd', label: null,
            balance: 8888, currency: 'USD',
            updatedAt: '2026-05-25T00:00:00Z',
            excluded: false, inceptionDate: null,
          },
        ],
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('bank-projection');
    // bankNow = 15,000 (only the first ILS bank account)
    expect(within(card).getByText(/15,?000/)).toBeInTheDocument();
    expect(within(card).queryByText(/999,?999/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/8,?888/)).not.toBeInTheDocument();
  });

  it('omits the projection block when there are no bank accounts', async () => {
    installFetchMock(mocks({
      'GET /api/accounts': () => ({
        accounts: [ACCOUNTS.accounts[2]], // only the card account — no banks
      }),
    }));
    renderOverview();
    await screen.findByTestId('balance-card');
    expect(screen.queryByTestId('bank-projection')).not.toBeInTheDocument();
  });

  it('renders essentials inside the budget card, one row per line', async () => {
    installFetchMock(mocks());
    renderOverview();
    const card = await screen.findByTestId('budget-card');
    expect(within(card).getByText('Groceries')).toBeInTheDocument();
    expect(within(card).getByText('Transport')).toBeInTheDocument();
    // Groceries — 1,800 / 2,500
    const row = within(card).getByText('Groceries').closest('.bgt-line') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText(/1,?800/)).toBeInTheDocument();
    expect(within(row).getByText(/2,?500/)).toBeInTheDocument();
  });

  it('marks an essentials row over-budget when spent exceeds budget', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({
        ...FULL_BUDGET,
        essentials: [{ category: 'Groceries', budget: 2000, spent: 2400 }],
      }),
    }));
    renderOverview();
    const card = await screen.findByTestId('budget-card');
    const row = within(card).getByText('Groceries').closest('.bgt-line');
    expect(row).not.toBeNull();
    // The bar fill picks up the `over` class once spend exceeds budget.
    expect(row!.querySelector('.bgt-fill.over')).not.toBeNull();
  });

  it('shows the budget card with no essential rows when no essential lines exist', async () => {
    installFetchMock(mocks({
      'GET /api/budget': () => ({ ...FULL_BUDGET, essentials: [] }),
    }));
    renderOverview();
    const card = await screen.findByTestId('budget-card');
    expect(card.querySelector('.bgt-line')).toBeNull();
    expect(within(card).queryByText('Essentials')).not.toBeInTheDocument();
  });

  it('shows "Saved this cycle" from savings-marked transactions', async () => {
    installFetchMock(mocks({
      'GET /api/transactions': () => ({ transactions: [
        ...RECURRING_DEFAULT.transactions,
        { id: 'sv1', date: `${currentCycleKey(1)}-12`, amount: -1500, currency: 'ILS',
          description: 'To savings', category: 'Transfers', refundForId: null, savings: true },
      ] }),
    }));
    renderOverview();
    const line = await screen.findByTestId('saved-this-cycle');
    expect(within(line).getByText(/1,?500/)).toBeInTheDocument();
  });
});
