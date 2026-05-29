import { useState } from 'react';
import { useSettings } from './useSettings';

const PRESETS = [3, 6, 12, 24];

export function CategoryAveragesCard() {
  const [settings, update] = useSettings();
  const value = settings.spendingAvgMonths;
  // Custom mode is active when the stored value isn't a preset, OR the user
  // explicitly clicked "Custom" (sticky, so clicking it from a preset shows
  // the input even though the value is momentarily still a preset number).
  const [customIntent, setCustomIntent] = useState(false);
  const isCustom = customIntent || !PRESETS.includes(value);
  // Local string state for the custom input — lets the user clear the field
  // and type a new number without immediately persisting the empty/partial value.
  const [inputStr, setInputStr] = useState<string>(String(value));

  return (
    <section className="set-card">
      <div className="set-card-head">
        <span className="set-ico">📐</span>
        <h3>Category averages</h3>
      </div>
      <div className="set-row col">
        <div className="set-row-main">
          <div className="set-row-name">Average window</div>
          <div className="set-row-sub">
            How many recent months feed the "vs avg" comparison on each category in
            Insights. Pick a preset or set a custom number of months.
          </div>
        </div>
        <div className="seg" role="group" aria-label="Category average window">
          {PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={!isCustom && value === n}
              className={!isCustom && value === n ? 'on' : ''}
              onClick={() => { setCustomIntent(false); update({ spendingAvgMonths: n }); }}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={isCustom}
            className={isCustom ? 'on' : ''}
            onClick={() => { setInputStr(String(value)); setCustomIntent(true); }}
          >
            Custom
          </button>
        </div>
        {isCustom && (
          <input
            type="number"
            min={1}
            max={120}
            className="set-num"
            aria-label="Custom months"
            value={inputStr}
            onChange={(e) => {
              const raw = e.target.value;
              setInputStr(raw);
              const n = Math.floor(Number(raw));
              if (Number.isFinite(n) && n >= 1 && n <= 120) update({ spendingAvgMonths: n });
            }}
          />
        )}
      </div>
    </section>
  );
}
