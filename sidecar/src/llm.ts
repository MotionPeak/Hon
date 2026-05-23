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

interface PersistedProvider {
  mode: LlmMode;
  ollama: OllamaConfig;
  api: ApiConfig;
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
  private model: LlamaModel | null = null;
  private modelPath: string | null = null;

  constructor(dataDir: string) {
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
    this.status.state = 'loading';
    this.status.message = 'Loading the model into memory…';
    try {
      this.llama ??= await getLlama();
      this.model = await this.llama.loadModel({ modelPath: this.modelPath });
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
    try {
      const data: PersistedProvider = {
        mode: this.mode,
        ollama: this.ollama,
        api: this.api,
      };
      writeFileSync(this.providerFile, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // non-fatal: the choice still holds for this session
    }
  }

  private restoreProvider(): void {
    if (!existsSync(this.providerFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.providerFile, 'utf8')) as Partial<PersistedProvider>;
      this.mode =
        saved.mode === 'ollama' ? 'ollama' : saved.mode === 'api' ? 'api' : 'local';
      this.ollama = {
        baseUrl: normalizeUrl(saved.ollama?.baseUrl ?? ''),
        apiKey: saved.ollama?.apiKey ?? '',
        model: (saved.ollama?.model ?? '').trim(),
      };
      this.api = {
        baseUrl: normalizeUrl(saved.api?.baseUrl ?? ''),
        apiKey: saved.api?.apiKey ?? '',
        model: (saved.api?.model ?? '').trim(),
      };
    } catch {
      // ignore a corrupt provider file — defaults to the local model
    }
  }
}
