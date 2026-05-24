import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from './repo.js';
import type { Vault } from './vault.js';
import { isSnapTrade, runSnapTradeSync, SNAPTRADE_COMPANY_ID } from './snaptrade.js';
import { fetchYahooHistory } from './marketData.js';
import { isPensionCompany, runPensionScrape } from './pension.js';
import { runInteractiveScrape, runScrape, type ScrapeOutcome } from './scrapers.js';
import { openSession } from './session.js';
import { makeLog } from './log.js';

const runnerLog = makeLog('runner');

// Companies whose "balance" is the next-bill outstanding, computed by the
// scraper from the full set of pending + scheduled charges across the cycle.
// Skipping the incremental-scrape shortcut for them — see chooseStartDate.
const CARD_COMPANIES = new Set(['max', 'visaCal', 'isracard', 'amex']);

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
    // One log line per scrape kick-off so the lifecycle for a connection
    // is greppable end-to-end. Credentials are logged by field NAME only —
    // never values — so the log never carries usernames/passwords/tokens.
    runnerLog.info('scrape.queued', {
      runId: run.id,
      connectionId: args.connectionId,
      companyId: args.companyId,
      mode: isSnapTrade(args.companyId)
        ? 'snaptrade'
        : isPensionCompany(args.companyId)
          ? 'pension'
          : args.interactive ? 'interactive' : 'headless',
      monthsBack: args.monthsBack,
      credentialFields: Object.keys(args.credentials),
    });
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
   *
   * Credit-card companies are excluded from the incremental shortcut: a
   * card's outstanding balance is computed from the *full* set of pending
   * and scheduled charges across the billing cycle, so missing the older
   * end of a cycle would undercount the balance. Cards always re-fetch the
   * full monthsBack window.
   */
  private chooseStartDate(connectionId: string, companyId: string, monthsBack: number): Date {
    if (CARD_COMPANIES.has(companyId)) return startDateMonthsAgo(monthsBack);
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
    runnerLog.info('otp.requested', { runId: status.runId, connectionId: status.connectionId });
    return new Promise<string>((resolve) => {
      status.status = 'needs-otp';
      status.message = 'Waiting for the verification code…';
      this.otpResolvers.set(status.runId, (code) => {
        status.status = 'running';
        status.message = 'Submitting the verification code…';
        runnerLog.info('otp.submitted', {
          runId: status.runId,
          connectionId: status.connectionId,
          codeLength: code.length,
        });
        resolve(code);
      });
    });
  }

  /** Supplies a 2FA code for a run that is waiting on one. */
  submitOtp(runId: string, code: string): boolean {
    const resolver = this.otpResolvers.get(runId);
    if (!resolver) {
      runnerLog.warn('otp.submit.no-resolver', { runId });
      return false;
    }
    this.otpResolvers.delete(runId);
    resolver(code);
    return true;
  }

  private async execute(status: RunStatus, args: StartArgs): Promise<void> {
    // Per-run logger so every line carries runId + connectionId + companyId
    // as part of its tag — `grep '[scrape:run123]'` shows everything for
    // one attempt across runner, scrapers and bank-loans output combined.
    const log = runnerLog.child(`run:${status.runId.slice(0, 8)}`);
    const startDate = this.chooseStartDate(args.connectionId, args.companyId, args.monthsBack);
    const lastSuccess = this.repo.lastSuccessfulScrapeAt(args.connectionId);
    log.info('execute', {
      companyId: args.companyId,
      connectionId: args.connectionId,
      monthsBack: args.monthsBack,
      startDate: startDate.toISOString().slice(0, 10),
      lastSuccess: lastSuccess ?? null,
      interactive: args.interactive,
    });
    const overallDone = log.timer('scrape', { companyId: args.companyId });
    try {
      let outcome: ScrapeOutcome;
      // A per-connection browser session, reused across syncs to skip the
      // sign-in. Encrypted in the vault; a no-op when the vault is locked.
      const session = openSession(this.vault, args.connectionId);
      // Bank scrapers no longer reuse a saved session (see below), so the
      // "reconnecting / reopening" wording is always off. Pension scrapers
      // surface their own message strings directly and bypass humanizeProgress.
      const onProgress = (progress: string) => {
        const humanized = humanizeProgress(progress, false);
        status.message = humanized;
        log.info('library.progress', { type: progress, message: humanized });
      };
      if (isSnapTrade(args.companyId)) {
        log.info('dispatch', { runner: 'snaptrade' });
        outcome = await runSnapTradeSync(args.credentials, this.vault, (message) => {
          status.message = message;
          log.info('snaptrade.progress', { message });
        });
      } else if (isPensionCompany(args.companyId)) {
        // Pension funds have no scraper library, so a custom Puppeteer routine
        // drives the portal login (and any SMS one-time code) itself.
        log.info('dispatch', { runner: 'pension', companyId: args.companyId });
        outcome = await runPensionScrape(
          args.companyId,
          args.credentials,
          (message) => {
            status.message = message;
            log.info('pension.progress', { message });
          },
          this.prepareScreenshotPath(args.companyId),
          () => this.requestOtp(status),
          session,
        );
      } else if (args.interactive) {
        // No session for bank scrapers: israeli-bank-scrapers re-runs its full
        // login every sync, and pre-restoring cookies has confused some banks
        // into landing on the post-login dashboard while the library waited
        // for a login form — hanging the scrape with no timeout. Sessions
        // stay where they actually pay off: the pension flow below, which
        // Hon drives itself.
        log.info('dispatch', { runner: 'bank.interactive', companyId: args.companyId });
        outcome = await runInteractiveScrape(
          args.companyId,
          args.credentials,
          startDate,
          onProgress,
          this.prepareScreenshotPath(args.companyId),
          () => this.requestOtp(status),
          undefined,
        );
      } else {
        log.info('dispatch', { runner: 'bank.headless', companyId: args.companyId });
        outcome = await runScrape(
          args.companyId,
          args.credentials,
          startDate,
          onProgress,
          this.prepareScreenshotPath(args.companyId),
          undefined,
        );
      }

      if (!outcome.success) {
        log.error('outcome.error', {
          errorType: outcome.errorType,
          errorMessage: outcome.errorMessage,
        });
        overallDone({ result: 'error', errorType: outcome.errorType });
        this.finish(status, args.connectionId, 'error', describeError(outcome));
        return;
      }

      // Per-account txn counts before persistence so a low-fetch issue surfaces
      // separately from a low-persist issue (uniqueness/upsert collapsing dups).
      log.info('outcome.summary', {
        accounts: outcome.accounts.length,
        txnsFetched: outcome.accounts.reduce((s, a) => s + a.transactions.length, 0),
        loans: outcome.scrapedLoans?.length ?? 0,
        perAccount: outcome.accounts.map((a) => ({
          account: a.accountNumber,
          txns: a.transactions.length,
          balance: a.balance ?? null,
          currency: a.currency,
          holdings: a.holdings?.length ?? 0,
        })),
      });

      const persistDone = log.timer('persist', { accounts: outcome.accounts.length });
      const saved = this.repo.saveScrapeResult(args.connectionId, outcome.accounts);
      persistDone({ accountsSaved: saved.accounts, transactionsSaved: saved.transactions });
      if (outcome.brokeragePerformance) {
        this.repo.saveBrokeragePerformance(args.connectionId, outcome.brokeragePerformance);
        log.info('brokerage.performance.saved');
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
        log.info('loans.upserted', { count: outcome.scrapedLoans.length });
      }
      status.accountsCount = saved.accounts;
      status.transactionsCount = saved.transactions;

      // Backfill long-range price history from Yahoo Finance for any holding
      // that doesn't yet have months of snapshots — runs in the background so
      // it never blocks the sync's "done" status.
      if (isSnapTrade(args.companyId)) {
        void this.backfillBrokerageHistory(status).catch((err) => {
          log.warn('yahoo.backfill.failed', {
            message: (err as Error).message,
          });
        });
      }
      overallDone({
        result: 'success',
        accounts: saved.accounts,
        transactions: saved.transactions,
        loans: outcome.scrapedLoans?.length ?? 0,
      });
      this.finish(
        status,
        args.connectionId,
        'success',
        `Imported ${saved.accounts} account(s) and ${saved.transactions} transaction(s).`,
      );
    } catch (err) {
      log.error('execute.threw', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      overallDone({ result: 'exception' });
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
      runnerLog.info('yahoo.backfill.done', { positions: touched });
    } else {
      runnerLog.debug('yahoo.backfill.skipped', { reason: 'no-positions-needed-backfill' });
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
    runnerLog.info(`finish.${result}`, {
      runId: status.runId,
      connectionId,
      accounts: status.accountsCount,
      transactions: status.transactionsCount,
      // Truncated so very long error messages don't sprawl across lines.
      message: message.length > 200 ? message.slice(0, 197) + '…' : message,
    });
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

function humanizeProgress(progressType: string, reusingSession = false): string {
  switch (progressType) {
    case 'INITIALIZING':
      return reusingSession
        ? 'Reopening your saved session…'
        : 'Starting the browser…';
    case 'START_SCRAPING':
      return 'Connecting to the institution…';
    case 'LOGGING_IN':
      // The scraper library always runs its login() step — even when
      // saved cookies have already authenticated the device. Naming it
      // "Reconnecting" sets the expectation that this is a handshake,
      // not a from-scratch sign-in (which would risk a 2FA prompt).
      return reusingSession
        ? 'Reconnecting with your saved session…'
        : 'Logging in…';
    case 'LOGIN_SUCCESS':
      return reusingSession
        ? 'Session reused — fetching transactions…'
        : 'Logged in — fetching transactions…';
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
