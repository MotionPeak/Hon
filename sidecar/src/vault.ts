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
 * Password-protected credential store. The web app has no macOS Keychain, so
 * connection credentials are encrypted (AES-256-GCM, key derived from the
 * user's passphrase via scrypt) and kept in the local SQLite database. The
 * passphrase is never stored — the derived key lives in memory only, for as
 * long as the engine process runs.
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
      salt = randomBytes(16).toString('hex');
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

  /** Returns the stored credentials for a connection, or undefined if none. */
  loadCredentials(connectionId: string): Record<string, string> | undefined {
    const blob = this.repo.getCredentialBlob(connectionId);
    if (!blob) return undefined;
    return JSON.parse(decryptWith(this.requireKey(), blob)) as Record<string, string>;
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

function deriveKey(passphrase: string, saltHex: string): Buffer {
  return scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 32);
}

function encryptWith(key: Buffer, plaintext: string): string {
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
