import { describe, expect, it } from 'vitest';
import { matchPaymentToLoan } from '../src/loanMatcher.js';
import type { Loan } from '../src/loans.js';

const baseLoan = (over: Partial<Loan> = {}): Loan => ({
  id: 'L1',
  name: 'משכנתא',
  principal: 1_000_000,
  startDate: '2022-01-01',
  termMonths: 240,
  isPrime: false,
  isCpiLinked: false,
  rateValue: 0.04,
  cpiStart: null,
  currency: 'ILS',
  excluded: false,
  notes: null,
  connectionId: 'C1',
  externalId: '12345678',
  nameOverridden: false,
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
  ...over,
});

describe('matchPaymentToLoan', () => {
  it('picks the loan whose externalId appears in the description', () => {
    const loans = [
      baseLoan({ id: 'A', externalId: '11111111' }),
      baseLoan({ id: 'B', externalId: '12345678' }),
    ];
    const m = matchPaymentToLoan(
      { description: 'הלואה-תשלום 12345678', amount: -1700 },
      loans,
    );
    expect(m).toBe('B');
  });

  it('falls back to a 3+ character name-token match', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99999999', name: 'משכנתא דירה' })];
    const m = matchPaymentToLoan(
      { description: 'תשלום דירה חודשי', amount: -2400 },
      loans,
    );
    expect(m).toBe('A');
  });

  it('strips the literal word הלוואה/loan from the loan name before tokenising', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99', name: 'הלוואה לרכב' })];
    expect(
      matchPaymentToLoan({ description: 'הלוואה לרכב', amount: -800 }, loans),
    ).toBe('A');
    expect(
      matchPaymentToLoan({ description: 'הלוואה כללית', amount: -800 }, loans),
    ).toBe(null);
  });

  it('uses the single-loan fallback when the description mentions "הלוואה"', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99', name: 'משכנתא' })];
    const m = matchPaymentToLoan(
      { description: 'הלואה-תשלום', amount: -1500 },
      loans,
    );
    expect(m).toBe('A');
  });

  it('uses the single-loan fallback when the description mentions "loan" (case-insensitive)', () => {
    const loans = [baseLoan({ id: 'A', externalId: '99', name: 'Car' })];
    expect(
      matchPaymentToLoan({ description: 'LOAN payment Apr', amount: -700 }, loans),
    ).toBe('A');
  });

  it('returns null on a multi-loan tie at the same rule', () => {
    const loans = [
      baseLoan({ id: 'A', externalId: '111', name: 'משכנתא' }),
      baseLoan({ id: 'B', externalId: '222', name: 'משכנתא' }),
    ];
    expect(
      matchPaymentToLoan({ description: 'הלוואה תשלום', amount: -1700 }, loans),
    ).toBe(null);
  });

  it('returns null for positive-amount transactions (income, not a payment)', () => {
    const loans = [baseLoan({ id: 'A', externalId: '12345678' })];
    expect(
      matchPaymentToLoan({ description: 'הלוואה 12345678', amount: 5000 }, loans),
    ).toBe(null);
  });

  it('returns null when no loans exist on the connection', () => {
    expect(
      matchPaymentToLoan({ description: 'הלוואה תשלום', amount: -1500 }, []),
    ).toBe(null);
  });
});
