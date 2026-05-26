import { useEffect, useState } from 'react';
import { api, ApiError, hasToken } from './api';

// Bare-bones starting point. This component is intentionally minimal:
// it proves the React → Vite proxy → engine pipeline works end-to-end.
// The next session's first migration task is to flesh this out with
// the Overview tab from app.html. See ../HANDOFF.md for the migration
// order.

interface Health {
  ok: boolean;
  name: string;
  version: string;
  uptimeMs: number;
  db: string;
  pid: number;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'no-token' }
  | { kind: 'connected'; health: Health }
  | { kind: 'error'; message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    if (!hasToken()) {
      setStatus({ kind: 'no-token' });
      return;
    }
    api<Health>('/health')
      .then((health) => setStatus({ kind: 'connected', health }))
      .catch((err) => setStatus({
        kind: 'error',
        message: err instanceof ApiError
          ? `${err.message} (HTTP ${err.status})`
          : String(err),
      }));
  }, []);

  return (
    <main style={{
      fontFamily: 'system-ui, sans-serif',
      maxWidth: 600,
      margin: '2rem auto',
      padding: '0 1rem',
      color: '#e6e6e6',
    }}>
      <h1>Hon — React scaffold</h1>
      <p style={{ opacity: 0.7 }}>
        This is the starting point of Hon's React UI. The migration plan
        is in <code>../HANDOFF.md</code>. The old vanilla app is still
        live at <code>sidecar/public/app.html</code> — both will run in
        parallel until each tab has been migrated.
      </p>
      <hr style={{ borderColor: '#333', margin: '1.5rem 0' }} />
      <h2>Engine connectivity</h2>
      {status.kind === 'loading' && <p>Checking /health…</p>}
      {status.kind === 'no-token' && (
        <div>
          <p>
            <strong>No access token.</strong> Start the engine
            (<code>cd ../sidecar &amp;&amp; npm run web</code>), copy
            the <code>#token=…</code> from its URL, and append it to
            this page's URL.
          </p>
          <p style={{ opacity: 0.7, fontSize: 14 }}>
            Example: <code>http://localhost:5173/#token=&lt;uuid&gt;</code>
          </p>
        </div>
      )}
      {status.kind === 'connected' && (
        <div>
          <p style={{ color: '#7CE5A0' }}>
            ✓ Connected to {status.health.name} {status.health.version}
          </p>
          <pre style={{
            background: '#1a1a1a', padding: '0.75rem',
            borderRadius: 6, fontSize: 13, overflow: 'auto',
          }}>{JSON.stringify(status.health, null, 2)}</pre>
        </div>
      )}
      {status.kind === 'error' && (
        <div>
          <p style={{ color: '#ff7a7a' }}>
            ✗ {status.message}
          </p>
          <p style={{ opacity: 0.7, fontSize: 14 }}>
            If this is 401: the token in your URL is wrong. Restart the
            engine and use its current URL. If it's a network error:
            the engine isn't running.
          </p>
        </div>
      )}
    </main>
  );
}
