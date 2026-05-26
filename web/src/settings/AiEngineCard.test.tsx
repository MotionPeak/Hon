import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiEngineCard } from './AiEngineCard';
import { installFetchMock } from '../test/mockFetch';

const CATALOG = [
  {
    id: 'qwen2.5-3b',
    name: 'Qwen2.5 3B Instruct',
    description: 'Balanced — solid Hebrew and English.',
    uri: 'hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M',
    approxSizeBytes: 2_100_000_000,
    recommended: true,
  },
  {
    id: 'qwen2.5-7b',
    name: 'Qwen2.5 7B Instruct',
    description: 'Higher quality — needs roughly 6 GB free memory.',
    uri: 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M',
    approxSizeBytes: 4_700_000_000,
    recommended: false,
  },
];

function statusResponse(over: Record<string, unknown> = {}): unknown {
  return {
    state: 'not-downloaded',
    modelId: null,
    modelName: null,
    message: '',
    downloadedBytes: 0,
    totalBytes: 0,
    catalog: CATALOG,
    modelsDir: '/tmp/hon-models',
    mode: 'local',
    ready: false,
    ollama: { baseUrl: '', model: '', hasKey: false },
    api: { baseUrl: '', model: '', hasKey: false },
    ...over,
  };
}

describe('AiEngineCard', () => {
  it('shows a provider segmented control (Local / Ollama / API)', async () => {
    installFetchMock({ 'GET /api/llm': () => statusResponse() });
    render(<AiEngineCard />);
    expect(await screen.findByRole('button', { name: /^On-device$/i }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Ollama$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^API$/i })).toBeInTheDocument();
  });

  it('local mode lists every catalog model with a Download button', async () => {
    installFetchMock({ 'GET /api/llm': () => statusResponse() });
    render(<AiEngineCard />);
    expect(await screen.findByText('Qwen2.5 3B Instruct')).toBeInTheDocument();
    expect(screen.getByText('Qwen2.5 7B Instruct')).toBeInTheDocument();
    const downloads = screen.getAllByRole('button', { name: /^Download$/i });
    expect(downloads.length).toBe(2);
  });

  it('clicking Download POSTs /llm/download with the model id', async () => {
    const post = vi.fn((_body: unknown) => ({ ok: true }));
    installFetchMock({
      'GET /api/llm': () => statusResponse(),
      'POST /api/llm/download': post,
    });
    const user = userEvent.setup();
    render(<AiEngineCard />);
    await user.click(
      (await screen.findAllByRole('button', { name: /^Download$/i }))[0]!,
    );
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((post.mock.calls[0]?.[0] as Record<string, unknown>).modelId)
      .toBe('qwen2.5-3b');
  });

  it('a downloading model shows a progress bar with %', async () => {
    installFetchMock({
      'GET /api/llm': () => statusResponse({
        state: 'downloading',
        modelId: 'qwen2.5-3b',
        modelName: 'Qwen2.5 3B Instruct',
        downloadedBytes: 1_050_000_000,
        totalBytes: 2_100_000_000,
        message: 'Downloading…',
      }),
    });
    render(<AiEngineCard />);
    expect(await screen.findByText(/50%/)).toBeInTheDocument();
    // Cancel button replaces Download for the in-flight model.
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
  });

  it('the loaded model hides the Download button (only other models can be downloaded)', async () => {
    installFetchMock({
      'GET /api/llm': () => statusResponse({
        state: 'ready',
        modelId: 'qwen2.5-3b',
        modelName: 'Qwen2.5 3B Instruct',
        ready: true,
      }),
    });
    render(<AiEngineCard />);
    const loaded = (await screen.findByText('Qwen2.5 3B Instruct')).closest('.ai-model')!;
    expect(within(loaded as HTMLElement).queryByRole('button', { name: /^Download$/i }))
      .not.toBeInTheDocument();
    // The other (un-loaded) model still has its Download button.
    const other = screen.getByText('Qwen2.5 7B Instruct').closest('.ai-model')!;
    expect(within(other as HTMLElement).getByRole('button', { name: /^Download$/i }))
      .toBeInTheDocument();
  });

  it('a ready local model shows a "Ready" pill', async () => {
    installFetchMock({
      'GET /api/llm': () => statusResponse({
        state: 'ready',
        modelId: 'qwen2.5-3b',
        modelName: 'Qwen2.5 3B Instruct',
        ready: true,
      }),
    });
    render(<AiEngineCard />);
    expect(await screen.findByText(/^Ready$/i)).toBeInTheDocument();
  });

  it('switching to Ollama renders URL / API key / model inputs + Test', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/llm': () => statusResponse() });
    render(<AiEngineCard />);
    await user.click(await screen.findByRole('button', { name: /^Ollama$/i }));
    expect(screen.getByLabelText(/server URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/API key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Test$/i })).toBeInTheDocument();
  });

  it('Ollama Test POSTs /llm/ollama/test with the typed URL + key', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => ({ ok: true, model: 'qwen2.5:3b' }));
    installFetchMock({
      'GET /api/llm': () => statusResponse(),
      'POST /api/llm/ollama/test': post,
    });
    render(<AiEngineCard />);
    await user.click(await screen.findByRole('button', { name: /^Ollama$/i }));
    await user.type(screen.getByLabelText(/server URL/i), 'http://localhost:11434');
    await user.type(screen.getByLabelText(/API key/i), 'secret');
    await user.click(screen.getByRole('button', { name: /^Test$/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.ollamaUrl).toBe('http://localhost:11434');
    expect(body.ollamaKey).toBe('secret');
  });

  it('shows a Categorize-all panel when the engine is ready', async () => {
    installFetchMock({
      'GET /api/llm': () => statusResponse({
        state: 'ready', modelId: 'qwen2.5-3b',
        modelName: 'Qwen2.5 3B Instruct', ready: true,
      }),
      'GET /api/categorize': () => ({
        state: 'idle', total: 0, done: 0, message: 'Not run yet.',
      }),
    });
    render(<AiEngineCard />);
    expect(await screen.findByRole('button', { name: /categorize all/i }))
      .toBeInTheDocument();
  });

  it('clicking Categorize all POSTs /categorize and polls status', async () => {
    const user = userEvent.setup();
    const post = vi.fn(() => ({ ok: true }));
    let calls = 0;
    installFetchMock({
      'GET /api/llm': () => statusResponse({
        state: 'ready', modelId: 'qwen2.5-3b',
        modelName: 'Qwen2.5 3B Instruct', ready: true,
      }),
      'GET /api/categorize': () => {
        calls += 1;
        if (calls === 1) return { state: 'idle', total: 0, done: 0, message: '' };
        if (calls === 2) return {
          state: 'running', total: 100, done: 42,
          message: 'Categorising 42/100…',
        };
        return {
          state: 'done', total: 100, done: 100,
          message: 'Categorised 100 transactions.',
        };
      },
      'POST /api/categorize': post,
    });
    render(<AiEngineCard />);
    await user.click(await screen.findByRole('button', { name: /categorize all/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    // Progress display surfaces during running state.
    expect(await screen.findByText(/42\s*\/\s*100/i, {}, { timeout: 4000 }))
      .toBeInTheDocument();
    // Done message lands once polling sees state=done.
    expect(await screen.findByText(/categorised 100/i, {}, { timeout: 4000 }))
      .toBeInTheDocument();
  });

  it('hides Categorize all when the engine is not ready', async () => {
    installFetchMock({
      'GET /api/llm': () => statusResponse({ ready: false }),
      'GET /api/categorize': () => ({ state: 'idle', total: 0, done: 0, message: '' }),
    });
    render(<AiEngineCard />);
    await screen.findByRole('button', { name: /^On-device$/i });
    expect(screen.queryByRole('button', { name: /categorize all/i }))
      .not.toBeInTheDocument();
  });

  it('Save in Ollama mode POSTs /llm/provider with mode=ollama + fields', async () => {
    const user = userEvent.setup();
    const post = vi.fn((_body: unknown) => statusResponse({ mode: 'ollama' }));
    installFetchMock({
      'GET /api/llm': () => statusResponse(),
      'POST /api/llm/provider': post,
    });
    render(<AiEngineCard />);
    await user.click(await screen.findByRole('button', { name: /^Ollama$/i }));
    await user.type(screen.getByLabelText(/server URL/i), 'http://localhost:11434');
    await user.type(screen.getByLabelText(/model/i), 'qwen2.5:3b');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.mode).toBe('ollama');
    expect(body.ollamaUrl).toBe('http://localhost:11434');
    expect(body.ollamaModel).toBe('qwen2.5:3b');
  });
});
