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
    expect(migrated.db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
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

test('frozen version-2 schema retains queued work and session bindings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-schema-v2-'));
  const path = join(dir, 'v2.sqlite');
  const db = new Database(path); db.exec(readFileSync(new URL('./fixtures/store/v2.sql', import.meta.url), 'utf8')); db.close();
  const migrated = new Store(path), fresh = new Store(':memory:');
  try {
    expect(schema(migrated.db)).toEqual(schema(fresh.db));
    expect(new SqliteMailbox(migrated).listQueue('fixture-agent')[0]!.batchId).toBeNull();
    expect(migrated.db.query('SELECT native_thread_id FROM agent_sessions').get()).toEqual({ native_thread_id: 'fixture-native-thread' });
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { migrated.close(); fresh.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('version-2 migration failure rolls back DDL and its receipt while retaining version-1 data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-rollback-v2-')); const path = join(dir, 'v1.sqlite');
  const fixture = new Database(path);
  fixture.exec(readFileSync(new URL('./fixtures/store/v1.sql', import.meta.url), 'utf8'));
  fixture.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'migration rollback'); END`);
  fixture.close();
  try {
    expect(() => new Store(path)).toThrow('migration rollback');
    const inspect = new Database(path);
    try {
      expect(inspect.query('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
      expect(inspect.query("SELECT name FROM sqlite_master WHERE name = 'active_lanes'").all()).toEqual([]);
      expect(inspect.query<{ name: string }, []>('PRAGMA table_info(deliveries)').all().some(r => r.name === 'batch_id')).toBe(false);
      expect(inspect.query('SELECT id FROM deliveries').get()).toEqual({ id: 'fixture-delivery' });
      inspect.exec('DROP TRIGGER reject_migration');
    } finally { inspect.close(); }
    const retried = new Store(path);
    try { expect(retried.db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]); }
    finally { retried.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agent setting patches merge permissions within the writer transaction', () => {
  const store = new Store(':memory:'), agents = new AgentRegistry(store);
  try {
    const agent = agents.create({ name: 'settings', provider: 'fake' });
    agents.update(agent.id, { config: { permissions: { sandbox: 'workspace-write' } } });
    agents.update(agent.id, { config: { permissions: { approvalPolicy: 'never' } } });
    expect(agents.get(agent.id)!.config.permissions).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'never' });
    expect(() => agents.update(agent.id, { config: { permissions: 'invalid' } })).toThrow('Invalid agent permissions');
    expect(() => agents.update(agent.id, { config: { permissions: null } })).toThrow('Invalid agent permissions');
  } finally { store.close(); }
});

test('registry changes share the Store bus with mailbox changes and publish only after commit', () => {
  const store = new Store(':memory:'), agents = new AgentRegistry(store), other = new AgentRegistry(store);
  try {
    const agent = agents.create({ name: 'shared', provider: 'fake' });
    const seen: string[] = [], topics: string[] = [];
    const off = agents.onChange(id => seen.push(id));
    store.onChange(c => topics.push(c.topic));
    store.write(() => store.db.exec(`CREATE TRIGGER reject_settings BEFORE UPDATE ON agents
      BEGIN SELECT RAISE(ABORT, 'rollback settings'); END`));
    expect(() => other.update(agent.id, { config: { paused: true } })).toThrow('rollback settings');
    expect(seen).toEqual([]); expect(topics).toEqual([]);
    store.write(() => store.db.exec('DROP TRIGGER reject_settings'));
    other.update(agent.id, { config: { paused: true } });
    new SqliteMailbox(store).enqueue({ sender: { kind: 'user' }, recipientIds: [agent.id], text: 'queued' });
    expect(seen).toEqual([agent.id]); expect(topics).toEqual(['agents', 'mailbox']);
    off(); other.update(agent.id, { config: { paused: false } }); expect(seen).toEqual([agent.id]);
  } finally { store.close(); }
});

test('frozen version-3 schema preserves historical price snapshots and turn costs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-schema-v3-')), path = join(dir, 'v3.sqlite');
  const db = new Database(path); db.exec(readFileSync(new URL('./fixtures/store/v3.sql', import.meta.url), 'utf8')); db.close();
  const migrated = new Store(path), fresh = new Store(':memory:');
  try {
    expect(schema(migrated.db)).toEqual(schema(fresh.db));
    const cost = JSON.parse(String((migrated.db.query('SELECT cost_json FROM usage_records').get() as { cost_json: string }).cost_json));
    expect(cost.maximumNanoUsd).toBe(24000); expect(cost.price.verifiedAt).toBe('2026-11-04');
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { migrated.close(); fresh.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('frozen version-4 schema retains its event history and matches a fresh schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-schema-v4-')), path = join(dir, 'v4.sqlite');
  const db = new Database(path); db.exec(readFileSync(new URL('./fixtures/store/v4.sql', import.meta.url), 'utf8')); db.close();
  const migrated = new Store(path), fresh = new Store(':memory:');
  try {
    expect(schema(migrated.db)).toEqual(schema(fresh.db));
    expect(migrated.db.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 6 });
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(migrated.db.query('SELECT cost_usd FROM usage_records').get()).toEqual({ cost_usd: .000024 });
  } finally { migrated.close(); fresh.close(); rmSync(dir, { recursive: true, force: true }); }
});
