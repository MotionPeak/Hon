import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModelDownloader,
  getLlama,
  type Llama,
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
    description: 'Balanced — solid Hebrew and English, runs on any modern Mac.',
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

/**
 * Manages the on-device LLM: downloading a GGUF model (with progress), loading
 * it into memory, and reporting status. The model never leaves the machine.
 */
export class LlmManager {
  private readonly modelsDir: string;
  private readonly stateFile: string;

  private status: LlmStatus = {
    state: 'not-downloaded',
    modelId: null,
    modelName: null,
    message: 'No AI model downloaded yet.',
    downloadedBytes: 0,
    totalBytes: 0,
  };

  private abortController: AbortController | null = null;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private modelPath: string | null = null;

  constructor(dataDir: string) {
    this.modelsDir = join(dataDir, 'models');
    this.stateFile = join(this.modelsDir, 'active-model.json');
    try {
      mkdirSync(this.modelsDir, { recursive: true });
      this.restoreState();
    } catch {
      // start fresh if the models directory can't be prepared
    }
  }

  getStatus(): LlmStatus & { catalog: ModelCatalogEntry[]; modelsDir: string } {
    return { ...this.status, catalog: MODEL_CATALOG, modelsDir: this.modelsDir };
  }

  /** The loaded model, for inference. Null until the state is `ready`. */
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
}
