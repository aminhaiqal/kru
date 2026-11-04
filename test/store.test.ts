import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { SqliteMailbox } from '../src/mailbox';
import { AgentRegistry } from '../src/agents';

const schema = (db: Database) => db.query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();

test('12. fresh and frozen version-1 databases migrate to the same schema without losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-schema-'));
  const fresh = new Store(join(dir, 'fresh.sqlite'));
  const path = join(dir, 'v1.sqlite');
  const fixture = new Database(path);
  fixture.exec(readFileSync(new URL('./fixtures/store/v1.sql', import.meta.url), 'utf8')); fixture.close();
  const migrated = new Store(path);
  try {
    expect(schema(migrated.db)).toEqual(schema(fresh.db));
    expect(new SqliteMailbox(migrated).listQueue('fixture-agent')[0]).toMatchObject({
      id: 'fixture-delivery', text: 'retained work', seq: 1, chainId: 'fixture-chain', hop: 0,
    });
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(migrated.db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }]);
  } finally { fresh.close(); migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('store enables durable WAL, foreign keys and busy timeout; rejects unsupported versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-store-')); const path = join(dir, 'db.sqlite');
  const store = new Store(path, { busyTimeoutMs: 1234 });
  try {
    expect(store.db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(store.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(store.db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
    expect(store.db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    store.write(() => store.db.query('INSERT INTO schema_migrations VALUES (?, ?)').run(99, 'future'));
    expect(() => new Store(path)).toThrow('Unsupported');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed migration rolls back both schema and migration receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-migrate-')); const path = join(dir, 'db.sqlite');
  const db = new Database(path); db.exec('CREATE TABLE deliveries (incompatible TEXT)'); db.close();
  try {
    expect(() => new Store(path)).toThrow();
    const inspect = new Database(path);
    try { expect(inspect.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'deliveries' }]); }
    finally { inspect.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agents persist config and distinguish exact ids from names', () => {
  const store = new Store(':memory:'); const agents = new AgentRegistry(store);
  try {
    const agent = agents.create({ name: 'reviewer', provider: 'fake', config: { cwd: '/tmp/review' } });
    expect(agents.resolve(agent.id)).toEqual(agent); expect(agents.resolve('reviewer')).toEqual(agent);
    expect(agent.config).toEqual({ cwd: '/tmp/review' }); expect(agents.list()).toEqual([agent]);
    expect(() => agents.create({ name: 'reviewer', provider: 'claude' })).toThrow();
    expect(() => agents.create({ name: ' ', provider: 'fake' })).toThrow();
    expect(agents.resolve('missing')).toBeNull();
  } finally { store.close(); }
});

test('data_version signals other connections committing, but not local writes or rollbacks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-data-version-'));
  const path = join(dir, 'db.sqlite');
  const observer = new Store(path), writer = new Store(path);
  const version = () => observer.db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version;
  try {
    const first = version();
    new AgentRegistry(observer).create({ name: 'local', provider: 'fake' });
    expect(version()).toBe(first);
    new AgentRegistry(writer).create({ name: 'external', provider: 'fake' });
    const changed = version();
    expect(changed).not.toBe(first);
    expect(() => writer.write(() => {
      writer.db.query("INSERT INTO agents VALUES ('rolled-back', 'aborted', 'fake', '{}', 'now')").run();
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(version()).toBe(changed);
  } finally { observer.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
