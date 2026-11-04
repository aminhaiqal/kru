import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider, CodexRuntime } from '../src/providers';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { SqliteSessions } from '../src/daemon/sessions';
import { Scheduler } from '../src/scheduler';
let dir: string, runtime: CodexRuntime | undefined;
let clients: CodexProvider[], scheduler: Scheduler | undefined, store: Store | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kru-retire-')); clients = []; });
afterEach(async () => {
  await scheduler?.stop(0); scheduler = undefined;
  await Promise.all(clients.map(c => c.stop()));
  store?.close(); store = undefined; runtime = undefined; rmSync(dir, { recursive: true, force: true });
});
async function until(predicate: () => boolean, timeout = 2_000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error('Condition timed out'); await Bun.sleep(3); }
}
const wire = () => readFileSync(join(dir, 'wire.ndjson'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
async function setup(env: Record<string, string> = {}) {
  runtime = new CodexRuntime({ answerTimeoutMs: 80, transport: {
    command: process.execPath, args: [new URL('./fakes/provider-agent.ts', import.meta.url).pathname],
    env: { KRU_FAKE_MODE: 'stall', KRU_CAPTURE_FILE: join(dir, 'wire.ndjson'), ...env },
    processRecordDir: join(dir, 'processes'), stopGraceMs: 50,
  } });
  const warm = view(); await warm.start(); return runtime;
}
function view() { const p = new CodexProvider({ runtime: runtime! }); clients.push(p); return p; }

test('an unknown start tombstones only its thread; another agent and new work finish in the same process', async () => {
  const r = await setup({ KRU_LATE_START_MS: '250', KRU_NATIVE_COMMAND_DELAY_MS: '400' });
  const pid = r.connection.pid;
  store = new Store(':memory:'); const agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store), sessions = new SqliteSessions(store);
  const a = agents.create({ name: 'slow', provider: 'codex' }), b = agents.create({ name: 'healthy', provider: 'codex' });
  const send = (id: string, text: string) => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [id], text }).deliveryIds[0]!;
  const slow = send(a.id, 'late-start'), healthy = send(b.id, 'native-command:quiet');
  const observed: string[] = [], requests: string[] = [], errors: unknown[] = [];
  scheduler = new Scheduler(mailbox, agents, sessions, () => {
    const p = view(); p.on('notification', n => observed.push(n.params.threadId)); p.on('request', q => requests.push(q.params.threadId)); return p;
  }, { startTimeoutMs: 100, startGraceMs: 30, onError: e => errors.push(e) });
  scheduler.start();
  await until(() => sessions.get(a.id, null, 'codex') !== null);
  const retiredId = sessions.get(a.id, null, 'codex')!.nativeThreadId;
  await until(() => mailbox.get(slow)!.status === 'interrupted');
  expect(mailbox.get(healthy)!.status).toBe('running'); expect(r.connection.pid).toBe(pid);
  const next = send(a.id, 'native-command:quiet');
  await until(() => mailbox.get(healthy)!.status === 'completed' && mailbox.get(next)!.status === 'completed');
  expect(r.connection.pid).toBe(pid); expect(observed).not.toContain(retiredId); expect(requests).not.toContain(retiredId);
  expect(r.isRetired(retiredId)).toBe(true); expect(sessions.get(a.id, null, 'codex')!.nativeThreadId).not.toBe(retiredId);
  const calls = wire();
  expect(calls.filter(c => c.method === 'turn/interrupt' && c.params.threadId === retiredId)).toHaveLength(1);
  expect(calls.some(c => c.method === 'config/read' && c.params.includeLayers === false)).toBe(true);
  expect(calls.some(c => String(c.id).startsWith('late-approval-') && c.result?.decision === 'decline')).toBe(true);
  expect(calls.some(c => String(c.id).startsWith('late-tool-') && c.error?.code === -32601)).toBe(true);
  expect(errors).toEqual([]);
});

test('a shared server is killed only when the local liveness request also times out', async () => {
  const r = await setup({ KRU_CONFIG_READ_MODE: 'hang', KRU_LATE_START_MS: '300' });
  const a = view(), b = view(); await Promise.all([a.start(), b.start()]);
  const ta = await a.request('thread/start', {}), tb = await b.request('thread/start', {});
  await b.request('turn/start', { threadId: tb.thread.id, input: [] });
  let exits = 0; b.on('exit', () => { exits++; });
  await expect(a.request('turn/start', { threadId: ta.thread.id, input: [{ type: 'text', text: 'late-start' }] }, 20)).rejects.toThrow('timed out');
  await until(() => r.connection.pid === undefined);
  expect(exits).toBe(1); expect(wire().filter(c => c.method === 'config/read')).toHaveLength(1);
});

test('RPC errors still prove liveness and simultaneous probes share one request', async () => {
  const r = await setup({ KRU_CONFIG_READ_MODE: 'error', KRU_CONFIG_READ_DELAY_MS: '10' });
  const pid = r.connection.pid;
  await Promise.all([r.checkAnswering(), r.checkAnswering(), r.checkAnswering()]);
  expect(r.connection.pid).toBe(pid); expect(wire().filter(c => c.method === 'config/read')).toHaveLength(1);
});
