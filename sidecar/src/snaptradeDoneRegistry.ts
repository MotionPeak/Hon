/**
 * In-memory registry of completed SnapTrade portal sessions, keyed by
 * Hon connectionId. Set when `/snaptrade/done` is hit; read by
 * `/snaptrade/connections/:id/count`. TTL bounds memory at the cost of
 * a tiny check on every read.
 *
 * Lives in-memory because:
 *   1. SnapTrade's portal redirects within seconds of a click — the
 *      client polls at 3s so a process restart between done & detect
 *      is extraordinarily unlikely.
 *   2. The engine is single-process, single-user. No coordination
 *      across instances needed.
 */
export interface DoneEntry {
  doneAt: number;
}

export interface DoneRegistry {
  markDone(connectionId: string): void;
  get(connectionId: string): DoneEntry | null;
  clear(connectionId: string): void;
}

export function createDoneRegistry(opts: { ttlMs: number }): DoneRegistry {
  const store = new Map<string, DoneEntry>();
  const { ttlMs } = opts;
  return {
    markDone(connectionId) {
      store.set(connectionId, { doneAt: Date.now() });
    },
    get(connectionId) {
      const entry = store.get(connectionId);
      if (!entry) return null;
      if (Date.now() - entry.doneAt > ttlMs) {
        store.delete(connectionId);
        return null;
      }
      return entry;
    },
    clear(connectionId) {
      store.delete(connectionId);
    },
  };
}
