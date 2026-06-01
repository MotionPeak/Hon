import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import type { Repo } from './repo.js';

// A known string encrypted under the derived key; decrypting it back proves the
// passphrase is correct without ever storing the passphrase itself.
const VERIFIER_PLAINTEXT = 'hon-vault-ok';

/**
 * Thrown when a stored credential blob fails to decrypt or parse — a corrupt
 * or tampered row, or a partial write. Carries `statusCode = 400` so Fastify's
 * error handler surfaces it as a clean `{ error }` 400 to the caller instead of
 * an opaque 500, while still being distinguishable from "no credentials stored"
 * (which the load methods signal with `undefined`).
 */
export class VaultDecryptError extends Error {
  readonly statusCode = 400;
  constructor(message = 'stored credentials are corrupt and could not be read') {
    super(message);
    this.name = 'VaultDecryptError';
  }
}

// OWASP-2024 scrypt parameters for NEW vaults (N=2^17). maxmem must be raised
// above Node's default because the higher N exceeds the 32 MiB default budget.
// New salts are persisted with a `v2:` prefix so deriveKey knows to apply these.
const SCRYPT_V2 = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/**
 * Password-protected credential store. Connection credentials are encrypted
 * (AES-256-GCM, key derived from the user's passphrase via scrypt) and kept in
 * the local SQLite database. The passphrase is never stored — the derived key
 * lives in memory only, for as long as the engine process runs.
 */
export class Vault {
  private key: Buffer | null = null;

  constructor(private readonly repo: Repo) {}

  /** True once a passphrase has been set up (a vault exists in this database). */
  exists(): boolean {
    return this.repo.getMeta('vault_salt') !== undefined;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /**
   * Unlocks the vault with the given passphrase. On first use (no vault yet)
   * this creates the vault and accepts whatever passphrase is supplied.
   */
  unlock(passphrase: string): void {
    if (!passphrase) throw new Error('A passphrase is required.');

    let salt = this.repo.getMeta('vault_salt');
    if (!salt) {
      // New vault: tag the salt `v2:` so deriveKey applies OWASP-2024 cost.
      const saltHex = randomBytes(16).toString('hex');
      salt = `v2:${saltHex}`;
      const key = deriveKey(passphrase, salt);
      this.repo.setMeta('vault_salt', salt);
      this.repo.setMeta('vault_verifier', encryptWith(key, VERIFIER_PLAINTEXT));
      this.key = key;
      return;
    }

    const key = deriveKey(passphrase, salt);
    const verifier = this.repo.getMeta('vault_verifier');
    let decrypted: string | undefined;
    try {
      decrypted = verifier ? decryptWith(key, verifier) : undefined;
    } catch {
      decrypted = undefined;
    }
    if (decrypted !== VERIFIER_PLAINTEXT) {
      throw new Error('Wrong passphrase.');
    }
    this.key = key;
  }

  lock(): void {
    this.key = null;
  }

  /** Stores the credentials for a connection, encrypted. */
  saveCredentials(connectionId: string, credentials: Record<string, string>): void {
    this.repo.saveCredentialBlob(
      connectionId,
      encryptWith(this.requireKey(), JSON.stringify(credentials)),
    );
  }

  /**
   * Returns the stored credentials for a connection, or undefined if none.
   * A blob that fails to decrypt or parse (corrupt/tampered/partial write)
   * throws a typed {@link VaultDecryptError} (400) rather than a raw 500 — and
   * never the bare `undefined` that means "nothing stored", so callers don't
   * mistake corruption for an empty vault.
   */
  loadCredentials(connectionId: string): Record<string, string> | undefined {
    const blob = this.repo.getCredentialBlob(connectionId);
    if (!blob) return undefined;
    let plaintext: string;
    try {
      plaintext = decryptWith(this.requireKey(), blob);
    } catch (err) {
      // A locked vault is a precondition failure, not corruption — let it
      // propagate unchanged so the caller's 409 path stays intact.
      if (err instanceof Error && /vault is locked/i.test(err.message)) throw err;
      throw new VaultDecryptError();
    }
    try {
      return JSON.parse(plaintext) as Record<string, string>;
    } catch {
      throw new VaultDecryptError();
    }
  }

  // A named secret not tied to a connection — e.g. the SnapTrade user, which
  // outlives the connections that use it. Encrypted under the same vault key
  // and kept as a ciphertext row in the `meta` table.
  private static readonly SECRET_PREFIX = 'vault_secret:';

  saveSecret(name: string, value: string): void {
    this.repo.setMeta(
      Vault.SECRET_PREFIX + name,
      encryptWith(this.requireKey(), value),
    );
  }

  loadSecret(name: string): string | undefined {
    const blob = this.repo.getMeta(Vault.SECRET_PREFIX + name);
    if (!blob) return undefined;
    return decryptWith(this.requireKey(), blob);
  }

  clearSecret(name: string): void {
    this.repo.deleteMeta(Vault.SECRET_PREFIX + name);
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error('The credential vault is locked.');
    }
    return this.key;
  }
}

/**
 * Derives the 32-byte AES key from a passphrase and the RAW stored salt.
 * A `v2:` prefix marks vaults created at OWASP-2024 cost (N=2^17); legacy
 * bare-hex salts keep deriving at Node's default cost so existing vaults are
 * never locked out. The branch is taken purely on the stored salt's format,
 * so unlocking transparently handles both generations without a migration.
 *
 * Exported for tests: the cost branch is security-critical and is asserted
 * directly (v2-prefixed vs bare-hex salts must yield different keys).
 */
export function deriveKey(passphrase: string, storedSalt: string): Buffer {
  if (storedSalt.startsWith('v2:')) {
    return scryptSync(
      passphrase,
      Buffer.from(storedSalt.slice(3), 'hex'),
      32,
      SCRYPT_V2,
    );
  }
  // Legacy vaults: bare-hex salt, Node default scrypt cost. Keep as-is.
  return scryptSync(passphrase, Buffer.from(storedSalt, 'hex'), 32);
}

// Exported for tests: lets a legacy (bare-hex salt) vault be reconstructed
// through the Repo so the back-compat unlock path can be exercised end-to-end.
export function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('hex')).join(':');
}

function decryptWith(key: Buffer, blob: string): string {
  const [ivHex, tagHex, dataHex] = blob.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
