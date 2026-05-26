import { useSettings } from './useSettings';
import type { IncomeAvgMonths } from './store';

const INCOME_SCOPES: IncomeAvgMonths[] = [1, 2, 3, 6];

export function SpendingProjectionCard() {
  const [settings, update] = useSettings();
  return (
    <section className="set-card">
      <div className="set-card-head">
        <span className="set-ico">📊</span>
        <h3>Spending projection</h3>
      </div>
      <label className="set-row">
        <div className="set-row-main">
          <div className="set-row-name">Project recurring bills &amp; income</div>
          <div className="set-row-sub">
            Reserve monthly and bimonthly fixed bills every cycle, and treat income as a
            multi-month average, so the budget shows what to expect — not only what has posted.
          </div>
        </div>
        <span className="switch">
          <input
            type="checkbox"
            checked={settings.projectRecurring}
            onChange={(e) => update({ projectRecurring: e.target.checked })}
          />
          <span className="switch-track" />
        </span>
      </label>
      <div className="set-row col">
        <div className="set-row-main">
          <div className="set-row-name">Income average window</div>
          <div className="set-row-sub">
            How many recent months to average for expected income.
          </div>
        </div>
        <div className="seg" role="group" aria-label="Income average window">
          {INCOME_SCOPES.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={settings.incomeAvgMonths === n}
              className={settings.incomeAvgMonths === n ? 'on' : ''}
              onClick={() => update({ incomeAvgMonths: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
