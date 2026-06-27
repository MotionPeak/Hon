import type { ReactNode } from 'react';
import { displayName } from './displayName';

interface TxnNameLike {
  description: string;
  customTitle?: string | null;
  notes?: string | null;
}

/** Renders a transaction's display name. When a custom title is set, the title
 *  shows prominently with the real scraped `description` on a smaller line
 *  beneath. A 🗒️ icon appears when the transaction has a note. `children`
 *  (e.g. a LoanChip) render inline next to the name, as before. */
export function TxnName({ t, children }: { t: TxnNameLike; children?: ReactNode }) {
  const titled = !!t.customTitle?.trim();
  const hasNote = !!t.notes?.trim();
  return (
    <>
      <div className="txn-name">
        {displayName(t)}
        {children}
        {hasNote && (
          <span className="txn-note-ico" role="img" aria-label="Has a note" title="Has a note">🗒️</span>
        )}
      </div>
      {titled && <div className="txn-realname" data-testid="txn-realname">{t.description}</div>}
    </>
  );
}
