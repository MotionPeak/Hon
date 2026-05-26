import { useState, type KeyboardEvent } from 'react';
import { useSettings } from './useSettings';

interface Brand {
  id: string;
  name: string;
  terms: string[];
}

const CATALOG: Brand[] = [
  { id: 'max', name: 'Max', terms: ['max', 'מקס'] },
  { id: 'isracard', name: 'Isracard', terms: ['isracard', 'ישראכרט'] },
  { id: 'cal', name: 'Cal / Visa Cal', terms: ['cal', 'כאל', 'ויזה כאל'] },
  { id: 'amex', name: 'American Express', terms: ['american express', 'אמריקן אקספרס'] },
  { id: 'leumi', name: 'Leumi Card', terms: ['leumi card', 'לאומי קארד'] },
  { id: 'diners', name: 'Diners', terms: ['diners', 'דיינרס'] },
];

function lowerSet(xs: string[]): Set<string> {
  return new Set(xs.map((t) => t.toLowerCase()));
}

function isBrandOn(brand: Brand, providers: string[]): boolean {
  const lower = lowerSet(providers);
  return brand.terms.every((t) => lower.has(t.toLowerCase()));
}

function toggleBrand(brand: Brand, providers: string[]): string[] {
  if (isBrandOn(brand, providers)) {
    const drop = lowerSet(brand.terms);
    return providers.filter((t) => !drop.has(t.toLowerCase()));
  }
  const lower = lowerSet(providers);
  return [...providers, ...brand.terms.filter((t) => !lower.has(t.toLowerCase()))];
}

const KNOWN_TERMS = new Set(
  CATALOG.flatMap((b) => b.terms.map((t) => t.toLowerCase())),
);

function customTerms(providers: string[]): string[] {
  return providers.filter((t) => !KNOWN_TERMS.has(t.toLowerCase()));
}

function removeTerm(term: string, providers: string[]): string[] {
  return providers.filter((t) => t.toLowerCase() !== term.toLowerCase());
}

function addTerm(term: string, providers: string[]): string[] {
  const trimmed = term.trim();
  if (!trimmed) return providers;
  const lower = lowerSet(providers);
  if (lower.has(trimmed.toLowerCase())) return providers;
  return [...providers, trimmed];
}

export function CreditCardBillsCard() {
  const [settings, update] = useSettings();
  const [draft, setDraft] = useState('');
  const onAdd = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = addTerm(draft, settings.cardProviders);
    setDraft('');
    if (next !== settings.cardProviders) update({ cardProviders: next });
  };
  return (
    <section className="set-card">
      <div className="set-card-head">
        <span className="set-ico">💳</span>
        <h3>Credit-card bills</h3>
      </div>
      <label className="set-row">
        <div className="set-row-main">
          <div className="set-row-name">Hide card-bill totals</div>
          <div className="set-row-sub">
            When a bank line is just the lump-sum card bill (already itemised under the
            card), keep it out of spending totals so it is not double-counted.
          </div>
        </div>
        <span className="switch">
          <input
            type="checkbox"
            checked={settings.hideCardTotals}
            onChange={(e) => update({ hideCardTotals: e.target.checked })}
          />
          <span className="switch-track" />
        </span>
      </label>
      <div className="set-row col">
        <div className="set-row-main">
          <div className="set-row-name">Card-provider names</div>
          <div className="set-row-sub">
            A bank line whose description contains any of these is treated as a card-bill total.
          </div>
        </div>
        <div className="chip-row">
          {CATALOG.map((b) => {
            const on = isBrandOn(b, settings.cardProviders);
            return (
              <button
                key={b.id}
                type="button"
                className={`chip${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => update({ cardProviders: toggleBrand(b, settings.cardProviders) })}
              >
                {b.name}
              </button>
            );
          })}
        </div>
        <div className="custom-row">
          <span className="custom-row-label">Custom matchers</span>
          <input
            type="text"
            value={draft}
            autoComplete="off"
            placeholder="Type a substring your bank uses, then press Enter"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onAdd}
          />
          <div className="custom-chips">
            {customTerms(settings.cardProviders).map((t) => (
              <span key={t} className="custom-chip">
                <span>{t}</span>
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => update({ cardProviders: removeTerm(t, settings.cardProviders) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
