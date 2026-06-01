import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the scraper layer so the interactive path just awaits the OTP callback
// (which rejects on timeout) instead of launching a real Puppeteer browser.
// This exercises the runner side of H-5: requestOtp's timeout → execute()'s
// catch → finish('error') → scrape-lock release. (The actual browser.close()
// on the Puppeteer path can only be confirmed by a live run; this locks down
// the runner wiring that drives that cleanup.)
//
// runInteractiveScrape(companyId, credentials, startDate, onProgress,
//   screenshotPath, onOtpNeeded, session?) — the OTP callback is the 6th arg
// (index 5). The mock awaits it so an un-submitted code drives requestOtp's
// timeout path (which is what H-5 added); on submit it resolves to success.
vi.mock('../src/scrapers.js', () => ({
  runInteractiveScrape: vi.fn(async (...args: unknown[]) => {
    const onOtpNeeded = args[5] as () => Promise<string>;
    await onOtpNeeded();
    return { accounts: [] };
  }),
  runScrape: vi.fn(async () => ({ accounts: [] })),
}));

import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { Vault } from '../src/vault.js';
import { ScrapeRunner } from '../src/runner.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-otp-'));
  const { db } = openDatabase(dir);
  const repo = new Repo(db);
  const vault = new Vault(repo);
  const runner = new ScrapeRunner(repo, dir, vault);
  return { repo, runner };
}

describe('OTP wait timeout (H-5)', () => {
  afterEach(() => {
    delete process.env.HON_OTP_TIMEOUT_MS;
    vi.clearAllMocks();
  });

  it('an abandoned OTP times out → run ends in error and the scrape lock clears', async () => {
    // Short timeout so the abandoned-OTP path resolves fast instead of 5 min.
    process.env.HON_OTP_TIMEOUT_MS = '150';
    const { repo, runner } = setup();
    const conn = repo.createConnection('beinleumi', 'FIBI');

    const runId = runner.start({
      companyId: 'beinleumi', // a real interactive bank → runInteractiveScrape path
      connectionId: conn.id,
      credentials: { username: 'u', password: 'p' },
      interactive: true,
      monthsBack: 3,
    });

    // Locked while the (mocked) scrape is awaiting the OTP.
    expect(runner.isActive(conn.id)).toBe(true);

    // After the 150ms timeout, the rejection propagates through execute()'s catch
    // → finish('error', 'otp.timeout') and the per-connection lock is released.
    await vi.waitFor(
      () => {
        expect(runner.getStatus(runId)?.status).toBe('error');
      },
      { timeout: 2000, interval: 20 },
    );

    expect(runner.getStatus(runId)?.message).toContain('otp.timeout');
    expect(runner.isActive(conn.id)).toBe(false);
  });

  it('submitting the code before the deadline cancels the timeout (no otp.timeout error)', async () => {
    // A long timeout that must NOT fire — submitting the code should clear the
    // timer. We assert the run never lands in the otp.timeout error state.
    process.env.HON_OTP_TIMEOUT_MS = '600000';
    const { repo, runner } = setup();
    const conn = repo.createConnection('beinleumi', 'FIBI');

    const runId = runner.start({
      companyId: 'beinleumi',
      connectionId: conn.id,
      credentials: { username: 'u', password: 'p' },
      interactive: true,
      monthsBack: 3,
    });

    // Poll submitOtp until the resolver is registered (the run reached
    // needs-otp); a true return means the code was delivered and the timeout
    // timer was cleared (clearTimeout in the resolver branch).
    await vi.waitFor(
      () => {
        expect(runner.submitOtp(runId, '123456')).toBe(true);
      },
      { timeout: 1000, interval: 10 },
    );

    // Let the run settle (the mocked scrape resolves immediately after the
    // code). Whatever terminal state it reaches, it must NOT be the
    // otp.timeout failure — that's the regression this guards.
    await vi.waitFor(
      () => {
        expect(runner.getStatus(runId)?.status).not.toBe('needs-otp');
      },
      { timeout: 2000, interval: 20 },
    );
    expect(runner.getStatus(runId)?.message).not.toContain('otp.timeout');
    expect(runner.isActive(conn.id)).toBe(false);
  });
});
