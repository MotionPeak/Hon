import type { Company } from './types';

/**
 * A company's favicon over an emoji fallback. The favicon is fetched from
 * the engine's `/api/logo/:id` proxy (only when the company has a domain);
 * if it fails to load, `onError` hides the <img> so the emoji shows through.
 *
 * Shared across the connection cards, the bank/card picker, and the pension
 * picker — kept in its own module so those files don't have to import from
 * each other (AccountsView already imports PensionPickerStep, which would
 * otherwise create a cycle).
 */
export function CompanyLogo({ company }: { company: Company }) {
  const emoji = company.type === 'card' ? '💳'
    : company.type === 'brokerage' ? '📈'
    : company.type === 'pension' ? '🪺'
    : '🏦';
  const tokenedSrc = company.domain
    ? `/api/logo/${encodeURIComponent(company.id)}`
    : null;
  return (
    <span className="logo">
      <span className="logo-emoji">{emoji}</span>
      {tokenedSrc && (
        <img
          src={tokenedSrc}
          alt=""
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      )}
    </span>
  );
}
