import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';

// The built-in substring rules moved out of categorize.ts (a JS `includes`
// loop) into the `category_rules` table, matched by repo.applyBuiltinRules in
// one set-based SQL pass. These tests pin behaviour parity with the retired
// loop + the precedence guards that protect manual categories.

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-catrules-'));
  const { db } = openDatabase(dir);
  return { repo: new Repo(db), db };
}

function seedTxns(repo: Repo, descriptions: string[]) {
  const conn = repo.createConnection('max', 'Max');
  const transactions = descriptions.map((description, i) => ({
    externalId: `tx-${i}`,
    date: '2024-01-01',
    amount: -10,
    currency: 'ILS',
    description,
  }));
  repo.saveScrapeResult(conn.id, [
    { accountNumber: '1', currency: 'ILS', balance: 0, transactions },
  ]);
}

type RuleRow = { pattern: string; category: string };
type TxnRow = { description: string; category: string | null };

describe('applyBuiltinRules — built-in substring rules in SQLite', () => {
  it('matches the retired categorizeByRule includes-loop for every seeded pattern', () => {
    const { repo, db } = makeRepo();
    const rules = db
      .prepare('SELECT pattern, category FROM category_rules ORDER BY priority')
      .all() as RuleRow[];
    expect(rules.length).toBeGreaterThan(100); // the full seed migrated

    // Oracle = the old categorizeByRule: first rule (priority order) whose
    // lowercase needle is a substring of the lowercased description.
    const oracle = (desc: string): string | null => {
      const haystack = desc.toLowerCase();
      for (const r of rules) if (haystack.includes(r.pattern)) return r.category;
      return null;
    };

    // One description per rule, needle UPPERCASED + embedded in noise — this
    // exercises ASCII case-folding (LOWER), substring (INSTR) and priority
    // ordering all at once — plus a few that should match nothing.
    const descriptions = rules.map((r, i) => `POS ${i} ${r.pattern.toUpperCase()} REF`);
    descriptions.push('SOME UNLISTED MERCHANT 9981', 'random text', '   ');
    seedTxns(repo, descriptions);

    repo.applyBuiltinRules();

    const rows = db.prepare('SELECT description, category FROM transactions').all() as TxnRow[];
    for (const row of rows) {
      expect(row.category, `description: ${row.description}`).toBe(oracle(row.description));
    }
  });

  it('honours first-match-wins priority (amazon prime → Subscriptions, amazon → Shopping)', () => {
    const { repo, db } = makeRepo();
    seedTxns(repo, ['PAYPAL *AMAZON PRIME 123', 'AMAZON MKTP US', 'NetFlix.com']);
    repo.applyBuiltinRules();
    const byDesc = Object.fromEntries(
      (db.prepare('SELECT description, category FROM transactions').all() as TxnRow[]).map((r) => [
        r.description,
        r.category,
      ]),
    );
    expect(byDesc['PAYPAL *AMAZON PRIME 123']).toBe('Subscriptions');
    expect(byDesc['AMAZON MKTP US']).toBe('Shopping');
    expect(byDesc['NetFlix.com']).toBe('Subscriptions');
  });

  it('never overwrites an already-set category (manual-override guard)', () => {
    const { repo, db } = makeRepo();
    seedTxns(repo, ['WOLT TLV']); // would map to Dining…
    db.prepare("UPDATE transactions SET category = 'Income'").run(); // …but pinned by hand
    repo.applyBuiltinRules();
    const { category } = db.prepare('SELECT category FROM transactions').get() as TxnRow;
    expect(category).toBe('Income');
  });

  it('skips a rule whose target category no longer exists', () => {
    const { repo, db } = makeRepo();
    db.prepare(
      "INSERT INTO category_rules (pattern, category, priority, source, created_at) VALUES ('zzqq', 'Ghost', 1, 'test', datetime('now'))",
    ).run();
    seedTxns(repo, ['MERCHANT ZZQQ LTD']);
    repo.applyBuiltinRules();
    const { category } = db.prepare('SELECT category FROM transactions').get() as TxnRow;
    expect(category).toBeNull(); // 'Ghost' isn't a live category, so the rule is skipped
  });

  it('returns the count of DISTINCT descriptions it categorized', () => {
    const { repo } = makeRepo();
    // 2 distinct matching descriptions (NETFLIX duplicated) + 1 non-match.
    seedTxns(repo, ['NETFLIX', 'NETFLIX', 'WOLT TLV', 'nothing here xyz']);
    expect(repo.applyBuiltinRules()).toBe(2);
  });
});
