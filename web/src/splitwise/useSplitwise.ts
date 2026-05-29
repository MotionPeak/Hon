import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  SplitwiseFriendBalance, SplitwiseLink, SplitwisePickList, SplitwiseShare, SplitwiseUser,
} from './types';

// Module-level cache so the Settings, Activity, and Overview consumers share
// one fetched copy. A 'hon.splitwise-changed' window event tells every mounted
// hook to re-read after a mutation — the same intra-tab signal pattern as
// 'hon.loan-ids-changed' (the browser 'storage' event is cross-tab only).
const CHANGED = 'hon.splitwise-changed';

interface CacheShape {
  loaded: boolean;
  connected: boolean;
  user: SplitwiseUser | null;
  links: SplitwiseLink[];
  friends: SplitwiseFriendBalance[];
}

let cache: CacheShape = {
  loaded: false, connected: false, user: null, links: [], friends: [],
};
let inFlight: Promise<void> | null = null;

/** Test-only: wipe the module cache between cases. */
export function __resetSplitwiseCache(): void {
  cache = { loaded: false, connected: false, user: null, links: [], friends: [] };
  inFlight = null;
}

function broadcast(): void {
  window.dispatchEvent(new Event(CHANGED));
}

function isLocked(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

async function fetchAll(): Promise<void> {
  const [status, links] = await Promise.all([
    api<{ connected: boolean; user: SplitwiseUser | null }>('/splitwise/status'),
    api<{ links: SplitwiseLink[] }>('/splitwise/links'),
  ]);
  cache = {
    loaded: true,
    connected: !!status.connected,
    user: status.user ?? null,
    links: links.links ?? [],
    friends: cache.friends,
  };
  broadcast();
  if (!cache.connected) return;
  try {
    const r = await api<{ friends: SplitwiseFriendBalance[]; links: SplitwiseLink[] }>(
      '/splitwise/refresh', 'POST',
    );
    cache = { ...cache, friends: r.friends ?? [], links: r.links ?? cache.links };
    broadcast();
  } catch { /* balances are best-effort — never block the dashboard */ }
}

function ensureLoaded(): void {
  if (cache.loaded || inFlight) return;
  inFlight = fetchAll().finally(() => { inFlight = null; });
}

export interface UseSplitwise {
  loading: boolean;
  connected: boolean;
  user: SplitwiseUser | null;
  links: SplitwiseLink[];
  friends: SplitwiseFriendBalance[];
  linkByTxnId: Map<string, SplitwiseLink>;
  vaultLocked: boolean;
  reload: () => Promise<void>;
  connect: (apiKey: string) => Promise<void>;
  disconnect: () => Promise<void>;
  loadPickList: () => Promise<SplitwisePickList>;
  createExpense: (
    transactionId: string, groupId: number | null, shares: SplitwiseShare[],
  ) => Promise<void>;
  deleteExpense: (transactionId: string) => Promise<void>;
}

export function useSplitwise(): UseSplitwise {
  const [, force] = useState(0);
  const [vaultLocked, setVaultLocked] = useState(false);

  useEffect(() => {
    const onChange = (): void => force((n) => n + 1);
    window.addEventListener(CHANGED, onChange);
    ensureLoaded();
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);

  const reload = useCallback(async () => {
    cache = { ...cache, loaded: false };
    await fetchAll();
  }, []);

  const guard = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    try { await fn(); }
    catch (err) { if (isLocked(err)) setVaultLocked(true); throw err; }
  }, []);

  const connect = useCallback((apiKey: string) => guard(async () => {
    const r = await api<{ user: SplitwiseUser | null }>('/splitwise/connect', 'POST', { apiKey });
    cache = { ...cache, connected: true, user: r.user ?? cache.user };
    broadcast();
    await fetchAll();
  }), [guard]);

  const disconnect = useCallback(() => guard(async () => {
    await api('/splitwise/disconnect', 'POST');
    cache = { loaded: true, connected: false, user: null, links: [], friends: [] };
    broadcast();
  }), [guard]);

  const loadPickList = useCallback(async (): Promise<SplitwisePickList> => {
    try { return await api<SplitwisePickList>('/splitwise/groups'); }
    catch (err) { if (isLocked(err)) setVaultLocked(true); throw err; }
  }, []);

  const createExpense = useCallback((
    transactionId: string, groupId: number | null, shares: SplitwiseShare[],
  ) => guard(async () => {
    const r = await api<{ link: SplitwiseLink }>('/splitwise/expense', 'POST', {
      transactionId, groupId, shares,
    });
    cache = {
      ...cache,
      links: cache.links.filter((l) => l.transactionId !== transactionId).concat([r.link]),
    };
    broadcast();
  }), [guard]);

  const deleteExpense = useCallback((transactionId: string) => guard(async () => {
    await api(`/splitwise/expense/${encodeURIComponent(transactionId)}`, 'DELETE');
    cache = {
      ...cache,
      links: cache.links.filter((l) => l.transactionId !== transactionId),
    };
    broadcast();
  }), [guard]);

  const linkByTxnId = new Map(cache.links.map((l) => [l.transactionId, l]));

  return {
    loading: !cache.loaded,
    connected: cache.connected,
    user: cache.user,
    links: cache.links,
    friends: cache.friends,
    linkByTxnId,
    vaultLocked,
    reload,
    connect,
    disconnect,
    loadPickList,
    createExpense,
    deleteExpense,
  };
}
