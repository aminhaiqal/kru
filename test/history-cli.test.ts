import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { SqliteUsageLedger } from '../src/usage/sqlite';
import { TurnRecorder } from '../src/turns/recorder';
import { verifyReplay } from '../src/store/replay';
import { Daemon } from '../src/daemon';

let dir: string, path: string, store: Store;
const children: ReturnType<typeof Bun.spawn>[] = [], daemons: Daemon[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kru-history-cli-')); path = join(dir, 'db.sqlite'); store = new Store(path); });
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill('SIGTERM'); await child.exited; }
  for (const daemon of daemons.splice(0)) await daemon.stop(0);
  store.close(); rmSync(dir, { recursive: true, force: true });
});
async function until(fn: () => boolean, timeout = 3000) { const end = performance.now() + timeout; while (!fn()) { if (performance.now() > end) throw new Error('Timed out'); await Bun.sleep(4); } }
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, ...args, '--db', path], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr };
}

test('log --follow sees another process snapshots and final text without duplicating the answer', async () => {
  const agent = new AgentRegistry(store).create({ name: 'live', provider: 'fake' }), mailbox = new SqliteMailbox(store);
  mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [agent.id], text: 'question' });
  const batch = mailbox.claimBatch(agent.id, null)!, recorder = new TurnRecorder(store, batch, agent, 'native', 'prefix', { flushMs: 10 });
  recorder.started('turn');
  const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'log', 'live', '--follow', '--db', path], { stdout: 'pipe', stderr: 'pipe' }); children.push(child);
  let output = ''; const reading = (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true }); })();
  try {
    await until(() => output.includes('question'));
    recorder.observe({ method: 'item/agentMessage/delta', params: { threadId: 'native', turnId: 'turn', itemId: 'answer', delta: 'partial answer' } });
    await until(() => output.includes('partial answer'));
    recorder.observe({ method: 'item/completed', params: { threadId: 'native', turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'partial answer' } } });
    recorder.finish({ status: 'completed' }); await Bun.sleep(130);
    child.kill('SIGTERM'); expect(await child.exited).toBe(0); await reading;
    expect(output.match(/partial answer/g)).toHaveLength(1); expect(output).toContain('assistant (partial)');
  } finally { recorder.finish({ status: 'completed' }); }
});

test('command receipts serialize competing processes and return the same generated ids', async () => {
  const jobs = Array.from({ length: 4 }, async () => {
    const child = Bun.spawn([process.execPath, new URL('./fakes/dispatch-agent.ts', import.meta.url).pathname, path, 'shared-command'], { stdout: 'pipe', stderr: 'pipe' }); children.push(child);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(stderr).toBe(''); return JSON.parse(stdout);
  });
  const results = await Promise.all(jobs);
  expect(results.every(r => r.id === results[0].id)).toBe(true); expect(new AgentRegistry(store).list()).toHaveLength(1);
  expect(store.db.query("SELECT * FROM events WHERE type='agent.configured'").all()).toHaveLength(1);
});

test('events and command receipts are immutable at the database boundary', () => {
  new AgentRegistry(store).create({ name: 'immutable', provider: 'fake' });
  for (const sql of ["UPDATE events SET type='changed'", 'DELETE FROM events', "UPDATE command_receipts SET name='changed'", 'DELETE FROM command_receipts']) {
    expect(() => store.write(() => store.db.exec(sql))).toThrow();
  }
  expect(verifyReplay(store).matches).toBe(true);
});

test('failed v4 migration rolls back events, scalar usage fields and marker, then retries without losing v3 data', () => {
  const legacy = join(dir, 'v3.sqlite'), db = new Database(legacy);
  db.exec(readFileSync(new URL('./fixtures/store/v3.sql', import.meta.url), 'utf8'));
  db.exec("CREATE TRIGGER reject_v4 BEFORE INSERT ON schema_migrations WHEN NEW.version=4 BEGIN SELECT RAISE(ABORT,'reject v4'); END"); db.close();
  expect(() => new Store(legacy)).toThrow('reject v4');
  const inspect = new Database(legacy);
  expect(inspect.query("SELECT name FROM sqlite_master WHERE name='events'").all()).toEqual([]);
  expect(inspect.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 3 });
  expect(inspect.query('SELECT count(*) AS n FROM usage_records').get()).toEqual({ n: 1 });
  inspect.exec('DROP TRIGGER reject_v4'); inspect.close();
  const migrated = new Store(legacy);
  try { expect(verifyReplay(migrated).matches).toBe(true); expect(migrated.db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }); expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]); }
  finally { migrated.close(); }
});

test('unknown submitted usage survives repeated SIGKILL/restart and midnight until explicitly resolved', async () => {
  const agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store), ledger = new SqliteUsageLedger(store);
  const agent = agents.create({ name: 'uncertain', provider: 'fake', config: { dailyTokens: 1000, dailyUsd: 10 } });
  const enqueue = () => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [agent.id], text: 'hello' }).deliveryIds[0]!;
  enqueue(); const batch = mailbox.claimBatch(agent.id, null)!;
  ledger.begin(batch, 'fake', 'fake', new Date(Date.now() - 2 * 86400_000).toISOString()); ledger.submitted(batch.id);
  const next = enqueue();
  for (let i = 0; i < 2; i++) {
    const child = Bun.spawn([process.execPath, new URL('./fakes/scheduler-daemon.ts', import.meta.url).pathname, path], { stdout: 'pipe', stderr: 'pipe' }); children.push(child);
    await until(() => {
      const row = store.db.query<{ status_json: string }, []>('SELECT status_json FROM daemon_lock').get();
      return row ? JSON.parse(row.status_json).lanes?.some((l: { reason: string }) => l.reason === 'budget') : false;
    });
    expect(mailbox.get(next)!.status).toBe('queued'); child.kill('SIGKILL'); await child.exited;
  }
  const d = new Daemon(store); daemons.push(d); d.start(); await until(() => d.scheduler.status()[0]?.reason === 'budget');
  expect(d.scheduler.status()[0]!.budgetDetail).toContain('unknown');
  ledger.acknowledge(batch.id, 100, 1000, 'reviewed interrupted test run');
  await until(() => mailbox.get(next)!.status === 'completed'); expect(verifyReplay(store).matches).toBe(true);
});

test('history and cost reject invalid options and preserve data on read commands', async () => {
  const before = store.db.query('SELECT count(*) AS n FROM events').get();
  for (const args of [['replay'], ['replay', '--verify', '--bad'], ['log'], ['log', 'missing'], ['log', 'missing', '--main', '--lane', 'x'], ['cost', '--by', 'invalid'], ['cost', '--since', 'yesterday']]) {
    expect((await cli(...args)).code).toBe(1);
  }
  expect((await cli('log', '--help')).stdout).toContain('--follow');
  expect((await cli('replay', '--help')).stdout).toContain('--verify');
  expect(store.db.query('SELECT count(*) AS n FROM events').get()).toEqual(before);
});
