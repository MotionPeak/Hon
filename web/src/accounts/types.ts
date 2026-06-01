// Mirrors the shapes returned by the engine's /accounts, /connections,
// /companies, /assets, and /loans endpoints. Kept in lockstep with
// sidecar/src/repo.ts + sidecar/src/scrapers.ts + sidecar/src/loans.ts.

export type { CompanyType, Company } from '@hon/shared/company';
export type { Connection } from '@hon/shared/connection';
export type { Account } from '@hon/shared/account';

export interface ManualAsset {
  id: string;
  kind: string;
  name: string;
  value: number;
  currency: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  excluded: boolean;
}

export type RateType = 'fixed' | 'prime' | 'cpi-fixed' | 'cpi-prime';

/** Computed Spitzer-schedule state — included on each loan in /loans. */
export interface LoanState {
  monthsElapsed: number;
  monthsRemaining: number;
  /** Effective annual rate currently applied (rateValue or prime+margin). */
  annualRate: number;
  monthlyPayment: number;
  /** Current outstanding, in current shekels (CPI-linked when applicable). */
  outstanding: number;
  totalPaid: number;
  /** 0..1, how far through the term. */
  progress: number;
  /** CPI ratio current/start when linked; else 1. */
  cpiRatio: number;
}

export interface Loan {
  id: string;
  name: string;
  principal: number;
  startDate: string;
  termMonths: number;
  isPrime: boolean;
  isCpiLinked: boolean;
  rateValue: number;
  cpiStart: number | null;
  currency: string;
  excluded: boolean;
  notes: string | null;
  connectionId: string | null;
  externalId: string | null;
  nameOverridden: boolean;
  createdAt: string;
  updatedAt: string;
  /** Derived: 'fixed' | 'prime' | 'cpi-fixed' | 'cpi-prime'. Engine fills it. */
  rateType?: RateType;
  /** Computed Spitzer state. Engine fills it when serving /loans. */
  state?: LoanState;
  /** Bank-detected payments linked to this loan, newest-first. Empty for
   *  manual / SnapTrade / pension loans. Server-populated by listLoanPayments. */
  payments?: LoanPayment[];
}

/** A single linked loan-payment transaction. Mirrors the shape the engine
 *  attaches to each Loan on GET /loans. */
export interface LoanPayment {
  id: string;
  date: string;
  amount: number;
  accountId: string;
  description: string;
}

/** A single brokerage security position. Mirrors HoldingRow in repo.ts. */
export interface Holding {
  accountId: string;
  symbol: string;
  description: string | null;
  units: number;
  price: number | null;
  currency: string;
  costBasis: number | null;
  openPnl: number | null;
  /** Bank/brokerage-reported market value, when present. Prefer this over
   *  units*price (Israeli funds quote price in agorot but value in NIS). */
  value: number | null;
  updatedAt: string;
}

/** A "section" in the Accounts view — Banks, Credit cards, etc. */
export type AssetSectionKey = 'bank' | 'card' | 'brokerage' | 'pension' | 'asset' | 'loan';

/** One brokerage SnapTrade can connect, returned by POST /snaptrade/brokerages. */
export interface BrokerageOption {
  slug: string;
  name: string;
  logoUrl?: string;
}
