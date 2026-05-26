import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { cycleKey, currentCycleKey } from '../cycle';
import { money } from '../format';
import { useSettings } from '../settings/useSettings';
import type { Category } from '../settings/CategoriesPanel';
import type { Transaction } from '../activity/types';
import {
  merchantKey, merchantName, monthlyEquivalent, type Frequency,
} from './helpers';

type FreqOrIgnore = Frequency | 'ignore';

interface MerchantRow {
  key: string;
  desc: string;
  category: string;
  count: number;
  freq: Frequency;
  cycles: Set<string>;
  lastTxnDate: string | null;
  lastChargeAbs: number;
  monthly: number;
  /** Split divisor — share among N people for the category. */
  split: number;
  /** This user's share of the monthly equivalent. */
  monthlyShare: number;
}

interface RecurringData {
  transactions: Transaction[];
  categories: Category[];
  frequencies: Record<string, FreqOrIgnore>;
  splits: Record<string, number>;
  cancelled: Record<string, boolean>;
}

function detectMerchants(
  data: RecurringData,
): { rows: MerchantRow[]; categoryGroups: Record<string, 'fixed' | 'essential' | 'variable' | 'income'> } {
  const catGroupByName: Record<string, Category['catGroup']> = {};
  for (const c of data.categories) catGroupByName[c.name] = c.catGroup;
  const merch = new Map<string, {
    key: string; desc: string; category: string; count: number;
    cycles: Set<string>; lastTxnDate: string | null; lastTs: number;
    lastChargeAbs: number;
  }>();
  for (const t of data.transactions) {
    if (t.currency !== 'ILS') continue;
    if (t.refundForId) continue;
    if (!t.category) continue;
    if (catGroupByName[t.category] !== 'fixed') continue;
    if (t.amount >= 0) continue;
    const key = merchantKey(t.description);
    let r = merch.get(key);
    if (!r) {
      r = {
        key,
        desc: merchantName(t.description),
        category: t.category,
        count: 0,
        cycles: new Set(),
        lastTxnDate: null,
        lastTs: 0,
        lastChargeAbs: 0,
      };
      merch.set(key, r);
    }
    r.cycles.add(cycleKey(t.date, 1));
    r.count += 1;
    const ts = new Date(t.date).getTime();
    if (ts >= r.lastTs) {
      r.lastTs = ts;
      r.lastTxnDate = t.date;
      r.lastChargeAbs = -t.amount;
      r.desc = merchantName(t.description);
      r.category = t.category;
    }
  }
  const rows: MerchantRow[] = [];
  for (const r of merch.values()) {
    const userFreq = data.frequencies[r.key];
    if (userFreq === 'ignore') continue;
    if (data.cancelled[r.key]) continue;
    if (!userFreq && r.cycles.size < 2) continue;
    const freq: Frequency =
      userFreq === 'monthly' || userFreq === 'bimonthly' || userFreq === 'yearly'
        ? userFreq
        : 'monthly';
    const split = data.splits[r.category] || 1;
    const fullMonthly = monthlyEquivalent(r.lastChargeAbs, freq);
    rows.push({
      key: r.key, desc: r.desc, category: r.category,
      count: r.count, freq,
      cycles: r.cycles, lastTxnDate: r.lastTxnDate,
      lastChargeAbs: r.lastChargeAbs,
      monthly: fullMonthly,
      split,
      monthlyShare: fullMonthly / split,
    });
  }
  return { rows, categoryGroups: catGroupByName };
}

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function cyclesBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

interface StatusBadge { cls: string; label: string; hint: string }
function statusFor(row: MerchantRow, monthStartDay: number): StatusBadge {
  const cur = currentCycleKey(monthStartDay);
  if (row.cycles.has(cur)) {
    return { cls: 'good', label: '✓ Billed', hint: 'Already billed this cycle.' };
  }
  const lastCycle = row.lastTxnDate ? cycleKey(row.lastTxnDate, monthStartDay) : null;
  const gap = lastCycle ? cyclesBetween(lastCycle, cur) : 999;
  if (row.freq === 'bimonthly' && gap === 1) {
    return { cls: 'muted', label: 'Off-cycle',
      hint: 'Bimonthly — billed last cycle, not expected this one.' };
  }
  if (row.freq === 'yearly' && gap >= 1 && gap < 12) {
    const left = 12 - gap;
    return { cls: 'muted', label: 'Off-cycle',
      hint: `Yearly — next charge in ${left} cycle${left === 1 ? '' : 's'}.` };
  }
  return { cls: 'warn', label: 'Not yet billed',
    hint: 'Expected this cycle but no charge has arrived yet.' };
}

export function RecurringView() {
  const [settings] = useSettings();
  const [data, setData] = useState<RecurringData | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ transactions: Transaction[] }>('/transactions'),
      api<{ categories: Category[] }>('/categories'),
      api<{ frequencies: Record<string, FreqOrIgnore> }>('/merchant-frequencies'),
      api<{ splits: Record<string, number> }>('/category-splits'),
      api<{ cancelled: Record<string, boolean> }>('/subscriptions/cancelled')
        .catch(() => ({ cancelled: {} as Record<string, boolean> })),
    ]).then(([t, c, f, s, sub]) => setData({
      transactions: t.transactions,
      categories: c.categories,
      frequencies: f.frequencies ?? {},
      splits: s.splits ?? {},
      cancelled: sub.cancelled ?? {},
    })).catch(() => setData({
      transactions: [], categories: [], frequencies: {}, splits: {}, cancelled: {},
    }));
  }, []);

  const detected = useMemo(() => data ? detectMerchants(data) : null, [data]);

  if (!data || !detected) return <p>Loading…</p>;

  const { rows } = detected;
  if (rows.length === 0) {
    return (
      <div className="recurring-view">
        <h1>Fixed bills</h1>
        <p className="blank">
          No recurring fixed bills detected yet. They appear here once a
          fixed-category charge (Housing · Utilities · Insurance · Subscriptions
          · Education · Fees) is seen in two or more billing cycles — or once
          you set a frequency on a charge by hand.
        </p>
      </div>
    );
  }

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
      <div data-testid="recurring-total" className="recurring-total">
        <span className="emoji">📆</span>
        <span>Expected monthly</span>
        <b>{money(grandMonthly, 'ILS')}</b>
      </div>
      <div className="recurring-sections">
        {catOrder.map((catName) => {
          const list = byCat.get(catName) ?? [];
          const cat = catByName.get(catName);
          const sectionTotal = list.reduce((s, r) => s + r.monthlyShare, 0);
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
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
