import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { SCHEMA_VERSION } from '../src/db/migrations.js';
import { Repo } from '../src/repo.js';

describe('transactions custom_title/notes migration', () => {
  it('adds nullable custom_title + notes columns and bumps version', () => {
    const { db } = openDatabase(mkdtempSync(join(tmpdir(), 'hon-txnmeta-')));
    const cols = db.prepare(`PRAGMA table_info(transactions)`).all() as Array<{ name: string; notnull: number }>;
    const title = cols.find((c) => c.name === 'custom_title');
    const notes = cols.find((c) => c.name === 'notes');
    expect(title).toBeTruthy(); expect(title!.notnull).toBe(0);
    expect(notes).toBeTruthy(); expect(notes!.notnull).toBe(0);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
  });
});

describe('Repo transaction details', () => {
  function seed(): { repo: Repo; id: string } {
    const { db } = openDatabase(mkdtempSync(join(tmpdir(), 'hon-txnmeta2-')));
    const repo = new Repo(db);
    // Use the Repo API to satisfy FK constraints (connections → accounts → transactions).
    const conn = repo.createConnection('hapoalim', 'Hapoalim');
    repo.saveScrapeResult(conn.id, [{
      accountNumber: '1', currency: 'ILS', balance: 0,
      transactions: [
        { externalId: 'x1', date: '2026-06-01', amount: -50, currency: 'ILS', description: 'SHUFERSAL 1' },
      ],
    }]);
    // Grab the real generated id for the one transaction seeded above.
    const id = (db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: string }).id;
    return { repo, id };
  }

  it('sets and reads back a custom title + notes', () => {
    const { repo, id } = seed();
    repo.setTransactionDetails(id, { customTitle: 'Lunch with Sara', notes: 'work trip' });
    const t = repo.getTransaction(id)!;
    expect(t.customTitle).toBe('Lunch with Sara');
    expect(t.notes).toBe('work trip');
  });

  it('stores empty/whitespace as null (clears)', () => {
    const { repo, id } = seed();
    repo.setTransactionDetails(id, { customTitle: 'X', notes: 'Y' });
    repo.setTransactionDetails(id, { customTitle: '  ', notes: '' });
    const t = repo.getTransaction(id)!;
    expect(t.customTitle).toBeNull();
    expect(t.notes).toBeNull();
  });

  it('updates only the provided field', () => {
    const { repo, id } = seed();
    repo.setTransactionDetails(id, { customTitle: 'Title', notes: 'Note' });
    repo.setTransactionDetails(id, { customTitle: 'New' }); // notes omitted
    const t = repo.getTransaction(id)!;
    expect(t.customTitle).toBe('New');
    expect(t.notes).toBe('Note');
  });
});
