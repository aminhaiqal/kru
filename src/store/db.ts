import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDatabasePath } from './location';
import { randomUUID } from 'node:crypto';
import { dispatch, emit, type Command } from './events';
import { importGenesis } from './genesis';
import { importThreads } from '../threads/migrate';
import { importSessionHistory } from '../threads/import-session-history';
import type { EventType, Payloads } from './event-types';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const migrations = [
  { version: 1, sql: readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8') },
  { version: 2, sql: readFileSync(new URL('./migrations/002-scheduler.sql', import.meta.url), 'utf8') },
  { version: 3, sql: readFileSync(new URL('./migrations/003-usage-ledger.sql', import.meta.url), 'utf8') },
  { version: 4, sql: readFileSync(new URL('./migrations/004-events.sql', import.meta.url), 'utf8') },
  { version: 5, sql: readFileSync(new URL('./migrations/005-tools.sql', import.meta.url), 'utf8') },
  { version: 6, sql: readFileSync(new URL('./migrations/006-key-retention.sql', import.meta.url), 'utf8') },
  { version: 7, sql: readFileSync(new URL('./migrations/007-threads.sql', import.meta.url), 'utf8') },
  { version: 8, sql: readFileSync(new URL('./migrations/008-recovery.sql', import.meta.url), 'utf8') },
  { version: 9, sql: readFileSync(new URL('./migrations/009-session-history.sql', import.meta.url), 'utf8') },
];

export interface StoreChange { topic: string; id: string; value?: unknown }

/** Synchronous writes own their transaction. No callbacks may await or nest writes. */
export class Store {
  readonly db: Database;
  readonly path: string;
  private fence: (() => void) | undefined;
  get databaseId(): string { return this.db.query<{ database_id: string }, []>('SELECT database_id FROM store_identity WHERE id=1').get()!.database_id; }
  get processDirectory(): string { return join(this.path === ':memory:' ? tmpdir() : dirname(resolve(this.path)), 'processes', this.databaseId); }
  setWriteFence(fence?: () => void): void { this.fence = fence; }
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private readonly notifications: StoreChange[] = [];
  private publishing = false;
  private composing = false;
  private stagedChanges: StoreChange[] = [];
  commandId: string | undefined;
  get inCommand(): boolean { return this.composing; }

  constructor(path = resolveDatabasePath(), options: { busyTimeoutMs?: number } = {}) {
    this.path = path;
    const timeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error('Invalid SQLite busy timeout');
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.function('kru_fold', { deterministic: true }, (value: unknown) => typeof value === 'string' ? value.toLowerCase() : '');
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
          if (migration.version === 4) importGenesis(this.db);
          if (migration.version === 7) importThreads(this.db);
          if (migration.version === 9) importSessionHistory(this.db);
          this.db.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }

  write<T>(operation: () => T): T {
    if (this.db.inTransaction && !this.composing) throw new Error('Store writes cannot run inside another transaction');
    const staged = this.stagedChanges.length;
    try { return this.db.transaction(() => {
      this.fence?.();
      const value = operation();
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Store writes must be synchronous');
      return value;
    }).immediate(); }
    catch (error) { this.stagedChanges.length = staged; throw error; }
  }

  /** Explicit M4 composition: nested writes use savepoints, events publish after the outer commit. */
  atomic<T>(operation: () => T): T {
    return this.command('transaction', operation);
  }
  command<T>(name: string, operation: () => T, options?: { id?: string; input?: unknown }): T {
    const command: Command = { id: options?.id ?? randomUUID(), name, input: options?.input };
    return dispatch(this, command, operation);
  }
  emit<K extends EventType>(type: K, payload: Payloads[K]): void { emit(this, type, payload); }
  /** Internal transaction boundary used only by dispatch; operational writes use write(). */
  commandTransaction<T>(operation: () => T): T {
    if (this.db.inTransaction) throw new Error('Atomic commands must own their transaction');
    this.composing = true; this.stagedChanges = [];
    let value: T;
    try { value = this.write(operation); }
    catch (error) { this.stagedChanges = []; throw error; }
    finally { this.composing = false; }
    const changes = this.stagedChanges; this.stagedChanges = [];
    this.publishChanges(changes);
    return value;
  }

  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** Domain adapters publish only after their write transaction has committed. */
  publishChanges(changes: StoreChange[]): void {
    if (this.db.inTransaction) {
      if (!this.composing) throw new Error('Store changes must be published after commit');
      this.stagedChanges.push(...changes); return;
    }
    this.notifications.push(...changes);
    if (this.publishing) return;
    this.publishing = true;
    try {
      for (let change = this.notifications.shift(); change; change = this.notifications.shift()) {
        for (const listener of [...this.listeners]) {
          try { listener({ ...change }); }
          catch (error) { process.emitWarning(`Store listener failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
    } finally { this.publishing = false; }
  }
  close(): void { this.listeners.clear(); this.db.close(); }
}
