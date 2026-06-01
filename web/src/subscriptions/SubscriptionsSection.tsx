import { money } from '../format';
import {
  merchantKey, merchantName, monthlyEquivalent,
  RECURRENCE_ACTIVE_DAYS, type Frequency,
} from '../recurring/helpers';
import type { Transaction } from '../activity/types';

type FreqOrIgnore = Frequency | 'ignore';

interface SubRow {
  key: string;
  desc: string;
  last: Transaction;
  daysSinceLast: number;
  count: number;
  charge: number;
  freq: Frequency;
  currency: string;
  monthly: number;
  active: boolean;
}

interface SubInput {
  transactions: Transaction[];
  frequencies: Record<string, FreqOrIgnore>;
}

function detect(data: SubInput): SubRow[] {
  const subs = data.transactions.filter(
    (t) => t.category === 'Subscriptions' && t.amount < 0,
  );
  const byKey = new Map<string, Transaction[]>();
  for (const t of subs) {
    const k = merchantKey(t.description);
    const list = byKey.get(k) ?? [];
    list.push(t);
    byKey.set(k, list);
  }
  const now = Date.now();
  const rows: SubRow[] = [];
  for (const [key, list] of byKey) {
    const userFreq = data.frequencies[key];
    if (userFreq === 'ignore') continue;
    const sorted = list.slice().sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    const last = sorted[0];
    if (!last) continue;
    const lastTs = new Date(last.date).getTime();
    const daysSinceLast = Math.floor((now - lastTs) / 86400000);
    const freq: Frequency =
      userFreq === 'monthly' || userFreq === 'bimonthly' || userFreq === 'yearly'
        ? userFreq
        : 'monthly';
    const charge = Math.abs(last.amount);
    const activeWindow = RECURRENCE_ACTIVE_DAYS[freq];
    rows.push({
      key,
      desc: merchantName(last.description),
      last,
      daysSinceLast,
      count: list.length,
      charge,
      freq,
      currency: last.currency,
      monthly: monthlyEquivalent(charge, freq),
      active: daysSinceLast <= activeWindow,
    });
  }
  return rows;
}

interface Buckets {
  flagged: SubRow[];
  active: SubRow[];
  userCancelled: SubRow[];
  autoLapsed: SubRow[];
}

function bucket(rows: SubRow[], cancelled: Record<string, string>): Buckets {
  const flagged: SubRow[] = [];
  const active: SubRow[] = [];
  const userCancelled: SubRow[] = [];
  const autoLapsed: SubRow[] = [];
  for (const r of rows) {
    const cancelledAt = cancelled[r.key];
    if (cancelledAt) {
      const lastTs = new Date(r.last.date).getTime();
      const cancelledTs = new Date(cancelledAt).getTime();
      if (lastTs > cancelledTs) flagged.push(r);
      else userCancelled.push(r);
      continue;
    }
    if (r.active) active.push(r);
    else autoLapsed.push(r);
  }
  active.sort((a, b) => b.monthly - a.monthly);
  userCancelled.sort((a, b) => a.daysSinceLast - b.daysSinceLast);
  autoLapsed.sort((a, b) => a.daysSinceLast - b.daysSinceLast);
  flagged.sort((a, b) =>
    new Date(b.last.date).getTime() - new Date(a.last.date).getTime(),
  );
  return { flagged, active, userCancelled, autoLapsed };
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

interface SubscriptionsSectionProps {
  transactions: Transaction[];
  frequencies: Record<string, FreqOrIgnore>;
  /** merchantKey → ISO cancellation timestamp. */
  cancelled: Record<string, string>;
}

/**
 * The Subscriptions area of the Fixed bills page. Detects 'Subscriptions'-
 * category charges and groups them into active / cancelled / flagged / lapsed
 * buckets. Presentational — fed by RecurringView's existing data fetch.
 */
export function SubscriptionsSection({ transactions, frequencies, cancelled }: SubscriptionsSectionProps) {
  const rows = detect({ transactions, frequencies });

  if (rows.length === 0) {
    return (
      <section className="subs-section">
        <h2 className="subs-section-title">🔁 Subscriptions</h2>
        <p className="blank">
          🔁 No subscription charges found yet — categorize transactions as
          Subscriptions in Activity to track them here.
        </p>
      </section>
    );
  }

  const { flagged, active, userCancelled, autoLapsed } = bucket(rows, cancelled);
  // Only sum the displayed currency — never add a $ subscription into a ₪ total
  // under one symbol. (Per-currency breakdown is future work; the common case
  // is a single currency.)
  const currency = active[0]?.currency ?? rows[0]?.currency ?? 'ILS';
  const monthly = active.reduce((s, r) => (r.currency === currency ? s + r.monthly : s), 0);

  return (
    <section className="subs-section">
      <h2 className="subs-section-title">🔁 Subscriptions</h2>
      <div data-testid="sub-summary" className="sub-summary">
        <div className="sub-big">
          {money(monthly, currency)}<span className="sub-per"> / month</span>
        </div>
        <div className="sub-meta">
          {active.length} active subscription{active.length === 1 ? '' : 's'}
          {userCancelled.length > 0 && <> · {userCancelled.length} cancelled</>}
          {autoLapsed.length > 0 && <> · {autoLapsed.length} likely cancelled</>}
        </div>
      </div>

      {flagged.length > 0 && (
        <section className="sub-section sub-section-warn">
          <h3>⚠ Charged after you marked them cancelled</h3>
          <p className="sub-section-hint">
            A new charge arrived after you marked these cancelled — the
            cancellation may not have gone through. Reconfirm with the merchant.
          </p>
          {flagged.map((r) => <SubRowCard key={r.key} row={r} />)}
        </section>
      )}

      <section className="sub-section">
        <h3>Active</h3>
        {active.length === 0
          ? <p className="blank">No active subscriptions in the last month.</p>
          : active.map((r) => <SubRowCard key={r.key} row={r} />)}
      </section>

      {userCancelled.length > 0 && (
        <section className="sub-section">
          <h3>Cancelled</h3>
          <p className="sub-section-hint">
            You marked these cancelled — Hon flags any new charge.
          </p>
          {userCancelled.map((r) => <SubRowCard key={r.key} row={r} faded />)}
        </section>
      )}

      {autoLapsed.length > 0 && (
        <section className="sub-section">
          <h3>Probably cancelled</h3>
          <p className="sub-section-hint">
            No charge in over a month — likely cancelled.
          </p>
          {autoLapsed.map((r) => <SubRowCard key={r.key} row={r} faded />)}
        </section>
      )}
    </section>
  );
}

function SubRowCard({ row, faded }: { row: SubRow; faded?: boolean }) {
  const subNote = row.freq !== 'monthly'
    ? ` · billed ${row.freq} · ${money(row.charge, row.currency)}`
    : '';
  return (
    <div className={`sub-row${faded ? ' faded' : ''}`}>
      <span className="sub-row-icon">🔁</span>
      <div className="sub-row-main">
        <div className="sub-row-name">{row.desc}</div>
        <div className="sub-row-sub">
          Last charged {fmtDate(row.last.date)}
          {faded && <> · {row.daysSinceLast} days ago</>}
          {!faded && row.count > 1 && <> · {row.count} charges</>}
          {subNote}
        </div>
      </div>
      <div className="sub-amt">
        {money(row.monthly, row.currency)}
        <span className="sub-per">/mo</span>
      </div>
    </div>
  );
}
