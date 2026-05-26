import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';
import { cycleKey, cycleLabel, currentCycleKey } from '../cycle';
import { money } from '../format';
import { useSettings } from '../settings/useSettings';
import type { Account } from '../accounts/types';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from './types';

function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function ActivityView() {
  const [settings] = useSettings();
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  const [moving, setMoving] = useState<Transaction | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, a, c] = await Promise.all([
        api<{ transactions: Transaction[] }>('/transactions'),
        api<{ accounts: Account[] }>('/accounts'),
        api<{ categories: Category[] }>('/categories'),
      ]);
      setTransactions(t.transactions);
      setAccounts(a.accounts);
      setCategories(c.categories);
    } catch {
      setTransactions([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // The list of months that actually have transactions, newest first. Refund
  // rows (refundForId) and card-bill totals are excluded — same logic as the
  // legacy activityMonths().
  const monthsWithTxns = useMemo(() => {
    if (!transactions) return [];
    const set = new Set<string>();
    for (const t of transactions) {
      if (t.refundForId) continue;
      const k = cycleKey(t.date, settings.monthStartDay);
      if (k && k.length === 7) set.add(k);
    }
    return Array.from(set).sort().reverse();
  }, [transactions, settings.monthStartDay]);

  // The active month — picks itself when transactions land or settings change.
  const activeMonth = useMemo(() => {
    if (!transactions) return null;
    if (month && monthsWithTxns.includes(month)) return month;
    return monthsWithTxns[0] ?? currentCycleKey(settings.monthStartDay);
  }, [month, monthsWithTxns, transactions, settings.monthStartDay]);

  if (transactions === null) return <p>Loading…</p>;

  if (transactions.length === 0) {
    return (
      <div className="activity-view">
        <h1>Activity</h1>
        <p className="blank">No transactions yet — sync an account to see activity.</p>
      </div>
    );
  }

  const monthTxns = transactions.filter((t) =>
    !t.refundForId && cycleKey(t.date, settings.monthStartDay) === activeMonth,
  );

  // Group by category. The category order comes from the engine's sortOrder.
  const grouped = new Map<string, Transaction[]>();
  for (const t of monthTxns) {
    const cat = t.category || 'Other';
    const arr = grouped.get(cat) ?? [];
    arr.push(t);
    grouped.set(cat, arr);
  }
  // Order: categories in catalog order, then any extras alphabetically.
  const catalog = categories
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => c.name);
  const orderedCats = [
    ...catalog.filter((n) => grouped.has(n)),
    ...Array.from(grouped.keys())
      .filter((n) => !catalog.includes(n))
      .sort(),
  ];

  const accountById = new Map<string, Account>();
  for (const a of accounts) accountById.set(a.id, a);
  const categoryByName = new Map<string, Category>();
  for (const c of categories) categoryByName.set(c.name, c);

  const monthIdx = activeMonth ? monthsWithTxns.indexOf(activeMonth) : -1;
  const canPrev = monthIdx >= 0 && monthIdx < monthsWithTxns.length - 1;
  const canNext = monthIdx > 0;

  return (
    <div className="activity-view">
      <div className="activity-head">
        <h1>Activity</h1>
        <div className="month-pick">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous month"
            disabled={!canPrev}
            onClick={() => canPrev && setMonth(monthsWithTxns[monthIdx + 1])}
          >‹</button>
          <span className="month-label">
            {activeMonth ? cycleLabel(activeMonth) : ''}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next month"
            disabled={!canNext}
            onClick={() => canNext && setMonth(monthsWithTxns[monthIdx - 1])}
          >›</button>
        </div>
        <span className="spacer" />
        <span className="act-count">
          {monthTxns.length} transaction{monthTxns.length === 1 ? '' : 's'}
        </span>
      </div>
      {monthTxns.length === 0 ? (
        <p className="blank">
          No transactions in {activeMonth ? cycleLabel(activeMonth) : 'this period'}.
        </p>
      ) : (
        <div className="cat-stack">
          {orderedCats.map((catName) => {
            const cat = categoryByName.get(catName);
            const rows = grouped.get(catName) ?? [];
            return (
              <section key={catName} className="cat-section-act">
                <h3 className="cat-head-act">
                  <span
                    className="cat-emoji"
                    style={{ background: cat ? cat.color + '22' : 'var(--card-hi)' }}
                  >
                    {cat?.emoji ?? '▫️'}
                  </span>
                  <span className="cat-name">{catName}</span>
                  <span className="cat-count">{rows.length}</span>
                </h3>
                <ul className="txn-list">
                  {rows.map((t) => {
                    const acct = accountById.get(t.accountId);
                    const pos = t.amount > 0;
                    return (
                      <li
                        key={t.id}
                        className="txn"
                        role="button"
                        tabIndex={0}
                        onClick={() => setMoving(t)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setMoving(t);
                          }
                        }}
                      >
                        <span
                          className="txn-icon"
                          style={{ background: cat ? cat.color + '22' : 'var(--card-hi)' }}
                        >
                          {cat?.emoji ?? '▫️'}
                        </span>
                        <div className="txn-main">
                          <div className="txn-name">{t.description}</div>
                          <div className="txn-sub">
                            {fmtDate(t.date)}
                            {acct && (
                              <>
                                <span className="sep"> · </span>
                                {acct.label || acct.connectionName}
                              </>
                            )}
                          </div>
                        </div>
                        <div className={`txn-amt${pos ? ' pos' : ''}`}>
                          {money(t.amount, t.currency)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {moving && (
        <CategoryPickerModal
          transaction={moving}
          categories={categories}
          onClose={() => setMoving(null)}
          onPicked={async (cat) => {
            await api(
              `/transactions/${encodeURIComponent(moving.id)}/category`,
              'PATCH',
              { category: cat },
            );
            setMoving(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

interface CategoryPickerProps {
  transaction: Transaction;
  categories: Category[];
  onClose: () => void;
  onPicked: (category: string) => void | Promise<void>;
}

function CategoryPickerModal(
  { transaction, categories, onClose, onPicked }: CategoryPickerProps,
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = transaction.category ?? 'Other';

  // Group by catGroup; render in income → essential → fixed → variable order.
  const groupOrder: Category['catGroup'][] = ['income', 'essential', 'fixed', 'variable'];
  const grouped: Record<Category['catGroup'], Category[]> = {
    income: [], essential: [], fixed: [], variable: [],
  };
  for (const c of categories) grouped[c.catGroup].push(c);
  for (const g of groupOrder) {
    grouped[g].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }
  const pick = async (name: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPicked(name);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <ModalPortal>
      <div className="overlay">
        <div role="dialog" aria-label="Move to category" className="modal">
          <h2>Move to category</h2>
          <p>
            <strong>{transaction.description}</strong> · {money(transaction.amount, transaction.currency)}
          </p>
          {groupOrder.map((g) => grouped[g].length === 0 ? null : (
            <div key={g} className="cat-pick-section">
              <div className="cat-pick-head">{g}</div>
              <div className="cat-pick-grid">
                {grouped[g].map((c) => {
                  const selected = c.name === current;
                  return (
                    <button
                      key={c.name}
                      type="button"
                      className={`cat-pick-tile${selected ? ' on' : ''}`}
                      aria-pressed={selected}
                      style={{ '--cat-color': c.color } as React.CSSProperties}
                      onClick={() => void pick(c.name)}
                      disabled={busy}
                    >
                      <span className="cat-pick-emoji">{c.emoji}</span>
                      <span className="cat-pick-name">{c.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {error && <div className="modal-err">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
