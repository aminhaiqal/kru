import { readMigration } from './sql';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDatabasePath } from './location';
import { randomUUID } from 'node:crypto';
import { dispatch, emit, type Command } from './events';
import { importGenesis } from './genesis';
import { importThreads } from '../threads/migrate';
import { importSessionHistory } from '../threads/import-session-history';
import { enableBrowserDefaults } from '../workspace/browser-defaults';
import type { EventType, Payloads } from './event-types';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const migrations = [
  { version: 1, sql: readMigration('001-initial.sql') },
  { version: 2, sql: readMigration('002-scheduler.sql') },
  { version: 3, sql: readMigration('003-usage-ledger.sql') },
  { version: 4, sql: readMigration('004-events.sql') },
  { version: 5, sql: readMigration('005-tools.sql') },
  { version: 6, sql: readMigration('006-key-retention.sql') },
  { version: 7, sql: readMigration('007-threads.sql') },
  { version: 8, sql: readMigration('008-recovery.sql') },
  { version: 9, sql: readMigration('009-session-history.sql') },
  { version: 10, sql: readMigration('010-workspace.sql') },
  { version: 11, sql: readMigration('011-work.sql') },
  { version: 12, sql: readMigration('012-workflows.sql') },
  { version: 13, sql: readMigration('013-conversations.sql') },
  { version: 14, sql: readMigration('014-conversation-projects.sql') },
  { version: 15, sql: readMigration('015-project-files.sql') },
];

export interface StoreChange {
  topic: string;
  id: string;
  value?: unknown;
}

/** Synchronous writes own their transaction. No callbacks may await or nest writes. */
export class Store {
  readonly db: Database;
  readonly path: string;
  private fence: (() => void) | undefined;
  get databaseId(): string {
    return this.db
      .query<{ database_id: string }, []>('SELECT database_id FROM store_identity WHERE id=1')
      .get()!.database_id;
  }
  get processDirectory(): string {
    return join(
      this.path === ':memory:' ? tmpdir() : dirname(resolve(this.path)),
      'processes',
      this.databaseId,
    );
  }
  setWriteFence(fence?: () => void): void {
    this.fence = fence;
  }
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private readonly notifications: StoreChange[] = [];
  private publishing = false;
  private composing = false;
  private stagedChanges: StoreChange[] = [];
  commandId: string | undefined;
  get inCommand(): boolean {
    return this.composing;
  }

  constructor(path = resolveDatabasePath(), options: { busyTimeoutMs?: number } = {}) {
    this.path = path;
    const timeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0)
      throw new Error('Invalid SQLite busy timeout');
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.function('kru_fold', { deterministic: true }, (value: unknown) =>
        typeof value === 'string' ? value.toLowerCase() : '',
      );
      this.db.exec(
        `PRAGMA busy_timeout = ${timeout}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`,
      );
      const { version } = this.db
        .query<{ version: string }, []>('SELECT sqlite_version() AS version')
        .get()!;
      const [major = 0, minor = 0] = version.split('.').map(Number);
      if (major < 3 || (major === 3 && minor < 35))
        throw new Error('SQLite 3.35 or newer is required');
      // Check the version under the same writer lock as the schema changes.
      this.write(() => {
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
        );
        const versions = this.db
          .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
          .all();
        if (
          versions.some((row, i) => row.version !== i + 1) ||
          versions.length > migrations.length
        ) {
          throw new Error('Unsupported database schema version');
        }
        for (const migration of migrations.slice(versions.length)) {
          this.db.exec(migration.sql);
          if (migration.version === 4) importGenesis(this.db);
          if (migration.version === 7) importThreads(this.db);
          if (migration.version === 9) importSessionHistory(this.db);
          if (migration.version === 13) enableBrowserDefaults(this.db);
          this.db
            .query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
            .run(migration.version, new Date().toISOString());
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  write<T>(operation: () => T): T {
    if (this.db.inTransaction && !this.composing)
      throw new Error('Store writes cannot run inside another transaction');
    const staged = this.stagedChanges.length;
    try {
      return this.db
        .transaction(() => {
          this.fence?.();
          const value = operation();
          if (value && typeof (value as { then?: unknown }).then === 'function')
            throw new Error('Store writes must be synchronous');
          return value;
        })
        .immediate();
    } catch (error) {
      this.stagedChanges.length = staged;
      throw error;
    }
  }

  /** Explicit M4 composition: nested writes use savepoints, events publish after the outer commit. */
  atomic<T>(operation: () => T): T {
    return this.command('transaction', operation);
  }
  command<T>(name: string, operation: () => T, options?: { id?: string; input?: unknown }): T {
    const command: Command = { id: options?.id ?? randomUUID(), name, input: options?.input };
    return dispatch(this, command, operation);
  }
  emit<K extends EventType>(type: K, payload: Payloads[K]): void {
    emit(this, type, payload);
  }
  /** Internal transaction boundary used only by dispatch; operational writes use write(). */
  commandTransaction<T>(operation: () => T): T {
    if (this.db.inTransaction) throw new Error('Atomic commands must own their transaction');
    this.composing = true;
    this.stagedChanges = [];
    let value: T;
    try {
      value = this.write(operation);
    } catch (error) {
      this.stagedChanges = [];
      throw error;
    } finally {
      this.composing = false;
    }
    const changes = this.stagedChanges;
    this.stagedChanges = [];
    this.publishChanges(changes);
    return value;
  }

  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Domain adapters publish only after their write transaction has committed. */
  publishChanges(changes: StoreChange[]): void {
    if (this.db.inTransaction) {
      if (!this.composing) throw new Error('Store changes must be published after commit');
      this.stagedChanges.push(...changes);
      return;
    }
    this.notifications.push(...changes);
    if (this.publishing) return;
    this.publishing = true;
    try {
      for (let change = this.notifications.shift(); change; change = this.notifications.shift()) {
        for (const listener of [...this.listeners]) {
          try {
            listener({ ...change });
          } catch (error) {
            process.emitWarning(
              `Store listener failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }
  close(): void {
    this.listeners.clear();
    this.db.close();
  }
}
