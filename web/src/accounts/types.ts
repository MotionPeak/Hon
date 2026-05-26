// Mirrors the shapes returned by the engine's /accounts, /connections,
// /companies, /assets, and /loans endpoints. Kept in lockstep with
// sidecar/src/repo.ts + sidecar/src/scrapers.ts + sidecar/src/loans.ts.

export type CompanyType = 'bank' | 'card' | 'brokerage' | 'pension';

export interface Company {
  id: string;
  name: string;
  loginFields: string[];
  type: CompanyType;
  domain?: string;
  interactive?: boolean;
}

export interface Connection {
  id: string;
  companyId: string;
  displayName: string;
  createdAt: string;
  lastScrapeAt: string | null;
  lastStatus: string | null;
  hasCredentials: boolean;
}

export interface Account {
  id: string;
  connectionId: string;
  companyId: string;
  connectionName: string;
  accountNumber: string;
  label: string | null;
  balance: number | null;
  currency: string;
  updatedAt: string;
  excluded: boolean;
  inceptionDate: string | null;
}

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
}

/** A "section" in the Accounts view — Banks, Credit cards, etc. */
export type AssetSectionKey = 'bank' | 'card' | 'brokerage' | 'pension' | 'asset' | 'loan';
