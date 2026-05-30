import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModelDownloader,
  getLlama,
  LlamaChatSession,
  type Llama,
  type LlamaContext,
  type LlamaGrammar,
  type LlamaModel,
  type ModelDownloader,
} from 'node-llama-cpp';
import type { Vault } from './vault.js';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  description: string;
  uri: string;
  approxSizeBytes: number;
  recommended: boolean;
}

/** The local models Hon offers to download. GGUF, runs fully on-device. */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: 'qwen2.5-3b',
    name: 'Qwen2.5 3B Instruct',
    description: 'Balanced — solid Hebrew and English, runs on any modern machine.',
    uri: 'hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M',
    approxSizeBytes: 2_100_000_000,
    recommended: true,
  },
  {
    id: 'qwen2.5-7b',
    name: 'Qwen2.5 7B Instruct',
    description: 'Higher quality — best results, needs roughly 6 GB of free memory.',
    uri: 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M',
    approxSizeBytes: 4_700_000_000,
    recommended: false,
  },
  {
    id: 'dictalm2-7b',
    name: 'DictaLM 2.0 (Hebrew-focused)',
    // Mistral 7B continued-pre-trained on a large Hebrew corpus + instruct-
    // tuned by Dicta (Israeli NLP lab). Strongest Hebrew comprehension at
    // this size — pays off on Hebrew merchant strings and Hebrew chat,
    // slightly weaker than Qwen on English & code.
    description: 'Mistral 7B fine-tuned on Hebrew by Dicta — best Hebrew comprehension at this size; ~4 GB.',
    uri: 'hf:dicta-il/dictalm2.0-instruct-GGUF:Q4_K_M',
    approxSizeBytes: 4_100_000_000,
    recommended: false,
  },
];

export type LlmState =
  | 'not-downloaded'
  | 'downloading'
  | 'downloaded'
  | 'loading'
  | 'ready'
  | 'error';

/**
 * Where inference runs: a downloaded on-device model, a remote Ollama server,
 * or an OpenAI-compatible API service (Groq's free tier, OpenRouter, etc.).
 */
export type LlmMode = 'local' | 'ollama' | 'api';

export interface LlmStatus {
  state: LlmState;
  modelId: string | null;
  modelName: string | null;
  message: string;
  downloadedBytes: number;
  totalBytes: number;
}

interface PersistedModel {
  modelId: string;
  modelName: string;
  filePath: string;
}

/** Connection details for an Ollama server — a local install or Ollama Cloud. */
export interface OllamaConfig {
  baseUrl: string; // e.g. http://localhost:11434 or https://ollama.com
  apiKey: string; // optional — required for Ollama Cloud's free tier
  model: string; // e.g. qwen2.5:3b
}

/**
 * Connection details for an OpenAI-compatible chat API. Works with Groq's free
 * tier, OpenRouter, Google's Gemini OpenAI endpoint, a local LM Studio, etc.
 */
export interface ApiConfig {
  baseUrl: string; // e.g. https://api.groq.com/openai/v1
  apiKey: string; // the service's API key
  model: string; // e.g. llama-3.3-70b-versatile
}

// The non-secret half of the provider config, written PLAINTEXT to
// llm-provider.json. API keys are deliberately absent here — they live only in
// the encrypted vault (H-2). Old files may still carry an `apiKey` per provider;
// `restoreProvider` migrates and strips those once the vault is unlocked.
interface PersistedProvider {
  mode: LlmMode;
  ollama: Omit<OllamaConfig, 'apiKey'>;
  api: Omit<ApiConfig, 'apiKey'>;
}

// The shape of a legacy llm-provider.json that may still embed plaintext keys.
// Used only to read & migrate older files; never written.
interface LegacyPersistedProvider {
  mode?: LlmMode;
  ollama?: Partial<OllamaConfig>;
  api?: Partial<ApiConfig>;
}

// The single vault secret that holds both API keys, JSON-encoded.
const PROVIDER_KEYS_SECRET = 'llm-provider-keys';

interface ProviderKeys {
  ollamaKey: string;
  apiKey: string;
}

/**
 * A single, short-lived inference handle. Each `prompt` is independent — no
 * conversation carries over — so the same handle serves a whole batch of
 * classifications. `dispose` releases any native resources.
 */
export interface LlmSession {
  prompt(text: string, opts?: PromptOptions): Promise<string>;
  dispose(): void;
}

export interface PromptOptions {
  /** Constrain the output to this JSON schema (grammar locally, `format` on Ollama). */
  jsonSchema?: object;
  /** Soft cap on generated tokens. */
  maxTokens?: number;
}

type GrammarSchema = Parameters<Llama['createGrammarForJsonSchema']>[0];

/** Drops a trailing slash so `${url}/api/chat` never doubles up. */
function normalizeUrl(url: string): string {
  return (url ?? '').trim().replace(/\/+$/, '');
}

/** An inference handle backed by the on-device llama.cpp model. */
class LocalSession implements LlmSession {
  private readonly grammars = new Map<string, Promise<LlamaGrammar>>();

  constructor(
    private readonly llama: Llama,
    private readonly context: LlamaContext,
    private readonly session: LlamaChatSession,
  ) {}

  private grammarFor(schema: object): Promise<LlamaGrammar> {
    const key = JSON.stringify(schema);
    let g = this.grammars.get(key);
    if (!g) {
      g = this.llama.createGrammarForJsonSchema(schema as GrammarSchema);
      this.grammars.set(key, g);
    }
    return g;
  }

  async prompt(text: string, opts?: PromptOptions): Promise<string> {
    const grammar = opts?.jsonSchema ? await this.grammarFor(opts.jsonSchema) : undefined;
    const response = await this.session.prompt(text, {
      grammar,
      maxTokens: opts?.maxTokens,
    });
    // Each prompt stands alone — clear history so the next one starts clean.
    this.session.resetChatHistory();
    return response;
  }

  dispose(): void {
    this.context.dispose();
  }
}

/** An inference handle that calls a remote Ollama server over HTTP. */
class OllamaSession implements LlmSession {
  constructor(
    private readonly cfg: OllamaConfig,
    private readonly system: string,
  ) {}

  async prompt(text: string, opts?: PromptOptions): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: this.system },
        { role: 'user', content: text },
      ],
      stream: false,
    };
    if (opts?.jsonSchema) body.format = opts.jsonSchema;
    if (opts?.maxTokens) body.options = { num_predict: opts.maxTokens };

    const res = await fetch(`${this.cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama replied HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? '').trim();
  }

  dispose(): void {
    // Stateless HTTP — nothing to release.
  }
}

/** An inference handle that calls an OpenAI-compatible chat API over HTTP. */
class OpenAiSession implements LlmSession {
  constructor(
    private readonly cfg: ApiConfig,
    private readonly system: string,
  ) {}

  async prompt(text: string, opts?: PromptOptions): Promise<string> {
    // JSON-schema support varies across providers, so rather than the strict
    // `json_schema` response format Hon asks for plain JSON object mode (which
    // every OpenAI-compatible service supports) and states the shape in the
    // prompt. Callers validate the parsed result regardless.
    let userText = text;
    const body: Record<string, unknown> = { model: this.cfg.model, stream: false };
    if (opts?.jsonSchema) {
      body.response_format = { type: 'json_object' };
      userText += `\n\nReply with a JSON object matching this schema: ${JSON.stringify(opts.jsonSchema)}`;
    }
    body.messages = [
      { role: 'system', content: this.system },
      { role: 'user', content: userText },
    ];
    if (opts?.maxTokens) body.max_tokens = opts.maxTokens;

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `API replied HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }

  dispose(): void {
    // Stateless HTTP — nothing to release.
  }
}

/**
 * Manages how Hon runs AI: either an on-device GGUF model (downloaded with
 * progress, never leaving the machine) or a remote Ollama server — a local
 * install or Ollama Cloud's free tier — for machines that can't run a model
 * locally. The active choice and Ollama details persist across restarts.
 */
export class LlmManager {
  private readonly modelsDir: string;
  private readonly stateFile: string;
  private readonly providerFile: string;

  private status: LlmStatus = {
    state: 'not-downloaded',
    modelId: null,
    modelName: null,
    message: 'No AI model downloaded yet.',
    downloadedBytes: 0,
    totalBytes: 0,
  };

  private mode: LlmMode = 'local';
  private ollama: OllamaConfig = { baseUrl: '', apiKey: '', model: '' };
  private api: ApiConfig = { baseUrl: '', apiKey: '', model: '' };

  private abortController: AbortController | null = null;
  private llama: Llama | null = null;
  // In-flight load dedup (H-9): concurrent load() callers share this single
  // promise instead of each kicking off a fresh (expensive) model load.
  private loadingPromise: Promise<void> | null = null;
  private model: LlamaModel | null = null;
  private modelPath: string | null = null;

  // The vault is optional so tests (and any caller that doesn't need remote
  // providers) can construct an LlmManager without one. When absent, API keys
  // simply aren't persisted and aren't restored — local mode is unaffected.
  constructor(
    dataDir: string,
    private readonly vault?: Vault,
  ) {
    this.modelsDir = join(dataDir, 'models');
    this.stateFile = join(this.modelsDir, 'active-model.json');
    this.providerFile = join(dataDir, 'llm-provider.json');
    try {
      mkdirSync(this.modelsDir, { recursive: true });
      this.restoreProvider();
      this.restoreState();
    } catch {
      // start fresh if the models directory can't be prepared
    }
  }

  getStatus(): LlmStatus & {
    catalog: ModelCatalogEntry[];
    modelsDir: string;
    mode: LlmMode;
    ready: boolean;
    ollama: { baseUrl: string; model: string; hasKey: boolean };
    api: { baseUrl: string; model: string; hasKey: boolean };
  } {
    return {
      ...this.status,
      catalog: MODEL_CATALOG,
      modelsDir: this.modelsDir,
      mode: this.mode,
      ready: this.isReady(),
      // API keys are never echoed back — only whether one is stored.
      ollama: {
        baseUrl: this.ollama.baseUrl,
        model: this.ollama.model,
        hasKey: !!this.ollama.apiKey,
      },
      api: {
        baseUrl: this.api.baseUrl,
        model: this.api.model,
        hasKey: !!this.api.apiKey,
      },
    };
  }

  /** True when inference can run right now under the active provider. */
  isReady(): boolean {
    if (this.mode === 'ollama') {
      return !!(this.ollama.baseUrl && this.ollama.model);
    }
    if (this.mode === 'api') {
      return !!(this.api.baseUrl && this.api.model && this.api.apiKey);
    }
    return this.status.state === 'ready' && !!this.model;
  }

  /**
   * Opens an inference handle for the active provider. Throws when the provider
   * is not ready — callers should gate on `isReady()` first.
   */
  async openSession(opts: { system: string; contextSize?: number }): Promise<LlmSession> {
    if (this.mode === 'ollama') {
      if (!this.ollama.baseUrl || !this.ollama.model) {
        throw new Error('Ollama is not configured.');
      }
      return new OllamaSession(this.ollama, opts.system);
    }
    if (this.mode === 'api') {
      if (!this.api.baseUrl || !this.api.model || !this.api.apiKey) {
        throw new Error('The API service is not configured.');
      }
      return new OpenAiSession(this.api, opts.system);
    }
    if (!this.llama || !this.model) {
      throw new Error('No on-device AI model is loaded.');
    }
    const context = await this.model.createContext({ contextSize: opts.contextSize ?? 2048 });
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: opts.system,
    });
    return new LocalSession(this.llama, context, session);
  }

  /** Switches the active provider and persists the choice. */
  setProvider(next: {
    mode: LlmMode;
    ollama?: Partial<OllamaConfig>;
    api?: Partial<ApiConfig>;
  }): void {
    this.mode =
      next.mode === 'ollama' ? 'ollama' : next.mode === 'api' ? 'api' : 'local';
    if (next.ollama) {
      this.ollama = {
        baseUrl: normalizeUrl(next.ollama.baseUrl ?? this.ollama.baseUrl),
        // An absent key keeps the stored one — the UI omits it to avoid
        // round-tripping the secret through the browser.
        apiKey: next.ollama.apiKey ?? this.ollama.apiKey,
        model: (next.ollama.model ?? this.ollama.model).trim(),
      };
    }
    if (next.api) {
      this.api = {
        baseUrl: normalizeUrl(next.api.baseUrl ?? this.api.baseUrl),
        apiKey: next.api.apiKey ?? this.api.apiKey,
        model: (next.api.model ?? this.api.model).trim(),
      };
    }
    this.persistProvider();
  }

  /** Checks an Ollama server is reachable and lists the models it offers. */
  async testOllama(opts: { baseUrl: string; apiKey?: string }): Promise<{
    ok: boolean;
    models: string[];
    message: string;
  }> {
    const baseUrl = normalizeUrl(opts.baseUrl);
    if (!baseUrl) return { ok: false, models: [], message: 'Enter the Ollama server URL first.' };
    // An omitted key falls back to the stored one, so a test can run without
    // re-typing the secret.
    const apiKey = opts.apiKey ?? this.ollama.apiKey;
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl}/api/tags`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return { ok: false, models: [], message: `Server replied HTTP ${res.status}.` };
      }
      const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const models = (data.models ?? [])
        .map((m) => m.name ?? m.model ?? '')
        .filter(Boolean);
      return {
        ok: true,
        models,
        message: models.length
          ? `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.`
          : 'Connected to the server.',
      };
    } catch {
      return { ok: false, models: [], message: 'Could not reach the server — check the URL and key.' };
    }
  }

  /** Checks an OpenAI-compatible API is reachable and lists its models. */
  async testApi(opts: { baseUrl: string; apiKey?: string }): Promise<{
    ok: boolean;
    models: string[];
    message: string;
  }> {
    const baseUrl = normalizeUrl(opts.baseUrl);
    if (!baseUrl) return { ok: false, models: [], message: 'Enter the API base URL first.' };
    const apiKey = opts.apiKey ?? this.api.apiKey;
    if (!apiKey) return { ok: false, models: [], message: 'Enter the API key first.' };
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return { ok: false, models: [], message: `Server replied HTTP ${res.status}.` };
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
      return {
        ok: true,
        models,
        message: models.length
          ? `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.`
          : 'Connected to the server.',
      };
    } catch {
      return { ok: false, models: [], message: 'Could not reach the API — check the URL and key.' };
    }
  }

  /** The loaded on-device model, for direct inference. Null unless local + ready. */
  getModel(): LlamaModel | null {
    return this.model;
  }

  getLlama(): Llama | null {
    return this.llama;
  }

  /** Begins downloading a catalog model in the background. */
  startDownload(modelId: string): void {
    const entry = MODEL_CATALOG.find((m) => m.id === modelId);
    if (!entry) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    if (this.status.state === 'downloading' || this.status.state === 'loading') {
      return;
    }
    this.status = {
      state: 'downloading',
      modelId: entry.id,
      modelName: entry.name,
      message: 'Starting download…',
      downloadedBytes: 0,
      totalBytes: entry.approxSizeBytes,
    };
    void this.runDownload(entry);
  }

  cancelDownload(): void {
    this.abortController?.abort();
  }

  private async runDownload(entry: ModelCatalogEntry): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const downloader: ModelDownloader = await createModelDownloader({
        modelUri: entry.uri,
        dirPath: this.modelsDir,
        onProgress: ({ totalSize, downloadedSize }) => {
          this.status.totalBytes = totalSize;
          this.status.downloadedBytes = downloadedSize;
          this.status.message = 'Downloading the model…';
        },
      });
      const filePath = await downloader.download({ signal: controller.signal });

      this.modelPath = filePath;
      this.persistState({ modelId: entry.id, modelName: entry.name, filePath });
      this.status.state = 'downloaded';
      this.status.message = 'Download complete — loading…';
      await this.load();
    } catch (err) {
      if (controller.signal.aborted) {
        this.status = {
          state: 'not-downloaded',
          modelId: null,
          modelName: null,
          message: 'Download canceled.',
          downloadedBytes: 0,
          totalBytes: 0,
        };
      } else {
        this.status.state = 'error';
        this.status.message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.abortController = null;
    }
  }

  /** Loads the downloaded model into memory (idempotent). */
  async load(): Promise<void> {
    if (!this.modelPath || !existsSync(this.modelPath)) {
      throw new Error('No downloaded model to load.');
    }
    if (this.status.state === 'ready' && this.model) {
      return;
    }
    // Concurrent callers share the in-flight load rather than each starting
    // their own. Cleared in `finally` so a failed load can be retried.
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this._load().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  }

  private async _load(): Promise<void> {
    this.status.state = 'loading';
    this.status.message = 'Loading the model into memory…';
    try {
      this.llama ??= await getLlama();
      // Non-null: public load() already threw if modelPath was null/missing.
      this.model = await this.llama.loadModel({ modelPath: this.modelPath! });
      this.status.state = 'ready';
      this.status.message = `${this.status.modelName ?? 'Model'} ready.`;
    } catch (err) {
      this.status.state = 'error';
      this.status.message = err instanceof Error ? err.message : String(err);
    }
  }

  private persistState(model: PersistedModel): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(model, null, 2), 'utf8');
    } catch {
      // non-fatal: the model still works this session
    }
  }

  private restoreState(): void {
    if (!existsSync(this.stateFile)) return;
    const saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as PersistedModel;
    if (!saved.filePath || !existsSync(saved.filePath)) return;

    this.modelPath = saved.filePath;
    this.status = {
      state: 'downloaded',
      modelId: saved.modelId,
      modelName: saved.modelName,
      message: 'Model downloaded — loading…',
      downloadedBytes: 1,
      totalBytes: 1,
    };
    // Load in the background so sidecar startup is not blocked.
    void this.load();
  }

  private persistProvider(): void {
    // Secrets (the API keys) go to the encrypted vault, NEVER to the plaintext
    // file (H-2). The file keeps only the non-secret fields. If the vault is
    // locked or absent we still persist everything else, and the keys stay in
    // memory for this session — they get written to the vault on next unlock
    // via migrateProviderKeysToVault().
    if (this.vault?.unlocked) {
      try {
        const keys: ProviderKeys = {
          ollamaKey: this.ollama.apiKey,
          apiKey: this.api.apiKey,
        };
        this.vault.saveSecret(PROVIDER_KEYS_SECRET, JSON.stringify(keys));
      } catch {
        // best-effort: a vault write failure must not lose the provider choice
      }
    }
    try {
      const data: PersistedProvider = {
        mode: this.mode,
        // apiKey deliberately omitted from both — see PersistedProvider.
        ollama: { baseUrl: this.ollama.baseUrl, model: this.ollama.model },
        api: { baseUrl: this.api.baseUrl, model: this.api.model },
      };
      writeFileSync(this.providerFile, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // non-fatal: the choice still holds for this session
    }
  }

  private restoreProvider(): void {
    if (!existsSync(this.providerFile)) return;
    try {
      // Read with the legacy shape: older files may still carry plaintext keys
      // we want to pick up (and later migrate into the vault + strip).
      const saved = JSON.parse(
        readFileSync(this.providerFile, 'utf8'),
      ) as LegacyPersistedProvider;
      this.mode =
        saved.mode === 'ollama' ? 'ollama' : saved.mode === 'api' ? 'api' : 'local';

      // Keys come from the vault when it's unlocked; otherwise leave them ''.
      // A legacy plaintext key in the file is honoured as a fallback so the
      // provider keeps working this session even before the first unlock — the
      // migration on unlock then moves it into the vault and rewrites the file.
      const vaultKeys = this.loadKeysFromVault();
      const ollamaKey = vaultKeys?.ollamaKey ?? saved.ollama?.apiKey ?? '';
      const apiKey = vaultKeys?.apiKey ?? saved.api?.apiKey ?? '';

      this.ollama = {
        baseUrl: normalizeUrl(saved.ollama?.baseUrl ?? ''),
        apiKey: ollamaKey,
        model: (saved.ollama?.model ?? '').trim(),
      };
      this.api = {
        baseUrl: normalizeUrl(saved.api?.baseUrl ?? ''),
        apiKey,
        model: (saved.api?.model ?? '').trim(),
      };

      // If the file still embedded plaintext keys and the vault is already
      // unlocked at construction time, migrate immediately. The common case
      // (vault locked at startup) is handled later by the unlock route calling
      // migrateProviderKeysToVault().
      if ((saved.ollama?.apiKey || saved.api?.apiKey) && this.vault?.unlocked) {
        this.migrateProviderKeysToVault();
      }
    } catch {
      // ignore a corrupt provider file — defaults to the local model
    }
  }

  /** Reads the API-key blob from the vault, or undefined when locked/absent. */
  private loadKeysFromVault(): ProviderKeys | undefined {
    if (!this.vault?.unlocked) return undefined;
    try {
      const raw = this.vault.loadSecret(PROVIDER_KEYS_SECRET);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<ProviderKeys>;
      return {
        ollamaKey: parsed.ollamaKey ?? '',
        apiKey: parsed.apiKey ?? '',
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Moves any plaintext API keys still sitting in llm-provider.json into the
   * encrypted vault, then rewrites the file without them. Safe to call on every
   * unlock: it's a no-op when the file has no keys, and when keys already live
   * in memory it simply ensures the vault and the on-disk file are consistent.
   * No-op while the vault is locked or absent.
   */
  migrateProviderKeysToVault(): void {
    if (!this.vault?.unlocked) return;

    // Pull any plaintext keys the file may still embed into memory first, so a
    // key the UI set before unlock isn't lost when we rewrite the file.
    let fileHadKeys = false;
    if (existsSync(this.providerFile)) {
      try {
        const saved = JSON.parse(
          readFileSync(this.providerFile, 'utf8'),
        ) as LegacyPersistedProvider;
        if (saved.ollama?.apiKey && !this.ollama.apiKey) {
          this.ollama.apiKey = saved.ollama.apiKey;
        }
        if (saved.api?.apiKey && !this.api.apiKey) {
          this.api.apiKey = saved.api.apiKey;
        }
        fileHadKeys = !!(saved.ollama?.apiKey || saved.api?.apiKey);
      } catch {
        // corrupt file — nothing to migrate
      }
    }

    // If the vault has no key blob yet but we hold keys in memory, seed it.
    // Either way, persistProvider() writes the secret to the vault and rewrites
    // llm-provider.json WITHOUT the plaintext keys, completing the migration.
    const haveKeys = !!(this.ollama.apiKey || this.api.apiKey);
    if (fileHadKeys || haveKeys || this.loadKeysFromVault() !== undefined) {
      this.persistProvider();
    }
  }
}
