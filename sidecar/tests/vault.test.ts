import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Vault, deriveKey, encryptWith } from '../src/vault.js';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';

// A fresh on-disk DB per call (mirrors repo.test.ts). `:memory:` is NOT usable
// here: openDatabase mkdir's the arg as a data dir and opens <dir>/hon.db, so a
// literal ':memory:' would be a single shared file reused across tests.
function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'hon-vault-'));
  const { db } = openDatabase(dir);
  return new Repo(db);
}

describe('Vault', () => {
  it('round-trips credentials after unlock', () => {
    const repo = makeRepo();
    // saveCredentialBlob has a FK to connections, so create a real one first.
    const conn = repo.createConnection('hapoalim', 'Hapoalim');
    const vault = new Vault(repo);
    vault.unlock('correct horse battery staple');
    vault.saveCredentials(conn.id, { username: 'alice', password: 'secret' });
    expect(vault.loadCredentials(conn.id)).toEqual({
      username: 'alice',
      password: 'secret',
    });
  });

  it('rejects the wrong passphrase on an existing vault', () => {
    const repo = makeRepo();
    const v1 = new Vault(repo);
    v1.unlock('right-pass');
    const v2 = new Vault(repo);
    expect(() => v2.unlock('wrong-pass')).toThrow(/wrong passphrase/i);
  });
});

describe('Vault — H-6 scrypt cost via salt-version prefix', () => {
  it('stores a v2:-prefixed salt for a fresh vault and round-trips', () => {
    const repo = makeRepo();
    const v1 = new Vault(repo);
    v1.unlock('owasp-pass');

    // New vaults are tagged so deriveKey applies OWASP-2024 cost.
    const salt = repo.getMeta('vault_salt');
    expect(salt).toMatch(/^v2:[0-9a-f]+$/);

    // A second instance unlocks with the correct passphrase (full round-trip
    // through the persisted prefixed salt + verifier)...
    const v2 = new Vault(repo);
    expect(() => v2.unlock('owasp-pass')).not.toThrow();
    expect(v2.unlocked).toBe(true);

    // ...and rejects the wrong one.
    const v3 = new Vault(repo);
    expect(() => v3.unlock('nope')).toThrow(/wrong passphrase/i);
  });

  it('derives different keys for a v2: salt vs the same hex as a legacy bare-hex salt', () => {
    // Proves the cost branch in deriveKey is actually taken: identical
    // passphrase + identical salt bytes must produce different keys because the
    // v2: prefix selects OWASP-2024 cost while the bare hex uses Node default.
    const saltHex = randomBytes(16).toString('hex');
    const legacyKey = deriveKey('same-pass', saltHex);
    const v2Key = deriveKey('same-pass', `v2:${saltHex}`);
    expect(legacyKey.equals(v2Key)).toBe(false);
  });

  it('still unlocks a legacy bare-hex-salt vault (no-lockout guarantee)', () => {
    // Simulate the real user's pre-existing vault: a bare-hex salt (no v2:
    // prefix) plus a verifier encrypted under the legacy-cost key, written
    // straight through the Repo as an old Vault would have left them.
    const repo = makeRepo();
    const legacySaltHex = randomBytes(16).toString('hex');
    const legacyKey = deriveKey('legacy-pass', legacySaltHex); // default cost
    repo.setMeta('vault_salt', legacySaltHex);
    repo.setMeta('vault_verifier', encryptWith(legacyKey, 'hon-vault-ok'));

    const vault = new Vault(repo);
    expect(() => vault.unlock('legacy-pass')).not.toThrow();
    expect(vault.unlocked).toBe(true);

    // The salt is left untouched — no silent migration that could lock the
    // user out — and the wrong passphrase still throws.
    expect(repo.getMeta('vault_salt')).toBe(legacySaltHex);
    const wrong = new Vault(repo);
    expect(() => wrong.unlock('wrong-pass')).toThrow(/wrong passphrase/i);
  });
});

describe('Vault — H-2 LLM provider API keys never hit plaintext on disk', () => {
  it('round-trips an llm-provider secret blob', () => {
    // The LLM manager stores its API keys as a single named secret. Prove the
    // round-trip works AND that the on-disk (meta) form does NOT contain the
    // plaintext key — only the AES-GCM ciphertext.
    const repo = makeRepo();
    const vault = new Vault(repo);
    vault.unlock('provider-pass');

    const secret = JSON.stringify({
      ollamaKey: 'ollama-cloud-key-123',
      apiKey: 'groq-sk-super-secret-456',
    });
    vault.saveSecret('llm-provider-keys', secret);

    // Round-trips back out cleanly through the unlocked vault.
    expect(vault.loadSecret('llm-provider-keys')).toBe(secret);

    // The persisted form (whatever the vault wrote to the meta table) must not
    // leak either plaintext key — the stored secret row holds only AES-GCM
    // ciphertext, never the keys themselves.
    const onDisk = JSON.stringify(collectMeta(repo));
    expect(onDisk).not.toContain('groq-sk-super-secret-456');
    expect(onDisk).not.toContain('ollama-cloud-key-123');
  });
});

// Best-effort sweep of the meta table for the assertion above. Repo has no
// "dump everything" method, so reconstruct the values we know the vault uses
// (the secret row) plus the salt/verifier — none of which should ever contain
// a plaintext API key.
function collectMeta(repo: Repo): Record<string, string | undefined> {
  return {
    'vault_secret:llm-provider-keys': repo.getMeta('vault_secret:llm-provider-keys'),
    vault_salt: repo.getMeta('vault_salt'),
    vault_verifier: repo.getMeta('vault_verifier'),
  };
}
