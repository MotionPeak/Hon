import { useState } from 'react';
import { ApiError } from '../api';
import { useVault } from '../vault/useVault';

/**
 * Settings card for the credential vault. When locked it shows a passphrase
 * field that unlocks the saved bank/Splitwise/SnapTrade logins (so syncs can
 * run); when unlocked it offers a Lock button. Raw passwords are never shown —
 * unlocking only makes the stored credentials usable, keeping the
 * zero-knowledge model.
 */
export function VaultCard() {
  const { loaded, exists, unlocked, unlock, lock } = useVault();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loaded) return null;

  if (!exists) {
    return (
      <section className="set-card vault-card" data-testid="vault-card">
        <div className="set-card-head"><h3>🔒 Vault</h3></div>
        <p className="set-card-sub">
          No saved credentials yet. Your bank logins get encrypted into a vault
          the first time you add a connection that needs a password.
        </p>
      </section>
    );
  }

  async function doLock() {
    setBusy(true);
    setError(null);
    try { await lock(); }
    catch { setError('Could not lock — is the engine running?'); }
    finally { setBusy(false); }
  }

  async function doUnlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(pass);
      setPass('');
    } catch (err) {
      setError(err instanceof ApiError
        ? 'Wrong passphrase — try again.'
        : 'Could not unlock — is the engine running?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="set-card vault-card" data-testid="vault-card">
      <div className="set-card-head">
        <h3>🔒 Vault</h3>
        <span className={`vault-status ${unlocked ? 'on' : 'off'}`}>
          {unlocked ? 'Unlocked' : 'Locked'}
        </span>
      </div>

      {unlocked ? (
        <>
          <p className="set-card-sub">
            Saved logins are available — syncs can run. Lock to require the
            passphrase again this session.
          </p>
          <button type="button" className="mini" onClick={doLock} disabled={busy}>
            {busy ? 'Locking…' : 'Lock vault'}
          </button>
        </>
      ) : (
        <form onSubmit={doUnlock}>
          <p className="set-card-sub">
            Enter your passphrase to unlock your saved logins for syncing. The
            passwords themselves are never shown.
          </p>
          <input
            type="password"
            className="vault-input"
            placeholder="Vault passphrase"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            disabled={busy}
            autoComplete="current-password"
            aria-label="Vault passphrase"
          />
          {error && <div className="modal-err">{error}</div>}
          <button type="submit" className="primary" disabled={busy || !pass}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      )}
    </section>
  );
}
