import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from './repo.js';
import type { Vault } from './vault.js';
import { isSnapTrade, runSnapTradeSync, SNAPTRADE_COMPANY_ID } from './snaptrade.js';
import { fetchYahooHistory } from './marketData.js';
import { isPensionCompany, runPensionScrape } from './pension.js';
import { runInteractiveScrape, runScrape, type ScrapeOutcome } from './scrapers.js';
import { openSession } from './session.js';

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
 * Runs scrapes in the background and tracks their live status. The web app
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

  /**
   * Picks the start date for a scrape. With a successful previous run on
   * record, fetches from 14 days before its finish — the buffer catches
   * transactions that post late or whose processed-date drifts. Otherwise
   * falls back to the requested monthsBack window (the first-ever sync, or a
   * sync after a failure). The DB's UNIQUE(account_id, external_id) makes any
   * overlap a no-op, so the buffer is safe.
   */
  private chooseStartDate(connectionId: string, monthsBack: number): Date {
    const lastSuccess = this.repo.lastSuccessfulScrapeAt(connectionId);
    if (lastSuccess) {
      const since = new Date(lastSuccess);
      if (!Number.isNaN(since.getTime())) {
        since.setDate(since.getDate() - 14);
        return since;
      }
    }
    return startDateMonthsAgo(monthsBack);
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
      // A per-connection browser session, reused across syncs to skip the
      // sign-in. Encrypted in the vault; a no-op when the vault is locked.
      const session = openSession(this.vault, args.connectionId);
      if (isSnapTrade(args.companyId)) {
        outcome = await runSnapTradeSync(args.credentials, this.vault, (message) => {
          status.message = message;
        });
      } else if (isPensionCompany(args.companyId)) {
        // Pension funds have no scraper library, so a custom Puppeteer routine
        // drives the portal login (and any SMS one-time code) itself.
        outcome = await runPensionScrape(
          args.companyId,
          args.credentials,
          (message) => {
            status.message = message;
          },
          this.prepareScreenshotPath(args.companyId),
          () => this.requestOtp(status),
          session,
        );
      } else if (args.interactive) {
        outcome = await runInteractiveScrape(
          args.companyId,
          args.credentials,
          this.chooseStartDate(args.connectionId, args.monthsBack),
          (progress) => {
            status.message = humanizeProgress(progress);
          },
          this.prepareScreenshotPath(args.companyId),
          () => this.requestOtp(status),
          session,
        );
      } else {
        outcome = await runScrape(
          args.companyId,
          args.credentials,
          this.chooseStartDate(args.connectionId, args.monthsBack),
          (progress) => {
            status.message = humanizeProgress(progress);
          },
          this.prepareScreenshotPath(args.companyId),
          session,
        );
      }

      if (!outcome.success) {
        this.finish(status, args.connectionId, 'error', describeError(outcome));
        return;
      }

      const saved = this.repo.saveScrapeResult(args.connectionId, outcome.accounts);
      if (outcome.brokeragePerformance) {
        this.repo.saveBrokeragePerformance(args.connectionId, outcome.brokeragePerformance);
      }
      // Loans the scraper pulled from the bank's loans page are upserted
      // against the same connection so a re-sync updates the existing row
      // instead of creating duplicates. User-set fields (excluded, notes)
      // are preserved by repo.upsertBankLoan.
      if (outcome.scrapedLoans) {
        for (const loan of outcome.scrapedLoans) {
          this.repo.upsertBankLoan(args.connectionId, {
            externalId: loan.externalId,
            name: loan.name,
            principal: loan.principal,
            startDate: loan.startDate,
            termMonths: loan.termMonths,
            isPrime: loan.isPrime,
            isCpiLinked: loan.isCpiLinked,
            rateValue: loan.rateValue,
            currency: loan.currency,
          });
        }
      }
      status.accountsCount = saved.accounts;
      status.transactionsCount = saved.transactions;

      // Backfill long-range price history from Yahoo Finance for any holding
      // that doesn't yet have months of snapshots — runs in the background so
      // it never blocks the sync's "done" status.
      if (isSnapTrade(args.companyId)) {
        void this.backfillBrokerageHistory(status).catch((err) =>
          process.stdout.write(
            `yahoo backfill failed: ${(err as Error).message}\n`,
          ));
      }
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

  /**
   * Walks every position in every brokerage account and, if Hon has fewer
   * than ~120 days of snapshots for it, pulls a 10-year daily close series
   * from Yahoo Finance and stores it as units × close. Lets the equity chart
   * draw a real history on the very first sync, instead of waiting weeks for
   * Hon's own daily snapshots to accumulate.
   */
  private async backfillBrokerageHistory(status: RunStatus): Promise<void> {
    const brkAccts = this.repo.listBrokerageAccounts(SNAPTRADE_COMPANY_ID);
    const holdings = this.repo.listHoldings();
    const inScope = new Set(brkAccts.map((a) => a.id));
    let touched = 0;
    for (const h of holdings) {
      if (!inScope.has(h.accountId)) continue;
      const bounds = this.repo.holdingSnapshotBounds(h.accountId, h.symbol);
      if (bounds.count >= 120) continue; // already well-populated
      status.message = `Backfilling price history for ${h.symbol}…`;
      const history = await fetchYahooHistory(h.symbol, 365 * 10);
      if (!history.length) continue;
      const inserted = this.repo.backfillHoldingHistory(
        h.accountId,
        h.symbol,
        h.units,
        history.map((p) => ({ date: p.date, price: p.close, currency: p.currency })),
      );
      if (inserted > 0) touched += 1;
    }
    if (touched > 0) {
      process.stdout.write(
        `yahoo backfill: populated history for ${touched} position(s)\n`,
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
