import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Vault } from './vault.js';

// A SnapTrade personal key has exactly one user. Hon used to keep that user's
// id/secret inside each connection's credentials, so removing a connection
// lost the secret and orphaned the key. The user is now persisted once, keyed
// by the developer Client ID, encrypted in the credential vault — the secret
// grants ongoing access to the user's brokerage data, so it never sits in
// plaintext on disk.

export interface SnapTradeUser {
  userId: string;
  userSecret: string;
}

const secretName = (clientId: string): string => `snaptrade-user:${clientId.trim()}`;

export function loadSnapTradeUser(vault: Vault, clientId: string): SnapTradeUser | null {
  const blob = vault.loadSecret(secretName(clientId));
  if (!blob) return null;
  try {
    const user = JSON.parse(blob) as SnapTradeUser;
    return user?.userId && user?.userSecret ? user : null;
  } catch {
    return null;
  }
}

export function saveSnapTradeUser(
  vault: Vault,
  clientId: string,
  user: SnapTradeUser,
): void {
  vault.saveSecret(secretName(clientId), JSON.stringify(user));
}

export function clearSnapTradeUser(vault: Vault, clientId: string): void {
  vault.clearSecret(secretName(clientId));
}

/**
 * Moves any SnapTrade users left in the legacy plaintext `snaptrade-users.json`
 * into the encrypted vault, then deletes the file. Safe to call on every
 * unlock — it is a no-op once the file is gone.
 */
export function migrateLegacySnapTradeUsers(vault: Vault, dataDir: string): void {
  const path = join(dataDir, 'snaptrade-users.json');
  if (!existsSync(path)) return;
  try {
    const store = JSON.parse(readFileSync(path, 'utf8')) as
      | Record<string, SnapTradeUser>
      | null;
    if (store && typeof store === 'object') {
      for (const [clientId, user] of Object.entries(store)) {
        if (user?.userId && user?.userSecret) saveSnapTradeUser(vault, clientId, user);
      }
    }
  } catch {
    // A corrupt legacy file should not block unlock; drop it regardless.
  }
  rmSync(path, { force: true });
}
