import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDatabasePath } from './location';

const migrations = [
  { version: 1, sql: readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8') },
];

/** Synchronous writes own their transaction. No callbacks may await or nest writes. */
export class Store {
  readonly db: Database;

  constructor(path = resolveDatabasePath(), options: { busyTimeoutMs?: number } = {}) {
    const timeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error('Invalid SQLite busy timeout');
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec(`PRAGMA busy_timeout = ${timeout}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
      const { version } = this.db.query<{ version: string }, []>('SELECT sqlite_version() AS version').get()!;
      const [major = 0, minor = 0] = version.split('.').map(Number);
      if (major < 3 || (major === 3 && minor < 35)) throw new Error('SQLite 3.35 or newer is required');
      // Check the version under the same writer lock as the schema changes.
      this.write(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
        const versions = this.db.query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version').all();
        if (versions.some((row, i) => row.version !== i + 1) || versions.length > migrations.length) {
          throw new Error('Unsupported database schema version');
        }
        for (const migration of migrations.slice(versions.length)) {
          this.db.exec(migration.sql);
          this.db.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }

  write<T>(operation: () => T): T {
    if (this.db.inTransaction) throw new Error('Store writes cannot run inside another transaction');
    return this.db.transaction(() => {
      const value = operation();
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Store writes must be synchronous');
      return value;
    }).immediate();
  }

  close(): void { this.db.close(); }
}
