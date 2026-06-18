import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the scraper layer (no real Puppeteer). Two shapes:
//  - runInteractiveScrape awaits the OTP callback → the run parks at needs-otp,
//    so we can observe activeRunFor() returning the in-flight run.
//  - runScrape never resolves → simulates a hung headless scrape with no
//    timeout of its own, so only the runner's overall deadline can end it.
vi.mock('../src/scrapers.js', () => ({
  runInteractiveScrape: vi.fn(async (...args: unknown[]) => {
    const onOtpNeeded = args[5] as () => Promise<string>;
    await onOtpNeeded();
    return { accounts: [] };
  }),
  runScrape: vi.fn(() => new Promise(() => { /* never resolves */ })),
  isCardCompany: () => false,
}));

import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { Vault } from '../src/vault.js';
import { ScrapeRunner } from '../src/runner.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-run-'));
  const { db } = openDatabase(dir);
  const repo = new Repo(db);
  const vault = new Vault(repo);
  const runner = new ScrapeRunner(repo, dir, vault);
  return { repo, runner };
}

afterEach(() => {
  delete process.env.HON_OTP_TIMEOUT_MS;
  delete process.env.HON_RUN_TIMEOUT_MS;
  vi.clearAllMocks();
});

describe('activeRunFor — restore an in-flight run by connection', () => {
  it('finds the in-flight run for a connection, then nothing once it ends', async () => {
    process.env.HON_OTP_TIMEOUT_MS = '150'; // let the abandoned-OTP path end fast
    const { repo, runner } = setup();
    const conn = repo.createConnection('beinleumi', 'FIBI');

    const runId = runner.start({
      companyId: 'beinleumi', connectionId: conn.id,
      credentials: { username: 'u', password: 'p' }, interactive: true, monthsBack: 3,
    });

    // While the scrape is in flight, the UI can rediscover the run from just the
    // connection id (no runId needed) — this is what restores progress on remount.
    const active = runner.activeRunFor(conn.id);
    expect(active?.runId).toBe(runId);
    expect(['running', 'needs-otp']).toContain(active?.status);

    await vi.waitFor(() => {
      expect(runner.getStatus(runId)?.status).toBe('error');
    }, { timeout: 2000, interval: 20 });

    expect(runner.activeRunFor(conn.id)).toBeUndefined();
  });
});

describe('overall run timeout — a hung scrape self-releases the lock', () => {
  it('fails and unlocks a never-resolving scrape after the deadline', async () => {
    process.env.HON_RUN_TIMEOUT_MS = '150';
    const { repo, runner } = setup();
    const conn = repo.createConnection('hapoalim', 'Poalim');

    const runId = runner.start({
      companyId: 'hapoalim', connectionId: conn.id,
      credentials: { username: 'u', password: 'p' }, interactive: false, monthsBack: 3,
    });
    expect(runner.isActive(conn.id)).toBe(true);

    await vi.waitFor(() => {
      expect(runner.getStatus(runId)?.status).toBe('error');
    }, { timeout: 2000, interval: 20 });

    expect(runner.getStatus(runId)?.message).toMatch(/tim(ed|e)\s*out/i);
    expect(runner.isActive(conn.id)).toBe(false);
    expect(runner.activeRunFor(conn.id)).toBeUndefined();
  });
});
