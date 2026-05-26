import { useEffect, useRef, useState } from 'react';
import { useSettings } from './useSettings';

const DAYS: Array<[number, string]> = [
  [1, 'Calendar month — 1st'],
  [2, '2nd'],
  [5, '5th'],
  [10, '10th'],
  [15, '15th'],
  [20, '20th'],
  [25, '25th'],
];

function labelFor(day: number): string {
  const hit = DAYS.find(([d]) => d === day);
  return hit ? hit[1] : DAYS[0][1];
}

export function BillingCycleCard() {
  const [settings, update] = useSettings();
  const [open, setOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <section className="set-card">
      <div className="set-card-head">
        <span className="set-ico">📅</span>
        <h3>Billing cycle</h3>
      </div>
      <div className="set-row col">
        <div className="set-row-main">
          <div className="set-row-name">Month starts on</div>
          <div className="set-row-sub">
            Group activity and budgets by your billing cycle instead of the calendar month.
          </div>
        </div>
        <div ref={ddRef} className={`dd${open ? ' open' : ''}`}>
          <button
            type="button"
            className="dd-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span>{labelFor(settings.monthStartDay)}</span>
            <svg
              className="dd-chev"
              viewBox="0 0 12 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M1 1l5 5 5-5" />
            </svg>
          </button>
          {open && (
            <ul className="dd-menu" role="listbox">
              {DAYS.map(([d, l]) => (
                <li
                  key={d}
                  role="option"
                  aria-selected={settings.monthStartDay === d}
                  onClick={() => {
                    update({ monthStartDay: d });
                    setOpen(false);
                  }}
                >
                  {l}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
