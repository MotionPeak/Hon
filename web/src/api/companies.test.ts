import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchMock } from '../test/mockFetch';
import { listCompanies } from './companies';

afterEach(() => vi.restoreAllMocks());

describe('listCompanies', () => {
  it('parses { companies } from GET /companies', async () => {
    const company = { id: 'hapoalim', name: 'Hapoalim', loginFields: ['userCode'], type: 'bank' };
    installFetchMock({ 'GET /api/companies': () => ({ companies: [company] }) });
    await expect(listCompanies()).resolves.toEqual([company]);
  });

  it('rejects an unknown company type (drift)', async () => {
    installFetchMock({
      'GET /api/companies': () => ({
        companies: [{ id: 'x', name: 'X', loginFields: [], type: 'crypto' }],
      }),
    });
    await expect(listCompanies()).rejects.toThrow();
  });
});
