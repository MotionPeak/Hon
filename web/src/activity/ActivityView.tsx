import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { api, ApiError } from '../api';
import { DelayedLoader } from '../ui/DelayedLoader';
import { cycleKey, cycleLabel, currentCycleKey } from '../cycle';
import { money } from '../format';
import { useSettings } from '../settings/useSettings';
import type { Account, Loan } from '../accounts/types';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from './types';
import { merchantKey, recurrenceChoices, type Frequency } from '../recurring/helpers';
import { isExcludedFromCycle, ruleMatches } from './excluded';
import { SplitwiseSection } from './SplitwiseSection';
import { SplitwiseRepaymentSection } from './SplitwiseRepaymentSection';
import { useSplitwise } from '../splitwise/useSplitwise';

/** Stored merchant-frequency value. 'income'/'ignore' are tags the editor
 *  here doesn't expose, but we keep them in the type to round-trip safely. */
type FreqValue = Frequency | 'income' | 'ignore';

function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "· ₪X owed to you" / "· paid back" suffix on a transaction's sub-line when
 *  it has been split onto Splitwise. Reads the shared useSplitwise cache, so it
 *  costs nothing when Splitwise is disconnected (linkByTxnId is empty). */
function SplitwiseNote({ txnId }: { txnId: string }) {
  const sw = useSplitwise();
  const link = sw.linkByTxnId.get(txnId);
  if (!link) return null;
  if (link.paidState === 'paid') {
    return <span className="txn-sw paid"> · paid back</span>;
  }
  const remaining = Math.max(0, link.owedToMe - (link.paidAmount || 0));
  return <span className="txn-sw"> · {money(remaining, link.currency)} owed to you</span>;
}

/** Match a transaction against a lowercase search query. Mirrors the legacy
 *  txnMatchesSearch — description, category, date, account label, or amount. */
function txnMatchesSearch(
  t: Transaction, accounts: Map<string, Account>, q: string,
): boolean {
  if (!q) return true;
  if ((t.description || '').toLowerCase().includes(q)) return true;
  if ((t.category || '').toLowerCase().includes(q)) return true;
  if (t.date && t.date.includes(q)) return true;
  const acct = accounts.get(t.accountId);
  if (acct) {
    if ((acct.label || '').toLowerCase().includes(q)) return true;
    if ((acct.connectionName || '').toLowerCase().includes(q)) return true;
  }
  const num = parseFloat(q.replace(/[^0-9.\-]/g, ''));
  if (Number.isFinite(num) && num !== 0) {
    if (Math.abs(Math.abs(t.amount) - Math.abs(num)) < 0.5) return true;
  }
  return false;
}

export function ActivityView() {
  const [settings] = useSettings();
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [merchantFreqs, setMerchantFreqs] = useState<Record<string, FreqValue>>({});
  const [month, setMonth] = useState<string | null>(null);
  const [moving, setMoving] = useState<Transaction | null>(null);
  const [search, setSearch] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPickOpen, setBulkPickOpen] = useState(false);

  const pickTxn = (t: Transaction): void => {
    if (batchMode) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(t.id)) next.delete(t.id);
        else next.add(t.id);
        return next;
      });
    } else {
      setMoving(t);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const [t, a, c, l, f] = await Promise.all([
        api<{ transactions: Transaction[] }>('/transactions'),
        api<{ accounts: Account[] }>('/accounts'),
        api<{ categories: Category[] }>('/categories'),
        api<{ loans: Loan[] }>('/loans').catch(() => ({ loans: [] as Loan[] })),
        api<{ frequencies: Record<string, FreqValue> }>('/merchant-frequencies')
          .catch(() => ({ frequencies: {} as Record<string, FreqValue> })),
      ]);
      setTransactions(t.transactions);
      setAccounts(a.accounts);
      setCategories(c.categories);
      setLoans(l.loans);
      setMerchantFreqs(f.frequencies ?? {});
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

  if (transactions === null) return <DelayedLoader />;

  if (transactions.length === 0) {
    return (
      <div className="activity-view">
        <h1>Activity</h1>
        <p className="blank">No transactions yet — sync an account to see activity.</p>
      </div>
    );
  }

  const accountById = new Map<string, Account>();
  for (const a of accounts) accountById.set(a.id, a);
  const categoryByName = new Map<string, Category>();
  for (const c of categories) categoryByName.set(c.name, c);

  const searchQ = search.trim().toLowerCase();
  const inSearchMode = searchQ.length > 0;

  // Search mode: flat cross-month list, newest first, with the same
  // refundForId / card-bill folding as the grouped view.
  const searchResults = inSearchMode
    ? transactions
        .filter((t) => !t.refundForId && txnMatchesSearch(t, accountById, searchQ))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    : [];

  const monthTxnsAll = transactions.filter((t) =>
    !t.refundForId && cycleKey(t.date, settings.monthStartDay) === activeMonth,
  );

  // Split into "counted toward the cycle", "excluded", and "savings" buckets.
  // Savings is checked FIRST so savings rows never land in the excluded bucket
  // (isExcludedFromCycle returns true for savings rows). Excluded rows skip the
  // regular category grouping and render in a dedicated section at the bottom —
  // visible, manageable, but out of the totals.
  const exclusionSettings = {
    hideCardTotals: settings.hideCardTotals,
    cardProviders: settings.cardProviders,
  };
  const monthTxns: Transaction[] = [];
  const excludedTxns: Transaction[] = [];
  const savingsTxns: Transaction[] = [];
  for (const t of monthTxnsAll) {
    if (t.savings) savingsTxns.push(t);
    else if (isExcludedFromCycle(t, exclusionSettings)) excludedTxns.push(t);
    else monthTxns.push(t);
  }

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

  const monthIdx = activeMonth ? monthsWithTxns.indexOf(activeMonth) : -1;
  const canPrev = monthIdx >= 0 && monthIdx < monthsWithTxns.length - 1;
  const canNext = monthIdx > 0;

  return (
    <div className="activity-view">
      <div className="activity-head">
        <h1>Activity</h1>
        {!inSearchMode && (
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
        )}
        <div className="act-search">
          <span className="act-search-ico">⌕</span>
          <input
            type="search"
            placeholder="Search transactions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="act-search-clear"
              aria-label="Clear search"
              onClick={() => setSearch('')}
            >×</button>
          )}
        </div>
        <span className="spacer" />
        <span className="act-count">
          {inSearchMode
            ? `${searchResults.length} match${searchResults.length === 1 ? '' : 'es'}`
            : `${monthTxnsAll.length} transaction${monthTxnsAll.length === 1 ? '' : 's'}`}
        </span>
        {batchMode ? (
          <button
            type="button"
            className="act-select-btn"
            onClick={() => { setBatchMode(false); setSelectedIds(new Set()); }}
          >Cancel</button>
        ) : (
          <button
            type="button"
            className="act-select-btn"
            onClick={() => setBatchMode(true)}
          >Select</button>
        )}
      </div>
      {batchMode && (
        <div className="batch-bar" data-testid="batch-bar">
          <span className="batch-n">
            {selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : 'Tap rows to select'}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="primary"
            disabled={selectedIds.size === 0}
            onClick={() => setBulkPickOpen(true)}
          >Move to category…</button>
        </div>
      )}
      <BulkCategoryDialog
        open={bulkPickOpen}
        count={selectedIds.size}
        categories={categories}
        onClose={() => setBulkPickOpen(false)}
        onPick={async (cat) => {
          await Promise.all(
            Array.from(selectedIds).map((id) =>
              api(`/transactions/${encodeURIComponent(id)}/category`, 'PATCH', { category: cat }),
            ),
          );
          setBulkPickOpen(false);
          setBatchMode(false);
          setSelectedIds(new Set());
          await refresh();
        }}
      />
      {inSearchMode ? (
        searchResults.length === 0 ? (
          <p className="blank">No matching transactions.</p>
        ) : (
          <section className="cat-section-act">
            <ul className="txn-list">
              {searchResults.map((t) => {
                const cat = categoryByName.get(t.category || '');
                const acct = accountById.get(t.accountId);
                const pos = t.amount > 0;
                return (
                  <li
                    key={t.id}
                    className="txn"
                    role="button"
                    tabIndex={0}
                    onClick={() => pickTxn(t)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        pickTxn(t);
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
                      <div className="txn-name">
                        {t.description}
                        <LoanChip loanId={t.loanId} loans={loans} />
                      </div>
                      <div className="txn-sub">
                        {fmtDate(t.date)}
                        {acct && (
                          <>
                            <span className="sep"> · </span>
                            {acct.label || acct.connectionName}
                          </>
                        )}
                        {t.category && (
                          <>
                            <span className="sep"> · </span>
                            {t.category}
                          </>
                        )}
                        <SplitwiseNote txnId={t.id} />
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
        )
      ) : monthTxns.length === 0 && excludedTxns.length === 0 && savingsTxns.length === 0 ? (
        <p className="blank">
          No transactions in {activeMonth ? cycleLabel(activeMonth) : 'this period'}.
        </p>
      ) : (
        <>
          {monthTxns.length > 0 && (
            <UmbrellaSections
              orderedCats={orderedCats}
              grouped={grouped}
              categoryByName={categoryByName}
              accountById={accountById}
              loans={loans}
              onPickTxn={pickTxn}
              selectedIds={selectedIds}
            />
          )}
          {savingsTxns.length > 0 && (
            <SavingsSection
              transactions={savingsTxns}
              accountById={accountById}
              onPickTxn={pickTxn}
              selectedIds={selectedIds}
            />
          )}
          {excludedTxns.length > 0 && (
            <ExcludedSection
              transactions={excludedTxns}
              accountById={accountById}
              onPickTxn={pickTxn}
              selectedIds={selectedIds}
            />
          )}
        </>
      )}
      {moving && (
        <CategoryPickerSidebar
          transaction={moving}
          allTransactions={transactions}
          categories={categories}
          loans={loans}
          onLinkLoan={async (loanId) => {
            await api(
              `/transactions/${encodeURIComponent(moving.id)}/loan`,
              'PATCH',
              { loanId },
            );
            await refresh();
          }}
          onUnlinkLoan={async () => {
            await api(
              `/transactions/${encodeURIComponent(moving.id)}/loan`,
              'PATCH',
              { loanId: null },
            );
            await refresh();
          }}
          currentFreq={
            (merchantFreqs[merchantKey(moving.description)] as Frequency | undefined) ?? null
          }
          excluded={isExcludedFromCycle(moving, exclusionSettings)}
          ruleMatched={ruleMatches(moving, exclusionSettings)}
          onSetExcluded={async (next: boolean) => {
            // When the user's choice already matches the rule, clear the
            // manual override so future rule changes propagate. Otherwise
            // store an explicit true/false that wins over the rule.
            const matched = ruleMatches(moving, exclusionSettings);
            const value: boolean | null = next === matched ? null : next;
            await api(
              `/transactions/${encodeURIComponent(moving.id)}/excluded`,
              'PATCH',
              { excluded: value },
            );
            await refresh();
          }}
          savings={!!moving.savings}
          onSetSavings={async (next: boolean) => {
            await api(
              `/transactions/${encodeURIComponent(moving.id)}/savings`,
              'PATCH',
              { savings: next },
            );
            await refresh();
          }}
          onClose={() => setMoving(null)}
          onSaved={async (cat, opts) => {
            const catChanged = cat !== (moving.category ?? '');
            if (catChanged || opts.applyToMerchant) {
              await api(
                `/transactions/${encodeURIComponent(moving.id)}/category`,
                'PATCH',
                { category: cat, applyToMerchant: opts.applyToMerchant },
              );
            }
            // Billing frequency — only persist when the category is a recurring
            // bill AND the user changed it.
            if (opts.frequency) {
              const mKey = merchantKey(moving.description);
              const stored = merchantFreqs[mKey];
              // Don't overwrite an 'income'/'ignore' tag with a billing freq
              // through the activity sidebar — those have their own UIs.
              const isBillingFreq = !stored || stored === 'monthly'
                || stored === 'bimonthly' || stored === 'yearly';
              if (isBillingFreq && opts.frequency !== (stored ?? 'monthly')) {
                await api('/merchant-frequency', 'PUT',
                  { key: mKey, frequency: opts.frequency });
              }
            }
            setMoving(null);
            await refresh();
          }}
          onLinkRefund={async (otherId) => {
            // The API always takes the EXPENSE id in the URL and the
            // REFUND id in the body. When the open transaction is an
            // expense (amount < 0) we target it; when it's a refund
            // (amount > 0), the "other side" is the expense we link to.
            const isRefund = moving.amount > 0;
            const expenseId = isRefund ? otherId : moving.id;
            const refundId  = isRefund ? moving.id : otherId;
            await api(
              `/transactions/${encodeURIComponent(expenseId)}/link`,
              'PUT',
              { refundId },
            );
            await refresh();
          }}
          onUnlinkRefund={async () => {
            // Only ever called from the expense side (where transaction.refundId
            // is set) — so the URL is always the expense.
            await api(
              `/transactions/${encodeURIComponent(moving.id)}/link`,
              'DELETE',
            );
            await refresh();
          }}
        />
      )}
    </div>
  );
}

interface UmbrellaSectionsProps {
  orderedCats: string[];
  grouped: Map<string, Transaction[]>;
  categoryByName: Map<string, Category>;
  accountById: Map<string, Account>;
  loans: Loan[];
  onPickTxn: (t: Transaction) => void;
  selectedIds: Set<string>;
}

const GROUP_ORDER: Category['catGroup'][] = ['income', 'essential', 'fixed', 'variable'];
const GROUP_LABEL: Record<Category['catGroup'], string> = {
  income: 'Income',
  essential: 'Essentials',
  fixed: 'Fixed expenses',
  variable: 'Variable expenses',
};

function UmbrellaSections({
  orderedCats, grouped, categoryByName, accountById, loans, onPickTxn, selectedIds,
}: UmbrellaSectionsProps) {
  const groupOf = (catName: string): Category['catGroup'] => {
    return categoryByName.get(catName)?.catGroup ?? 'variable';
  };
  // Bucket category names by their catGroup, preserving the ordered list
  // inside each (catalog order then alphabetical extras).
  const byGroup = new Map<Category['catGroup'], string[]>();
  for (const g of GROUP_ORDER) byGroup.set(g, []);
  for (const c of orderedCats) byGroup.get(groupOf(c))?.push(c);
  return (
    <div className="act-umbrellas">
      {GROUP_ORDER.map((g) => {
        const cats = byGroup.get(g) ?? [];
        if (cats.length === 0) return null;
        // Umbrella total: sum across every category under this group.
        // Income contributes positively, expenses negative.
        let umbrellaTotal = 0;
        let umbrellaCur = 'ILS';
        for (const c of cats) {
          for (const t of grouped.get(c) ?? []) {
            umbrellaTotal += t.amount;
            umbrellaCur = t.currency;
          }
        }
        const positive = umbrellaTotal >= 0;
        return (
          <section key={g} className="act-umbrella">
            <h2 className="umbrella-head">
              <span className="umbrella-name">{GROUP_LABEL[g]}</span>
              <span className="umbrella-line" />
              <span className={`umbrella-total${positive ? ' pos' : ''}`}>
                {money(umbrellaTotal, umbrellaCur)}
              </span>
            </h2>
            <div className="act-cols">
              {cats.map((catName) => (
                <CatCard
                  key={catName}
                  catName={catName}
                  cat={categoryByName.get(catName)}
                  rows={grouped.get(catName) ?? []}
                  accountById={accountById}
                  loans={loans}
                  onPickTxn={onPickTxn}
                  selectedIds={selectedIds}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

interface ExcludedSectionProps {
  transactions: Transaction[];
  accountById: Map<string, Account>;
  onPickTxn: (t: Transaction) => void;
  selectedIds: Set<string>;
}

/** Bottom-of-page collapsible holding every transaction that is excluded
 *  from cycle calculations — either because it matched the card-bill rule
 *  in Settings or because the user manually parked it via the sidebar.
 *  Clicking any row re-opens the sidebar so the user can put it back. */
function ExcludedSection({
  transactions, accountById, onPickTxn, selectedIds,
}: ExcludedSectionProps) {
  const [open, setOpen] = useState(false);
  const total = transactions.reduce((s, t) => s + t.amount, 0);
  const cur = transactions[0]?.currency ?? 'ILS';
  return (
    <section className="act-excluded">
      <button
        type="button"
        className="act-excluded-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="act-excluded-caret">{open ? '▾' : '▸'}</span>
        <span className="act-excluded-name">
          Excluded from cycle ({transactions.length})
        </span>
        <span className="act-excluded-line" />
        <span className="act-excluded-total">{money(total, cur)}</span>
      </button>
      {open && (
        <ul className="txn-list">
          {transactions
            .slice()
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .map((t) => {
              const acct = accountById.get(t.accountId);
              const pos = t.amount > 0;
              const selected = selectedIds.has(t.id);
              return (
                <li
                  key={t.id}
                  className={`txn act-excluded-row${selected ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onPickTxn(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onPickTxn(t);
                    }
                  }}
                >
                  <span className="txn-icon">▫️</span>
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
                      <SplitwiseNote txnId={t.id} />
                    </div>
                  </div>
                  <div className={`txn-amt${pos ? ' pos' : ''}`}>
                    {money(t.amount, t.currency)}
                  </div>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}

interface SavingsSectionProps {
  transactions: Transaction[];
  accountById: Map<string, Account>;
  onPickTxn: (t: Transaction) => void;
  selectedIds: Set<string>;
}

/** Bottom-of-page collapsible holding every transaction marked as a savings
 *  transfer — kept out of spend totals and tallied separately. Clicking any
 *  row re-opens the sidebar so the user can unmark it. */
function SavingsSection({
  transactions, accountById, onPickTxn, selectedIds,
}: SavingsSectionProps) {
  const [open, setOpen] = useState(false);
  const total = transactions.reduce((s, t) => s + Math.abs(t.amount), 0);
  const cur = transactions[0]?.currency ?? 'ILS';
  return (
    <section className="act-savings">
      <button
        type="button"
        className="act-savings-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="act-savings-caret">{open ? '▾' : '▸'}</span>
        <span className="act-savings-name">
          Savings ({transactions.length})
        </span>
        <span className="act-savings-line" />
        <span className="act-savings-total">{money(total, cur)}</span>
      </button>
      {open && (
        <ul className="txn-list">
          {transactions
            .slice()
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .map((t) => {
              const acct = accountById.get(t.accountId);
              const pos = t.amount > 0;
              const selected = selectedIds.has(t.id);
              return (
                <li
                  key={t.id}
                  className={`txn act-savings-row${selected ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onPickTxn(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onPickTxn(t);
                    }
                  }}
                >
                  <span className="txn-icon">💰</span>
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
                      <SplitwiseNote txnId={t.id} />
                    </div>
                  </div>
                  <div className={`txn-amt${pos ? ' pos' : ''}`}>
                    {money(t.amount, t.currency)}
                  </div>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}

interface CatCardProps {
  catName: string;
  cat: Category | undefined;
  rows: Transaction[];
  accountById: Map<string, Account>;
  loans: Loan[];
  onPickTxn: (t: Transaction) => void;
  selectedIds: Set<string>;
}

function CatCard({
  catName, cat, rows, accountById, loans, onPickTxn, selectedIds,
}: CatCardProps) {
  let total = 0;
  let cur = 'ILS';
  for (const t of rows) { total += t.amount; cur = t.currency; }
  return (
    <article className="cat-card-act">
      <h3 className="cat-head-act">
        <span
          className="cat-emoji"
          style={{ background: cat ? cat.color + '22' : 'var(--card-hi)' }}
        >
          {cat?.emoji ?? '▫️'}
        </span>
        <span className="cat-name">{catName}</span>
        <span className="cat-count">{rows.length}</span>
        <span className={`cat-total${total >= 0 ? ' pos' : ''}`}>
          {money(total, cur)}
        </span>
      </h3>
      <ul className="txn-list">
        {rows.map((t) => {
          const acct = accountById.get(t.accountId);
          const pos = t.amount > 0;
          const sel = selectedIds.has(t.id);
          return (
            <li
              key={t.id}
              className={`txn${sel ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              onClick={() => onPickTxn(t)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPickTxn(t);
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
                <div className="txn-name">
                  {t.description}
                  <LoanChip loanId={t.loanId} loans={loans} />
                </div>
                <div className="txn-sub">
                  {fmtDate(t.date)}
                  {acct && (
                    <>
                      <span className="sep"> · </span>
                      {acct.label || acct.connectionName}
                    </>
                  )}
                  <SplitwiseNote txnId={t.id} />
                </div>
              </div>
              <div className={`txn-amt${pos ? ' pos' : ''}`}>
                {money(t.amount, t.currency)}
              </div>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

/** Small "→ Loan name" pill rendered next to the description on Activity
 *  rows whose loan_id is set (either auto-matched by loanMatcher or
 *  pinned by hand via the sidebar). Clicking it dispatches
 *  `hon.go-to-loans` — App.tsx catches that and flips the active tab.
 *  Renders nothing when loanId is null or the loan isn't in the loans
 *  array (e.g. the matcher ran before the loan was fetched). */
function LoanChip({
  loanId, loans,
}: {
  loanId: string | null | undefined;
  loans: Loan[];
}) {
  if (!loanId) return null;
  const loan = loans.find((l) => l.id === loanId);
  if (!loan) return null;
  return (
    <button
      type="button"
      className="txn-loan-chip"
      title={`Linked to ${loan.name} — open the Loans tab`}
      onClick={(e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('hon.go-to-loans'));
      }}
    >
      → {loan.name}
    </button>
  );
}

interface CategoryPickerProps {
  transaction: Transaction;
  allTransactions: Transaction[];
  categories: Category[];
  loans: Loan[];
  /** Stored billing frequency for this txn's merchant, or null if unset. */
  currentFreq: Frequency | null;
  /** Effective excluded-from-cycle state (rule + manual override merged). */
  excluded: boolean;
  /** Whether the live card-bill rule matches this txn — used to show the
   *  caller why it's excluded by default. */
  ruleMatched: boolean;
  onSetExcluded: (next: boolean) => void | Promise<void>;
  /** Whether this txn is marked as a savings transfer. */
  savings: boolean;
  onSetSavings: (next: boolean) => void | Promise<void>;
  onClose: () => void;
  onSaved: (
    category: string,
    opts: { applyToMerchant: boolean; frequency: Frequency | null },
  ) => void | Promise<void>;
  onLinkRefund: (refundId: string) => void | Promise<void>;
  onUnlinkRefund: () => void | Promise<void>;
  onLinkLoan: (loanId: string) => void | Promise<void>;
  onUnlinkLoan: () => void | Promise<void>;
}

function CategoryPickerSidebar(
  {
    transaction, allTransactions, categories, loans, currentFreq,
    excluded, ruleMatched, onSetExcluded, savings, onSetSavings,
    onClose, onSaved,
    onLinkRefund, onUnlinkRefund, onLinkLoan, onUnlinkLoan,
  }: CategoryPickerProps,
) {
  const current = transaction.category ?? 'Other';
  const [picked, setPicked] = useState<string>(current);
  const [always, setAlways] = useState<boolean>(false);
  const [freq, setFreq] = useState<Frequency>(currentFreq ?? 'monthly');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'category' | 'refund-picker'>('category');

  // Group by catGroup; render in income → essential → fixed → variable order.
  const groupOrder: Category['catGroup'][] = ['income', 'essential', 'fixed', 'variable'];
  const grouped: Record<Category['catGroup'], Category[]> = {
    income: [], essential: [], fixed: [], variable: [],
  };
  for (const c of categories) grouped[c.catGroup].push(c);
  for (const g of groupOrder) {
    grouped[g].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }
  // Billing-frequency choices depend on the currently *picked* category, not
  // the saved one — so picking Subscriptions vs. a fixed-group category swaps
  // the toggles in place. Null when the category isn't a recurring bill.
  const pickedCat = categories.find((c) => c.name === picked);
  const choices = recurrenceChoices(pickedCat);
  // Snap freq to a valid choice if the user pivoted to a category with a
  // different set of options (e.g. fixed → Subscriptions where bimonthly
  // disappears). 'monthly' is the always-available fallback.
  const effectiveFreq: Frequency = choices && choices.some(([v]) => v === freq)
    ? freq : 'monthly';

  const freqChanged = !!choices && effectiveFreq !== (currentFreq ?? 'monthly');
  const catChanged = picked !== current;
  const canSave = catChanged || always || freqChanged;

  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSaved(picked, {
        applyToMerchant: always,
        frequency: choices ? effectiveFreq : null,
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  const cat = categories.find((c) => c.name === current);
  return (
    <ModalPortal>
      <aside
        role="dialog"
        aria-label="Move to category"
        className="txn-sidebar"
      >
        <header className="txn-sidebar-head">
          <span className="label">Transaction</span>
          <button
            type="button"
            className="icon-btn txn-sidebar-close"
            aria-label="Close"
            onClick={onClose}
          >×</button>
        </header>
        <div className="txn-sidebar-preview">
          <span
            className="txn-icon"
            style={{ background: cat ? cat.color + '22' : 'var(--card-hi)' }}
          >
            {cat?.emoji ?? '▫️'}
          </span>
          <div className="txn-sidebar-meta">
            <div className="txn-sidebar-name">{transaction.description}</div>
            <div className="txn-sidebar-sub">
              {money(transaction.amount, transaction.currency)} · {transaction.date}
            </div>
          </div>
        </div>

        {view === 'refund-picker' ? (
          <RefundPicker
            key="refund-picker"
            transaction={transaction}
            allTransactions={allTransactions}
            categories={categories}
            onBack={() => setView('category')}
            onPick={async (refundId) => {
              await onLinkRefund(refundId);
              setView('category');
            }}
          />
        ) : (
          <div key="category-view" className="sb-view-anim">
            <div className="txn-sidebar-section">
              <div className="label">Category</div>
              {groupOrder.map((g) => grouped[g].length === 0 ? null : (
                <div key={g} className="cat-pick-section">
                  <div className="cat-pick-head">{g}</div>
                  <div className="cat-pick-grid">
                    {grouped[g].map((c) => {
                      const selected = c.name === picked;
                      return (
                        <button
                          key={c.name}
                          type="button"
                          className={`cat-pick-tile${selected ? ' on' : ''}`}
                          aria-pressed={selected}
                          style={{ '--cat-color': c.color } as React.CSSProperties}
                          onClick={() => setPicked(c.name)}
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
            </div>

            <label className="txn-sidebar-always">
              <input
                type="checkbox"
                checked={always}
                disabled={busy}
                onChange={(e) => setAlways(e.target.checked)}
              />
              <span>Always categorize transactions from this business this way</span>
            </label>

            {choices && (
              <div className="txn-sidebar-section">
                <div className="label">Billing frequency</div>
                <div
                  className="freq-pick"
                  role="radiogroup"
                  aria-label="Billing frequency"
                >
                  {choices.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={effectiveFreq === value}
                      className={`freq-opt${effectiveFreq === value ? ' active' : ''}`}
                      onClick={() => setFreq(value)}
                      disabled={busy}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <RefundSection
              transaction={transaction}
              allTransactions={allTransactions}
              onOpenPicker={() => setView('refund-picker')}
              onUnlinkRefund={onUnlinkRefund}
            />

            <LoansSection
              transaction={transaction}
              loans={loans}
              onLink={onLinkLoan}
              onUnlink={onUnlinkLoan}
            />

            <SplitwiseSection transaction={transaction} />
            <SplitwiseRepaymentSection transaction={transaction} />

            <div className="txn-sidebar-section">
              <div className="label">Cycle calculations</div>
              <label className="txn-sidebar-toggle">
                <span className="txn-sidebar-toggle-main">
                  <span className="txn-sidebar-toggle-name">Exclude from cycle</span>
                  <span className="txn-sidebar-toggle-sub">
                    {excluded
                      ? ruleMatched
                        ? 'Matched the card-bill rule — already out of totals.'
                        : 'Hidden from monthly totals + projection.'
                      : 'Counted in monthly totals + projection.'}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={excluded}
                  disabled={busy}
                  onChange={(e) => { void onSetExcluded(e.target.checked); }}
                  aria-label="Exclude from cycle calculations"
                />
              </label>
              <label className="txn-sidebar-toggle">
                <span className="txn-sidebar-toggle-main">
                  <span className="txn-sidebar-toggle-name">Savings</span>
                  <span className="txn-sidebar-toggle-sub">
                    {savings
                      ? 'Money moved to savings — kept out of spend, tallied separately.'
                      : 'Counts as regular spend. Turn on for transfers to savings.'}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={savings}
                  disabled={busy}
                  onChange={(e) => { void onSetSavings(e.target.checked); }}
                  aria-label="Mark as savings transfer"
                />
              </label>
            </div>

            {error && <div className="modal-err">{error}</div>}
            <button
              type="button"
              className="primary txn-sidebar-save"
              onClick={() => void save()}
              disabled={busy || !canSave}
            >
              Save
            </button>
          </div>
        )}
      </aside>
    </ModalPortal>
  );
}

function LoansSection({
  transaction, loans, onLink, onUnlink,
}: {
  transaction: Transaction;
  loans: Loan[];
  onLink: (loanId: string) => void | Promise<void>;
  onUnlink: () => void | Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const linkedLoan = transaction.loanId
    ? loans.find((l) => l.id === transaction.loanId) ?? null
    : null;
  const handleUnlink = async (): Promise<void> => {
    setBusy(true);
    try { await onUnlink(); } finally { setBusy(false); }
  };
  const handleLink = async (loanId: string): Promise<void> => {
    setBusy(true);
    try {
      await onLink(loanId);
      setPicking(false);
    } finally { setBusy(false); }
  };
  return (
    <div className="txn-sidebar-section">
      <div className="label">Loans</div>
      {linkedLoan ? (
        <div className="rf-linked">
          <div className="rf-linked-name">Linked to {linkedLoan.name}</div>
          <button
            type="button"
            className="rf-unlink"
            aria-label="Unlink loan"
            disabled={busy}
            onClick={() => void handleUnlink()}
          >Unlink</button>
        </div>
      ) : (
        <button
          type="button"
          className="txn-sidebar-action"
          onClick={() => setPicking(true)}
          disabled={loans.length === 0}
        >+ Link to a loan</button>
      )}
      <Dialog.Root open={picking} onOpenChange={(o) => { if (!o) setPicking(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="rx-overlay" />
          <Dialog.Content className="rx-dialog rx-dialog-sm" aria-label="Pick a loan">
            <Dialog.Title>Pick a loan</Dialog.Title>
            <Dialog.Description className="rx-dialog-desc">
              The transaction will be attached to the selected loan and
              appear in its payment history. Auto-matched links can be
              overridden here too.
            </Dialog.Description>
            <ul className="loan-pick-list">
              {loans.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className="loan-pick-row"
                    disabled={busy}
                    onClick={() => void handleLink(l.id)}
                  >
                    <span className="loan-pick-name">{l.name}</span>
                    <span className="loan-pick-meta">
                      {l.connectionId ? 'Bank loan' : 'Manual'}
                    </span>
                  </button>
                </li>
              ))}
              {loans.length === 0 && (
                <li className="loan-pick-empty">
                  No loans yet. Add one from the Loans tab first.
                </li>
              )}
            </ul>
            <div className="form-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn-ghost">Cancel</button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

interface RefundSectionProps {
  transaction: Transaction;
  allTransactions: Transaction[];
  onOpenPicker: () => void;
  onUnlinkRefund: () => void | Promise<void>;
}

interface BulkCategoryDialogProps {
  open: boolean;
  count: number;
  categories: Category[];
  onClose: () => void;
  onPick: (category: string) => void | Promise<void>;
}

function BulkCategoryDialog({
  open, count, categories, onClose, onPick,
}: BulkCategoryDialogProps) {
  const [busy, setBusy] = useState(false);
  const groupOrder: Category['catGroup'][] = ['income', 'essential', 'fixed', 'variable'];
  const grouped: Record<Category['catGroup'], Category[]> = {
    income: [], essential: [], fixed: [], variable: [],
  };
  for (const c of categories) grouped[c.catGroup].push(c);
  for (const g of groupOrder) {
    grouped[g].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content
          className="rx-dialog"
          aria-label={`Move ${count} transactions to category`}
        >
          <Dialog.Title>
            Move {count} transaction{count === 1 ? '' : 's'} to category
          </Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            Pick a category — the chosen tag is applied to every selected
            transaction in one go.
          </Dialog.Description>
          <div className="cat-pick-stack">
            {groupOrder.map((g) => grouped[g].length === 0 ? null : (
              <div key={g} className="cat-pick-section">
                <div className="cat-pick-head">{g}</div>
                <div className="cat-pick-grid">
                  {grouped[g].map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      className="cat-pick-tile"
                      style={{ '--cat-color': c.color } as React.CSSProperties}
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try { await onPick(c.name); }
                        finally { setBusy(false); }
                      }}
                    >
                      <span className="cat-pick-emoji">{c.emoji}</span>
                      <span className="cat-pick-name">{c.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="form-actions">
            <Dialog.Close asChild>
              <button type="button" className="btn-ghost">Cancel</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RefundSection({
  transaction, allTransactions, onOpenPicker, onUnlinkRefund,
}: RefundSectionProps) {
  const [busy, setBusy] = useState(false);
  const isRefund = transaction.amount > 0;
  // Only an expense carries a refundId; refunds don't show the linked-state
  // card here (it would need /transaction-links to enumerate every expense
  // linked to this refund — deferred).
  const linked = !isRefund && transaction.refundId
    ? allTransactions.find((t) => t.id === transaction.refundId) ?? null
    : null;

  if (linked) {
    return (
      <div className="txn-sidebar-section">
        <div className="label">Reimbursement</div>
        <div className="rf-linked">
          <div className="rf-linked-name">{linked.description}</div>
          <div className="rf-linked-sub">
            +{money(linked.amount, linked.currency)} · {linked.date}
          </div>
          <button
            type="button"
            className="rf-unlink"
            aria-label="Unlink refund"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await onUnlinkRefund(); }
              finally { setBusy(false); }
            }}
          >Unlink</button>
        </div>
      </div>
    );
  }

  return (
    <div className="txn-sidebar-section">
      <div className="label">Reimbursement</div>
      <button
        type="button"
        className="txn-sidebar-action"
        onClick={onOpenPicker}
      >
        {isRefund
          ? '+ Link to an expense it pays back'
          : '+ Link a refund or reimbursement'}
      </button>
    </div>
  );
}

interface RefundPickerProps {
  transaction: Transaction;
  allTransactions: Transaction[];
  categories: Category[];
  onBack: () => void;
  onPick: (refundId: string) => void | Promise<void>;
}

function RefundPicker({
  transaction, allTransactions, categories, onBack, onPick,
}: RefundPickerProps) {
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  // When the open transaction is a refund (amount > 0) the picker shows
  // EXPENSES it could pay back (amount < 0). When it's an expense the
  // picker shows refund candidates (amount > 0). Same currency, never
  // the transaction itself.
  const isRefund = transaction.amount > 0;
  const baseCandidates = useMemo(() => {
    return allTransactions
      .filter((t) =>
        t.id !== transaction.id
        && t.currency === transaction.currency
        && (isRefund ? t.amount < 0 : t.amount > 0))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [allTransactions, transaction.id, transaction.currency, isRefund]);

  // Search narrows the list. Match on description, category, date, or amount —
  // same shape as the main Activity search.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return baseCandidates;
    const num = parseFloat(q.replace(/[^0-9.\-]/g, ''));
    const numValid = Number.isFinite(num) && num !== 0;
    return baseCandidates.filter((t) => {
      if ((t.description || '').toLowerCase().includes(q)) return true;
      if ((t.category || '').toLowerCase().includes(q)) return true;
      if (t.date && t.date.includes(q)) return true;
      if (numValid && Math.abs(Math.abs(t.amount) - Math.abs(num)) < 0.5) return true;
      return false;
    });
  }, [baseCandidates, query]);

  const categoryByName = new Map<string, Category>();
  for (const c of categories) categoryByName.set(c.name, c);

  // Group candidates by category, preserving the date-desc order within each
  // group. The order of groups follows the first-appearance of each category
  // in the sorted candidate list — so the freshest category bubbles up.
  const grouped = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const c of candidates) {
      const key = c.category ?? '—';
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [candidates]);

  const hint = isRefund
    ? 'Pick the expense this refund pays back — Hon deducts whatever ' +
      'portion you allocate from that expense. One refund can split ' +
      'across several expenses.'
    : 'Pick the transaction that paid you back — Hon deducts whatever ' +
      'portion you allocate from this expense. One transfer can split ' +
      'across several expenses.';
  const emptyHint = isRefund
    ? 'No negative-amount expenses available to link this refund to.'
    : 'No positive-amount transactions to link as a refund yet.';

  return (
    <div className="rf-picker">
      <button type="button" className="rf-back" onClick={onBack}>‹ Back</button>
      <p className="rf-hint">{hint}</p>
      <div className="rf-search">
        <input
          type="search"
          placeholder="Search by name, category, date, or amount…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search candidates"
        />
      </div>
      {baseCandidates.length === 0 ? (
        <p className="txn-sidebar-hint">{emptyHint}</p>
      ) : candidates.length === 0 ? (
        <p className="txn-sidebar-hint">No matches.</p>
      ) : (
        <div className="rf-list">
          {grouped.map(([catName, rows]) => {
            const cat = categoryByName.get(catName);
            return (
              <section key={catName} className="rf-group">
                <h4 className="rf-group-head">
                  <span className="rf-group-emoji">{cat?.emoji ?? '▫️'}</span>
                  <span>{catName}</span>
                  <span className="rf-group-count">{rows.length}</span>
                </h4>
                <ul className="rf-group-list">
                  {rows.map((c) => {
                    const color = cat?.color ?? (isRefund ? '#E96B6B' : '#5CC773');
                    const emoji = cat?.emoji ?? (isRefund ? '🧾' : '💰');
                    const pos = c.amount > 0;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="rf-opt"
                          aria-label={c.description}
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try { await onPick(c.id); }
                            finally { setBusy(false); }
                          }}
                        >
                          <span
                            className="txn-icon sm"
                            style={{ background: color + '26', color }}
                          >{emoji}</span>
                          <span className="txn-main">
                            <span className="txn-name">{c.description}</span>
                            <span className="txn-sub">{fmtDate(c.date)}</span>
                          </span>
                          <span className={`txn-amt${pos ? ' pos' : ''}`}>
                            {pos ? '+' : ''}{money(c.amount, c.currency)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
