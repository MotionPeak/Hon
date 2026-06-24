import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the pension module: runPensionScrape signals it's waiting for a remote
// sign-in (the 7th arg), then resolves (so the run finishes and we can assert
// the flag is cleared).
vi.mock('../src/pension.js', () => ({
  runPensionScrape: vi.fn(async (
    _companyId: string,
    _credentials: Record<string, string>,
    _onProgress: ((m: string) => void) | undefined,
    _screenshotPath: string | undefined,
    _onOtpNeeded: () => Promise<string>,
    _session: unknown,
    onRemoteSignin?: () => void,
  ) => {
    onRemoteSignin?.();
    await new Promise((r) => setTimeout(r, 50));
    return { success: true, accounts: [] };
  }),
  isPensionCompany: (id: string) => id === 'menora',
}));

import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { Vault } from '../src/vault.js';
import { ScrapeRunner } from '../src/runner.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-signin-'));
  const { db } = openDatabase(dir);
  const repo = new Repo(db);
  return { repo, runner: new ScrapeRunner(repo, dir, new Vault(repo)) };
}

afterEach(() => vi.clearAllMocks());

describe('needsRemoteSignin run signal', () => {
  it('flips true while a captcha pension waits, and is cleared when the run ends', async () => {
    const { repo, runner } = setup();
    const conn = repo.createConnection('menora', 'Menora');
    const runId = runner.start({
      companyId: 'menora', connectionId: conn.id,
      credentials: { id: '123', phone: '050' }, interactive: true, monthsBack: 3,
    });
    await vi.waitFor(() => {
      expect(runner.getStatus(runId)?.needsRemoteSignin).toBe(true);
    }, { timeout: 1000, interval: 10 });
    await vi.waitFor(() => {
      expect(runner.getStatus(runId)?.status).toBe('success');
    }, { timeout: 1000, interval: 10 });
    expect(runner.getStatus(runId)?.needsRemoteSignin).toBe(false);
  });
});
