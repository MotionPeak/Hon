// One-off: decrypts the credentials stored in Hon's vault.
// Run:  node recover-creds.mjs    (asks for your vault passphrase locally)
import readline from 'node:readline';
import { scryptSync, createDecipheriv } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

function ask(question, muted = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (muted) {
      const onData = () => process.stdout.write('\x1b[2K\x1b[200D' + question + '*'.repeat(rl.line.length));
      process.stdin.on('data', onData);
      rl.once('close', () => process.stdin.removeListener('data', onData));
    }
    rl.question(question, (a) => { rl.close(); if (muted) process.stdout.write('\n'); resolve(a); });
  });
}

const db = new Database(join(homedir(), 'Library', 'Application Support', 'Hon', 'hon.db'), { readonly: true });
const meta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;

const salt = meta('vault_salt');
if (!salt) { console.log('No vault exists in this database.'); process.exit(1); }

const passphrase = await ask('Vault passphrase: ', true);
const key = scryptSync(passphrase, Buffer.from(salt, 'hex'), 32);

function decrypt(blob) {
  const [ivHex, tagHex, dataHex] = blob.split(':');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
}

// Confirm the passphrase against the stored verifier before going further.
try {
  if (decrypt(meta('vault_verifier')) !== 'hon-vault-ok') throw new Error();
} catch {
  console.log('\nWrong passphrase — could not unlock the vault.');
  process.exit(1);
}

const conns = db.prepare(
  'SELECT c.id, c.company_id, c.display_name, cr.blob ' +
  'FROM connections c LEFT JOIN credentials cr ON cr.connection_id = c.id ' +
  'ORDER BY c.display_name',
).all();

console.log('\n=== Stored credentials ===');
for (const c of conns) {
  console.log(`\n${c.display_name}  (${c.company_id})`);
  if (!c.blob) { console.log('  (no credentials stored)'); continue; }
  try {
    const creds = JSON.parse(decrypt(c.blob));
    for (const [k, v] of Object.entries(creds)) console.log(`  ${k}: ${v}`);
  } catch (e) {
    console.log('  (could not decrypt: ' + e.message + ')');
  }
}
console.log();
