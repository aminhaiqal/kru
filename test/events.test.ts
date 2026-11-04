import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, dispatch, type StoredEvent } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { SqliteUsageLedger } from '../src/usage/sqlite';
import { modelPrices } from '../src/usage/pricing';
import { BudgetCalendar } from '../src/scheduler/budget-day';
import { Daemon } from '../src/daemon';
import { FakeProvider } from '../src/providers/fake/adapter';
import { PriceBook } from '../src/cost/prices';
import { SqliteTurnHistory, TurnRecorder } from '../src/turns/recorder';
import { readLog } from '../src/turns/log';
import { replay, snapshot, verifyReplay, projectionTables } from '../src/store/replay';
import { tokenCount } from '../src/providers/token-usage';
import type { AgentItem } from '../src/providers/protocol';

let dir: string, path: string, store: Store;
const daemons: Daemon[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kru-events-')); path = join(dir, 'db.sqlite'); store = new Store(path); });
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(0); store.close(); rmSync(dir, { recursive: true, force: true }); });
const events = () => store.db.query<StoredEvent, []>('SELECT * FROM events ORDER BY seq').all();
const agents = () => new AgentRegistry(store);
const mailbox = () => new SqliteMailbox(store);
const ledger = () => new SqliteUsageLedger(store);
const send = (id: string, text = 'hello', laneId?: string) => mailbox().enqueue({ sender: { kind: 'user' }, recipientIds: [id], text, ...(laneId ? { laneId } : {}) }).deliveryIds[0]!;
async function until(fn: () => boolean, timeout = 3_000) { const end = performance.now() + timeout; while (!fn()) { if (performance.now() > end) throw new Error('Timed out'); await Bun.sleep(3); } }
function daemon(options: ConstructorParameters<typeof Daemon>[1] = {}) {
  const d = new Daemon(store, options, () => new FakeProvider({ delayMs: 3 })); daemons.push(d); d.start(); return d;
}
async function cli(...args: string[]) {
  const p = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, ...args, '--db', path], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
}
async function completed(config: Record<string, unknown> = {}) {
  const agent = agents().create({ name: `agent-${agents().list().length}`, provider: 'fake', config });
  const id = send(agent.id), d = daemon(); await until(() => mailbox().get(id)!.status === 'completed'); await d.stop(0);
  expect(d.failure).toBeUndefined(); return { agent, id, batchId: mailbox().get(id)!.batchId! };
}

test('M4 acceptance > 1. replay --verify matches a busy database and detects projection drift without changing live state', async () => {
  const a = agents().create({ name: 'a', provider: 'fake' }), b = agents().create({ name: 'b', provider: 'fake' });
  const ids = [send(a.id, 'one'), send(a.id, 'two'), send(a.id, 'side', 'research'), send(b.id)];
  const d = daemon(); await until(() => ids.every(id => mailbox().get(id)!.status === 'completed'));
  const cancelled = send(agents().create({ name: 'paused', provider: 'fake', config: { paused: true } }).id);
  mailbox().cancel(cancelled); mailbox().retry(cancelled);
  await until(() => d.scheduler.status().some(s => s.reason === 'paused'));
  const lock = store.db.query('SELECT * FROM daemon_lock').get();
  const check = await cli('replay', '--verify', '--json'); expect(check.code).toBe(0);
  expect(JSON.parse(check.stdout)).toMatchObject({ matches: true, projections: projectionTables.length });
  expect(store.db.query('SELECT * FROM daemon_lock').get()).toEqual(lock);
  store.write(() => store.db.query("UPDATE messages SET text='corrupt' WHERE id = ?").run(mailbox().get(ids[0]!)!.messageId));
  const broken = await cli('replay', '--verify', '--json'); expect(broken.code).toBe(1);
  expect(JSON.parse(broken.stdout).differences).toContain('messages');
  await d.stop(0);
});

test('M4 acceptance > 2. replay into two empty databases is identical, including ids, seq and timestamps', async () => {
  await completed(); const rows = events(), first = replay(rows), second = replay(rows);
  try { expect(snapshot(first)).toEqual(snapshot(second)); expect(snapshot(first)).toEqual(snapshot(store.db)); }
  finally { first.close(); second.close(); }
});

test('M4 acceptance > 3. repeated commands return the durable result, append nothing, and reject conflicting input', () => {
  const command = { id: 'stable-command', name: 'create-agent', input: { provider: 'fake', name: 'once' } };
  const first = dispatch(store, command, () => agents().create({ name: 'once', provider: 'fake' }));
  const count = events().length; store.close(); store = new Store(path);
  expect(dispatch<typeof first>(store, command, () => { throw new Error('must not execute'); })).toEqual(first);
  expect(events()).toHaveLength(count);
  expect(() => dispatch(store, { ...command, input: { name: 'different' } }, () => 0)).toThrow('different input');
  expect(agents().list()).toHaveLength(1);
  expect(() => dispatch(store, { id: 'async', name: 'bad' }, async () => 1)).toThrow('synchronous');
});

test('M4 acceptance > 4. failure halfway through turn end rolls back answer, usage, delivery, events, receipts and lane release', () => {
  const agent = agents().create({ name: 'atomic', provider: 'fake' }), id = send(agent.id), batch = mailbox().claimBatch(agent.id, null)!;
  const l = ledger(); l.begin(batch, 'fake', 'fake'); l.submitted(batch.id);
  const record = new TurnRecorder(store, batch, agent, 'thread', 'prefix');
  l.started(batch.id, 'thread', 'turn', () => { record.started('turn'); mailbox().markBatchRunning(batch.id, 'turn'); });
  record.observe({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: 'answer' } });
  record.flush(); const count = tokenCount(10, 0, 0, 6); l.observe(batch.id, { last: count, total: count });
  const before = snapshot(store.db), eventCount = events().length;
  const receiptCount = () => store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM command_receipts').get()!.n;
  const receipts = receiptCount(), seen: unknown[] = []; store.onChange(c => seen.push(c));
  store.write(() => store.db.exec("CREATE TRIGGER fail_final BEFORE UPDATE ON usage_records WHEN NEW.phase='final' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END"));
  const finish = () => l.settle(batch.id, 'completed', true, () => { record.finish({ status: 'completed' }); mailbox().finishBatch(batch.id, 'completed'); });
  expect(finish).toThrow('injected completion failure');
  expect(snapshot(store.db)).toEqual(before); expect(events()).toHaveLength(eventCount); expect(receiptCount()).toBe(receipts);
  expect(mailbox().laneBusy(agent.id, null)).toBe(true); expect(mailbox().get(id)!.status).toBe('running'); expect(seen).toEqual([]);
  expect(store.db.query('SELECT * FROM turn_scratch').all()).toHaveLength(1);
  store.write(() => store.db.exec('DROP TRIGGER fail_final')); finish();
  const end = events().slice(eventCount);
  expect(new Set(end.map(e => e.command_id)).size).toBe(1);
  expect(end.map(e => e.type)).toEqual(['item.completed', 'turn.completed', 'delivery.finished', 'usage.recorded']);
  expect(mailbox().laneBusy(agent.id, null)).toBe(false); expect(readLog(store, agent.id).at(-1)!.text).toBe('answer');
  expect(verifyReplay(store).matches).toBe(true);
});

test('M4 acceptance > 5. daemon and database restart retain the full conversation in kru log', async () => {
  const { agent } = await completed(); store.close(); store = new Store(path);
  const second = send(agent.id, 'remember me'), d = daemon(); await until(() => mailbox().get(second)!.status === 'completed'); await d.stop(0);
  const result = await cli('log', agent.name, '--json'); expect(result.code).toBe(0);
  const rows = result.stdout.trim().split('\n').map(s => JSON.parse(s));
  const answers = rows.filter(r => r.role === 'assistant').map(r => r.text);
  expect(answers).toHaveLength(2); expect(answers[0]).toBe('Echo: hello'); expect(answers[1]).toEndWith('remember me');
  expect(rows.filter(r => r.role === 'user')).toHaveLength(2); expect(verifyReplay(store).matches).toBe(true);
});

test('M4 acceptance > 6. cost totals equal final usage events, not the sum of checkpoints', async () => {
  await completed({ model: 'claude-sonnet-4-6' }); await completed({ model: 'claude-sonnet-4-6' });
  const total = events().filter(e => e.type === 'usage.recorded').reduce((n, e) => n + JSON.parse(JSON.parse(e.payload_json).row.cost_json).maximumNanoUsd, 0) / 1e9;
  const result = await cli('cost', '--by', 'agent', '--since', '7d', '--json'); expect(result.code).toBe(0);
  const cost = JSON.parse(result.stdout); expect(cost.maximumUsd).toBe(total); expect(cost.turns).toHaveLength(2); expect(cost.groups).toHaveLength(2);
  expect(cost.turns.every((r: { priceId: unknown }) => typeof r.priceId === 'string')).toBe(true);
  expect(events().filter(e => e.type === 'usage.checkpointed').length).toBeGreaterThan(2);
});

test('M4 acceptance > 7. an unknown price is NULL and visibly unpriced, never free', async () => {
  await completed({ model: 'unpriced-model' });
  expect(store.db.query('SELECT cost_usd, price_id FROM usage_records').get()).toEqual({ cost_usd: null, price_id: null });
  const result = await cli('cost', '--json'); const cost = JSON.parse(result.stdout);
  expect(cost.unknown).toBe(1); expect(cost.turns[0].maximumUsd).toBeNull();
  expect((await cli('cost')).stdout).toContain('unpriced');
});

test('M4 acceptance > 8. changing a price affects new turns and never rewrites historical costs', () => {
  const book = new PriceBook(store), price = { ...modelPrices['claude-sonnet-4-6']!, model: 'metered', source: 'fixture://pricing' };
  const firstPrice = book.add('fake', price, '2026-01-01T00:00:00Z');
  const a = agents().create({ name: 'priced', provider: 'fake' });
  const record = (at: string) => {
    send(a.id); const batch = mailbox().claimBatch(a.id, null)!, l = ledger();
    l.begin(batch, 'fake', 'metered', at); l.submitted(batch.id); l.started(batch.id, 'thread', batch.id); mailbox().markBatchRunning(batch.id, batch.id);
    const count = tokenCount(100, 20, 10, 10); l.observe(batch.id, { last: count, total: count });
    l.settle(batch.id, 'completed', true, () => mailbox().finishBatch(batch.id, 'completed')); return l.list().at(-1)!;
  };
  const first = record('2026-02-01T00:00:00.000Z');
  const nextPrice = book.add('fake', { ...price, output: price.output * 2 }, '2026-03-01T00:00:00Z');
  const next = record('2026-04-01T00:00:00.000Z');
  expect(first.priceId).toBe(firstPrice); expect(next.priceId).toBe(nextPrice);
  expect(ledger().list()[0]!.cost).toEqual(first.cost); expect(next.cost!.maximumNanoUsd!).toBeGreaterThan(first.cost!.maximumNanoUsd!);
  expect(verifyReplay(store).matches).toBe(true);
});

test('M4 acceptance > 9. restart with a spent dollar or token budget stays held', async () => {
  const { agent } = await completed({ model: 'claude-sonnet-4-6', dailyUsd: .000000001 });
  const next = send(agent.id); store.close(); store = new Store(path);
  const d = daemon(); await until(() => d.scheduler.status()[0]?.reason === 'budget');
  expect(d.scheduler.status()[0]!.budgetDetail).toBe('USD limit');
  agents().update(agent.id, { config: { dailyUsd: 100, dailyTokens: 0 } });
  await until(() => d.scheduler.status()[0]?.budgetDetail === 'token limit'); expect(mailbox().get(next)!.status).toBe('queued');
  agents().update(agent.id, { config: { dailyTokens: 10000 } }); await until(() => mailbox().get(next)!.status === 'completed');
});

test('M4 acceptance > 10. changing budget timezone never rewrites usage timestamps or its recorded day', async () => {
  const { agent } = await completed();
  const before = ledger().list(), now = Date.now();
  for (const zone of ['Asia/Kuala_Lumpur', 'UTC', 'America/New_York']) {
    const total = ledger().totals(agent.id, new BudgetCalendar(zone), now);
    expect(total.tokens).toBe(before[0]!.usage!.last.totalTokens);
  }
  expect(ledger().list()).toEqual(before); expect(verifyReplay(store).matches).toBe(true);
});

test('M4 acceptance > 11. an old stored payload version is read through its upcaster', () => {
  const row = { seq: 900, id: 'legacy', command_id: 'legacy-import', type: 'agent.configured', version: 0,
    payload_json: JSON.stringify({ agent: { id: 'old', name: 'old', provider: 'fake', config_json: '{}', created_at: '2020-01-01T00:00:00Z' } }), occurred_at: '2020-01-01T00:00:00Z' };
  const db = replay([row]);
  try { expect(db.query('SELECT created_at FROM agents').get()).toEqual({ created_at: '2020-01-01T00:00:00Z' }); }
  finally { db.close(); }
  expect(() => replay([{ ...row, version: 999 }])).toThrow('Unsupported');
});

test('M4 acceptance > 12. frozen v2 migration imports genesis in seq order and matches every projection', () => {
  const legacy = join(dir, 'v2.sqlite'), db = new Database(legacy);
  db.exec(readFileSync(new URL('./fixtures/store/v2.sql', import.meta.url), 'utf8')); db.close();
  const imported = new Store(legacy);
  try {
    expect(verifyReplay(imported).matches).toBe(true);
    expect(new SqliteMailbox(imported).listQueue('fixture-agent')[0]!.seq).toBe(1);
    const seq = imported.db.query<{ payload_json: string }, []>("SELECT payload_json FROM events WHERE type='delivery.imported' ORDER BY seq").all().map(r => JSON.parse(r.payload_json).row.seq);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    const count = imported.db.query('SELECT count(*) AS n FROM events').get(); imported.close();
    const reopened = new Store(legacy); try { expect(reopened.db.query('SELECT count(*) AS n FROM events').get()).toEqual(count); } finally { reopened.close(); }
  } finally { imported.close(); }
});

test('deltas are live-only, out-of-order items assemble correctly, and scratch is operational', () => {
  const agent = agents().create({ name: 'stream', provider: 'fake' }); send(agent.id); const batch = mailbox().claimBatch(agent.id, null)!;
  const record = new TurnRecorder(store, batch, agent, 'thread', 'prefix');
  record.started('turn'); const count = events().length, deltas: unknown[] = [];
  store.onChange(c => { if (c.topic === 'turn-delta') deltas.push(c.value); });
  const delta = (text: string) => record.observe({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: text } });
  delta('hello'); record.observe({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: '' } } }); delta(' world');
  record.flush(); expect(events()).toHaveLength(count); expect(deltas).toHaveLength(2);
  expect(readLog(store, agent.id, undefined, true).at(-1)!.text).toBe('hello world'); expect(verifyReplay(store).matches).toBe(true);
  record.finish({ status: 'interrupted' }); expect(readLog(store, agent.id).at(-1)).toMatchObject({ text: 'hello world', partial: true });
});

test('boot preserves a crashed partial answer as interrupted history without logging deltas', () => {
  const agent = agents().create({ name: 'crash', provider: 'fake' }); send(agent.id); const batch = mailbox().claimBatch(agent.id, null)!;
  // Scratch can be left by a different process; boot imports it as a final partial item.
  const row = { id: batch.id, agent_id: agent.id, lane_key: '', provider: 'fake', native_thread_id: 'thread', native_turn_id: 'turn', model: 'fake', profile: 'minimal', prefix_hash: 'prefix', status: 'running', error: null, started_at: '2026-11-04T00:00:00Z', completed_at: null, duration_ms: null, deliveries_json: '[]', chains_json: '[]' };
  store.command('prepare-crash', () => store.emit('turn.started', { row }));
  store.write(() => store.db.query('INSERT INTO turn_scratch(turn_id,agent_id,lane_key,items_json,updated_at) VALUES (?, ?, ?, ?, ?)').run(batch.id, agent.id, '', JSON.stringify([{ item: { id: 'partial', type: 'agentMessage', text: 'saved partial' }, completed: false }]), '2026-11-04T00:00:01Z'));
  new SqliteTurnHistory(store).recover(); expect(readLog(store, agent.id).at(-1)).toMatchObject({ text: 'saved partial', partial: true });
  expect(store.db.query('SELECT status FROM turns').get()).toEqual({ status: 'interrupted' }); expect(verifyReplay(store).matches).toBe(true);
});

test('native command/file fields and Claude tool inputs and results survive recording; duplicate ends are idempotent', () => {
  const agent = agents().create({ name: 'items', provider: 'fake' }); send(agent.id); const batch = mailbox().claimBatch(agent.id, null)!;
  const recorder = new TurnRecorder(store, batch, agent, 'thread', 'prefix'); recorder.started('turn');
  const item = (value: AgentItem, method: 'item/started' | 'item/completed') => recorder.observe({ method, params: { threadId: 'thread', turnId: 'turn', item: value } });
  item({ id: 'command', type: 'commandExecution', command: 'echo ok', cwd: '/tmp', aggregatedOutput: 'ok' } as AgentItem, 'item/completed');
  item({ id: 'files', type: 'fileChange', changes: [{ path: 'example.ts', kind: 'add' }] } as AgentItem, 'item/completed');
  item({ id: 'tool', type: 'tool', details: { name: 'Read', input: { file_path: 'example.ts' } } }, 'item/started');
  item({ id: 'tool', type: 'tool', details: { content: 'source', isError: false } }, 'item/completed');
  recorder.finish({ status: 'completed' }); const count = events().length; recorder.finish({ status: 'completed' }); expect(events()).toHaveLength(count);
  const rows = readLog(store, agent.id);
  expect(rows.find(r => r.role === 'commandExecution')!.details).toMatchObject({ command: 'echo ok', aggregatedOutput: 'ok' });
  expect(rows.find(r => r.role === 'fileChange')!.details).toMatchObject({ changes: [{ path: 'example.ts', kind: 'add' }] });
  expect(rows.find(r => r.role === 'tool')!.details).toMatchObject({ name: 'Read', input: { file_path: 'example.ts' }, content: 'source', isError: false });
});
