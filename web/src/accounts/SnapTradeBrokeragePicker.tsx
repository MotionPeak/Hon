import { useMemo, useState } from 'react';
import type { BrokerageOption } from './types';

interface Props {
  brokerages: BrokerageOption[];
  onPick: (slug: string, name: string) => void;
}

/**
 * Vertical list of SnapTrade-supported brokerages with a name filter on top —
 * SnapTrade returns 30+ brokerages, so the search box gets the user to theirs
 * quickly. Matches the bank/card drilldown style elsewhere in the picker
 * (.pick-list / .pick-row) and reuses the Activity search pill (.act-search).
 * IBKR is flagged via data-pre-focused so the parent can scroll it into view.
 */
export function SnapTradeBrokeragePicker({ brokerages, onPick }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? brokerages.filter((b) => b.name.toLowerCase().includes(q)) : brokerages),
    [brokerages, q],
  );

  // No brokerages at all (not just filtered out) — nothing to search.
  if (brokerages.length === 0) {
    return <p className="hint">No brokerages match.</p>;
  }

  return (
    <div className="brk-picker">
      <div className="act-search brk-search">
        <span className="act-search-ico">⌕</span>
        <input
          type="search"
          placeholder="Search brokerages…"
          aria-label="Search brokerages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {query && (
          <button
            type="button"
            className="act-search-clear"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >×</button>
        )}
      </div>
      {filtered.length === 0 ? (
        <p className="hint">No brokerages match.</p>
      ) : (
        <ul className="pick-list">
          {filtered.map((b) => (
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
      )}
    </div>
  );
}
