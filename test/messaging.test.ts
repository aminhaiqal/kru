import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, verifyReplay, snapshot } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { FakeProvider, type FakeTurnScript } from '../src/providers/fake/adapter';
import { ToolRouter, SqliteToolState, agentToolDefinitions, type ToolContext } from '../src/tools';
import { SqliteUsageLedger } from '../src/usage/sqlite';
import { TurnRecorder } from '../src/turns/recorder';
import { tokenCount } from '../src/providers/token-usage';
import type { ToolCall, ToolResult } from '../src/providers/protocol';
import { toolCallKey } from '../src/tools/idempotency';
import { TurnAnswer } from '../src/tools/delivery-content';
import type { AgentItem } from '../src/providers/protocol';

let dir: string, path: string, store: Store, agents: AgentRegistry, mailbox: SqliteMailbox;
const daemons: Daemon[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kru-m5-')); path = join(dir, 'db.sqlite'); store = new Store(path);
  agents = new AgentRegistry(store); mailbox = new SqliteMailbox(store);
});
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(0); store.close(); rmSync(dir, { recursive: true, force: true }); });
const agent = (name: string, config: Record<string, unknown> = {}) => agents.create({ name, provider: 'fake', config });
const send = (id: string, text = 'start', laneId?: string) => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [id], text, ...(laneId ? { laneId } : {}) }).deliveryIds[0]!;
const unpack = (r: ToolResult) => JSON.parse(r.contentItems[0]!.text);
const deliveries = () => store.db.query<{ id: string; recipient_id: string; status: string; hop: number; chain_id: string; message_id: string; lane_id: string | null }, []>('SELECT * FROM deliveries ORDER BY seq').all();
async function until(fn: () => boolean, timeout = 3000) { const end = performance.now() + timeout; while (!fn()) { if (performance.now() > end) throw new Error('Timed out'); await Bun.sleep(3); } }
function start(scripts: Record<string, FakeTurnScript>, maxHops = 4) {
  const d = new Daemon(store, { maxTurns: 1, maxHops }, a => new FakeProvider({ delayMs: 2, ...(scripts[a.name] ? { script: scripts[a.name] } : {}) }));
  daemons.push(d); d.start(); return d;
}
function context(name = 'a'): ToolContext {
  const a = agent(name); send(a.id); const batch = mailbox.claimBatch(a.id, null)!;
  return { agent: a, batch, threadId: `thread:${a.id}`, turnId: 'turn' };
}
function call(c: ToolContext, args: unknown, callId = 'call', tool = 'send_message'): ToolCall {
  return { threadId: c.threadId, turnId: c.turnId, callId, tool, arguments: args };
}

test('M5 acceptance > 1. A ends without waiting for paused B; B answers as a new delivery in A original lane', async () => {
  const a = agent('a'), b = agent('b', { paused: true }), first = send(a.id, 'ask', 'review');
  const d = start({ a: async (input, tool) => {
    if (input.startsWith('Kru delivery context:')) return 'Thanks, review received.';
    const list = await tool('list_agents', {}); expect(unpack(list).agents.map((a: { name: string }) => a.name)).toContain('b');
    const result = await tool('send_message', { to: ['b'], text: 'Review this change', expectsReply: true });
    expect(result.success).toBe(true); return 'Review queued; my turn can end.';
  }, b: async input => { expect(input).toContain('"expectsReply":true'); return 'Reviewed: looks correct.'; } });
  await until(() => mailbox.get(first)!.status === 'completed');
  expect(deliveries()).toHaveLength(2); expect(deliveries()[1]!.status).toBe('queued');
  agents.update(b.id, { config: { paused: false } });
  await until(() => deliveries().length === 3 && deliveries().every(r => r.status === 'completed'));
  expect(deliveries().map(r => r.recipient_id)).toEqual([a.id, b.id, a.id]);
  expect(deliveries()[2]!.lane_id).toBe('review'); expect(deliveries().map(r => r.hop)).toEqual([0, 1, 2]);
  expect(new Set(deliveries().map(r => r.chain_id)).size).toBe(1);
  const reply = mailbox.get(deliveries()[2]!.id)!; expect(reply.expectsReply).toBe(false); expect(reply.replyToMessageId).toBe(deliveries()[1]!.message_id);
  expect(d.failure).toBeUndefined(); expect(verifyReplay(store).matches).toBe(true);
});

test('M5 acceptance > 2. acknowledgement exchange stops because a thanks message never opts into a reply', async () => {
  const a = agent('a'); agent('b'); send(a.id);
  const d = start({ a: async (input, tool) => {
    if (!input.startsWith('Kru delivery context:')) { await tool('send_message', { to: ['b'], text: 'Question', expectsReply: true }); return 'Question queued'; }
    const thanks = await tool('send_message', { to: ['b'], text: 'Thanks!' });
    expect(unpack(thanks).expectsReply).toBe(false); return 'Done';
  }, b: async input => input.includes('Thanks!') ? 'Thanks to you too!' : 'Answer' });
  await until(() => deliveries().length === 4 && deliveries().every(r => r.status === 'completed'));
  await Bun.sleep(20); expect(deliveries()).toHaveLength(4); expect(d.scheduler.activeTurns).toBe(0);
  expect(deliveries().map(r => mailbox.get(r.id)!.expectsReply)).toEqual([false, true, false, false]);
});

test('M5 acceptance > 3. deliberate forwarding loop reaches maxHops, returns a tool error and starts no extra turn', async () => {
  const a = agent('a'); agent('b'); send(a.id);
  const errors: string[] = [];
  const script = (other: string): FakeTurnScript => async (_input, tool) => {
    const result = await tool('send_message', { to: [other], text: 'Forward again' });
    if (!result.success) errors.push(unpack(result).error); return 'finished';
  };
  const d = start({ a: script('b'), b: script('a') });
  await until(() => errors.length === 1 && deliveries().every(r => r.status === 'completed'));
  expect(deliveries().map(r => r.hop)).toEqual([0, 1, 2, 3, 4]); expect(errors[0]).toContain('maxHops (4)');
  expect(new SqliteUsageLedger(store).list()).toHaveLength(5); expect(d.scheduler.activeTurns).toBe(0);
  await Bun.sleep(15); expect(deliveries()).toHaveLength(5);
});

test('M5 acceptance > 4. cost --by chain accounts for every turn and token in an A-B exchange', async () => {
  const a = agent('a', { model: 'claude-sonnet-4-6' }); agent('b', { model: 'claude-sonnet-4-6' }); send(a.id);
  const d = start({ a: async (input, tool) => { if (!input.startsWith('Kru delivery context:')) await tool('send_message', { to: ['b'], text: 'Question', expectsReply: true }); return 'A answer'; }, b: async () => 'B answer' });
  await until(() => deliveries().length === 3 && deliveries().every(r => r.status === 'completed')); await d.stop(0);
  const p = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'cost', '--by', 'chain', '--json', '--db', path], { stdout: 'pipe', stderr: 'pipe' });
  expect(await p.exited).toBe(0); const report = JSON.parse(await new Response(p.stdout).text());
  const records = new SqliteUsageLedger(store).list(); expect(report.groups).toHaveLength(1); expect(report.groups[0].turns).toBe(3);
  expect(report.groups[0].input).toBe(records.reduce((n, r) => n + r.usage!.last.inputTotal, 0));
  expect(report.maximumUsd).toBe(records.reduce((n, r) => n + r.cost!.maximumNanoUsd!, 0) / 1e9);
  expect(report.groups[0].maximumUsd).toBeCloseTo(report.maximumUsd, 12);
  expect(JSON.parse(report.groups[0].key)).toEqual([deliveries()[0]!.chain_id]);
});

test('tool receipts survive reopen; duplicate calls append nothing and conflicting arguments cannot resend', () => {
  const c = context(); const b = agent('b');
  let router = new ToolRouter(mailbox, agents, new SqliteToolState(store));
  const request = call(c, { to: [b.id], text: 'once' }); const first = router.handle(c, request);
  const count = store.db.query('SELECT count(*) AS n FROM events').get(); store.close(); store = new Store(path); mailbox = new SqliteMailbox(store); agents = new AgentRegistry(store);
  router = new ToolRouter(mailbox, agents, new SqliteToolState(store));
  expect(router.handle(c, request)).toEqual(first); expect(store.db.query('SELECT count(*) AS n FROM events').get()).toEqual(count);
  expect(router.handle(c, { ...request, arguments: { to: [b.id], text: 'different' } }).success).toBe(false);
  expect(deliveries()).toHaveLength(2); expect(verifyReplay(store).matches).toBe(true);
});

test('manual answer forces replies off and suppresses a duplicate automatic answer', async () => {
  const a = agent('a'); agent('b'); send(a.id);
  start({ a: async (input, tool) => { if (!input.startsWith('Kru delivery context:')) await tool('send_message', { to: ['b'], text: 'Question', expectsReply: true }); return 'A done'; }, b: async (_input, tool) => {
    const result = await tool('send_message', { to: ['a'], text: 'Manual answer', expectsReply: true });
    expect(result.success).toBe(true); expect(unpack(result).expectsReply).toBe(false); return 'Automatic answer must not duplicate this';
  } });
  await until(() => deliveries().length === 3 && deliveries().every(r => r.status === 'completed'));
  expect(mailbox.get(deliveries()[2]!.id)!.text).toBe('Manual answer'); expect(store.db.query('SELECT * FROM delivery_replies').all()).toHaveLength(1);
});

test('tool validation, sender ownership and list_agents do not expose private agent configuration', () => {
  const c = context(); agent('b', { instructions: 'private instructions' }); const router = new ToolRouter(mailbox, agents, new SqliteToolState(store));
  const list = router.handle(c, call(c, {}, 'list', 'list_agents')); expect(JSON.stringify(list)).not.toContain('private instructions');
  const invalid = [null, [], { to: ['missing'], text: 'x' }, { to: ['b', 'b'], text: 'x' }, { to: ['a'], text: 'x' }, { to: ['b'], text: 'x', expectsReply: 'yes' }, { to: ['b'], text: 'x', chain: { id: 'fake', hop: 0 } }, { to: ['b'], text: 'x', inReplyTo: 'foreign-message' }];
  for (const [i, args] of invalid.entries()) expect(router.handle(c, call(c, args, `bad-${i}`)).success).toBe(false);
  expect(router.handle(c, { ...call(c, { to: ['b'], text: 'x' }), turnId: 'wrong' }).success).toBe(false);
  expect(deliveries()).toHaveLength(1);
});

test('batched user messages select the last chain unless inReplyTo explicitly selects another current message', () => {
  const a = agent('a'); agent('b'); send(a.id, 'one'); send(a.id, 'two'); const batch = mailbox.claimBatch(a.id, null)!;
  const c = { agent: a, batch, threadId: 'thread', turnId: 'turn' }, router = new ToolRouter(mailbox, agents, new SqliteToolState(store));
  const last = unpack(router.handle(c, call(c, { to: ['b'], text: 'last' }, 'last')));
  const first = unpack(router.handle(c, call(c, { to: ['b'], text: 'first', inReplyTo: batch.deliveries[0]!.messageId }, 'first')));
  expect(last.chainId).toBe(batch.deliveries[1]!.chainId); expect(first.chainId).toBe(batch.deliveries[0]!.chainId);
});

test('reply opt-in reserves a hop and maxHops=0 disables outbound agent messages', () => {
  const c = context(); agent('b');
  const one = new ToolRouter(mailbox, agents, new SqliteToolState(store), { maxHops: 1 });
  expect(one.handle(c, call(c, { to: ['b'], text: 'x', expectsReply: true }, 'request')).success).toBe(false);
  expect(one.handle(c, call(c, { to: ['b'], text: 'x' }, 'notice')).success).toBe(true);
  const zero = new ToolRouter(mailbox, agents, new SqliteToolState(store), { maxHops: 0 });
  expect(zero.handle(c, call(c, { to: ['b'], text: 'x' }, 'zero')).success).toBe(false);
});

test('reply enqueue, answer, usage and source completion roll back together on a reply projector failure', () => {
  const a = agent('a'), b = agent('b'), state = new SqliteToolState(store);
  mailbox.enqueue({ sender: { kind: 'agent', agentId: a.id }, recipientIds: [b.id], text: 'Question', expectsReply: true, chain: { id: 'chain', hop: 1 } });
  const batch = mailbox.claimBatch(b.id, null)!, c = { agent: b, batch, threadId: 'thread', turnId: 'turn' };
  const ledger = new SqliteUsageLedger(store), recorder = new TurnRecorder(store, batch, b, 'thread', 'prefix'), router = new ToolRouter(mailbox, agents, state);
  ledger.begin(batch, 'fake', 'fake'); ledger.submitted(batch.id); ledger.started(batch.id, 'thread', 'turn'); mailbox.markBatchRunning(batch.id, 'turn'); recorder.started('turn');
  const count = tokenCount(10, 0, 0, 10); ledger.observe(batch.id, { last: count, total: count });
  const before = snapshot(store.db), events = store.db.query('SELECT count(*) AS n FROM events').get();
  store.write(() => store.db.exec("CREATE TRIGGER reject_reply BEFORE INSERT ON delivery_replies BEGIN SELECT RAISE(ABORT,'reply rollback'); END"));
  const finish = () => ledger.settle(batch.id, 'completed', true, () => { recorder.finish({ status: 'completed' }); router.finish(c, 'Answer', 'completed'); mailbox.finishBatch(batch.id, 'completed'); });
  expect(finish).toThrow('reply rollback'); expect(snapshot(store.db)).toEqual(before); expect(store.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);
  expect(mailbox.laneBusy(b.id, null)).toBe(true); store.write(() => store.db.exec('DROP TRIGGER reject_reply')); finish();
  expect(deliveries()).toHaveLength(2); expect(verifyReplay(store).matches).toBe(true);
});

test('only the two M5 tool declarations enter the daemon native prefix, not roster or delivery data', async () => {
  const a = agent('a'); send(a.id);
  start({ a: async () => 'done' }); await until(() => deliveries().every(r => r.status === 'completed'));
  const turn = store.db.query<{ prefix_hash: string; profile: string }, []>('SELECT * FROM turns').get()!;
  agent('new-roster-entry'); send(a.id, 'different input'); await until(() => deliveries().length === 2 && deliveries().every(r => r.status === 'completed'));
  expect(store.db.query<{ prefix_hash: string }, []>('SELECT prefix_hash FROM turns').all().map(r => r.prefix_hash)).toEqual([turn.prefix_hash, turn.prefix_hash]);
  expect(agentToolDefinitions.map(t => t.name)).toEqual(['list_agents', 'send_message']);
});

test('tool identifiers are length-bounded and distinct even with separators or very long native ids', () => {
  const key = toolCallKey('codex', { threadId: 'x'.repeat(100000), turnId: 'turn', callId: 'call' });
  expect(key).toHaveLength(69);
  expect(toolCallKey('codex', { threadId: 'a:b', turnId: 'c', callId: 'd' })).not.toBe(toolCallKey('codex', { threadId: 'a', turnId: 'b:c', callId: 'd' }));
});

test('automatic answers retain final text and exclude explicitly marked native commentary', () => {
  const answer = new TurnAnswer();
  for (const item of [
    { id: 'final', type: 'agentMessage', text: 'Actual answer', phase: 'final_answer' },
    { id: 'progress', type: 'agentMessage', text: 'Working on this', phase: 'commentary' },
  ]) answer.observe({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: item as AgentItem } });
  expect(answer.text()).toBe('Actual answer');
});

test('tool validation includes routing overhead before queueing and failed/empty turns never auto-reply', () => {
  const c = context(); agent('b'); const router = new ToolRouter(mailbox, agents, new SqliteToolState(store));
  expect(router.handle(c, call(c, { to: ['b'], text: 'x'.repeat(32768) })).success).toBe(false); expect(deliveries()).toHaveLength(1);
  const b = agents.resolve('b')!;
  for (const status of ['completed', 'failed', 'interrupted'] as const) {
    mailbox.enqueue({ sender: { kind: 'agent', agentId: c.agent.id }, recipientIds: [b.id], text: 'request', expectsReply: true });
    const batch = mailbox.claimBatch(b.id, null)!;
    router.finish({ agent: b, batch, threadId: 'b-thread', turnId: batch.id }, '', status);
    mailbox.finishBatch(batch.id, 'interrupted');
  }
  expect(store.db.query("SELECT * FROM delivery_replies WHERE outcome='suppressed'").all()).toHaveLength(3);
  expect(deliveries()).toHaveLength(4);
});
