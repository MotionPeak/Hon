import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import type { Loan, RateType } from '../accounts/types';
import { DelayedLoader } from '../ui/DelayedLoader';

interface LoansResponse {
  loans: Loan[];
  rates: { prime: number | null; cpiNow: number | null };
}

const TRACK_LABELS: Record<RateType, string> = {
  fixed: 'Fixed',
  prime: 'Prime',
  'cpi-fixed': 'CPI-linked fixed',
  'cpi-prime': 'CPI-linked prime',
};

function formatRemainingMonths(monthsRemaining: number): string {
  const total = Math.max(0, Math.round(monthsRemaining));
  const yrs = Math.floor(total / 12);
  const mos = total - yrs * 12;
  if (yrs === 0) return `${mos} mo${mos === 1 ? '' : 's'}`;
  const yrText = `${yrs} yr${yrs === 1 ? '' : 's'}`;
  return mos ? `${yrText} ${mos} mo` : yrText;
}

export function LoansView() {
  const [data, setData] = useState<LoansResponse | null>(null);

  useEffect(() => {
    api<LoansResponse>('/loans')
      .then(setData)
      .catch(() => setData({ loans: [], rates: { prime: null, cpiNow: null } }));
  }, []);

  // Clear the "unseen loan ids" queue the moment the user opens this tab.
  // The Loans-nav dot in App.tsx reads the same key + the custom event;
  // emitting it drops the dot immediately even though it polls localStorage.
  useEffect(() => {
    window.localStorage.setItem('hon.unseenLoanIds', JSON.stringify([]));
    window.dispatchEvent(new Event('hon.loan-ids-changed'));
  }, []);

  if (data === null) return <DelayedLoader />;

  if (data.loans.length === 0) {
    return (
      <div className="loans-view">
        <h1>Loans</h1>
        <p className="blank">
          📉 No loans yet. Hon computes the Spitzer schedule, monthly payment,
          and payoff date from the principal, term, and rate.
        </p>
        <button
          type="button"
          className="mini"
          onClick={() => {
            // Loans are added through the Assets picker; flag the intent and
            // ask the shell to flip to the Assets tab, where AccountsView opens
            // the loan form on mount (see its hon.pendingAddLoan effect).
            window.localStorage.setItem('hon.pendingAddLoan', '1');
            window.dispatchEvent(new Event('hon.go-to-assets'));
          }}
        >
          + Add a loan
        </button>
      </div>
    );
  }

  // Total outstanding per currency (excluding excluded loans).
  const totals: Record<string, number> = {};
  for (const l of data.loans) {
    if (l.excluded || !l.state) continue;
    totals[l.currency] = (totals[l.currency] ?? 0) + l.state.outstanding;
  }
  const totalKeys = Object.keys(totals).sort();

  return (
    <div className="loans-view">
      <h1>Loans</h1>
      <p className="set-intro">
        Spitzer amortisation runs server-side from the principal, term, and
        rate. Prime-linked tracks ride the Bank of Israel base rate; CPI-linked
        tracks index principal against today's CPI.
      </p>
      {totalKeys.length > 0 && (
        <div data-testid="loan-totals" className="loan-totals">
          <span className="emoji">📉</span>
          <span>Total debt:</span>
          {totalKeys.map((cur, i) => (
            <span key={cur}>
              {i > 0 && <span className="sep"> · </span>}
              <b>{money(totals[cur], cur)}</b>
            </span>
          ))}
        </div>
      )}
      <div className="loans-grid">
        {data.loans.map((l) => <LoanCardRich key={l.id} loan={l} primeNow={data.rates.prime} />)}
      </div>
    </div>
  );
}

function LoanCardRich({ loan, primeNow }: { loan: Loan; primeNow: number | null }) {
  const s = loan.state;
  if (!s) return null;
  const track = loan.rateType ?? 'fixed';
  const trackLabel = TRACK_LABELS[track];
  const pct = Math.max(0, Math.min(1, s.progress)) * 100;
  const monthlyTotal = s.monthlyPayment * loan.termMonths;
  const principalNow = loan.principal * (s.cpiRatio || 1);
  const interest = Math.max(0, monthlyTotal - principalNow);
  return (
    <article className={`loan-card-rich${loan.excluded ? ' nw-off' : ''}`}>
      <header className="loan-head-rich">
        <div className="loan-title-block">
          <div className="loan-title">{loan.name}</div>
          <div className="loan-sub">
            {formatRemainingMonths(s.monthsRemaining)} left
            <span className="sep"> · </span>
            <span className={`loan-pill loan-pill-${track}`}>{trackLabel}</span>
          </div>
        </div>
        <div className="loan-outstanding">
          {money(-s.outstanding, loan.currency)}
        </div>
      </header>
      <div className="loan-progress-bar">
        <span style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      <div className="loan-stats">
        <div className="loan-stat">
          <label>Monthly</label>
          <b>{money(s.monthlyPayment, loan.currency)}</b>
        </div>
        <div className="loan-stat">
          <label>Rate</label>
          <b>{s.annualRate.toFixed(2)}%</b>
          {loan.isPrime && primeNow != null && (
            <span className="muted">
              {primeNow.toFixed(2)}% prime + {loan.rateValue.toFixed(2)}%
            </span>
          )}
          {loan.isCpiLinked && s.cpiRatio !== 1 && (
            <span className="muted">×{s.cpiRatio.toFixed(4)} index</span>
          )}
        </div>
        <div className="loan-stat">
          <label>Paid · {Math.round(pct)}%</label>
          <b>{money(s.totalPaid, loan.currency)}</b>
          <span className="muted">of {money(principalNow, loan.currency)}</span>
        </div>
      </div>
      {monthlyTotal > 0 && (
        <div className="loan-life">
          <span>Over {loan.termMonths} months</span>
          <span className="sep"> · </span>
          <b>{money(monthlyTotal, loan.currency)}</b>
          <span> total · </span>
          <b>{money(interest, loan.currency)}</b>
          <span> interest</span>
        </div>
      )}
      <LoanPaymentHistory loan={loan} />
    </article>
  );
}

function LoanPaymentHistory({ loan }: { loan: Loan }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const payments = loan.payments ?? [];
  if (payments.length === 0) return null;
  const last = payments[0]!;
  // ~35 days since the last payment is the rough overdue threshold. Anything
  // older flips the badge to amber + "Possibly missed".
  const daysSince = Math.round(
    (Date.now() - new Date(last.date).getTime()) / 86_400_000,
  );
  const overdue = daysSince > 35;
  const visible = showAll ? payments : payments.slice(0, 24);
  return (
    <>
      <div className={`loan-last-paid ${overdue ? 'overdue' : 'ok'}`}>
        {overdue ? '⚠ Possibly missed' : '✓ Last payment'}
        {' · '}
        <b>{money(Math.abs(last.amount), loan.currency)}</b>
        {' on '}
        {new Date(last.date).toLocaleDateString(undefined,
          { day: 'numeric', month: 'short' })}
      </div>
      <button
        type="button"
        className="loan-history-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? '▴' : '▾'} {payments.length} payment{payments.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ul className="loan-history" data-testid={`loan-history-${loan.id}`}>
          {visible.map((p) => (
            <li key={p.id} className="loan-history-row">
              <span className="loan-history-date">
                {new Date(p.date).toLocaleDateString(undefined,
                  { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
              <span className="loan-history-amt">
                {money(Math.abs(p.amount), loan.currency)}
              </span>
            </li>
          ))}
          {!showAll && payments.length > 24 && (
            <li className="loan-history-more">
              <button type="button" onClick={() => setShowAll(true)}>
                Show {payments.length - 24} more
              </button>
            </li>
          )}
        </ul>
      )}
    </>
  );
}
