import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getIlsRates, __resetFxCache } from '../src/fx.js';

describe('getIlsRates in-flight dedup (H-9)', () => {
  beforeEach(() => {
    __resetFxCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dedupes two concurrent callers into ONE fetch', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // simulate latency so the second caller arrives mid-flight
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          json: async () => ({ rates: { USD: 0.27, EUR: 0.25 } }),
        } as Response;
      }),
    );

    const [a, b] = await Promise.all([getIlsRates(), getIlsRates()]);
    expect(calls).toBe(1);
    expect(a).toBe(b); // same resolved object — shared in-flight promise
    expect(a?.USD).toBeCloseTo(1 / 0.27);
    expect(a?.ILS).toBe(1);
  });

  it('refetches after __resetFxCache clears the cache', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          json: async () => ({ rates: { USD: 0.27 } }),
        } as Response;
      }),
    );

    await getIlsRates();
    __resetFxCache();
    await getIlsRates();
    expect(calls).toBe(2);
  });

  it('clears the in-flight promise on fetch failure so a retry can run', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('network down');
        return {
          ok: true,
          json: async () => ({ rates: { USD: 0.27 } }),
        } as Response;
      }),
    );

    const first = await getIlsRates(); // swallows the error → null
    expect(first).toBeNull();
    const second = await getIlsRates(); // retry succeeds (inflight was cleared)
    expect(second?.USD).toBeCloseTo(1 / 0.27);
    expect(calls).toBe(2);
  });
});
