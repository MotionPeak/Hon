import { useState } from 'react';
import { useVault } from './useVault';

/**
 * Slim app-level notice shown when a vault exists but is locked, so the user
 * discovers they need to unlock it to sync. The actual unlock form lives in the
 * Settings Vault card; the "Unlock" button here jumps there. Dismissible for
 * the session. Renders nothing once the vault is unlocked (or no vault exists).
 */
export function VaultBanner({ onUnlockClick }: { onUnlockClick: () => void }) {
  const { loaded, exists, unlocked } = useVault();
  const [dismissed, setDismissed] = useState(false);

  if (!loaded || !exists || unlocked || dismissed) return null;

  return (
    <div className="vault-banner" role="status" data-testid="vault-banner">
      <span className="vault-banner-ico" aria-hidden="true">🔒</span>
      <span className="vault-banner-text">
        Vault locked — unlock to sync your accounts.
      </span>
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
