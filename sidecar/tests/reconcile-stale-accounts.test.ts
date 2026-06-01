import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import type { NormalizedAccount } from '../src/scrapers.js';

// Audit M6: pension portals key an account on its display label, so a relabel
// orphans the old row, which keeps its last balance and double-counts in net
// worth. saveScrapeResult({ reconcileBalances: true }) nulls the balance of
// accounts missing from a successful, non-empty scrape — without deleting the
// row (snapshot history + linked data survive; it self-heals on reappearance).

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-reconcile-'));
  const { db } = openDatabase(dir);
  return { repo: new Repo(db), db };
}

function acct(accountNumber: string, balance: number): NormalizedAccount {
  return { accountNumber, currency: 'ILS', balance, transactions: [] };
}

function balances(db: Database.Database, connId: string): Record<string, number | null> {
  const rows = db
    .prepare('SELECT account_number, balance FROM accounts WHERE connection_id = ?')
    .all(connId) as { account_number: string; balance: number | null }[];
  return Object.fromEntries(rows.map((r) => [r.account_number, r.balance]));
}

const sumBalances = (b: Record<string, number | null>) =>
  Object.values(b).reduce((s: number, v) => s + (v ?? 0), 0);

describe('saveScrapeResult stale-account reconciliation (M6)', () => {
  it('nulls a relabeled pension account so it stops double-counting', () => {
    const { repo, db } = makeRepo();
    const c = repo.createConnection('migdal', 'Migdal');

    repo.saveScrapeResult(c.id, [acct('migdal:Fund A', 100), acct('migdal:Fund B', 200)], {
      reconcileBalances: true,
    });
    // Portal relabels Fund A → "Fund A (2026)"; B unchanged.
    repo.saveScrapeResult(c.id, [acct('migdal:Fund A (2026)', 100), acct('migdal:Fund B', 200)], {
      reconcileBalances: true,
    });

    const b = balances(db, c.id);
    expect(b['migdal:Fund A']).toBeNull(); // orphaned → retired
    expect(b['migdal:Fund A (2026)']).toBe(100);
    expect(b['migdal:Fund B']).toBe(200);
    expect(sumBalances(b)).toBe(300); // not 400 — no double-count
  });

  it('leaves orphaned balances intact when reconcileBalances is off (banks)', () => {
    const { repo, db } = makeRepo();
    const c = repo.createConnection('hapoalim', 'Hapoalim');

    repo.saveScrapeResult(c.id, [acct('1111', 100), acct('2222', 200)]);
    repo.saveScrapeResult(c.id, [acct('3333', 100), acct('2222', 200)]); // no opts

    const b = balances(db, c.id);
    expect(b['1111']).toBe(100); // untouched — banks aren't reconciled
    expect(sumBalances(b)).toBe(400);
  });

  it('does not reconcile when the scrape returned no accounts (guard)', () => {
    const { repo, db } = makeRepo();
    const c = repo.createConnection('harel', 'Harel');

    repo.saveScrapeResult(c.id, [acct('harel:Pension', 500)], { reconcileBalances: true });
    repo.saveScrapeResult(c.id, [], { reconcileBalances: true }); // empty success — must not wipe

    expect(balances(db, c.id)['harel:Pension']).toBe(500);
  });

  it('self-heals: a retired account reappears with its balance restored', () => {
    const { repo, db } = makeRepo();
    const c = repo.createConnection('clal', 'Clal');

    repo.saveScrapeResult(c.id, [acct('clal:A', 100), acct('clal:B', 200)], { reconcileBalances: true });
    repo.saveScrapeResult(c.id, [acct('clal:B', 200)], { reconcileBalances: true }); // A drops out → nulled
    expect(balances(db, c.id)['clal:A']).toBeNull();

    repo.saveScrapeResult(c.id, [acct('clal:A', 150), acct('clal:B', 200)], { reconcileBalances: true });
    expect(balances(db, c.id)['clal:A']).toBe(150); // COALESCE upsert restores it
  });
});
