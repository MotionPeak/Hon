import { useState } from 'react';
import { useVault } from './useVault';

/**
 * Slim app-level notice shown when a vault exists but is locked, so the user
 * discovers they need to unlock it to sync. The actual unlock form lives in the
 * Settings Vault card; the "Unlock" button here jumps there. Dismissible for
 * the session. Renders nothing once the vault is unlocked (or no vault exists).
 *
 * When the status probe FAILED (`error`) we don't know if a vault exists, so we
 * still show the banner — but with a "Retry" affordance — rather than assuming
 * "no vault" and silently hiding the only unlock surface.
 */
export function VaultBanner({ onUnlockClick }: { onUnlockClick: () => void }) {
  const { loaded, exists, unlocked, error, refresh } = useVault();
  const [dismissed, setDismissed] = useState(false);

  if (!loaded || unlocked || dismissed) return null;
  // Known no-vault: nothing to prompt. The unknown/error case falls through.
  if (!exists && !error) return null;

  return (
    <div className="vault-banner" role="status" data-testid="vault-banner">
      <span className="vault-banner-ico" aria-hidden="true">🔒</span>
      <span className="vault-banner-text">
        {error
          ? "Couldn't check the vault — unlock or retry to sync your accounts."
          : 'Vault locked — unlock to sync your accounts.'}
      </span>
      {error && (
        <button
          type="button"
          className="vault-banner-btn"
          onClick={() => { void refresh(); }}
        >
          Retry
        </button>
      )}
      <button type="button" className="vault-banner-btn" onClick={onUnlockClick}>
        Unlock
      </button>
      <button
        type="button"
        className="vault-banner-x"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >×</button>
    </div>
  );
}
