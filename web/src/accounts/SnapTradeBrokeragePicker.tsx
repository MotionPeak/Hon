import { useDeferredValue, useMemo, useState } from 'react';
import type { BrokerageOption } from './types';

interface Props {
  brokerages: BrokerageOption[];
  onPick: (slug: string) => void;
}

/**
 * Searchable grid of SnapTrade-supported brokerages. Pre-builds a lowercase
 * name index so the filter doesn't re-lowercase on every keystroke; the
 * search input value is wrapped in useDeferredValue so typing stays
 * responsive even with 50+ entries.
 */
export function SnapTradeBrokeragePicker({ brokerages, onPick }: Props) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const indexed = useMemo(
    () => brokerages.map((b) => ({ b, key: b.name.toLowerCase() })),
    [brokerages],
  );

  const filtered = useMemo(() => {
    const q = deferredQuery.toLowerCase().trim();
    if (!q) return indexed.map((i) => i.b);
    return indexed.filter((i) => i.key.includes(q)).map((i) => i.b);
  }, [indexed, deferredQuery]);

  return (
    <div className="snaptrade-picker">
      <label className="field">
        <span>Search</span>
        <input
          type="text"
          placeholder="Search brokerages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </label>
      {filtered.length === 0 ? (
        <p className="snaptrade-picker-empty">No brokerages match.</p>
      ) : (
        <ul className="snaptrade-picker-grid">
          {filtered.map((b) => (
            <li key={b.slug}>
              <button
                type="button"
                className="snaptrade-picker-card"
                onClick={() => onPick(b.slug)}
                data-pre-focused={b.slug === 'INTERACTIVE_BROKERS' ? 'true' : undefined}
              >
                {b.logoUrl ? (
                  <img src={b.logoUrl} alt="" className="snaptrade-picker-logo" />
                ) : (
                  <span className="snaptrade-picker-logo snaptrade-picker-logo-fallback">📈</span>
                )}
                <span className="snaptrade-picker-name">{b.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
