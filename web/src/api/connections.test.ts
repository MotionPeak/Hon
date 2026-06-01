import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchMock } from '../test/mockFetch';
import {
  listConnections,
  deleteConnection,
  updateConnectionCredentials,
  startConnectionScrape,
} from './connections';

afterEach(() => vi.restoreAllMocks());

const connection = {
  id: 'c1', companyId: 'hapoalim', displayName: 'Hapoalim', createdAt: '2026-05-01T00:00:00Z',
  lastScrapeAt: null, lastStatus: null, hasCredentials: true, historyMonths: 12,
};

describe('listConnections', () => {
  it('parses { connections } from GET /connections', async () => {
    installFetchMock({ 'GET /api/connections': () => ({ connections: [connection] }) });
    await expect(listConnections()).resolves.toEqual([connection]);
  });
});

describe('connection mutations', () => {
  it('DELETEs /connections/:id', async () => {
    const spy = installFetchMock({ 'DELETE /api/connections/c1': () => ({ ok: true }) });
    await deleteConnection('c1');
    expect(spy).toHaveBeenCalledWith('/api/connections/c1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('PUTs /connections/:id/credentials with { credentials }', async () => {
    let body: unknown;
    installFetchMock({ 'PUT /api/connections/c1/credentials': (b) => { body = b; return { ok: true }; } });
    await updateConnectionCredentials('c1', { userCode: 'u', password: 'p' });
    expect(body).toEqual({ credentials: { userCode: 'u', password: 'p' } });
  });

  it('POSTs /connections/:id/scrape and returns { runId }', async () => {
    installFetchMock({ 'POST /api/connections/c1/scrape': () => ({ runId: 'run-9' }) });
    await expect(startConnectionScrape('c1', { interactive: true })).resolves.toEqual({ runId: 'run-9' });
  });
});
