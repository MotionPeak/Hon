import { useEffect, useState } from 'react';
import { api } from '../api';

// Module-level cache so every consumer (the app banner + the Settings card)
// shares one fetched status. A 'hon.vault-changed' window event tells every
// mounted hook to re-read after unlock/lock — the same intra-tab signal
// pattern useSplitwise / the loans nav use.
const CHANGED = 'hon.vault-changed';

interface VaultState {
  loaded: boolean;
  /** A vault file exists on disk (i.e. there are saved credentials). */
  exists: boolean;
  /** The vault is currently decrypted (passphrase entered this session). */
  unlocked: boolean;
}

let cache: VaultState = { loaded: false, exists: false, unlocked: false };
let inFlight: Promise<void> | null = null;

/** Test-only: wipe the module cache between cases. */
export function __resetVaultCache(): void {
  cache = { loaded: false, exists: false, unlocked: false };
  inFlight = null;
}

function broadcast(): void {
  window.dispatchEvent(new Event(CHANGED));
}

async function fetchStatus(): Promise<void> {
  const s = await api<{ exists: boolean; unlocked: boolean }>('/vault/status');
  cache = { loaded: true, exists: !!s.exists, unlocked: !!s.unlocked };
  broadcast();
}

function ensureLoaded(): void {
  if (cache.loaded || inFlight) return;
  inFlight = fetchStatus()
    .catch(() => { cache = { ...cache, loaded: true }; })
    .finally(() => { inFlight = null; });
}

export interface UseVault {
  loaded: boolean;
  exists: boolean;
  unlocked: boolean;
  /** Unlock with the passphrase. Rejects (ApiError 400) on a wrong passphrase. */
  unlock: (passphrase: string) => Promise<void>;
  lock: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useVault(): UseVault {
  const [, force] = useState(0);

  useEffect(() => {
    const onChange = (): void => force((n) => n + 1);
    window.addEventListener(CHANGED, onChange);
    ensureLoaded();
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);

  const unlock = async (passphrase: string): Promise<void> => {
    const r = await api<{ exists: boolean; unlocked: boolean }>(
      '/vault/unlock', 'POST', { passphrase },
    );
    cache = { loaded: true, exists: !!r.exists, unlocked: !!r.unlocked };
    broadcast();
    // Vault-backed features (Splitwise creds, etc.) can re-load now.
    window.dispatchEvent(new Event('hon.splitwise-changed'));
  };

  const lock = async (): Promise<void> => {
    await api('/vault/lock', 'POST');
    cache = { ...cache, loaded: true, unlocked: false };
    broadcast();
  };

  const refresh = async (): Promise<void> => {
    cache = { ...cache, loaded: false };
    await fetchStatus();
  };

  return {
    loaded: cache.loaded,
    exists: cache.exists,
    unlocked: cache.unlocked,
    unlock,
    lock,
    refresh,
  };
}
