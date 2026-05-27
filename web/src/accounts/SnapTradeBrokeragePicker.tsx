import type { BrokerageOption } from './types';

interface Props {
  brokerages: BrokerageOption[];
  onPick: (slug: string, name: string) => void;
}

/**
 * Vertical list of SnapTrade-supported brokerages. Matches the bank/card
 * drilldown style elsewhere in the picker (.pick-list / .pick-row).
 * IBKR is flagged via data-pre-focused so the parent can scroll it
 * into view if desired.
 */
export function SnapTradeBrokeragePicker({ brokerages, onPick }: Props) {
  if (brokerages.length === 0) {
    return <p className="hint">No brokerages match.</p>;
  }
  return (
    <ul className="pick-list">
      {brokerages.map((b) => (
        <li key={b.slug}>
          <button
            type="button"
            className="pick-row"
            onClick={() => onPick(b.slug, b.name)}
            data-pre-focused={b.slug === 'INTERACTIVE_BROKERS' ? 'true' : undefined}
          >
            {b.logoUrl ? (
              <img src={b.logoUrl} alt="" className="pick-row-logo" />
            ) : (
              <span className="logo">📈</span>
            )}
            <span className="pick-row-name">{b.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
