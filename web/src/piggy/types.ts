// Mirrors PiggyBankStatus + PiggyReport from sidecar/src/piggy.ts.

export type PiggyKind = 'monthly' | 'lump';
export type PiggyMonthStatus = 'funded' | 'skipped' | 'complete' | 'onhold' | 'reserved';

export interface PiggyBankStatus {
  id: string;
  name: string;
  emoji: string;
  kind: PiggyKind;
  targetAmount: number;
  monthlyAmount: number;
  currency: string;
  /** Total funded across every month, including this one. */
  saved: number;
  /** What's still left to save. */
  remaining: number;
  /** 0..1 progress fraction. */
  progress: number;
  complete: boolean;
  onHold: boolean;
  thisMonth: {
    amount: number;
    status: PiggyMonthStatus;
  };
  monthsLeft: number | null;
}

export interface PiggyReport {
  month: string;
  banks: PiggyBankStatus[];
  /** Sum set aside this month — counts as a budget expense. */
  fundedTotal: number;
  /** Income minus fixed + essential spend — the pool piggies draw from. */
  headroom: number;
  /** True when `headroom` is based on expected recurring income. */
  projected: boolean;
}
