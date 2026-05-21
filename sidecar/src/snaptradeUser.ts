import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A SnapTrade personal key has exactly one user. Hon used to keep that user's
// id/secret inside each connection's credentials, so removing a connection
// lost the secret and orphaned the key. This module persists the user once,
// keyed by the developer Client ID, independent of any connection.

export interface SnapTradeUser {
  userId: string;
  userSecret: string;
}

type Store = Record<string, SnapTradeUser>;

function storePath(dataDir: string): string {
  return join(dataDir, 'snaptrade-users.json');
}

function readStore(dataDir: string): Store {
  try {
    const path = storePath(dataDir);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(dataDir: string, store: Store): void {
  writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2));
}

export function loadSnapTradeUser(dataDir: string, clientId: string): SnapTradeUser | null {
  const user = readStore(dataDir)[clientId.trim()];
  return user?.userId && user?.userSecret ? user : null;
}

export function saveSnapTradeUser(
  dataDir: string,
  clientId: string,
  user: SnapTradeUser,
): void {
  const store = readStore(dataDir);
  store[clientId.trim()] = user;
  writeStore(dataDir, store);
}

export function clearSnapTradeUser(dataDir: string, clientId: string): void {
  const store = readStore(dataDir);
  delete store[clientId.trim()];
  writeStore(dataDir, store);
}
