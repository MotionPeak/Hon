import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDoneRegistry,
  type DoneRegistry,
} from '../src/snaptradeDoneRegistry.js';

describe('snaptradeDoneRegistry', () => {
  let registry: DoneRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = createDoneRegistry({ ttlMs: 10 * 60_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for unknown connection ids', () => {
    expect(registry.get('unknown')).toBeNull();
  });

  it('records a done timestamp keyed by connection id', () => {
    vi.setSystemTime(new Date('2026-05-27T10:00:00Z'));
    registry.markDone('conn-1');
    const entry = registry.get('conn-1');
    expect(entry).not.toBeNull();
    expect(entry!.doneAt).toBe(Date.parse('2026-05-27T10:00:00Z'));
  });

  it('expires entries after ttlMs', () => {
    vi.setSystemTime(new Date('2026-05-27T10:00:00Z'));
    registry.markDone('conn-1');
    vi.setSystemTime(new Date('2026-05-27T10:09:59Z'));
    expect(registry.get('conn-1')).not.toBeNull();
    vi.setSystemTime(new Date('2026-05-27T10:10:01Z'));
    expect(registry.get('conn-1')).toBeNull();
  });

  it('overwrites older entries on re-mark', () => {
    vi.setSystemTime(new Date('2026-05-27T10:00:00Z'));
    registry.markDone('conn-1');
    vi.setSystemTime(new Date('2026-05-27T10:05:00Z'));
    registry.markDone('conn-1');
    expect(registry.get('conn-1')!.doneAt).toBe(
      Date.parse('2026-05-27T10:05:00Z'),
    );
  });

  it('clears an entry on demand', () => {
    registry.markDone('conn-1');
    registry.clear('conn-1');
    expect(registry.get('conn-1')).toBeNull();
  });
});
