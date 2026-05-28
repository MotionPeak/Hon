import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { Company } from './types';

interface InteractiveSignInModalProps {
  /** The pension fund being synced. Used for the modal header. */
  company: Company;
  /** Hides the modal locally without cancelling the engine-side scrape.
   *  The scrape continues until it terminates (success / error /
   *  engine interactive-timeout) on the next poll tick. */
  onClose: () => void;
  /** Optional per-provider hint slot — e.g. Meitav-specific captcha tips.
   *  Customization seam; not currently used by any caller. */
  hints?: ReactNode;
}

/**
 * Shown while a sync is running against an interactive pension fund
 * (Meitav/Menora). The engine pops a visible OS Chromium window the user
 * signs into directly; this modal explains what's happening and gives
 * the user a way to dismiss it without cancelling the scrape.
 *
 * Mount/unmount is fully owned by the parent (AccountsView). The modal
 * does not manage any sync state of its own.
 */
export function InteractiveSignInModal(
  { company, onClose, hints }: InteractiveSignInModalProps,
) {
  return createPortal(
    <div className="overlay">
      <div
        role="dialog"
        aria-label={`Sign in to ${company.name}`}
        className="modal"
      >
        <h2>Signing in to {company.name}</h2>
        <p>
          A browser window has opened — sign in there. Hon will grab your
          balances once you're in.
        </p>
        {hints}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
