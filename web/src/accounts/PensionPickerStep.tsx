import type { Company } from './types';

interface PensionPickerStepProps {
  /** All companies known to the engine. The component filters internally to
   *  type==='pension' so callers don't have to. */
  companies: Company[];
  /** Picked a scraped fund → caller closes the picker and opens the existing
   *  AddConnectionForm with this company (same as the bank/card flow). */
  onPickCompany: (company: Company) => void;
  /** Picked "Custom pension account" → caller closes the picker and opens
   *  AddManualAssetForm with initialKind='pension'. */
  onPickCustom: () => void;
  /** Back to the category picker. */
  onBack: () => void;
}

/**
 * Dedicated pension picker. Lists scraped providers with an auto vs
 * browser-window tag, and a trailing "Custom pension account" row for
 * providers Hon can't scrape (e.g. Altshuler, or any future fund the
 * engine hasn't been taught to read).
 *
 * The row markup is delegated to `PensionProviderRow` so future
 * per-provider variants (e.g. a Migdal row that previews retirement
 * projection) can be swapped in without rewriting the picker itself.
 */
export function PensionPickerStep(
  { companies, onPickCompany, onPickCustom, onBack }: PensionPickerStepProps,
) {
  const pensionCompanies = companies.filter((c) => c.type === 'pension');
  return (
    <>
      <h2>Pension &amp; savings</h2>
      <button
        type="button"
        className="back-btn"
        onClick={onBack}
      >‹ All categories</button>
      <p className="hint">
        Connect a provider once — Hon pulls every retirement product you
        hold there together: pension (<bdi>פנסיה</bdi>), gemel / provident
        fund (<bdi>קופת גמל</bdi>) and study fund / keren hishtalmut
        (<bdi>קרן השתלמות</bdi>). Or add a custom account and enter the
        balance yourself.
      </p>
      <ul className="add-picker">
        {pensionCompanies.length === 0 && (
          <li className="hint">No scraped providers available.</li>
        )}
        {pensionCompanies.map((c) => (
          <PensionProviderRow
            key={c.id}
            company={c}
            onPick={() => onPickCompany(c)}
          />
        ))}
        <li>
          <button
            type="button"
            className="add-picker-item add-picker-item--custom"
            onClick={onPickCustom}
          >
            <span className="add-picker-emoji" aria-hidden="true">✍️</span>
            <span className="add-picker-name">Custom pension account</span>
            <span className="add-picker-sub">
              Type the provider and balance yourself — for any fund Hon
              can't sync
            </span>
          </button>
        </li>
      </ul>
    </>
  );
}

interface PensionProviderRowProps {
  company: Company;
  onPick: () => void;
}

/**
 * One row in the pension picker. Exported so future variants can swap it
 * in per provider (e.g. richer Migdal preview) without forking
 * `PensionPickerStep` itself.
 */
export function PensionProviderRow(
  { company, onPick }: PensionProviderRowProps,
) {
  const interactive = Boolean(company.interactive);
  return (
    <li>
      <button
        type="button"
        className="add-picker-item"
        onClick={onPick}
      >
        <span className="add-picker-name">{company.name}</span>
        <span className="add-picker-sub">
          {interactive
            ? 'A browser window opens on each sync to clear a security check'
            : 'Synced automatically in the background'}
        </span>
        <span
          className={
            interactive
              ? 'pension-tag pension-tag--manual'
              : 'pension-tag pension-tag--auto'
          }
        >
          {interactive ? 'Browser window' : 'Automatic'}
        </span>
      </button>
    </li>
  );
}
