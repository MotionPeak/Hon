import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchMock } from '../test/mockFetch';
import { listAccounts, setAccountBalance, setAccountExcluded } from './accounts';

afterEach(() => vi.restoreAllMocks());

const account = {
  id: 'a1', connectionId: 'c1', companyId: 'hapoalim', connectionName: 'Hapoalim',
  accountNumber: '12-345', label: null, balance: 15000, currency: 'ILS',
  updatedAt: '2026-05-25T00:00:00Z', excluded: false, inceptionDate: null,
};

describe('listAccounts', () => {
  it('parses { accounts } from GET /accounts', async () => {
    installFetchMock({ 'GET /api/accounts': () => ({ accounts: [account] }) });
    await expect(listAccounts()).resolves.toEqual([account]);
  });

  it('rejects when a row drifts (balance is a string)', async () => {
    installFetchMock({ 'GET /api/accounts': () => ({ accounts: [{ ...account, balance: '15000' }] }) });
    await expect(listAccounts()).rejects.toThrow();
  });
});

describe('account mutations', () => {
  it('PATCHes /accounts/:id/balance with { balance }', async () => {
    let body: unknown;
    installFetchMock({ 'PATCH /api/accounts/a1/balance': (b) => { body = b; return { ok: true }; } });
    await setAccountBalance('a1', 2500);
    expect(body).toEqual({ balance: 2500 });
  });

  it('PATCHes /accounts/:id/excluded with { excluded }', async () => {
    let body: unknown;
    installFetchMock({ 'PATCH /api/accounts/a1/excluded': (b) => { body = b; return { ok: true }; } });
    await setAccountExcluded('a1', true);
    expect(body).toEqual({ excluded: true });
  });
});
