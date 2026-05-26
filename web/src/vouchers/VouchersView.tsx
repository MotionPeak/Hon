import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import type { Voucher } from './types';

/** "BUYME ALL - מגוון אדיר במתנה אחת" → headline + subtitle. */
function splitTitle(name: string): { title: string; description: string } {
  const idx = name.indexOf(' - ');
  if (idx > 0 && idx < name.length - 3) {
    return { title: name.slice(0, idx).trim(), description: name.slice(idx + 3).trim() };
  }
  return { title: name, description: '' };
}

function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const target = new Date(date + 'T00:00:00');
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function PROVIDER_EMOJI(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('shufersal')) return '🛒';
  if (p.includes('buyme')) return '🎁';
  if (p.includes('cibus') || p.includes('pluxee')) return '🍽️';
  if (p.includes('hi-tech') || p.includes('htzone')) return '🎮';
  return '🎟️';
}

export function VouchersView() {
  const [vouchers, setVouchers] = useState<Voucher[] | null>(null);

  useEffect(() => {
    api<{ vouchers: Voucher[] }>('/vouchers')
      .then((d) => setVouchers(d.vouchers))
      .catch(() => setVouchers([]));
  }, []);

  if (vouchers === null) return <p>Loading…</p>;

  if (vouchers.length === 0) {
    return (
      <div className="vouchers-view">
        <h1>Vouchers &amp; gift cards</h1>
        <p className="blank">
          🎟️ No vouchers yet. Sync directly from a provider — Shufersal Tav HaZahav,
          BuyMe and more — or add one by hand.
        </p>
      </div>
    );
  }

  // Per-currency totals, excluding excluded vouchers.
  const totals: Record<string, number> = {};
  for (const v of vouchers) {
    if (v.excluded) continue;
    totals[v.currency] = (totals[v.currency] ?? 0) + (Number(v.balance) || 0);
  }
  const totalKeys = Object.keys(totals).sort();

  return (
    <div className="vouchers-view">
      <h1>Vouchers &amp; gift cards</h1>
      <p className="set-intro">
        Track current balances of gift cards and promo credits — they count
        toward your net worth and Hon reminds you when one is about to expire.
      </p>
      {totalKeys.length > 0 && (
        <div data-testid="voucher-totals" className="voucher-totals">
          <span className="emoji">🎟️</span>
          <span>Total balance:</span>
          {totalKeys.map((cur, i) => (
            <span key={cur} className="voucher-total-pill">
              {i > 0 && <span className="sep"> · </span>}
              <b>{money(totals[cur], cur)}</b>
            </span>
          ))}
        </div>
      )}
      <div className="voucher-grid">
        {vouchers.map((v) => <VoucherCard key={v.id} voucher={v} />)}
      </div>
    </div>
  );
}

function VoucherCard({ voucher }: { voucher: Voucher }) {
  const split = splitTitle(voucher.name);
  const days = daysUntil(voucher.expiresOn);
  let expiry: React.ReactNode = null;
  if (days != null && voucher.expiresOn) {
    if (days < 0) {
      expiry = (
        <div className="voucher-badge expired">
          ⌛ Expired {Math.abs(days)} day{Math.abs(days) === 1 ? '' : 's'} ago
        </div>
      );
    } else if (days <= 30) {
      expiry = (
        <div className="voucher-badge soon">
          ⌛ Expires in {days} day{days === 1 ? '' : 's'} ({voucher.expiresOn})
        </div>
      );
    } else {
      expiry = (
        <div className="voucher-badge later">
          📅 Expires {voucher.expiresOn}
        </div>
      );
    }
  }
  return (
    <article className={`voucher-card${voucher.excluded ? ' vc-excluded' : ''}`}>
      <header className="voucher-head">
        <span className="voucher-emoji">{PROVIDER_EMOJI(voucher.provider)}</span>
        <div className="voucher-title-wrap">
          <div className="voucher-title">
            {split.title}
            {voucher.excluded && <span className="voucher-tag"> excluded</span>}
          </div>
          <div className="voucher-sub">
            {voucher.provider}
            {split.description && (
              <>
                <span className="sep"> · </span>
                <span className="voucher-desc">{split.description}</span>
              </>
            )}
          </div>
        </div>
      </header>
      <div className="voucher-balance">{money(voucher.balance, voucher.currency)}</div>
      <div className="voucher-meta">
        current balance{voucher.excluded ? ' · not counted' : ''}
      </div>
      {voucher.notes && <div className="voucher-notes">{voucher.notes}</div>}
      {expiry}
    </article>
  );
}
