import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { SqliteUsageLedger } from '../src/usage/sqlite';
import { Daemon } from '../src/daemon';
import { BudgetCalendar } from '../src/scheduler/budget-day';
import { tokenCount } from '../src/providers/token-usage';
let dir: string, path: string, store: Store, agents: AgentRegistry, mailbox: SqliteMailbox, ledger: SqliteUsageLedger;
const daemons: Daemon[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kru-ledger-')); path = join(dir, 'db.sqlite'); store = new Store(path);
  agents = new AgentRegistry(store); mailbox = new SqliteMailbox(store); ledger = new SqliteUsageLedger(store);
});
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(0); store.close(); rmSync(dir, { recursive: true, force: true }); });
const send = (id: string) => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [id], text: 'hello' }).deliveryIds[0]!;
async function until(fn: () => boolean) { const end = performance.now() + 2000; while (!fn()) { if (performance.now() > end) throw new Error('Timed out'); await Bun.sleep(3); } }
function daemon() { const d = new Daemon(store); daemons.push(d); d.start(); return d; }

test('USD and token gates both apply, and known spending survives daemon restarts', async () => {
  const a = agents.create({ name: 'priced', provider: 'fake', config: { model: 'claude-sonnet-4-6', dailyUsd: .000000001 } });
  const first = send(a.id); const d = daemon(); await until(() => mailbox.get(first)!.status === 'completed');
  const next = send(a.id); await until(() => d.scheduler.status()[0]?.reason === 'budget');
  expect(d.scheduler.status()[0]!.budgetDetail).toBe('USD limit');
  const original = ledger.list()[0]!.cost!.maximumNanoUsd!;
  await d.stop(0); const second = daemon();
  await until(() => second.scheduler.status()[0]?.reason === 'budget');
  expect(ledger.list()[0]!.cost!.maximumNanoUsd).toBe(original);
  agents.update(a.id, { config: { dailyTokens: 0, dailyUsd: 100 } });
  await until(() => second.scheduler.status()[0]?.budgetDetail === 'token limit');
  agents.update(a.id, { config: { dailyTokens: 10000 } }); await until(() => mailbox.get(next)!.status === 'completed');
  expect(ledger.list()).toHaveLength(2);
  const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'cost', '--db', path, '--json'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0); const report = JSON.parse(await new Response(child.stdout).text());
  expect(report.currency).toBe('USD'); expect(report.unknown).toBe(0); expect(report.maximumUsd).toBeGreaterThan(0);
});

test('usage and batch completion roll back together, publish nothing on rollback, and replace duplicate snapshots', () => {
  const a = agents.create({ name: 'a', provider: 'fake' }); const ids = [send(a.id), send(a.id)];
  const batch = mailbox.claimBatch(a.id, null)!;
  ledger.begin(batch, 'claude', 'claude-sonnet-4-6'); ledger.submitted(batch.id); ledger.started(batch.id, 'thread', 'turn');
  mailbox.markBatchRunning(batch.id, 'turn');
  const count = tokenCount(100, 50, 20, 10), usage = { last: count, total: count };
  ledger.observe(batch.id, usage); ledger.observe(batch.id, usage);
  expect(ledger.list()).toHaveLength(1);
  expect(ledger.totals(a.id, new BudgetCalendar(), Date.now()).tokens).toBe(110);
  const changes: unknown[] = []; mailbox.onChange(c => changes.push(c));
  store.write(() => store.db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON deliveries
    WHEN NEW.seq = 2 AND NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'rollback'); END`));
  expect(() => ledger.settle(batch.id, 'completed', true, () => mailbox.finishBatch(batch.id, 'completed'))).toThrow('rollback');
  expect(changes).toEqual([]); expect(ledger.list()[0]!.phase).toBe('submitted');
  expect(ids.map(id => mailbox.get(id)!.status)).toEqual(['running', 'running']);
  store.write(() => store.db.exec('DROP TRIGGER reject_completion'));
  ledger.settle(batch.id, 'completed', true, () => mailbox.finishBatch(batch.id, 'completed'));
  expect(ledger.list()[0]!.complete).toBe(true); expect(changes).toHaveLength(2);
  expect(() => ledger.begin(batch, 'claude', 'claude-sonnet-4-6')).toThrow('already exists');
});

test('recovery retains unknown usage gaps for submitted and conservatively interrupted starting work', async () => {
  const a = agents.create({ name: 'a', provider: 'fake', config: { model: 'claude-sonnet-4-6', dailyUsd: 1 } });
  const old = send(a.id); const batch = mailbox.claimBatch(a.id, null)!;
  ledger.begin(batch, 'claude', 'claude-sonnet-4-6'); ledger.submitted(batch.id);
  const b = agents.create({ name: 'prepared', provider: 'fake' }); const unsent = send(b.id);
  const prepared = mailbox.claimBatch(b.id, null)!; ledger.begin(prepared, 'fake', 'fake');
  let d = daemon(); await d.ready; expect(mailbox.get(old)!.status).toBe('interrupted');
  expect(mailbox.get(unsent)!.status).toBe('interrupted');
  expect(ledger.list().some(row => row.batchId === prepared.id)).toBe(false);
  const next = send(a.id); await until(() => d.scheduler.status()[0]?.reason === 'budget');
  expect(d.scheduler.status()[0]!.budgetDetail).toContain('unknown');
  for (let i = 0; i < 2; i++) {
    await d.stop(0); d = daemon(); await until(() => d.scheduler.status()[0]?.reason === 'budget');
    expect(mailbox.get(next)!.status).toBe('queued');
  }
  const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'cost', 'acknowledge', batch.id,
    '--tokens', '100', '--usd', '.01', '--note', 'reviewed interrupted run', '--db', path], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0); await until(() => mailbox.get(next)!.status === 'completed');
  expect(JSON.parse(ledger.recoveryList().find(row=>row.execution_id===batch.id)!.resolution_json!).note).toBe('reviewed interrupted run');
  expect(() => ledger.acknowledge(batch.id, 0, 0, 'overwrite')).toThrow('already resolved');
});

test('unpriced models cannot run under a dollar limit', async () => {
  const a = agents.create({ name: 'a', provider: 'fake', config: { model: 'unknown', dailyUsd: 1 } }); const id = send(a.id), d = daemon();
  await until(() => d.scheduler.status()[0]?.reason === 'budget'); expect(mailbox.get(id)!.status).toBe('queued');
  agents.update(a.id, { config: { model: 'claude-sonnet-4-6' } }); await until(() => mailbox.get(id)!.status === 'completed');
});
