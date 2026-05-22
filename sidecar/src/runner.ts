import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from './repo.js';
import type { Vault } from './vault.js';
import { isSnapTrade, runSnapTradeSync } from './snaptrade.js';
import { isPensionCompany, runPensionScrape, setPensionSolverConfig } from './pension.js';
import { runInteractiveScrape, runScrape, type ScrapeOutcome } from './scrapers.js';

export interface StartArgs {
  connectionId: string;
  companyId: string;
  credentials: Record<string, string>;
  monthsBack: number;
  interactive: boolean;
}

export interface RunStatus {
  runId: string;
  connectionId: string;
  status: 'running' | 'needs-otp' | 'success' | 'error';
  message: string;
  accountsCount: number;
  transactionsCount: number;
  startedAt: string;
  finishedAt?: string;
}

/**
 * Runs scrapes in the background and tracks their live status. The Hon app
 * starts a scrape, then polls getStatus() until it is done.
 */
export class ScrapeRunner {
  private readonly runs = new Map<string, RunStatus>();
  private readonly otpResolvers = new Map<string, (code: string) => void>();
  private readonly debugDir: string;

  constructor(
    private readonly repo: Repo,
    dataDir: string,
    private readonly vault: Vault,
  ) {
    this.debugDir = join(dataDir, 'debug');
  }

  /** Kicks off a scrape and returns its run id immediately. */
  start(args: StartArgs): string {
    const run = this.repo.createRun(args.connectionId);
    const status: RunStatus = {
      runId: run.id,
      connectionId: args.connectionId,
      status: 'running',
      message: 'Starting…',
      accountsCount: 0,
      transactionsCount: 0,
      startedAt: run.startedAt,
    };
    this.runs.set(run.id, status);
    this.repo.setConnectionStatus(args.connectionId, 'running');
    void this.execute(status, args);
    return run.id;
  }

  getStatus(runId: string): RunStatus | undefined {
    return this.runs.get(runId);
  }

  /** Clears any stale failure screenshot and returns the path for a new one. */
  private prepareScreenshotPath(companyId: string): string | undefined {
    try {
      mkdirSync(this.debugDir, { recursive: true });
      const path = join(this.debugDir, `${companyId}.png`);
      rmSync(path, { force: true });
      return path;
    } catch {
      return undefined;
    }
  }

  /** Called by the scraper when it needs a 2FA code; resolves when one arrives. */
  private requestOtp(status: RunStatus): Promise<string> {
    return new Promise<string>((resolve) => {
      status.status = 'needs-otp';
      status.message = 'Waiting for the verification code…';
      this.otpResolvers.set(status.runId, (code) => {
        status.status = 'running';
        status.message = 'Submitting the verification code…';
        resolve(code);
      });
    });
  }

  /** Supplies a 2FA code for a run that is waiting on one. */
  submitOtp(runId: string, code: string): boolean {
    const resolver = this.otpResolvers.get(runId);
    if (!resolver) return false;
    this.otpResolvers.delete(runId);
    resolver(code);
    return true;
  }

  private async execute(status: RunStatus, args: StartArgs): Promise<void> {
    try {
      let outcome: ScrapeOutcome;
      if (isSnapTrade(args.companyId)) {
        outcome = await runSnapTradeSync(args.credentials, this.vault, (message) => {
          status.message = message;
        });
      } else if (isPensionCompany(args.companyId)) {
        // Pension funds have no scraper library, so a custom Puppeteer routine
        // drives the portal login (and any SMS one-time code) itself. Apply
        // the user's solver settings first — both API keys are vault secrets.
        let capSolverKey = '';
        let twoCaptchaKey = '';
        try {
          if (this.vault.unlocked) {
            capSolverKey = this.vault.loadSecret('capsolver_key') ?? '';
            twoCaptchaKey = this.vault.loadSecret('twocaptcha_key') ?? '';
          }
        } catch {
          /* a missing or unreadable secret leaves that key empty */
        }
        setPensionSolverConfig({
          enabled: this.repo.getMeta('capsolver_enabled') === '1',
          capSolverKey,
          twoCaptchaKey,
        });
        outcome = await runPensionScrape(
          args.companyId,
          args.credentials,
          (message) => {
            status.message = message;
          },
          this.prepareScreenshotPath(args.companyId),
          () => this.requestOtp(status),
        );
      } else if (args.interactive) {
        outcome = await runInteractiveScrape(
          args.companyId,
          args.credentials,
          startDateMonthsAgo(args.monthsBack),
          (progress) => {
            status.message = humanizeProgress(progress);
          },
          this.prepareScreenshotPath(args.companyId),
          () => this.requestOtp(status),
        );
      } else {
        outcome = await runScrape(
          args.companyId,
          args.credentials,
          startDateMonthsAgo(args.monthsBack),
          (progress) => {
            status.message = humanizeProgress(progress);
          },
          this.prepareScreenshotPath(args.companyId),
        );
      }

      if (!outcome.success) {
        this.finish(status, args.connectionId, 'error', describeError(outcome));
        return;
      }

      const saved = this.repo.saveScrapeResult(args.connectionId, outcome.accounts);
      status.accountsCount = saved.accounts;
      status.transactionsCount = saved.transactions;
      this.finish(
        status,
        args.connectionId,
        'success',
        `Imported ${saved.accounts} account(s) and ${saved.transactions} transaction(s).`,
      );
    } catch (err) {
      this.finish(
        status,
        args.connectionId,
        'error',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private finish(
    status: RunStatus,
    connectionId: string,
    result: 'success' | 'error',
    message: string,
  ): void {
    this.otpResolvers.delete(status.runId);
    status.status = result;
    status.message = message;
    status.finishedAt = new Date().toISOString();
    this.repo.updateRun(status.runId, {
      status: result,
      message,
      finishedAt: status.finishedAt,
      accountsCount: status.accountsCount,
      transactionsCount: status.transactionsCount,
    });
    this.repo.setConnectionStatus(connectionId, result, status.finishedAt);
  }
}

function startDateMonthsAgo(months: number): Date {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

function describeError(outcome: { errorType?: string; errorMessage?: string }): string {
  const hints: Record<string, string> = {
    INVALID_PASSWORD: 'The username or password was rejected.',
    CHANGE_PASSWORD: 'The institution is asking you to change your password — do that on their site first.',
    ACCOUNT_BLOCKED: 'The account is blocked. Contact the institution.',
    TWO_FACTOR_RETRIEVER_MISSING: 'This account needs two-factor auth, which Hon does not support yet.',
    TIMEOUT: 'The institution timed out. Try again.',
  };
  const type = outcome.errorType ?? 'GENERIC';
  return hints[type] ?? outcome.errorMessage ?? 'The scrape failed.';
}

function humanizeProgress(progressType: string): string {
  switch (progressType) {
    case 'INITIALIZING':
      return 'Starting the browser…';
    case 'START_SCRAPING':
      return 'Connecting to the institution…';
    case 'LOGGING_IN':
      return 'Logging in…';
    case 'LOGIN_SUCCESS':
      return 'Logged in — fetching transactions…';
    case 'LOGIN_FAILED':
      return 'Login failed.';
    case 'CHANGE_PASSWORD':
      return 'The institution requires a password change.';
    case 'END_SCRAPING':
      return 'Finishing up…';
    case 'TERMINATING':
      return 'Closing the browser…';
    default:
      return 'Working…';
  }
}
