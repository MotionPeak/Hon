import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/pension.js', () => ({
  runPensionScrape: vi.fn(async (...args: unknown[]) => {
    (args[6] as (() => void) | undefined)?.();
    await new Promise((r) => setTimeout(r, 100));
    return { success: true, accounts: [] };
  }),
  isPensionCompany: (id: string) => id === 'menora',
}));

import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { Vault } from '../src/vault.js';
import { ScrapeRunner } from '../src/runner.js';

describe('validateVncTicket', () => {
  it('accepts a live run ticket and rejects unknown/empty tickets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hon-vnc-'));
    const { db } = openDatabase(dir);
    const repo = new Repo(db);
    const runner = new ScrapeRunner(repo, dir, new Vault(repo));
    const conn = repo.createConnection('menora', 'Menora');
    const runId = runner.start({
      companyId: 'menora', connectionId: conn.id,
      credentials: { id: '1' }, interactive: true, monthsBack: 3,
    });
    await vi.waitFor(() => {
      expect(runner.getStatus(runId)?.vncTicket).toBeTruthy();
    }, { timeout: 1000, interval: 10 });
    const ticket = runner.getStatus(runId)!.vncTicket!;
    expect(runner.validateVncTicket(ticket)).toBe(true);
    expect(runner.validateVncTicket('nope')).toBe(false);
    expect(runner.validateVncTicket('')).toBe(false);
  });
});
