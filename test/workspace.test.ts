import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { verifyReplay } from '../src/store/replay';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { FakeProvider, type FakeProviderOptions } from '../src/providers/fake/adapter';
import { nextRun, RoutineRunner, WorkspaceRecords } from '../src/workspace';
import type { ToolContext } from '../src/tools/ports';
import { ApprovalBroker } from '../src/workspace/approvals';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await Bun.sleep(10);
  }
}
function env() {
  const dir = mkdtempSync(join(tmpdir(), 'kru-workspace-')),
    path = join(dir, 'db.sqlite'),
    store = new Store(path);
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const agents = new AgentRegistry(store),
    mailbox = new SqliteMailbox(store),
    records = new WorkspaceRecords(store);
  const agent = agents.create({ name: 'worker', provider: 'fake' });
  return { dir, path, store, agents, mailbox, records, agent };
}
async function daemon(
  e: ReturnType<typeof env>,
  options: FakeProviderOptions = {},
  scheduler = {},
) {
  const d = new Daemon(e.store, { pollMs: 10, ...scheduler }, () => new FakeProvider(options));
  cleanups.push(() => d.stop(0));
  d.start();
  await d.ready;
  return d;
}

test('workspace state is scoped, transactional, durable and replayable, including removal', () => {
  const e = env(),
    other = e.agents.create({ name: 'other', provider: 'fake' });
  const own = e.records.put('memory', e.agent.id, { key: 'language', text: 'Use English.' });
  e.records.put('memory', other.id, { key: 'private', text: 'Other agent context.' });
  e.records.put('skill', e.agent.id, {
    name: 'Review',
    instructions: 'Read the diff and verify the changes.',
  });
  expect(e.records.list('memory', e.agent.id).map((m) => m.data.key)).toEqual(['language']);
  expect(() => e.records.put('memory', other.id, own.data, own.id)).toThrow('ownership');
  expect(() =>
    e.store.atomic(() => {
      e.records.put('memory', e.agent.id, { key: 'rollback', text: 'Discard me.' });
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  e.records.remove('memory', own.id);
  expect(e.records.get('memory', own.id)).toBeNull();
  const reopened = new Store(e.path);
  try {
    expect(new WorkspaceRecords(reopened).list('skill', e.agent.id)).toHaveLength(1);
    expect(verifyReplay(reopened).matches).toBe(true);
  } finally {
    reopened.close();
  }
});

test('tasks continue across turns and only finish with explicit checked steps and evidence', async () => {
  const e = env();
  let count = 0;
  const d = await daemon(e, {
    script: async (_prompt, call) => {
      count++;
      const reply = await call('task_update', {
        steps: [{ text: 'Verify result', done: count === 2 }],
        status: count === 2 ? 'completed' : 'running',
        result: count === 2 ? 'Verified expected result.' : 'Prepared input.',
      });
      expect(reply.success).toBe(true);
      return count === 2 ? 'Complete.' : 'Continue with verification.';
    },
  });
  const task = d.workspace.tasks.create(e.agent.id, {
    title: 'Two step task',
    objective: 'Prepare and verify a result.',
    maxTurns: 3,
  });
  await until(() => e.records.require('task', task.id).data.status === 'completed');
  await until(() => e.mailbox.activeLanes().length === 0);
  const final = e.records.require('task', task.id);
  expect(final.data.attempts).toBe(2);
  expect(final.data.steps.every((s) => s.done)).toBe(true);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('task loop is bounded; explicit resume starts a new attempt and cancellation stops queued work', async () => {
  const e = env(),
    d = await daemon(e, { script: async () => 'More work remains.' });
  const task = d.workspace.tasks.create(e.agent.id, {
    title: 'Bounded task',
    objective: 'Do work.',
    maxTurns: 1,
  });
  await until(() => e.records.require('task', task.id).data.status === 'blocked');
  expect(e.records.require('task', task.id).data.error).toContain('Turn limit');
  e.agents.update(e.agent.id, { config: { paused: true } });
  const resumed = d.workspace.tasks.resume(task.id);
  expect(resumed.data.attempts).toBe(2);
  const cancelled = d.workspace.tasks.cancel(task.id);
  expect(cancelled.data.status).toBe('cancelled');
  expect(e.mailbox.get(resumed.data.deliveryIds[0]!)?.status).toBe('cancelled');
});

test('task_update rejects foreign lanes and false completion', () => {
  const e = env(),
    d = new Daemon(e.store);
  cleanups.push(() => d.stop(0));
  e.agents.update(e.agent.id, { config: { paused: true } });
  const task = d.workspace.tasks.create(e.agent.id, { title: 'Task', objective: 'Do it.' });
  const batch = e.mailbox.claimBatch(e.agent.id, 'task:' + task.id)!;
  const context: ToolContext = { agent: e.agent, batch, threadId: 'thread', turnId: 'turn' };
  d.workspace.tasks.update(context, {
    steps: [{ text: 'Prepare result', done: true }],
    result: 'Kept result.',
  });
  const patched = d.workspace.tasks.update(context, {
    steps: [{ text: 'Verify result', done: false }],
  });
  expect(patched.data.status).toBe('running');
  expect(patched.data.result).toBe('Kept result.');
  expect(() =>
    d.workspace.tasks.update(context, {
      status: 'completed',
      result: '',
      steps: [{ text: 'Unfinished', done: false }],
    }),
  ).toThrow('Completion needs');
  expect(() =>
    d.workspace.tasks.update(
      { ...context, batch: { ...batch, laneId: null } },
      { status: 'completed' },
    ),
  ).toThrow('assigned task');
});

test('native approval waits beyond idle deadline, accepts once, and stale consent cannot be reused', async () => {
  const e = env(),
    d = await daemon(e, { mode: 'permissions' }, { idleTimeoutMs: 30 });
  const sent = e.mailbox.enqueue({
    sender: { kind: 'user' },
    recipientIds: [e.agent.id],
    text: JSON.stringify({ name: 'Bash', input: { command: 'echo hello' } }),
  });
  await until(() => e.records.list('approval').length === 1);
  const approval = e.records.list('approval')[0]!;
  await Bun.sleep(100);
  expect(e.mailbox.get(sent.deliveryIds[0]!)?.status).toBe('running');
  d.workspace.approvals.decide(approval.id, 'accept');
  await until(() => e.mailbox.get(sent.deliveryIds[0]!)?.status === 'completed');
  expect(() => d.workspace.approvals.decide(approval.id, 'accept')).toThrow('no longer active');
  expect(
    e.store.db
      .query<{ text: string }, []>("SELECT text FROM thread_messages WHERE type='agentMessage'")
      .get()?.text,
  ).toBe('allowed');
});

test('approval cancellation and expiry are durable and decline without allowing late approval', async () => {
  const e = env(),
    broker = new ApprovalBroker(e.records, 20),
    controller = new AbortController();
  const sent = e.mailbox.enqueue({
    sender: { kind: 'user' },
    recipientIds: [e.agent.id],
    text: 'work',
  });
  const batch = e.mailbox.claimBatch(e.agent.id, null)!;
  e.mailbox.markBatchRunning(batch.id, 'turn');
  const context: ToolContext = { agent: e.agent, batch, threadId: 'thread', turnId: 'turn' };
  const waiting = broker.request(
    context,
    { kind: 'command', threadId: 'thread', turnId: 'turn', input: { command: 'echo test' } },
    controller.signal,
  );
  expect((await waiting).decision).toBe('decline');
  const expired = e.records.list('approval')[0]!;
  expect(expired.data.status).toBe('expired');
  expect(() => broker.decide(expired.id, 'accept')).toThrow('no longer active');
  const cancelled = broker.request(
    context,
    { kind: 'command', threadId: 'thread', turnId: 'turn', input: {} },
    controller.signal,
  );
  controller.abort();
  expect((await cancelled).decision).toBe('decline');
  expect(e.records.list('approval').every((a) => a.data.status === 'expired')).toBe(true);
  expect(e.mailbox.get(sent.deliveryIds[0]!)?.status).toBe('running');
  broker.close();
});

test('daily schedules honor timezone and DST; interval and webhook scheduling are explicit', () => {
  expect(
    nextRun(
      { type: 'daily', time: '09:00', timezone: 'Asia/Kuala_Lumpur' },
      Date.parse('2026-11-23T00:00:00Z'),
    ),
  ).toBe('2026-11-23T01:00:00.000Z');
  expect(
    nextRun(
      { type: 'daily', time: '09:00', timezone: 'America/New_York' },
      Date.parse('2026-03-08T00:00:00Z'),
    ),
  ).toBe('2026-03-08T13:00:00.000Z');
  expect(
    nextRun(
      { type: 'daily', time: '01:30', timezone: 'America/New_York' },
      Date.parse('2026-11-01T05:30:00Z'),
      '2026-11-01T05:30:00Z',
    ),
  ).toBe('2026-11-02T06:30:00.000Z');
  expect(nextRun({ type: 'interval', minutes: 5 }, 0)).toBe('1970-01-01T00:05:00.000Z');
  expect(nextRun({ type: 'webhook' }, 0)).toBeNull();
});

test('routine firing commits schedule and queue atomically, catches up once, and webhook events deduplicate', () => {
  const e = env(),
    runner = new RoutineRunner(e.records);
  const routine = runner.save(e.agent.id, {
    name: 'Poll',
    prompt: 'Review the queue.',
    schedule: { type: 'interval', minutes: 1 },
  });
  e.records.put(
    'routine',
    e.agent.id,
    { ...routine.data, nextRunAt: '2020-01-01T00:00:00.000Z' },
    routine.id,
  );
  runner.tick();
  runner.tick();
  expect(e.mailbox.listQueue(e.agent.id)).toHaveLength(1);
  const hook = runner.save(e.agent.id, {
    name: 'Event',
    prompt: 'Review event.',
    schedule: { type: 'webhook' },
  });
  const token = runner.rotateToken(hook.id);
  expect(() => runner.trigger(hook.id, { token: 'wrong', eventId: 'event' })).toThrow(
    'Invalid webhook token',
  );
  const one = runner.trigger(hook.id, { token, eventId: 'event', payload: '{"event":"changed"}' });
  const two = runner.trigger(hook.id, { token, eventId: 'event', payload: '{"event":"changed"}' });
  expect(two.duplicate).toBe(true);
  expect(two.deliveryIds).toEqual(one.deliveryIds);
  expect(() =>
    runner.trigger(hook.id, { token, eventId: 'event', payload: 'different' }),
  ).toThrow();
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('agents can save own memory and skills, but cannot configure connectors or read another agent memory', async () => {
  const e = env(),
    other = e.agents.create({ name: 'other', provider: 'fake' });
  e.records.put('memory', other.id, { key: 'secret', text: 'Other agent only.' });
  const d = await daemon(e, {
    script: async (_prompt, call) => {
      expect(
        (
          await call(
            'workspace',
            { action: 'remember', key: 'project', text: 'KRU' },
            'memory-call',
          )
        ).success,
      ).toBe(true);
      expect(
        (
          await call(
            'workspace',
            { action: 'remember', key: 'project', text: 'KRU' },
            'memory-call',
          )
        ).success,
      ).toBe(true);
      expect(
        (
          await call(
            'workspace',
            { action: 'remember', key: 'project', text: 'Conflicting' },
            'memory-call',
          )
        ).success,
      ).toBe(false);
      expect(
        (
          await call('workspace', {
            action: 'save_skill',
            name: 'Check',
            instructions: 'Run project checks.',
          })
        ).success,
      ).toBe(true);
      const memories = await call('workspace', { action: 'memories' });
      expect(JSON.stringify(memories)).not.toContain('Other agent only.');
      expect((await call('workspace', { action: 'configure_connector' })).success).toBe(false);
      return 'Saved context.';
    },
  });
  const sent = e.mailbox.enqueue({
    sender: { kind: 'user' },
    recipientIds: [e.agent.id],
    text: 'Remember context.',
  });
  await until(() => e.mailbox.get(sent.deliveryIds[0]!)?.status === 'completed');
  expect(e.records.list('memory', e.agent.id)).toHaveLength(1);
  expect(e.records.list('skill', e.agent.id)).toHaveLength(1);
  expect(d.workspace.tools.definitions).toHaveLength(6);
});
