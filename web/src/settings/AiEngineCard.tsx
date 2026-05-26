import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';

type LlmMode = 'local' | 'ollama' | 'api';
type LlmState =
  | 'not-downloaded' | 'downloading' | 'downloaded' | 'loading' | 'ready' | 'error';

interface ModelCatalogEntry {
  id: string;
  name: string;
  description: string;
  uri: string;
  approxSizeBytes: number;
  recommended: boolean;
}

interface RemoteConfig { baseUrl: string; model: string; hasKey: boolean }

interface LlmStatus {
  state: LlmState;
  modelId: string | null;
  modelName: string | null;
  message: string;
  downloadedBytes: number;
  totalBytes: number;
  catalog: ModelCatalogEntry[];
  modelsDir: string;
  mode: LlmMode;
  ready: boolean;
  ollama: RemoteConfig;
  api: RemoteConfig;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function AiEngineCard() {
  const [status, setStatus] = useState<LlmStatus | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await api<LlmStatus>('/llm');
      setStatus(s);
    } catch { /* keep prior state */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while a download is in flight so the progress bar advances.
  useEffect(() => {
    if (status?.state !== 'downloading') return;
    const h = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(h);
  }, [status?.state, refresh]);

  if (!status) {
    return (
      <section className="set-card">
        <div className="set-card-head">
          <span className="set-ico">🧠</span>
          <h3>AI engine</h3>
        </div>
        <p className="set-hint">Loading…</p>
      </section>
    );
  }

  const setMode = (mode: LlmMode): void => {
    setStatus({ ...status, mode });
  };

  return (
    <section className="set-card">
      <div className="set-card-head">
        <span className="set-ico">🧠</span>
        <h3>AI engine</h3>
        {status.ready && <span className="ai-ready-pill">Ready</span>}
      </div>
      <p className="set-hint">
        Hon's categorization, AI rollup and chat all run through this
        engine. Pick where inference happens — fully local, an Ollama
        server, or any OpenAI-compatible API.
      </p>

      <div className="seg ai-mode-seg" role="group" aria-label="Provider">
        <button
          type="button"
          className={status.mode === 'local' ? 'on' : ''}
          onClick={() => setMode('local')}
        >On-device</button>
        <button
          type="button"
          className={status.mode === 'ollama' ? 'on' : ''}
          onClick={() => setMode('ollama')}
        >Ollama</button>
        <button
          type="button"
          className={status.mode === 'api' ? 'on' : ''}
          onClick={() => setMode('api')}
        >API</button>
      </div>

      {status.mode === 'local' && (
        <LocalModelList status={status} onChange={refresh} />
      )}
      {status.mode === 'ollama' && (
        <OllamaPanel status={status} onChange={refresh} />
      )}
      {status.mode === 'api' && (
        <ApiPanel status={status} onChange={refresh} />
      )}
    </section>
  );
}

function LocalModelList({
  status, onChange,
}: {
  status: LlmStatus;
  onChange: () => void | Promise<void>;
}) {
  const downloading = status.state === 'downloading';
  const pct = downloading && status.totalBytes > 0
    ? Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100))
    : 0;

  const start = async (modelId: string): Promise<void> => {
    try {
      await api('/llm/download', 'POST', { modelId });
      await onChange();
    } catch (e) {
      // Errors are surfaced via status.message after the next poll;
      // swallow the throw so the button doesn't break the card.
      void e;
    }
  };
  const cancel = async (): Promise<void> => {
    try { await api('/llm/cancel', 'POST'); } catch { /* best effort */ }
    await onChange();
  };

  return (
    <div className="ai-model-list">
      {status.catalog.map((m) => {
        const isCurrent = status.modelId === m.id;
        const isReady = isCurrent && status.state === 'ready';
        const isDownloading = isCurrent && downloading;
        return (
          <div
            key={m.id}
            className={`ai-model${isReady ? ' ready' : ''}${m.recommended ? ' recommended' : ''}`}
          >
            <div className="ai-model-head">
              <span className="ai-model-name">{m.name}</span>
              {m.recommended && !isReady && (
                <span className="ai-model-tag">Recommended</span>
              )}
              {isReady && <span className="ai-model-tag ready">Loaded</span>}
            </div>
            <p className="ai-model-desc">{m.description}</p>
            <div className="ai-model-meta">~{fmtBytes(m.approxSizeBytes)}</div>
            {isDownloading ? (
              <>
                <div className="ai-progress">
                  <span
                    className="ai-progress-fill"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="ai-progress-meta">
                  {pct}% · {fmtBytes(status.downloadedBytes)} of {fmtBytes(status.totalBytes)}
                </div>
                <div className="form-actions">
                  <button type="button" className="btn-ghost" onClick={cancel}>
                    Cancel
                  </button>
                </div>
              </>
            ) : isReady ? (
              // The active model is already loaded — no download to offer.
              // The green "Loaded" tag + ready border already communicate
              // its state; an extra "✓ In use" footer would be noise.
              null
            ) : (
              <div className="form-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={downloading}
                  onClick={() => void start(m.id)}
                >Download</button>
              </div>
            )}
          </div>
        );
      })}
      {status.message && status.state === 'error' && (
        <p className="form-error">{status.message}</p>
      )}
    </div>
  );
}

interface RemotePanelProps {
  status: LlmStatus;
  onChange: () => void | Promise<void>;
}

function OllamaPanel({ status, onChange }: RemotePanelProps) {
  return (
    <RemoteFormPanel
      status={status}
      onChange={onChange}
      providerKey="ollama"
      mode="ollama"
      testPath="/llm/ollama/test"
      keyRequired={false}
      defaults={{
        baseUrlPlaceholder: 'http://localhost:11434',
        modelPlaceholder: 'qwen2.5:3b',
      }}
    />
  );
}

function ApiPanel({ status, onChange }: RemotePanelProps) {
  return (
    <RemoteFormPanel
      status={status}
      onChange={onChange}
      providerKey="api"
      mode="api"
      testPath="/llm/api/test"
      keyRequired
      defaults={{
        baseUrlPlaceholder: 'https://api.groq.com/openai/v1',
        modelPlaceholder: 'llama-3.3-70b-versatile',
      }}
    />
  );
}

function RemoteFormPanel({
  status, onChange, providerKey, mode, testPath, keyRequired, defaults,
}: {
  status: LlmStatus;
  onChange: () => void | Promise<void>;
  providerKey: 'ollama' | 'api';
  mode: LlmMode;
  testPath: string;
  keyRequired: boolean;
  defaults: { baseUrlPlaceholder: string; modelPlaceholder: string };
}) {
  const cfg = status[providerKey];
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(cfg.model);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the inputs in sync if the engine reports updated config.
  useEffect(() => {
    setBaseUrl(cfg.baseUrl);
    setModel(cfg.model);
  }, [cfg.baseUrl, cfg.model]);

  const bodyUrlKey = providerKey === 'ollama' ? 'ollamaUrl' : 'apiUrl';
  const bodyKeyKey = providerKey === 'ollama' ? 'ollamaKey' : 'apiKey';
  const bodyModelKey = providerKey === 'ollama' ? 'ollamaModel' : 'apiModel';

  const test = async (): Promise<void> => {
    setError(null);
    setTestResult(null);
    setBusy(true);
    try {
      const r = await api<{ ok?: boolean; model?: string; error?: string }>(
        testPath, 'POST', { [bodyUrlKey]: baseUrl, [bodyKeyKey]: apiKey },
      );
      if (r.ok === false || r.error) {
        setError(r.error ?? 'Test failed.');
      } else {
        setTestResult(r.model
          ? `OK — reached the server, model "${r.model}" is reachable.`
          : 'OK — server responded.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setError(null);
    if (!baseUrl.trim()) { setError('Server URL is required.'); return; }
    if (!model.trim()) { setError('Model name is required.'); return; }
    if (keyRequired && !apiKey && !cfg.hasKey) {
      setError('API key is required.'); return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        mode,
        [bodyUrlKey]: baseUrl.trim(),
        [bodyModelKey]: model.trim(),
      };
      // Omit the key when blank so a saved key isn't wiped on every save.
      if (apiKey) body[bodyKeyKey] = apiKey;
      await api(`/llm/provider`, 'POST', body);
      await onChange();
      setApiKey('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-remote">
      <label htmlFor={`ai-${providerKey}-url`} className="fld-lbl">
        Server URL
      </label>
      <input
        id={`ai-${providerKey}-url`}
        type="url"
        placeholder={defaults.baseUrlPlaceholder}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <label htmlFor={`ai-${providerKey}-key`} className="fld-lbl">
        API key
        {cfg.hasKey && !apiKey && (
          <span className="ai-key-hint"> · saved (leave blank to keep)</span>
        )}
      </label>
      <input
        id={`ai-${providerKey}-key`}
        type="password"
        autoComplete="off"
        placeholder={cfg.hasKey ? '••••••••' : ''}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <label htmlFor={`ai-${providerKey}-model`} className="fld-lbl">
        Model
      </label>
      <input
        id={`ai-${providerKey}-model`}
        type="text"
        placeholder={defaults.modelPlaceholder}
        value={model}
        onChange={(e) => setModel(e.target.value)}
      />
      {error && <p className="form-error">{error}</p>}
      {testResult && <p className="form-ok">{testResult}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="btn-ghost"
          disabled={busy || !baseUrl}
          onClick={() => void test()}
        >Test</button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => void save()}
        >Save</button>
      </div>
    </div>
  );
}
