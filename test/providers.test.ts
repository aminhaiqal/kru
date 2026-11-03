import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeProvider, CodexProvider, ClaudeProvider, createProvider, type FakeMode, type ProviderClient, type Notification, type ToolDefinition } from '../src/providers';
import { scriptedClaude } from './fakes/claude-sdk';
import { runChatTurn } from '../src/chat/turn';

const peer = fileURLToPath(new URL('./fakes/provider-agent.ts', import.meta.url));
const tool: ToolDefinition = { name: 'kru_echo', description: 'Return the supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
let directory: string;
const clients: ProviderClient[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'kru-provider-')); });
afterEach(async () => {
  await Promise.all(clients.map(client => client.stop()));
  for (const client of clients) {
    if (client instanceof CodexProvider) {
      expect(client.connection.pendingRequestCount).toBe(0);
      expect(client.connection.queuedWriteBytes).toBe(0);
      expect(client.connection.pid).toBeUndefined();
    }
  }
  const records = join(directory, 'processes');
  if (existsSync(records)) expect(readdirSync(records)).toEqual([]);
  clients.length = 0;
  rmSync(directory, { recursive: true, force: true });
});
function make(kind: 'fake' | 'codex' | 'claude', mode: FakeMode = 'echo', toolTimeoutMs = 500, env: Record<string, string> = {}): ProviderClient {
  const client = kind === 'claude' ? new ClaudeProvider({ query: scriptedClaude(mode), toolTimeoutMs }) : kind === 'fake' ? new FakeProvider({ mode, toolTimeoutMs }) : new CodexProvider({
    toolTimeoutMs,
    transport: { command: process.execPath, args: [peer], env: { KRU_FAKE_MODE: mode, ...env }, processRecordDir: join(directory, 'processes'), stopGraceMs: 100, stderrDrainTimeoutMs: 50 },
  });
  clients.push(client); return client;
}
function completed(client: ProviderClient): Promise<Extract<Notification, { method: 'turn/started' | 'turn/completed' }>> {
  return new Promise(resolve => {
    const listener = (n: Notification) => {
      if (n.method === 'turn/completed') { client.off('notification', listener); resolve(n); }
    };
    client.on('notification', listener);
  });
}
for (const kind of ['fake', 'codex', 'claude'] as const) describe(`${kind} shared provider conformance`, () => {
  test('usage includes cache reads/writes in inputTotal without double counting', async () => {
    const client = make(kind); await client.start();
    const { thread } = await client.request('thread/start', {});
    for (const prompt of ['hello', 'again']) {
      const { usage } = await runChatTurn(client, thread.id, prompt);
      expect(usage).toBeDefined();
      for (const count of [usage!.last, usage!.total]) {
        expect(count.inputTotal).toBeGreaterThanOrEqual(count.cachedRead + count.cacheWrite);
        expect(count.totalTokens).toBe(count.inputTotal + count.output);
      }
      expect(usage!.last).toEqual({ inputTotal: kind === 'claude' ? 55 : 5,
        cachedRead: kind === 'claude' ? 20 : kind === 'codex' ? 2 : 0,
        cacheWrite: kind === 'claude' ? 30 : kind === 'codex' ? 1 : 0,
        output: 11, totalTokens: kind === 'claude' ? 66 : 16 });
      expect(usage!.total.inputTotal).toBe((kind === 'claude' ? 55 : 5) * (prompt === 'hello' ? 1 : 2));
      expect(usage!.total.cachedRead).toBe(usage!.last.cachedRead * (prompt === 'hello' ? 1 : 2));
      expect(usage!.total.cacheWrite).toBe(usage!.last.cacheWrite * (prompt === 'hello' ? 1 : 2));
    }
  });
  test('same chat streams, handles a delta before item/start, resumes and emits usage', async () => {
    const client = make(kind);
    const events: Notification[] = [];
    client.on('notification', n => events.push(n));
    await client.start();
    const { thread } = await client.request('thread/start', { cwd: directory });
    let streamed = '';
    const result = await runChatTurn(client, thread.id, 'hello', { onDelta: delta => { streamed += delta; } });
    expect(streamed).toBe('Echo: hello');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe(streamed);
    if (kind !== 'claude') expect(events.findIndex(n => n.method === 'item/agentMessage/delta')).toBeLessThan(events.findIndex(n => n.method === 'item/started'));
    expect(events.filter(n => n.method === 'turn/started')).toHaveLength(1);
    expect(events.filter(n => n.method === 'turn/completed')).toHaveLength(1);
    expect(events.some(n => n.method === 'item/completed')).toBe(true);
    expect(events.some(n => n.method === 'thread/tokenUsage/updated')).toBe(true);
    expect((await client.request('thread/resume', { threadId: thread.id })).thread.id).toBe(thread.id);
    expect((await runChatTurn(client, thread.id, 'again')).messages[0]?.text).toBe('Echo: again');
  });
  test('#7 prefix stability across turns and resume', async () => {
    const client = make(kind); await client.start();
    const { thread } = await client.request('thread/start', { instructions: 'Stable agent role.', tools: [tool] });
    const prefix = thread.prompt?.prefixHash;
    expect(prefix).toBeString();
    await runChatTurn(client, thread.id, 'first');
    await runChatTurn(client, thread.id, 'different prompt');
    const resumed = await client.request('thread/resume', { threadId: thread.id });
    expect(resumed.thread.prompt?.prefixHash).toBe(prefix);
  });
  test('#8 context budget rejects 8 KiB instructions and a seventh tool', async () => {
    const client = make(kind); await client.start();
    const tools = Array.from({ length: 6 }, (_, i) => ({ ...tool, name: `tool_${i}` }));
    const { thread } = await client.request('thread/start', { tools });
    expect(thread.prompt?.instructionBytes).toBeLessThan(8192);
    expect(thread.prompt?.toolCount).toBe(6);
    await expect(client.request('thread/start', { instructions: 'x'.repeat(8192) })).rejects.toThrow('8 KB');
    await expect(client.request('thread/start', { tools: [...tools, { ...tool, name: 'seventh' }] })).rejects.toThrow('six tools');
    await expect(client.request('thread/resume', { threadId: thread.id, tools: [...tools, { ...tool, name: 'seventh' }] })).rejects.toThrow('six tools');
  });
  test('tool calls wait for respond and reject duplicate responses', async () => {
    const client = make(kind, 'tool');
    let requestId: string | number = '';
    client.on('request', request => {
      if (request.method !== 'item/tool/call') throw new Error('Unexpected approval request');
      expect(request.method).toBe('item/tool/call'); expect(request.params.tool).toBe(tool.name);
      expect(request.signal.aborted).toBe(false);
      requestId = request.id;
      client.respond(request.id, { success: true, contentItems: [{ type: 'inputText', text: 'tool reply' }] });
    });
    await client.start();
    const { thread } = await client.request('thread/start', { tools: [tool] });
    expect((await runChatTurn(client, thread.id, 'call tool')).messages[0]?.text).toBe('tool reply');
    expect(() => client.respond(requestId, { success: true, contentItems: [] })).toThrow('Unknown or completed');
  });
  test('respondError reaches the peer and ends the turn as failed', async () => {
    const client = make(kind, 'tool');
    client.on('request', r => client.respondError(r.id, { code: -32042, message: 'tool rejected' }));
    await client.start();
    const { thread } = await client.request('thread/start', { tools: [tool] });
    await expect(runChatTurn(client, thread.id, 'call')).rejects.toThrow('tool rejected');
  });
  test('rejected async tool handlers become internal errors without unhandled promises', async () => {
    const client = make(kind, 'tool');
    client.on('request', async () => { await Bun.sleep(1); throw new Error('private handler detail'); });
    await client.start();
    const { thread } = await client.request('thread/start', { tools: [tool] });
    await expect(runChatTurn(client, thread.id, 'call')).rejects.toThrow('Internal error');
  });
  test('missing or non-answering tool listeners cannot deadlock', async () => {
    const client = make(kind, 'tool', 30);
    await client.start();
    const { thread } = await client.request('thread/start', { tools: [tool] });
    await expect(runChatTurn(client, thread.id, 'call')).rejects.toThrow('Method not found');
    client.on('request', () => {});
    await expect(runChatTurn(client, thread.id, 'call')).rejects.toThrow('Tool response timed out');
  });
  test('interrupt completes exactly once and frees the lane', async () => {
    const client = make(kind, 'stall');
    await client.start();
    const { thread } = await client.request('thread/start', {});
    const terminal = completed(client);
    const { turn } = await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'stall' }] });
    await expect(client.request('turn/start', { threadId: thread.id, input: [] })).rejects.toThrow();
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
    expect((await terminal).params.turn.status).toBe('interrupted');
    await expect(client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })).rejects.toThrow();
    const second = await client.request('turn/start', { threadId: thread.id, input: [] });
    await client.request('turn/interrupt', { threadId: thread.id, turnId: second.turn.id });
  });
  test('turn failures and process exits reject waiting chat without retries', async () => {
    const failure = make(kind, 'failure'); await failure.start();
    const a = await failure.request('thread/start', {});
    await expect(runChatTurn(failure, a.thread.id, 'fail')).rejects.toThrow('Scripted turn failure');
    const crash = make(kind, 'crash'); await crash.start();
    const b = await crash.request('thread/start', {});
    await expect(runChatTurn(crash, b.thread.id, 'crash')).rejects.toThrow();
  });
  test('stop settles tool callers, aborts signals and prevents stale replies after restart', async () => {
    const client = make(kind, 'tool'); await client.start();
    const { thread } = await client.request('thread/start', { tools: [tool] });
    let oldId: string | number = '';
    let oldSignal: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => client.on('request', r => { oldId = r.id; oldSignal = r.signal; resolve(); }));
    const waiting = runChatTurn(client, thread.id, 'call').catch(error => error);
    await entered; await client.stop();
    expect(await waiting).toBeInstanceOf(Error); expect(oldSignal?.aborted).toBe(true);
    const staleId = oldId;
    await expect(client.request('thread/start', {})).rejects.toThrow('not started');
    await client.start();
    const second = await client.request('thread/start', { tools: [tool] });
    const called = new Promise<void>(resolve => client.on('request', () => resolve()));
    const newWaiting = runChatTurn(client, second.thread.id, 'call');
    await called;
    expect(oldId).not.toBe(staleId);
    expect(() => client.respond(staleId, { success: true, contentItems: [] })).toThrow('Unknown or completed');
    client.respond(oldId, { success: true, contentItems: [{ type: 'inputText', text: 'fresh reply' }] });
    expect((await newWaiting).messages[0]?.text).toBe('fresh reply');
  });
  test('unknown threads reject, duplicate starts reject, and stop emits one exit', async () => {
    const client = make(kind); let exits = 0; client.on('exit', () => exits++);
    await client.start(); await expect(client.start()).rejects.toThrow('already started');
    await expect(client.request('thread/resume', { threadId: 'missing' })).rejects.toThrow();
    await Promise.all([client.stop(), client.stop()]); expect(exits).toBe(1);
  });
  test('interrupting a pending tool aborts its engine handler', async () => {
    const client = make(kind, 'tool'); await client.start();
    const { thread } = await client.request('thread/start', { tools: [tool] });
    const entered = new Promise<AbortSignal>(resolve => client.on('request', request => {
      resolve(request.signal);
      void client.request('turn/interrupt', { threadId: thread.id, turnId: request.params.turnId }).catch(() => {});
    }));
    const waiting = runChatTurn(client, thread.id, 'call').catch(error => error);
    const signal = await entered;
    expect((await waiting).message).toBe('Turn interrupted');
    expect(signal.aborted).toBe(true);
    await Bun.sleep(1);
    expect((await client.request('thread/resume', { threadId: thread.id })).thread.id).toBe(thread.id);
  });
});

test('registry selects adapters without changing the consumer', () => {
  expect(createProvider('fake').provider).toBe('fake');
  expect(createProvider('codex').provider).toBe('codex');
  expect(() => createProvider('missing')).toThrow('Unknown provider');
});
test('chat timeout and cancellation interrupt known turns and clean listeners', async () => {
  const client = make('fake', 'stall'); await client.start();
  const { thread } = await client.request('thread/start', {});
  await expect(runChatTurn(client, thread.id, 'stall', { timeoutMs: 20 })).rejects.toThrow('outcome may be unknown');
  const controller = new AbortController();
  const waiting = runChatTurn(client, thread.id, 'stall', { signal: controller.signal }).catch(error => error);
  await Bun.sleep(1); controller.abort(new Error('cancelled'));
  expect((await waiting).message).toBe('cancelled');
  expect((client as FakeProvider).listenerCount('notification')).toBe(0);
  expect((client as FakeProvider).listenerCount('exit')).toBe(0);
});

test('Codex startup failures settle callers and stop the child', async () => {
  const startup = make('codex', 'echo', 500, { KRU_INIT_FAILURE: '1' });
  await expect(startup.start()).rejects.toThrow('Scripted initialization failure');
});
test('Codex validates results and buffers streamed events arriving before the turn receipt', async () => {
  const invalid = make('codex', 'echo', 500, { KRU_BAD_RESULT: 'turn/start' }); await invalid.start();
  const { thread } = await invalid.request('thread/start', {});
  await expect(runChatTurn(invalid, thread.id, 'hello')).rejects.toThrow('protocol');
  const early = make('codex', 'echo', 500, { KRU_REPLY_DELAY_MS: '20' }); await early.start();
  const other = await early.request('thread/start', {});
  expect((await runChatTurn(early, other.thread.id, 'early')).messages[0]?.text).toBe('Echo: early');
});

test('a completed agent item without deltas still renders, and unrelated turns stay isolated', async () => {
  class CompletedOnly extends FakeProvider {
    override async request<M extends keyof import('../src/providers').Methods>(method: M, params: import('../src/providers').Methods[M]['params']): Promise<import('../src/providers').Methods[M]['result']> {
      if (method !== 'turn/start') return super.request(method, params);
      const threadId = (params as { threadId: string }).threadId;
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, turnId: 'other-turn', itemId: 'other', delta: 'wrong' } });
      this.emit('notification', { method: 'item/completed', params: { threadId, turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'final text' } } });
      this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
      return { turn: { id: 'turn', status: 'inProgress' } } as import('../src/providers').Methods[M]['result'];
    }
  }
  const client = new CompletedOnly(); clients.push(client); await client.start();
  const { thread } = await client.request('thread/start', {});
  let output = '';
  const result = await runChatTurn(client, thread.id, 'hello', { onDelta: delta => { output += delta; } });
  expect(output).toBe('final text'); expect(result.messages[0]?.text).toBe('final text');
});
