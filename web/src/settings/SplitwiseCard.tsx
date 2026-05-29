import { useState } from 'react';
import { useSplitwise } from '../splitwise/useSplitwise';

// Connect Splitwise with a personal API key, or disconnect. The key is sent to
// the engine and stored encrypted in the vault — it never leaves the machine.
export function SplitwiseCard() {
  const sw = useSplitwise();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async (): Promise<void> => {
    if (!apiKey.trim()) { setError('Paste your Splitwise API key first.'); return; }
    setBusy(true); setError(null);
    try { await sw.connect(apiKey.trim()); setApiKey(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const onDisconnect = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await sw.disconnect(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="set-card set-card--wide">
      <div className="set-card-head">
        <span className="set-ico">🤝</span>
        <h3>Splitwise</h3>
      </div>
      {sw.connected ? (
        <div className="set-row">
          <div className="set-row-main">
            <div className="set-row-name">
              Connected{sw.user ? ` as ${sw.user.name}` : ''}
            </div>
            <div className="set-row-sub">
              Hon can split transactions onto Splitwise and track who has paid you back.
            </div>
          </div>
          <button
            type="button" className="btn-danger-sm" disabled={busy}
            onClick={() => void onDisconnect()}
          >Disconnect</button>
        </div>
      ) : (
        <>
          <p className="set-hint">
            Split transactions onto Splitwise and track repayments. Get a free
            personal API key from{' '}
            <a
              href="https://secure.splitwise.com/apps" target="_blank" rel="noreferrer"
            >your Splitwise apps page</a>.
          </p>
          <div className="field">
            <label htmlFor="sw-api-key">API key</label>
            <input
              id="sw-api-key" type="password" value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="paste your Splitwise API key"
              disabled={busy}
            />
          </div>
          <div className="form-actions">
            <button
              type="button" className="btn-primary" disabled={busy}
              onClick={() => void onConnect()}
            >Connect</button>
          </div>
        </>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
    </section>
  );
}
