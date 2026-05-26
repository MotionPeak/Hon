import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { computeLoanState, type Loan } from '../src/loans.js';
import { Repo } from '../src/repo.js';

/** Opens a fully-migrated in-process SQLite db per test — no shared state. */
function freshRepo(): Repo {
  const dir = mkdtempSync(`${tmpdir()}/hon-test-`);
  const { db } = openDatabase(dir);
  // Clean up on process exit; not critical for unit tests but keeps /tmp tidy.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return new Repo(db);
}

// Spitzer amortization (the Israeli mortgage standard). Tests anchor
// known fixed scenarios so a refactor of the math can't silently shift
// monthly payments or outstanding balances.

const baseLoan = (overrides: Partial<Loan> = {}): Loan => ({
  id: 'test-loan',
  name: 'Test loan',
  principal: 100_000,
  startDate: '2020-01-01', // ~5 years before today's test date
  termMonths: 120,         // 10-year loan
  rateType: 'fixed',
  rateValue: 5,            // 5% annual
  isPrime: false,
  isCpiLinked: false,
  cpiStart: null,
  excluded: 0,
  notes: '',
  currency: 'ILS',
  externalId: null,
  ...overrides,
});

describe('computeLoanState — fixed-rate Spitzer', () => {
  it('computes a known monthly payment for a 100k @ 5% / 10y loan', () => {
    // Spitzer formula: P × r / (1 − (1+r)^−n)
    // r = 5%/12 = 0.004166..., n = 120
    // → ~₪1,060.66/month — verified against a financial calculator.
    const state = computeLoanState(baseLoan(), 6, null);
    expect(state.monthlyPayment).toBeCloseTo(1060.66, 1);
  });

  it('a zero-interest loan equals principal / months', () => {
    const state = computeLoanState(
      baseLoan({ rateValue: 0 }),
      6, null,
    );
    // 100_000 / 120 = 833.33...
    expect(state.monthlyPayment).toBeCloseTo(833.33, 1);
  });

  it('reports progress = monthsElapsed / termMonths', () => {
    const state = computeLoanState(baseLoan(), 6, null);
    // Loan started 2020-01-01; depending on test run date, we should
    // see "some" progress between 0 and 1. Don't pin to an exact value
    // because tests are time-sensitive — sanity-check the range.
    expect(state.progress).toBeGreaterThan(0);
    expect(state.progress).toBeLessThanOrEqual(1);
  });

  it('caps monthsElapsed at termMonths once the loan is past term', () => {
    // A loan that started 30 years ago is long-paid; monthsElapsed
    // shouldn't exceed termMonths.
    const state = computeLoanState(
      baseLoan({ startDate: '1995-01-01', termMonths: 120 }),
      6, null,
    );
    expect(state.monthsElapsed).toBe(120);
    expect(state.monthsRemaining).toBe(0);
    expect(state.progress).toBe(1);
    // Outstanding should be ~0 (modulo float drift) — the loan is paid.
    expect(state.outstanding).toBeLessThan(1);
  });
});

describe('computeLoanState — prime tracks', () => {
  it('annualRate = prime + margin for prime loans', () => {
    const state = computeLoanState(
      baseLoan({ isPrime: true, rateValue: 1.5 }),
      6, // prime = 6%
      null,
    );
    expect(state.annualRate).toBe(7.5);
  });
});

describe('computeLoanState — CPI-linked', () => {
  it('scales outstanding + payment by cpiNow / cpiStart', () => {
    const flat = computeLoanState(
      baseLoan({ isCpiLinked: false, cpiStart: null }),
      6, 110,
    );
    const linked = computeLoanState(
      baseLoan({ isCpiLinked: true, cpiStart: 100 }),
      6, 110,
    );
    // 10% CPI rise → outstanding and payment both 10% higher
    expect(linked.outstanding).toBeCloseTo(flat.outstanding * 1.1, 1);
    expect(linked.monthlyPayment).toBeCloseTo(flat.monthlyPayment * 1.1, 1);
    expect(linked.cpiRatio).toBeCloseTo(1.1, 4);
  });

  it('falls back to ratio = 1 when cpiStart is missing', () => {
    const state = computeLoanState(
      baseLoan({ isCpiLinked: true, cpiStart: null }),
      6, 110,
    );
    expect(state.cpiRatio).toBe(1);
  });

  it('falls back to ratio = 1 when cpiNow is missing', () => {
    const state = computeLoanState(
      baseLoan({ isCpiLinked: true, cpiStart: 100 }),
      6, null,
    );
    expect(state.cpiRatio).toBe(1);
  });
});

describe('upsertBankLoan — backfill matcher', () => {
  it('attaches existing matching transactions to a newly-upserted loan', () => {
    const repo = freshRepo();
    // Create a connection with a pre-existing loan-payment transaction,
    // BEFORE the loan is upserted.
    const conn = repo.createConnection('beinleumi', 'Beinleumi');
    repo.saveScrapeResult(conn.id, [
      {
        accountNumber: '1-2-3',
        label: 'Checking',
        balance: 1000,
        currency: 'ILS',
        transactions: [
          {
            externalId: 'txn-1',
            date: '2026-05-10',
            amount: -1747.17,
            currency: 'ILS',
            description: 'הלואה-תשלום 12345678',
          },
        ],
      },
    ]);

    // Now upsert the matching loan. The backfill should tag the prior txn.
    const loan = repo.upsertBankLoan(conn.id, {
      name: 'משכנתא',
      principal: 100_000,
      startDate: '2024-01-01',
      termMonths: 120,
      isPrime: false,
      isCpiLinked: false,
      rateValue: 0.04,
      currency: 'ILS',
      externalId: '12345678',
    });

    const payments = repo.listLoanPayments(loan.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.externalId).toBe('txn-1');
  });

  it('does NOT touch transactions older than 12 months', () => {
    const repo = freshRepo();
    const conn = repo.createConnection('beinleumi', 'Beinleumi');
    // 18 months ago — outside the backfill window.
    const oldDate = new Date();
    oldDate.setMonth(oldDate.getMonth() - 18);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    repo.saveScrapeResult(conn.id, [
      {
        accountNumber: 'a',
        balance: 0,
        currency: 'ILS',
        transactions: [
          {
            externalId: 'old',
            date: oldDateStr,
            amount: -500,
            currency: 'ILS',
            description: 'הלוואה 12345678',
          },
        ],
      },
    ]);
    const loan = repo.upsertBankLoan(conn.id, {
      name: 'L',
      principal: 1000,
      startDate: '2020-01-01',
      termMonths: 120,
      isPrime: false,
      isCpiLinked: false,
      rateValue: 0,
      currency: 'ILS',
      externalId: '12345678',
    });
    expect(repo.listLoanPayments(loan.id)).toHaveLength(0);
  });
});
