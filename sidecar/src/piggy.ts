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
  onHold: boolean; // the user has manually paused this bank
  thisMonth: {
    amount: number; // what was actually set aside this month
    // funded · skipped (budget too tight) · complete (target reached) ·
    // onhold (manually paused by the user)
    status: 'funded' | 'skipped' | 'complete' | 'onhold';
  };
  monthsLeft: number | null; // estimated months to reach the target, null if unknowable
}

export interface PiggyReport {
  month: string; // "YYYY-MM"
  banks: PiggyBankStatus[];
  fundedTotal: number; // sum set aside this month — counts as a budget expense
  headroom: number; // income minus fixed + essential spend — the pool piggies draw from
  projected: boolean; // true when `headroom` is based on expected recurring income
}

/**
 * Decides, for the current month, which piggy banks get their set-aside and
 * which are paused because the budget cannot fit them. Goes bank by bank in the
 * user's order: each one is funded only if its full set-aside still fits the
 * headroom left after fixed bills and essentials — otherwise it is skipped and
 * stops counting as an expense.
 *
 * Pure — it reads the ledger (earlier months' funded amounts) but never writes.
 * `persistPiggyMonth` commits the decision; only the `/budget` route does that,
 * so a stray report build (e.g. from insights) cannot clobber the ledger.
 *
 * `afterCommitted` is the saving room — expected recurring income minus fixed
 * and essential commitments when projection is on (so a bank is not paused just
 * because the month's salary has not landed yet), or the actual money-in-so-far
 * minus actual spend when it is off.
 */
export function settlePiggyBanks(
  repo: Repo,
  afterCommitted: number,
  monthLabel: string,
  projected = false,
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
    let monthStatus: 'funded' | 'skipped' | 'complete' | 'onhold';
    if (targetRemaining <= 0) {
      monthStatus = 'complete';
    } else if (b.onHold) {
      // Manually paused — no set-aside, and it does not draw on the headroom.
      monthStatus = 'onhold';
    } else {
      // The last push only needs whatever still remains, not a full month.
      const desired = Math.min(b.monthlyAmount, targetRemaining);
      if (desired > 0 && desired <= headroom) {
        thisAmount = desired;
        headroom -= desired;
        fundedTotal += desired;
        monthStatus = 'funded';
      } else {
        monthStatus = 'skipped';
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
      onHold: b.onHold,
      thisMonth: { amount: thisAmount, status: monthStatus },
      monthsLeft:
        complete || b.onHold
          ? complete
            ? 0
            : null
          : b.monthlyAmount > 0
            ? Math.ceil(remaining / b.monthlyAmount)
            : null,
    });
  }

  return {
    month: monthLabel,
    banks: statuses,
    fundedTotal,
    headroom: afterCommitted,
    projected,
  };
}

/**
 * Commits a settled month into the ledger — one row per bank, `funded` with its
 * amount or `skipped`. Overwrites the month's existing rows, so the current
 * month self-corrects as its numbers move; past months stay frozen once the
 * calendar rolls on and they are no longer the report's month.
 */
export function persistPiggyMonth(repo: Repo, report: PiggyReport): void {
  for (const bank of report.banks) {
    const funded = bank.thisMonth.status === 'funded';
    repo.setPiggyContribution(
      bank.id,
      report.month,
      funded ? bank.thisMonth.amount : 0,
      funded ? 'funded' : 'skipped',
    );
  }
}
