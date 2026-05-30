import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from './repo.js';
import type { Vault } from './vault.js';
import { isSnapTrade, runSnapTradeSync, SNAPTRADE_COMPANY_ID } from './snaptrade.js';
import { fetchHistoryForSymbol } from './marketData.js';
import { isPensionCompany, runPensionScrape } from './pension.js';
import { runInteractiveScrape, runScrape, type ScrapeOutcome } from './scrapers.js';
import { openSession } from './session.js';
import { makeLog } from './log.js';

const runnerLog = makeLog('runner');

// Bank scrapers where pre-restored cookies are known to break the
// underlying israeli-bank-scrapers login() step (the library waits for a
// login form, but the cookies have already authenticated the user past
// it, so the scrape hangs to its 90s timeout). Anything not listed here
// gets full session reuse — typically skipping the OTP for several days
// after the first successful sign-in.
//
// Add new ids here ONLY after seeing the symptom in the logs:
//   `library.progress type=LOGGING_IN`  → never reaches LOGIN_SUCCESS
//   the failure screenshot lands on the post-login dashboard
// Removing one is just as safe — the scraper falls back to a fresh login
// the moment the cookies don't actually skip the form.
const BANK_SESSION_DENYLIST = new Set<string>([
  // Max consistently lands the browser on the dashboard when cookies are
  // pre-loaded, but the library still waits for the login form. The hang
  // wastes 4 minutes per attempt until the default timeout kicks in.
  'max',
]);


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
   * Picks the start date for a scrape: always `monthsBack` months ago.
   *
   * Earlier behavior used `lastSuccess - 14d` as an incremental shortcut, but
   * once any connection had a small first sync the shortcut locked it into
   * the same small window forever. Per-connection `historyMonths`
   * (default 12) is now the only knob — DB UNIQUE(account_id, external_id)
   * makes refetching old months a free no-op on persistence.
   */
  private chooseStartDate(_connectionId: string, _companyId: string, monthsBack: number): Date {
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
        outcome = await runSnapTradeSync(args.credentials, this.vault, {}, (message) => {
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
        // Pass the per-connection session through so the bank can trust the
        // device and skip the OTP step (Hapoalim/Beinleumi/etc. honour
        // remembered cookies for a window of days). The denylist holds the
        // banks where cookie-restore has historically confused the
        // underlying scraper into landing on the dashboard while the
        // library was still waiting for a login form — for those Hon falls
        // back to a clean session every sync.
        const bankSession = BANK_SESSION_DENYLIST.has(args.companyId) ? undefined : session;
        log.info('dispatch', {
          runner: 'bank.interactive',
          companyId: args.companyId,
          sessionReused: !!bankSession && !!bankSession.cookies?.length,
        });
        outcome = await runInteractiveScrape(
          args.companyId,
          args.credentials,
          startDate,
          onProgress,
          this.prepareScreenshotPath(args.companyId),
          () => this.requestOtp(status),
          bankSession,
        );
      } else {
        const bankSession = BANK_SESSION_DENYLIST.has(args.companyId) ? undefined : session;
        log.info('dispatch', {
          runner: 'bank.headless',
          companyId: args.companyId,
          sessionReused: !!bankSession && !!bankSession.cookies?.length,
        });
        outcome = await runScrape(
          args.companyId,
          args.credentials,
          startDate,
          onProgress,
          this.prepareScreenshotPath(args.companyId),
          bankSession,
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
      const txnsFetched = outcome.accounts.reduce((s, a) => s + a.transactions.length, 0);
      log.info('persist.skipped', {
        fetched: txnsFetched,
        saved: saved.transactions,
        skipped: txnsFetched - saved.transactions,
      });
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
    // Backfill every holding — fetchHistoryForSymbol dispatches numeric
    // symbols (Israeli mutual funds / ETFs, e.g. Meitav's MisparNiar) to TASE
    // Maya and everything else to Yahoo Finance, so a holding from any
    // connection that ended up with a `holdings[]` array gets its history
    // pulled, not just SnapTrade brokerage positions.
    const holdings = this.repo.listHoldings();
    let touched = 0;
    for (const h of holdings) {
      const bounds = this.repo.holdingSnapshotBounds(h.accountId, h.symbol);
      if (bounds.count >= 120) continue; // already well-populated
      status.message = `Backfilling price history for ${h.symbol}…`;
      const t0 = Date.now();
      runnerLog.debug('history.backfill.start', { symbol: h.symbol });
      const history = await fetchHistoryForSymbol(h.symbol, 365 * 10);
      runnerLog.debug('history.backfill.done', {
        symbol: h.symbol,
        elapsedMs: Date.now() - t0,
        points: history.length,
      });
      if (!history.length) continue;
      // Snapshot value is `units × price`. Israeli mutual funds (Meitav
      // portfolio holdings, etc.) come back from the scraper with units=0
      // because the provider only reports value, not a share count — that
      // would store every historical snapshot as 0 and the sparkline draws
      // nothing. Derive a pseudo-unit count from `current value / latest
      // price` so historical price ratios scale to a meaningful per-day
      // value. SnapTrade holdings keep their real units untouched.
      const latestPrice = history[history.length - 1]?.close ?? 0;
      const units = h.units !== 0
        ? h.units
        : (h.value != null && latestPrice > 0)
          ? h.value / latestPrice
          : 0;
      const inserted = this.repo.backfillHoldingHistory(
        h.accountId,
        h.symbol,
        units,
        history.map((p) => ({ date: p.date, price: p.close, currency: p.currency })),
      );
      if (inserted > 0) touched += 1;
    }
    if (touched > 0) {
      runnerLog.info('history.backfill.done', { positions: touched });
    } else {
      runnerLog.debug('history.backfill.skipped', { reason: 'no-positions-needed-backfill' });
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
  if (hints[type]) return hints[type];
  return humanizeRawError(outcome.errorMessage) ?? outcome.errorMessage ?? 'The scrape failed.';
}

/**
 * Rewrites the most common infrastructure errors that bubble up from puppeteer
 * / fetch / fs into a short summary plus a hint at what to do, so the UI shows
 * something actionable instead of a stack-trace excerpt with documentation URLs.
 * Returns undefined when the message looks like a real domain error worth
 * showing verbatim.
 */
function humanizeRawError(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const msg = raw.replace(/\s+/g, ' ').trim();

  if (/Could not find Chrome \(ver/i.test(msg) || /Could not find expected browser/i.test(msg)) {
    return (
      'Hon’s bundled Chrome is missing. Either point Hon at an installed ' +
      'Chrome by setting PUPPETEER_EXECUTABLE_PATH (on Windows, often ' +
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), or ' +
      're-run `npm install` in sidecar/ to download the bundled build. ' +
      'See the README’s Windows gotchas for the step-by-step.'
    );
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return 'Network error reaching the institution. Check the connection and try again.';
  }
  if (/Navigation timeout|Waiting for selector .* failed: timeout/i.test(msg)) {
    return 'The institution’s page took too long to load. Try syncing again.';
  }
  if (/Target closed|Session closed|Protocol error \(.*\): Target closed/i.test(msg)) {
    return 'The browser closed before the scrape finished. Try syncing again.';
  }
  if (/EACCES|EPERM/i.test(msg)) {
    return (
      'Hon could not write to its data folder. Check the permissions on ' +
      '~/Library/Application Support/Hon (macOS), %APPDATA%\\Hon (Windows), ' +
      'or your $HON_DATA_DIR.'
    );
  }
  return undefined;
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
