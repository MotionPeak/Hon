// Mirrors the Voucher shape from sidecar/src/repo.ts. A voucher is any
// gift card / promotional credit Hon tracks — Shufersal Tav HaZahav,
// BuyMe, Cibus / Pluxee, employer gifts, etc.

export interface Voucher {
  id: string;
  name: string;
  provider: string;
  balance: number;
  currency: string;
  /** YYYY-MM-DD; null when the voucher does not expire (or is unknown). */
  expiresOn: string | null;
  notes: string | null;
  excluded: boolean;
  connectionId: string | null;
  externalId: string | null;
  nameOverridden: boolean;
  createdAt: string;
  updatedAt: string;
}
