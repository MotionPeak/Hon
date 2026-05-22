import type { Repo } from './repo.js';

/** One piggy bank with its progress and how this month's set-aside played out. */
export interface PiggyBankStatus {
  id: string;
  name: string;
  emoji: string;
  targetAmount: number;
  monthlyAmount: number;
  currency: string;
  saved: number; // total funded across every month, this one included
  remaining: number; // what is still left to save
  progress: number; // 0..1
  complete: boolean;
  thisMonth: {
    amount: number; // what was actually set aside this month
    status: 'funded' | 'skipped' | 'complete';
  };
  monthsLeft: number | null; // estimated months to reach the target, null if unknowable
}

export interface PiggyReport {
  month: string; // "YYYY-MM"
  banks: PiggyBankStatus[];
  fundedTotal: number; // sum set aside this month — counts as a budget expense
  headroom: number; // income minus fixed + essential spend — the pool piggies draw from
}

/**
 * Decides, for the current month, which piggy banks get their set-aside and
 * which are paused because the budget cannot fit them. Goes bank by bank in the
 * user's order: each one is funded only if its full set-aside still fits the
 * headroom left after fixed bills and essentials — otherwise it is skipped and
 * stops counting as an expense. The decision is rewritten into the per-month
 * ledger on every call, so it self-corrects as the month's numbers move.
 */
export function settlePiggyBanks(
  repo: Repo,
  afterCommitted: number,
  monthLabel: string,
): PiggyReport {
  const banks = repo.listPiggyBanks();
  const contributions = repo.listPiggyContributions();

  // What each bank holds from earlier months — the current month is decided
  // fresh below, so it is excluded here.
  const priorSaved = new Map<string, number>();
  for (const c of contributions) {
    if (c.status !== 'funded' || c.month === monthLabel) continue;
    priorSaved.set(c.piggyId, (priorSaved.get(c.piggyId) ?? 0) + c.amount);
  }

  let headroom = Math.max(0, afterCommitted);
  let fundedTotal = 0;
  const statuses: PiggyBankStatus[] = [];

  for (const b of banks) {
    const prior = priorSaved.get(b.id) ?? 0;
    const targetRemaining = Math.max(0, b.targetAmount - prior);

    let thisAmount = 0;
    let monthStatus: 'funded' | 'skipped' | 'complete';
    if (targetRemaining <= 0) {
      monthStatus = 'complete';
      repo.setPiggyContribution(b.id, monthLabel, 0, 'skipped');
    } else {
      // The last push only needs whatever still remains, not a full month.
      const desired = Math.min(b.monthlyAmount, targetRemaining);
      if (desired > 0 && desired <= headroom) {
        thisAmount = desired;
        headroom -= desired;
        fundedTotal += desired;
        monthStatus = 'funded';
        repo.setPiggyContribution(b.id, monthLabel, desired, 'funded');
      } else {
        monthStatus = 'skipped';
        repo.setPiggyContribution(b.id, monthLabel, 0, 'skipped');
      }
    }

    const saved = prior + thisAmount;
    const remaining = Math.max(0, b.targetAmount - saved);
    const complete = remaining <= 0;
    statuses.push({
      id: b.id,
      name: b.name,
      emoji: b.emoji,
      targetAmount: b.targetAmount,
      monthlyAmount: b.monthlyAmount,
      currency: b.currency,
      saved,
      remaining,
      progress: b.targetAmount > 0 ? Math.min(1, saved / b.targetAmount) : 0,
      complete,
      thisMonth: { amount: thisAmount, status: monthStatus },
      monthsLeft: complete ? 0 : b.monthlyAmount > 0 ? Math.ceil(remaining / b.monthlyAmount) : null,
    });
  }

  return { month: monthLabel, banks: statuses, fundedTotal, headroom: afterCommitted };
}
