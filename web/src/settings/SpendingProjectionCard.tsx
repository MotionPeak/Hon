import { useSettings } from './useSettings';

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
          <div className="set-row-name">Project recurring bills</div>
          <div className="set-row-sub">
            Reserve monthly and bimonthly fixed bills every cycle, so the budget shows
            what to expect — not only what has posted.
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
    </section>
  );
}
