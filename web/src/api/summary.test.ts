import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchMock } from '../test/mockFetch';
import { getSummary } from './summary';

afterEach(() => vi.restoreAllMocks());

const validSummary = {
  connectionCount: 2,
  accountCount: 3,
  manualAssetCount: 1,
  voucherCount: 0,
  byCurrency: [{ currency: 'ILS', total: 1000, accountCount: 3 }],
  netWorthILS: 1000,
  sources: [{ key: 'bank', amount: 1000 }],
};

describe('getSummary', () => {
  it('unwraps and parses { summary } from GET /summary', async () => {
    installFetchMock({ 'GET /api/summary': () => ({ summary: validSummary }) });
    await expect(getSummary()).resolves.toEqual(validSummary);
  });

  it('rejects when the payload shape drifts (missing required fields)', async () => {
    installFetchMock({ 'GET /api/summary': () => ({ summary: { accountCount: 0 } }) });
    await expect(getSummary()).rejects.toThrow();
  });
});
