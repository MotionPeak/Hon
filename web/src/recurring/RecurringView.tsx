import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '../api';
import { DelayedLoader } from '../ui/DelayedLoader';
import { cycleKey, currentCycleKey } from '../cycle';
import { money } from '../format';
import { useSettings } from '../settings/useSettings';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from '../activity/types';
import {
  type Frequency, type FreqOrIgnore, type MerchantRow, type RecurringData,
  detectMerchants, cyclesBetween, cycleStatus, expectedFixedThisCycle,
} from './helpers';
import { SubscriptionsSection } from '../subscriptions/SubscriptionsSection';

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

interface StatusBadge { cls: string; label: string; hint: string }
function statusFor(row: MerchantRow, monthStartDay: number): StatusBadge {
  const status = cycleStatus(row, monthStartDay);
  if (status === 'billed') {
    return { cls: 'good', label: '✓ Billed', hint: 'Already billed this cycle.' };
  }
  if (status === 'off-cycle') {
    if (row.freq === 'bimonthly') {
      return { cls: 'muted', label: 'Off-cycle',
        hint: 'Bimonthly — billed last cycle, not expected this one.' };
    }
    // Yearly between charges — show how many cycles until the next one.
    const cur = currentCycleKey(monthStartDay);
    const lastCycle = row.lastTxnDate ? cycleKey(row.lastTxnDate, monthStartDay) : null;
    const left = 12 - (lastCycle ? cyclesBetween(lastCycle, cur) : 0);
    return { cls: 'muted', label: 'Off-cycle',
      hint: `Yearly — next charge in ${left} cycle${left === 1 ? '' : 's'}.` };
  }
  return { cls: 'warn', label: 'Not yet billed',
    hint: 'Expected this cycle but no charge has arrived yet.' };
}

export function RecurringView() {
  const [settings] = useSettings();
  const [data, setData] = useState<RecurringData | null>(null);
  const [splitEdit, setSplitEdit] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [t, c, f, s, sub] = await Promise.all([
        api<{ transactions: Transaction[] }>('/transactions'),
        api<{ categories: Category[] }>('/categories'),
        api<{ frequencies: Record<string, FreqOrIgnore> }>('/merchant-frequencies'),
        api<{ splits: Record<string, number>; shareAmounts: Record<string, number> }>('/category-splits'),
        api<{ cancelled: Record<string, string> }>('/subscriptions/cancelled')
          .catch(() => ({ cancelled: {} as Record<string, string> })),
      ]);
      setData({
        transactions: t.transactions,
        categories: c.categories,
        frequencies: f.frequencies ?? {},
        splits: s.splits ?? {},
        shareAmounts: s.shareAmounts ?? {},
        cancelled: sub.cancelled ?? {},
      });
    } catch {
      setData({
        transactions: [], categories: [], frequencies: {}, splits: {}, shareAmounts: {}, cancelled: {},
      });
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const removeFromFixed = async (key: string): Promise<void> => {
    await api('/merchant-frequency', 'PUT', { key, frequency: 'ignore' });
    await reload();
  };
  const markCancelled = async (key: string): Promise<void> => {
    await api('/subscriptions/cancelled', 'PUT', { merchantKey: key });
    await reload();
  };
  const restoreCancelled = async (key: string): Promise<void> => {
    await api('/subscriptions/cancelled', 'DELETE', { merchantKey: key });
    await reload();
  };
  const saveCategorySplit = async (
    category: string, splitCount: number | null,
  ): Promise<void> => {
    await api('/category-split', 'PUT', { category, splitCount });
    setSplitEdit(null);
    await reload();
  };
  const saveCategoryShare = async (
    category: string, shareAmount: number | null,
  ): Promise<void> => {
    await api('/category-share', 'PUT', { category, shareAmount });
    setSplitEdit(null);
    await reload();
  };

  const detected = useMemo(
    () => data ? detectMerchants(data, settings.monthStartDay) : null,
    [data, settings.monthStartDay],
  );

  if (!data || !detected) return <DelayedLoader />;

  // Subscriptions render in the dedicated area below, not as a fixed section.
  const rows = detected.rows.filter((r) => r.category !== 'Subscriptions');

  // Group by category, sort each by monthly share desc, sort categories by
  // their combined monthly cost desc.
  const byCat = new Map<string, MerchantRow[]>();
  for (const r of rows) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }
  for (const list of byCat.values()) list.sort((a, b) => b.monthlyShare - a.monthlyShare);
  const catOrder = Array.from(byCat.keys()).sort((a, b) => {
    const sumA = (byCat.get(a) ?? []).reduce((s, r) => s + r.monthlyShare, 0);
    const sumB = (byCat.get(b) ?? []).reduce((s, r) => s + r.monthlyShare, 0);
    return sumB - sumA;
  });

  const grandMonthly = rows.reduce((s, r) => s + r.monthlyShare, 0);
  // The full charges actually due THIS cycle (bimonthly counted full when on-
  // cycle, ₪0 off-cycle) — the same number the Overview "Expected fixed +
  // essentials" headline uses. Differs from the smoothed monthly equivalent.
  const dueThisCycle = expectedFixedThisCycle(rows, settings.monthStartDay);
  const catByName = new Map<string, Category>();
  for (const c of data.categories) catByName.set(c.name, c);
  const FREQ_LABEL: Record<Frequency, string> = {
    monthly: 'Monthly', bimonthly: 'Bimonthly', yearly: 'Yearly',
  };

  return (
    <div className="recurring-view">
      <h1>Fixed bills</h1>
      <p className="set-intro">
        Detected from your transactions: any fixed-category merchant that's
        appeared in 2+ billing cycles, or a single charge you've told Hon
        bills regularly. Hover the status pill for details.
      </p>
      {rows.length === 0 ? (
        <p className="blank">
          No recurring fixed bills detected yet. They appear here once a
          fixed-category charge (Housing · Utilities · Insurance · Education ·
          Fees) is seen in two or more billing cycles — or once you set a
          frequency on a charge by hand.
        </p>
      ) : (
        <>
          <div className="recurring-totals">
            <div data-testid="recurring-due" className="recurring-total recurring-due">
              <span className="emoji">🎯</span>
              <span>Due this cycle</span>
              <b>{money(dueThisCycle, 'ILS')}</b>
            </div>
            <div data-testid="recurring-total" className="recurring-total recurring-total-sub">
              <span className="emoji">📆</span>
              <span>Expected monthly</span>
              <b>{money(grandMonthly, 'ILS')}</b>
            </div>
          </div>
          <div className="recurring-sections">
            {catOrder.map((catName) => {
              const list = byCat.get(catName) ?? [];
              const cat = catByName.get(catName);
              const sectionTotal = list.reduce((s, r) => s + r.monthlyShare, 0);
              const split = data.splits[catName] || 1;
              const shared = split > 1;
              return (
                <section key={catName} className="rec-section">
                  <h3 className="rec-section-head">
                    <span
                      className="rec-section-emoji"
                      style={{ background: cat ? cat.color + '22' : 'var(--card-hi)' }}
                    >
                      {cat?.emoji ?? '▫️'}
                    </span>
                    <span className="rec-section-name">{catName}</span>
                    <button
                      type="button"
                      className={`rec-split${shared ? ' on' : ''}`}
                      onClick={() => setSplitEdit(catName)}
                      aria-label={`Split ${catName}`}
                      title={shared
                        ? `You pay 1/${split} of every ${catName} bill. Click to change.`
                        : 'Share this category with roommates / partner'}
                    >÷{split}</button>
                    <span className="rec-section-total">
                      {money(sectionTotal, 'ILS')}
                      <span className="rec-unit">/mo</span>
                    </span>
                  </h3>
                  <ul className="rec-list">
                    {list.map((r) => {
                      const status = statusFor(r, settings.monthStartDay);
                      return (
                        <li key={r.key} className="rec-row">
                          <div className="rec-main">
                            <div className="rec-name">
                              {r.desc}
                              <span className={`rec-tag rec-tag-${status.cls}`} title={status.hint}>
                                {status.label}
                              </span>
                            </div>
                            <div className="rec-meta">
                              {FREQ_LABEL[r.freq]} · {money(r.lastChargeAbs, 'ILS')} per charge
                              · last {fmtDate(r.lastTxnDate)}
                              · {r.count} charge{r.count === 1 ? '' : 's'}
                            </div>
                          </div>
                          <div className="rec-amount">
                            {money(r.monthlyShare, 'ILS')}
                            <span className="rec-unit">/mo</span>
                          </div>
                          <button
                            type="button"
                            className="rec-remove"
                            aria-label="Remove from Fixed bills"
                            title={"Remove from Fixed bills — keeps the underlying " +
                              "transactions, just stops counting this merchant " +
                              "toward Expected fixed"}
                            onClick={() => void removeFromFixed(r.key)}
                          >✕</button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}

      <SubscriptionsSection
        transactions={data.transactions}
        frequencies={data.frequencies}
        cancelled={data.cancelled}
        onCancel={markCancelled}
        onRestore={restoreCancelled}
      />

      <SplitEditorDialog
        category={splitEdit}
        currentSplit={splitEdit ? (data.splits[splitEdit] || 1) : 1}
        currentShare={splitEdit ? (data.shareAmounts[splitEdit] ?? null) : null}
        onClose={() => setSplitEdit(null)}
        onSave={saveCategorySplit}
        onSaveShare={saveCategoryShare}
      />
    </div>
  );
}

function SplitEditorDialog({
  category, currentSplit, currentShare, onClose, onSave, onSaveShare,
}: {
  category: string | null;
  currentSplit: number;
  currentShare: number | null;
  onClose: () => void;
  onSave: (category: string, splitCount: number | null) => void | Promise<void>;
  onSaveShare: (category: string, shareAmount: number | null) => void | Promise<void>;
}) {
  const open = category !== null;
  const [value, setValue] = useState<string>(String(currentSplit));
  const [share, setShare] = useState<string>(currentShare != null ? String(currentShare) : '');

  useEffect(() => {
    if (open) {
      setValue(String(currentSplit));
      setShare(currentShare != null ? String(currentShare) : '');
    }
  }, [open, currentSplit, currentShare]);

  const handleSave = (): void => {
    if (!category) return;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 50) return;
    void onSave(category, n === 1 ? null : n);
  };
  const handleClear = (): void => {
    if (!category) return;
    void onSave(category, null);
  };
  const handleSaveShare = (): void => {
    if (!category) return;
    const n = Number(share);
    void onSaveShare(category, Number.isFinite(n) && n > 0 ? n : null);
  };
  const handleClearShare = (): void => {
    if (!category) return;
    void onSaveShare(category, null);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay" />
        <Dialog.Content className="rx-dialog rx-dialog-sm">
          <Dialog.Title>Split {category}</Dialog.Title>
          <Dialog.Description className="rx-dialog-desc">
            Set how many people share the bill — your share shows as the
            total ÷ N. Or pin the exact amount you pay; the exact amount
            takes precedence.
          </Dialog.Description>
          <form
            className="piggy-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (share.trim() !== '') handleSaveShare();
              else if (currentShare != null) handleClearShare();
              else handleSave();
            }}
          >
            <label htmlFor="rec-split-input" className="fld-lbl">
              People sharing
            </label>
            <input
              id="rec-split-input"
              type="number"
              min={1}
              max={50}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={share.trim() !== ''}
              autoFocus
            />
            <label htmlFor="rec-share-input" className="fld-lbl">
              …or my exact amount (₪)
            </label>
            <input
              id="rec-share-input"
              type="number"
              min={0}
              step={1}
              placeholder="e.g. 2250"
              value={share}
              onChange={(e) => setShare(e.target.value)}
              aria-label="My exact amount"
            />
            <div className="form-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn-ghost">Cancel</button>
              </Dialog.Close>
              {currentSplit > 1 && (
                <button type="button" className="btn-ghost" onClick={handleClear}>
                  Don't split
                </button>
              )}
              <button type="submit" className="btn-primary">Save</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
