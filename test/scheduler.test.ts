import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox, type EnqueueInput } from '../src/mailbox';
import { Scheduler } from '../src/scheduler';
import type { SchedulerOptions } from '../src/scheduler';
import { SqliteSessions } from '../src/daemon/sessions';
import { Daemon } from '../src/daemon';
import { DaemonLock } from '../src/daemon/lock';
import { sessionConfigHash } from '../src/scheduler/session';
import { prepareThread, promptMetadata } from '../src/providers/prompt-profile';
import { SchedulerFake } from './fakes/scheduler-provider';

let dir: string, path: string, store: Store, agents: AgentRegistry, mailbox: SqliteMailbox;
let cleanups: (() => Promise<unknown>)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kru-m3-')); path = join(dir, 'db.sqlite'); store = new Store(path);
  agents = new AgentRegistry(store); mailbox = new SqliteMailbox(store); cleanups = [];
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  store.close(); rmSync(dir, { recursive: true, force: true });
});
async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const end = performance.now() + timeout;
  while (!predicate()) { if (performance.now() >= end) throw new Error('Condition did not become true'); await Bun.sleep(3); }
}
const agent = (name = 'a', config: Record<string, unknown> = {}) => agents.create({ name, provider: 'fake', config });
function send(recipient: string, text = 'hello', extra: Partial<EnqueueInput> = {}): string {
  return mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [recipient], text, ...extra }).deliveryIds[0]!;
}
function start(options: SchedulerOptions = {}, factory?: (id: string) => SchedulerFake) {
  const providers = new Map<string, SchedulerFake>();
  const errors: unknown[] = [];
  const scheduler = new Scheduler(mailbox, agents, new SqliteSessions(store), a => {
    const p = factory?.(a.id) ?? new SchedulerFake(); providers.set(a.id, p); return p;
  }, { providerRetryMs: 10, ...options, onError: e => errors.push(e) });
  scheduler.start(); cleanups.push(async () => { await scheduler.stop(0); expect(errors).toEqual([]); });
  return { scheduler, providers };
}
const done = (id: string) => mailbox.get(id)!.status === 'completed';
const fixture = new URL('./fakes/scheduler-daemon.ts', import.meta.url).pathname;
async function childDaemon() {
  const child = Bun.spawn([process.execPath, fixture, path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  cleanups.push(async () => { child.kill(); await child.exited; });
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready\n');
  reader.releaseLock();
  return child;
}

describe('M3 acceptance', () => {
  test('1. five fast messages produce a running turn then one batch of four', async () => {
    const a = agent(); const first = send(a.id, 'first'); const { providers } = start();
    await until(() => mailbox.get(first)!.status === 'running');
    const rest = [1, 2, 3, 4].map(n => send(a.id, `next-${n}`));
    await until(() => rest.every(done));
    const p = providers.get(a.id)!;
    expect(p.starts).toEqual(['first', 'next-1\n\n--- Kru message ---\n\nnext-2\n\n--- Kru message ---\n\nnext-3\n\n--- Kru message ---\n\nnext-4']);
    expect(new Set(rest.map(id => mailbox.get(id)!.batchId)).size).toBe(1);
    expect(mailbox.get(first)!.batchId).not.toBe(mailbox.get(rest[0]!)!.batchId);
  });
  test('2. two agents run in parallel', async () => {
    const a = agent('a'), b = agent('b'); const ids = [send(a.id), send(b.id)];
    const { scheduler } = start({}, () => new SchedulerFake(60));
    await until(() => ids.every(id => mailbox.get(id)!.status === 'running'));
    expect(scheduler.activeTurns).toBe(2); await until(() => ids.every(done));
  });
  test('3. a second daemon refuses the database before it can sweep active work', async () => {
    const a = agent('a', { testMode: 'stall' }); const id = send(a.id);
    await childDaemon(); await until(() => mailbox.get(id)!.status === 'running');
    const second = new Daemon(store);
    expect(() => second.start()).toThrow('already owns');
    expect(mailbox.get(id)!.status).toBe('running');
  });
  test('4. holds appear in priority order and clear when their condition changes', async () => {
    const a = agent('a', { paused: true, dailyTokens: 0 }); const id = send(a.id);
    const p = new SchedulerFake(); p.available = false;
    const { scheduler } = start({}, () => p);
    await until(() => scheduler.status()[0]?.reason === 'paused');
    agents.update(a.id, { config: { paused: false } }); scheduler.refresh();
    await until(() => scheduler.status()[0]?.reason === 'provider-not-ready');
    p.available = true; await Bun.sleep(12); scheduler.tick();
    await until(() => scheduler.status()[0]?.reason === 'budget');
    const blocker = mailbox.claimBatch(a.id, null)!;
    scheduler.refresh();
    await until(() => scheduler.status()[0]?.reason === 'lane-busy' || scheduler.status()[0]?.reason === 'budget');
    // With no queued head in this lane, add work so its lane-busy hold is visible.
    const next = send(a.id, 'next');
    await until(() => scheduler.status()[0]?.reason === 'lane-busy');
    mailbox.restoreBatch(blocker.id);
    agents.update(a.id, { config: { dailyTokens: 10_000 } }); scheduler.refresh();
    await until(() => done(id) && done(next));
  });
  test('5. a separate CLI send is picked up via data_version within one second', async () => {
    const a = agent();
    const daemon = new Daemon(store); daemon.start(); cleanups.push(() => daemon.stop(0));
    const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname,
      'send', a.name, 'external', '--db', path], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text(); const id = output.trim().split('delivery ')[1]!;
    await until(() => done(id), 1_000);
  });
  test('6. a message arriving in the flag-release gap is not lost', async () => {
    const a = agent(); const first = send(a.id); let next: string | undefined;
    start({ beforeRelease: () => { next ??= send(a.id, 'arrived during release'); } });
    await until(() => done(first) && next !== undefined && done(next));
    expect(mailbox.listQueue(a.id)).toEqual([]);
  });
  test('7. agent and routine deliveries run alone without batching user work across them', async () => {
    const a = agent(), sender = agent('sender');
    const ids = [send(a.id, 'user1'), send(a.id, 'agent', { sender: { kind: 'agent', agentId: sender.id } }),
      send(a.id, 'routine', { sender: { kind: 'routine', routineId: 'daily' } }), send(a.id, 'user2')];
    const { providers } = start(); await until(() => ids.every(done));
    expect(providers.get(a.id)!.starts).toEqual(['user1', 'agent', 'routine', 'user2']);
  });
  test('8. cap two holds other lanes and prioritizes a person-headed lane when a slot frees', async () => {
    const a = agent('a'), b = agent('b'), routine = agent('routine'), user = agent('user');
    const ids = [send(a.id), send(b.id)]; const { scheduler, providers } = start({}, () => new SchedulerFake(80));
    await until(() => ids.every(id => mailbox.get(id)!.status === 'running'));
    const routineId = send(routine.id, 'routine', { sender: { kind: 'routine', routineId: 'timer' } });
    const userId = send(user.id, 'person');
    await until(() => scheduler.status().filter(s => s.reason === 'slots').length === 2);
    expect(scheduler.activeTurns).toBe(2);
    const order: string[] = [];
    mailbox.onChange(c => { if (c.status === 'starting' && [routineId, userId].includes(c.deliveryId)) order.push(c.deliveryId); });
    await until(() => done(routineId) && done(userId));
    expect(order[0]).toBe(userId);
    expect([...providers.values()].reduce((n, p) => n + p.starts.length, 0)).toBe(4);
  });
  test('9. unknown start stays starting, expires interrupted, and never retries', async () => {
    const a = agent(); const id = send(a.id); const p = new SchedulerFake(); p.mode = 'unknown';
    start({ startTimeoutMs: 5, startGraceMs: 70 }, () => p);
    await until(() => p.starts.length === 1); await Bun.sleep(15);
    expect(mailbox.get(id)!.status).toBe('starting'); expect(mailbox.activeLanes().length).toBe(1);
    await until(() => mailbox.get(id)!.status === 'interrupted');
    expect(mailbox.get(id)!.error).toContain('unknown');
    expect(p.starts.length).toBe(1); expect(p.forces).toBeGreaterThan(0); expect(mailbox.activeLanes()).toEqual([]);
  });
  test('10. SIGKILL then restart interrupts abandoned work, releases lanes and continues the queue', async () => {
    const a = agent('a', { testMode: 'stall' }); const first = send(a.id);
    const child = await childDaemon(); await until(() => mailbox.get(first)!.status === 'running');
    const next = send(a.id, 'after restart'); child.kill(9); await child.exited;
    agents.update(a.id, { config: { testMode: 'echo' } });
    const daemon = new Daemon(store); daemon.start(); cleanups.push(() => daemon.stop(0));
    await until(() => done(next));
    expect(mailbox.get(first)).toMatchObject({ status: 'interrupted', error: 'daemon restarted' });
    expect(mailbox.listQueue(a.id)).toEqual([]); expect(mailbox.activeLanes()).toEqual([]);
  });
  test('11. competing processes cannot reserve the same main or side lane', async () => {
    const a = agent();
    for (const lane of [null, 'side']) {
      send(a.id, 'work', { laneId: lane });
      const children = [0, 1].map(() => Bun.spawn([process.execPath, new URL('./fakes/batch-claimer.ts', import.meta.url).pathname,
        path, a.id, lane ?? 'main'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
      try {
        const readers = children.map(c => c.stdout.getReader());
        for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready\n');
        for (const child of children) { child.stdin.write('go'); child.stdin.end(); }
        const results = await Promise.all(children.map(async (child, i) => {
          let output = ''; for (;;) { const r = await readers[i]!.read(); if (r.done) break; output += new TextDecoder().decode(r.value); }
          expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe('');
          return JSON.parse(output) as string | null;
        }));
        expect(results.filter(Boolean).length).toBe(1);
        expect(() => store.write(() => store.db.query('INSERT INTO active_lanes VALUES (?, ?, ?, NULL, ?)')
          .run(a.id, lane ?? '', 'duplicate', 'now'))).toThrow();
      } finally { for (const child of children) child.kill(); await Promise.all(children.map(c => c.exited)); }
    }
    expect(mailbox.activeLanes().length).toBe(2);
  });
  test('12. every fake turn start corresponds to exactly one claimed batch', async () => {
    const a = agent(); const ids = [send(a.id), send(a.id), send(a.id, 'side', { laneId: 'side' })];
    const all: SchedulerFake[] = [];
    start({}, () => { const p = new SchedulerFake(); all.push(p); return p; });
    await until(() => ids.every(done));
    const batches = new Set(ids.map(id => mailbox.get(id)!.batchId));
    expect(all.reduce((n, p) => n + p.nativeStarts, 0)).toBe(batches.size);
    const before = all.reduce((n, p) => n + p.nativeStarts, 0);
    await Bun.sleep(30); expect(all.reduce((n, p) => n + p.nativeStarts, 0)).toBe(before);
  });
});

test('late turn/started confirms an uncertain request and completes the original batch', async () => {
  const a = agent(); const id = send(a.id); const p = new SchedulerFake(); p.mode = 'late';
  start({ startGraceMs: 200 }, () => p); await until(() => done(id));
  expect(p.starts.length).toBe(1); expect(mailbox.get(id)!.turnId).not.toBeNull();
});

test('definite refusal fails the batch; provider failure and idle timeout interrupt it', async () => {
  const a = agent(); const id = send(a.id); const p = new SchedulerFake(); p.mode = 'refused';
  const b = agent('stall');
  start({ idleTimeoutMs: 20 }, recipient => recipient === a.id ? p : new SchedulerFake(1, true));
  await until(() => mailbox.get(id)!.status === 'failed');
  expect(mailbox.get(id)!.error).toBe('Definite start refusal'); expect(p.starts.length).toBe(1);
  const stalled = send(b.id);
  await until(() => mailbox.get(stalled)!.status === 'interrupted');
  expect(mailbox.get(stalled)!.error).toBe('Turn idle timeout');
});

test('spent budgets hold subsequent work and a higher budget resumes it', async () => {
  const a = agent('a', { dailyTokens: 1 }); const id = send(a.id);
  const { scheduler } = start(); await until(() => done(id));
  const next = send(a.id);
  await until(() => scheduler.status()[0]?.reason === 'budget');
  agents.update(a.id, { config: { dailyTokens: 10_000 } }); scheduler.refresh();
  await until(() => done(next));
});

test('daily reset wakes a budget-held lane even without a database commit', async () => {
  let now = Date.parse('2026-11-04T23:59:59Z');
  const a = agent('a', { dailyTokens: 1 }); const id = send(a.id);
  const { scheduler } = start({ now: () => now, budgetTimezone: 'UTC' }); await until(() => done(id));
  const next = send(a.id); await until(() => scheduler.status()[0]?.reason === 'budget');
  now += 2_000; scheduler.tick(); await until(() => done(next));
});

test('shutdown interrupts an active turn and releases its batch', async () => {
  const a = agent(); const id = send(a.id); const { scheduler } = start({}, () => new SchedulerFake(1, true));
  await until(() => mailbox.get(id)!.status === 'running');
  await scheduler.stop(5);
  expect(mailbox.get(id)!.status).toBe('interrupted'); expect(mailbox.activeLanes()).toEqual([]);
});

test('unchanged sessions are reused, and changed prefixes start a fresh native session', async () => {
  const a = agent(); const first = send(a.id); const all: SchedulerFake[] = [];
  const { scheduler } = start({}, () => { const p = new SchedulerFake(); all.push(p); return p; });
  await until(() => done(first));
  const next = send(a.id); await until(() => done(next));
  expect(all[0]!.calls.filter(c => c === 'thread/start').length).toBe(1);
  agents.update(a.id, { config: { instructions: 'New stable instructions' } });
  const third = send(a.id); scheduler.refresh(); await until(() => done(third));
  expect(all.length).toBe(2);
  expect(all[1]!.calls.filter(c => c === 'thread/start').length).toBe(1);
});

test('session setup failure restores the batch before any turn is submitted', async () => {
  const a = agent(); const id = send(a.id); const p = new SchedulerFake(); p.threadReady = false;
  const { scheduler } = start({}, () => p);
  await until(() => scheduler.status()[0]?.reason === 'provider-not-ready' && p.calls.includes('thread/start'));
  expect(mailbox.get(id)!.status).toBe('queued'); expect(mailbox.activeLanes()).toEqual([]); expect(p.starts).toEqual([]);
  p.threadReady = true; await Bun.sleep(12); scheduler.tick();
  await until(() => done(id)); expect(p.starts.length).toBe(1);
});

test('process exit interrupts a running batch and duplicate usage snapshots do not double count', async () => {
  const a = agent('a', { dailyTokens: 100 }); const id = send(a.id); const p = new SchedulerFake(1, true);
  const { scheduler } = start({}, () => p);
  await until(() => mailbox.get(id)!.status === 'running');
  const threadId = new SqliteSessions(store).get(a.id, null, 'fake')!.nativeThreadId;
  const turnId = mailbox.get(id)!.turnId!;
  for (const total of [10, 10, 20]) {
    const count = { inputTotal: total, cachedRead: 0, cacheWrite: 0, output: 0, totalTokens: total };
    p.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: count, total: count } } });
  }
  expect(scheduler.status()[0]!.usedTokens).toBe(20);
  await p.stop(); await until(() => mailbox.get(id)!.status === 'interrupted');
  expect(mailbox.activeLanes()).toEqual([]);
});

test('provider startup that never resolves cannot hang daemon shutdown', async () => {
  class NeverReady extends SchedulerFake { override async start(): Promise<void> { await new Promise(() => {}); } }
  const a = agent(); const id = send(a.id);
  const { scheduler } = start({}, () => new NeverReady());
  await until(() => scheduler.status()[0]?.reason === 'provider-not-ready');
  const began = performance.now(); await scheduler.stop(0);
  expect(performance.now() - began).toBeLessThan(500);
  expect(mailbox.get(id)!.status).toBe('queued');
});

test('a replacement scheduler resumes the persisted native binding when available', async () => {
  const a = agent(); const id = send(a.id); const p = new SchedulerFake();
  const first = start({}, () => p); await until(() => done(id)); await first.scheduler.stop(0);
  const binding = new SqliteSessions(store).get(a.id, null, 'fake')!;
  const next = send(a.id); start({}, () => p); await until(() => done(next));
  expect(p.calls.filter(c => c === 'thread/resume').length).toBe(1);
  expect(p.calls.filter(c => c === 'thread/start').length).toBe(1);
  expect(new SqliteSessions(store).get(a.id, null, 'fake')!.nativeThreadId).toBe(binding.nativeThreadId);
});

test('provider-completed failure maps to failed, and a person interrupt maps to interrupted', async () => {
  const a = agent('failure'), b = agent('person'); const failed = send(a.id), interrupted = send(b.id);
  const { providers } = start({}, id => id === a.id ? new SchedulerFake(1, false, true) : new SchedulerFake(1, true));
  await until(() => mailbox.get(failed)!.status === 'failed' && mailbox.get(interrupted)!.status === 'running');
  const threadId = new SqliteSessions(store).get(b.id, null, 'fake')!.nativeThreadId;
  await providers.get(b.id)!.request('turn/interrupt', { threadId, turnId: mailbox.get(interrupted)!.turnId! });
  await until(() => mailbox.get(interrupted)!.status === 'interrupted');
  expect(mailbox.get(failed)!.error).toBe('Scripted turn failure');
  expect(mailbox.activeLanes()).toEqual([]);
});

test('a running native command suspends idle expiry until it completes', async () => {
  const a = agent(); const id = send(a.id); const p = new SchedulerFake(1, true);
  start({ idleTimeoutMs: 20 }, () => p); await until(() => mailbox.get(id)!.status === 'running');
  const threadId = new SqliteSessions(store).get(a.id, null, 'fake')!.nativeThreadId;
  const params = { threadId, turnId: mailbox.get(id)!.turnId!, item: { id: 'command', type: 'commandExecution' } };
  p.emit('notification', { method: 'item/started', params });
  await Bun.sleep(50); expect(mailbox.get(id)!.status).toBe('running');
  p.emit('notification', { method: 'item/completed', params });
  await until(() => mailbox.get(id)!.status === 'interrupted');
  expect(mailbox.get(id)!.error).toBe('Turn idle timeout');
});

test('an oversized queued message fails without a model call and later messages still run', async () => {
  const a = agent(); const large = send(a.id, '界'.repeat(12000)), next = send(a.id, 'small');
  const { providers } = start(); await until(() => done(next));
  expect(mailbox.get(large)!.status).toBe('failed'); expect(mailbox.get(large)!.error).toContain('32 KB');
  expect(providers.get(a.id)!.starts).toEqual(['small']);
});

test('local writes through another mailbox on the daemon connection wake it without data_version', async () => {
  const a = agent(); const daemon = new Daemon(store); daemon.start(); cleanups.push(() => daemon.stop(0));
  await Bun.sleep(15);
  const id = send(a.id, 'same-connection write');
  await until(() => done(id));
});

test('a stale heartbeat never overrides live process ownership', () => {
  const owner = new DaemonLock(store); owner.acquire();
  store.write(() => store.db.exec("UPDATE daemon_lock SET heartbeat_at = '1900-01-01'"));
  expect(() => new DaemonLock(store).acquire()).toThrow('already owns');
  owner.release(); expect(owner.read()).toBeNull();
});

test('a reused PID with a different start identity can be reclaimed; release checks ownership', () => {
  store.write(() => store.db.query("INSERT INTO daemon_lock (id, pid, start_identity, heartbeat_at) VALUES (1, ?, 'old-start', 'old')").run(process.pid));
  const owner = new DaemonLock(store); owner.acquire();
  expect(owner.read()!.start_identity).not.toBe('old-start');
  store.write(() => store.db.exec("UPDATE daemon_lock SET start_identity = 'replacement'"));
  owner.release(); expect(owner.read()!.start_identity).toBe('replacement');
});

test('agent changes on the daemon connection wake held lanes without scheduler.refresh', async () => {
  const a = agent('a', { paused: true, dailyTokens: 0 }); const id = send(a.id);
  const daemon = new Daemon(store); daemon.start(); cleanups.push(() => daemon.stop(0));
  await until(() => daemon.scheduler.status()[0]?.reason === 'paused');
  new AgentRegistry(store).update(a.id, { config: { paused: false } });
  await until(() => daemon.scheduler.status()[0]?.reason === 'budget');
  agents.update(a.id, { config: { dailyTokens: 1000 } });
  await until(() => done(id));
});

test('an unchanged status does not write; the default heartbeat is ten seconds', async () => {
  const interval = spyOn(globalThis, 'setInterval');
  const daemon = new Daemon(store); cleanups.push(() => daemon.stop(0));
  try {
    daemon.start(); expect(interval.mock.calls.some(call => call[1] === 10_000)).toBe(true);
  } finally { interval.mockRestore(); }
  await Bun.sleep(10);
  const changes = () => store.db.query<{ changes: number }, []>('SELECT total_changes() AS changes').get()!.changes;
  const baseline = changes();
  const write = spyOn(store, 'write');
  try {
    daemon.scheduler.refresh(); daemon.scheduler.refresh(); await Bun.sleep(25);
    expect(write).not.toHaveBeenCalled(); expect(changes()).toBe(baseline);
    const a = agent('paused', { paused: true }); send(a.id);
    await until(() => daemon.scheduler.status()[0]?.reason === 'paused');
    await Bun.sleep(1);
    expect(JSON.parse(new DaemonLock(store).read()!.status_json).lanes[0].reason).toBe('paused');
  } finally { write.mockRestore(); }
});

test('budget holds clear at midnight in the configured timezone', async () => {
  let now = Date.parse('2026-11-04T15:59:59Z');
  const a = agent('a', { dailyTokens: 1 }), first = send(a.id);
  const { scheduler } = start({ now: () => now, budgetTimezone: 'Asia/Kuala_Lumpur' });
  await until(() => done(first)); const next = send(a.id);
  await until(() => scheduler.status()[0]?.reason === 'budget');
  now += 2000; scheduler.tick(); await until(() => done(next));
});

test('boot recovery preserves an interrupted lane binding and resumes its native session', async () => {
  const a = agent(), p = new SchedulerFake(); await p.start();
  const thread = (await p.request('thread/start', {})).thread;
  const sessions = new SqliteSessions(store);
  sessions.put({ agentId: a.id, laneId: null, provider: 'fake', nativeThreadId: thread.id,
    promptHash: thread.prompt!.prefixHash, configHash: sessionConfigHash(a) });
  const old = send(a.id); const batch = mailbox.claimBatch(a.id, null)!;
  const turn = (await p.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'old' }] })).turn;
  mailbox.markBatchRunning(batch.id, turn.id);
  await p.request('turn/interrupt', { threadId: thread.id, turnId: turn.id }); await p.stop();
  mailbox.recoverInterrupted();
  expect(mailbox.get(old)!.status).toBe('interrupted'); expect(sessions.get(a.id, null, 'fake')!.nativeThreadId).toBe(thread.id);
  const next = send(a.id); start({}, () => p); await until(() => done(next));
  expect(p.calls.filter(c => c === 'thread/resume')).toHaveLength(1);
  expect(p.calls.filter(c => c === 'thread/start')).toHaveLength(1);
  expect(sessions.get(a.id, null, 'fake')!.nativeThreadId).toBe(thread.id);
});

test('a missing native session is replaced only after resume fails', async () => {
  const a = agent(), sessions = new SqliteSessions(store);
  sessions.put({ agentId: a.id, laneId: null, provider: 'fake', nativeThreadId: 'missing-native-session',
    promptHash: promptMetadata(prepareThread({})).prefixHash, configHash: sessionConfigHash(a) });
  const id = send(a.id); const { providers } = start(); await until(() => done(id));
  const calls = providers.get(a.id)!.calls;
  expect(calls.indexOf('thread/resume')).toBeLessThan(calls.indexOf('thread/start'));
  expect(sessions.get(a.id, null, 'fake')!.nativeThreadId).not.toBe('missing-native-session');
});
