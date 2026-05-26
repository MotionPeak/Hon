import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import type { PiggyBankStatus, PiggyReport } from './types';

interface BudgetResponse {
  piggy: PiggyReport;
  currency?: string;
}

export function PiggyView() {
  const [report, setReport] = useState<PiggyReport | null>(null);

  useEffect(() => {
    api<BudgetResponse>('/budget')
      .then((d) => setReport(d.piggy))
      .catch(() => setReport({
        month: '', banks: [], fundedTotal: 0, headroom: 0, projected: false,
      }));
  }, []);

  if (report === null) return <p>Loading…</p>;

  if (report.banks.length === 0) {
    return (
      <div className="piggy-view">
        <h1>Piggy banks</h1>
        <p className="blank">
          🐷 No piggy banks yet. Create one for something you're saving toward —
          a trip, a new camera, a rainy-day fund — and Hon sets a little aside each
          month, counting it as an expense against your budget.
        </p>
      </div>
    );
  }

  const cur = report.banks[0]?.currency ?? 'ILS';
  const skipped = report.banks.filter(
    (b) => !b.complete && b.thisMonth.status === 'skipped',
  ).length;
  const onHoldCount = report.banks.filter((b) => b.onHold && !b.complete).length;
  const incomeWord = report.projected ? 'your expected income' : 'income';

  return (
    <div className="piggy-view">
      <h1>Piggy banks</h1>
      <p className="set-intro">
        Money set aside each month for what you're saving up for. It counts as
        an expense — and pauses automatically on any month it doesn't fit
        your budget.
      </p>
      <div data-testid="piggy-headroom" className="piggy-headroom">
        <span className="emoji">🪙</span>
        <span>
          {report.headroom > 0
            ? <>Saving room this month — {incomeWord} less fixed bills and essentials: <b>{money(report.headroom, cur)}</b>.</>
            : <>There's no saving room this month — {incomeWord} is fully taken up by fixed bills and essentials.</>}
          {report.fundedTotal > 0 && <> <b>{money(report.fundedTotal, cur)}</b> set aside so far.</>}
          {skipped > 0 && <> {skipped} {skipped === 1 ? 'bank is' : 'banks are'} paused — they don't fit right now.</>}
          {onHoldCount > 0 && <> {onHoldCount} on hold.</>}
        </span>
      </div>
      <div className="piggy-grid">
        {report.banks.map((b) => <PiggyCard key={b.id} bank={b} />)}
      </div>
    </div>
  );
}

function PiggyCard({ bank }: { bank: PiggyBankStatus }) {
  const cur = bank.currency || 'ILS';
  const lump = bank.kind === 'lump';
  const reserved = lump && bank.thisMonth.status === 'reserved';
  const pct = Math.round(bank.progress * 100);
  const deg = Math.max(0, Math.min(360, bank.progress * 360));
  const ringColor = bank.complete ? 'var(--green)'
    : reserved ? 'var(--green)'
    : bank.onHold ? 'var(--hairline-2)'
    : bank.thisMonth.status === 'skipped' ? 'var(--amber)' : 'var(--accent)';
  const ringLabel = lump ? (reserved ? 'reserved' : 'set aside') : 'saved';

  let badge: React.ReactNode = null;
  if (bank.complete) {
    badge = (
      <div className="piggy-badge done">
        🎉 Goal reached — {money(bank.targetAmount, cur)} saved.
      </div>
    );
  } else if (bank.onHold) {
    badge = (
      <div className="piggy-badge onhold">
        ⏸ On hold — you've paused this piggy bank. Resume it any time to start saving again.
      </div>
    );
  } else if (lump && reserved) {
    badge = (
      <div className="piggy-badge done">
        🔒 {money(bank.targetAmount, cur)} set aside — held until you mark it used.
      </div>
    );
  } else if (lump) {
    badge = (
      <div className="piggy-badge funded">
        ✓ {money(bank.thisMonth.amount, cur)} reserved this month — counts as a fixed commitment in your budget.
      </div>
    );
  } else if (bank.thisMonth.status === 'funded') {
    badge = (
      <div className="piggy-badge funded">
        ✓ {money(bank.thisMonth.amount, cur)} set aside this month.
      </div>
    );
  } else {
    badge = (
      <div className="piggy-badge skipped">
        ⏸ Paused this month — the set-aside doesn't fit your budget right now.
      </div>
    );
  }

  return (
    <article className="piggy-card">
      <div className="piggy-card-top">
        <div className="piggy-emoji-lg">{bank.emoji}</div>
        <div className="piggy-name-wrap">
          <div className="piggy-name">{bank.name}</div>
          <div className="piggy-monthly">
            {money(bank.monthlyAmount, cur)}/mo
            {bank.monthsLeft != null && !bank.complete && (
              <> · {bank.monthsLeft} mo{bank.monthsLeft === 1 ? '' : 's'} to go</>
            )}
          </div>
        </div>
      </div>
      <div
        className="piggy-ring"
        style={{ background: `conic-gradient(${ringColor} ${deg.toFixed(1)}deg, var(--card-hi) 0)` }}
      >
        <div className="piggy-hole">
          <div className="piggy-pct">{pct}%</div>
          <div className="piggy-pct-lbl">{ringLabel}</div>
        </div>
      </div>
      <div className="piggy-figs">
        <div className="piggy-saved">{money(bank.saved, cur)}</div>
        <div className="piggy-target">
          of {money(bank.targetAmount, cur)}
        </div>
      </div>
      {badge}
    </article>
  );
}
