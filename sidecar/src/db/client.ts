// The Drizzle client, bound to an EXISTING better-sqlite3 connection.
//
// Hon opens exactly one SQLite connection (db.ts openDatabase). The Repo wraps
// that same connection with Drizzle via makeDb(sqlite) — there is no second
// connection, no second pool, and migrations are still applied by db.ts before
// any query runs. Importing this module does not load the native binding; the
// caller supplies the already-open Database instance.

import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/** The app-wide Drizzle database type, with the full schema attached so
 *  relational queries and `db.query.*` are fully typed. */
export type HonDb = BetterSQLite3Database<typeof schema>;

/** Wrap an open better-sqlite3 connection with Drizzle + the Hon schema. */
export function makeDb(sqlite: Database.Database): HonDb {
  return drizzle(sqlite, { schema });
}

export { schema };
