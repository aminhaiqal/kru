import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexProvider, CodexRuntime, FakeProvider, prepareThread, promptMetadata } from '../src/providers';
import { runChatTurn } from '../src/chat/turn';
let directory: string;
let runtime: CodexRuntime;
const clients: CodexProvider[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kru-shared-'));
  runtime = new CodexRuntime({ transport: { command: process.execPath, args: [fileURLToPath(new URL('./fakes/provider-agent.ts', import.meta.url))], env: { KRU_FAKE_MODE: 'stall', KRU_CAPTURE_FILE: join(directory, 'wire.ndjson') }, processRecordDir: join(directory, 'processes'), stopGraceMs: 100 } });
});
afterEach(async () => { await Promise.all(clients.map(c => c.stop())); clients.length = 0; expect(runtime.connection.pid).toBeUndefined(); if (existsSync(join(directory, 'processes'))) expect(readdirSync(join(directory, 'processes'))).toEqual([]); rmSync(directory, { recursive: true, force: true }); });
const view = () => { const client = new CodexProvider({ runtime }); clients.push(client); return client; };

test('two agent views share one process, route independently, and release by reference', async () => {
  const a = view(); const b = view(); await Promise.all([a.start(), b.start()]);
  expect(a.connection.pid).toBe(b.connection.pid); expect(readdirSync(join(directory, 'processes'))).toHaveLength(1);
  const [ta, tb] = await Promise.all([a.request('thread/start', {}), b.request('thread/start', {})]);
  const seenA: string[] = []; const seenB: string[] = [];
  a.on('notification', n => seenA.push(n.params.threadId)); b.on('notification', n => seenB.push(n.params.threadId));
  const pendingA = runChatTurn(a, ta.thread.id, 'stall').catch(e => e);
  const turnB = await b.request('turn/start', { threadId: tb.thread.id, input: [] });
  await a.stop(); expect(await pendingA).toBeInstanceOf(Error);
  expect(b.connection.pid).toBeDefined();
  await b.request('turn/interrupt', { threadId: tb.thread.id, turnId: turnB.turn.id });
  expect(seenA.every(id => id === ta.thread.id)).toBe(true); expect(seenB.every(id => id === tb.thread.id)).toBe(true);
});

test('one malformed turn does not kill the shared process or another agent', async () => {
  const a = view(); const b = view(); await Promise.all([a.start(), b.start()]);
  const ta = await a.request('thread/start', {}); const tb = await b.request('thread/start', {});
  const other = await b.request('turn/start', { threadId: tb.thread.id, input: [] });
  const pid = b.connection.pid;
  await expect(runChatTurn(a, ta.thread.id, 'corrupt:1')).rejects.toThrow('Invalid provider notification');
  expect(b.connection.pid).toBe(pid);
  await b.request('turn/interrupt', { threadId: tb.thread.id, turnId: other.turn.id });
});

test('repeated malformed notifications end the process; explicit start can replace it', async () => {
  const a = view(); await a.start(); const { thread } = await a.request('thread/start', {});
  const exited = new Promise<void>(resolve => a.on('exit', () => resolve()));
  await runChatTurn(a, thread.id, 'corrupt:3').catch(() => {}); await exited;
  expect(a.connection.pid).toBeUndefined(); await a.start();
  expect(a.connection.pid).toBeDefined();
});

test('an idle deadline resets on scoped activity and ignores other threads', async () => {
  const fake = new FakeProvider({ mode: 'stall' }); await fake.start();
  try {
    const { thread } = await fake.request('thread/start', {});
    const running = runChatTurn(fake, thread.id, 'slow', { idleTimeoutMs: 60 }).catch(e => e);
    let finished = false; void running.then(() => { finished = true; });
    const activity = setInterval(() => fake.emit('activity', { threadId: thread.id }), 10);
    await Bun.sleep(150); clearInterval(activity);
    expect(finished).toBe(false);
    // Still active after more than two full idle windows.
    const resumed = await fake.request('thread/resume', { threadId: thread.id }); expect(resumed.thread.id).toBe(thread.id);
    expect((await running).message).toContain('idle timed out');
    const unrelated = setInterval(() => fake.emit('activity', { threadId: 'other' }), 5);
    try { await expect(runChatTurn(fake, thread.id, 'idle', { idleTimeoutMs: 30 })).rejects.toThrow('idle timed out'); }
    finally { clearInterval(unrelated); }
  } finally { await fake.stop(); }
});

test('prompt snapshots are immutable, canonical and independent of object insertion order', () => {
  expect(prepareThread({}).promptProfile).toBe('minimal'); // coding remains explicit opt-in.
  const a = prepareThread({ tools: [{ name: 'tool', description: 'test', inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } } } }] });
  const b = prepareThread({ tools: [{ description: 'test', name: 'tool', inputSchema: { properties: { a: { type: 'string' }, z: { type: 'string' } }, type: 'object' } }] });
  expect(promptMetadata(a).prefixHash).toBe(promptMetadata(b).prefixHash);
  expect(Object.isFrozen(a.tools[0]?.inputSchema)).toBe(true);
});

test('agent sandbox/approval settings are forwarded and approvals/elicitation are answered', async () => {
  const a = view(); await a.start();
  const { thread } = await a.request('thread/start', { permissions: { sandbox: 'workspace-write', approvalPolicy: 'on-request' } });
  a.on('request', request => { if (request.method === 'approval/request') a.respond(request.id, { decision: 'accept', content: {} }); });
  for (const text of ['approval:accept', 'elicitation:accept']) {
    const { turn } = await a.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
    await a.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
  }
  const b = view(); await b.start(); const other = await b.request('thread/start', {});
  const { turn } = await b.request('turn/start', { threadId: other.thread.id, input: [{ type: 'text', text: 'approval:decline' }] });
  await b.request('turn/interrupt', { threadId: other.thread.id, turnId: turn.id });
  const calls = readFileSync(join(directory, 'wire.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => call.method === 'thread/start');
  expect(calls[0].params.sandbox).toBe('workspace-write'); expect(calls[0].params.approvalPolicy).toBe('on-request');
  expect(calls[1].params.sandbox).toBe('read-only');
});

test('Claude coding profile retains all built-ins alongside six Kru tools and routes permission decisions', async () => {
  const { ClaudeProvider } = await import('../src/providers/claude/adapter');
  const { scriptedClaude } = await import('./fakes/claude-sdk');
  let captured: Parameters<import('../src/providers/claude/adapter').ClaudeQueryFactory>[0] | undefined;
  const provider = new ClaudeProvider({ query: scriptedClaude('echo', args => { captured = args; }) });
  try {
    await provider.start();
    const tools = ['send_message', 'list_agents', 'tool_3', 'tool_4', 'tool_5', 'tool_6']
      .map(name => ({ name, description: 'test', inputSchema: { type: 'object' } }));
    const { thread } = await provider.request('thread/start', { promptProfile: 'coding', permissions: { sandbox: 'workspace-write', approvalPolicy: 'on-request' }, tools });
    expect(thread.prompt?.toolCount).toBe(6);
    expect(thread.prompt?.builtinToolCount).toBe(6);
    await runChatTurn(provider, thread.id, 'hello');
    expect(captured?.options.systemPrompt).toBe(prepareThread({ promptProfile: 'coding' }).instructions);
    expect(captured?.options.tools).toEqual(['Read', 'Edit', 'Bash', 'Write', 'Glob', 'Grep']);
    expect(captured?.options.tools).toContain('Edit'); expect(captured?.options.permissionMode).toBe('default');
    provider.on('request', request => { if (request.method === 'approval/request') provider.respond(request.id, { decision: 'accept' }); });
    const allowed = await captured!.options.canUseTool!('Write', { file_path: 'example' }, { signal: new AbortController().signal, toolUseID: 'permission-test', requestId: 'permission-test' });
    expect(allowed?.behavior).toBe('allow');
    const resumed = await provider.request('thread/resume', { threadId: thread.id });
    expect(resumed.thread.prompt).toEqual(thread.prompt);
    await expect(provider.request('thread/resume', { threadId: thread.id, tools: [...tools, { ...tools[0]!, name: 'seventh' }] })).rejects.toThrow('six tools');
    const readOnly = await provider.request('thread/resume', { threadId: thread.id, permissions: { sandbox: 'read-only' } });
    expect(readOnly.thread.prompt?.toolCount).toBe(6);
    expect(readOnly.thread.prompt?.builtinToolCount).toBe(3);
    expect(readOnly.thread.prompt?.prefixHash).not.toBe(thread.prompt?.prefixHash);
    await runChatTurn(provider, thread.id, 'hello');
    expect(captured?.options.tools).toEqual(['Read', 'Glob', 'Grep']);
    const minimal = await provider.request('thread/resume', { threadId: thread.id, promptProfile: 'minimal' });
    expect(minimal.thread.prompt?.toolCount).toBe(6);
    expect(minimal.thread.prompt?.builtinToolCount).toBe(0);
    await runChatTurn(provider, thread.id, 'hello');
    expect(captured?.options.tools).toEqual([]);
  } finally { await provider.stop(); }
});

test('Claude maps SDK built-in tool steps to common item events', async () => {
  const { ClaudeProvider } = await import('../src/providers/claude/adapter');
  const { scriptedClaude } = await import('./fakes/claude-sdk');
  const provider = new ClaudeProvider({ query: scriptedClaude() });
  const steps: string[] = [];
  provider.on('notification', n => { if ((n.method === 'item/started' || n.method === 'item/completed') && n.params.item.type === 'commandExecution') steps.push(n.method); });
  try {
    await provider.start(); const { thread } = await provider.request('thread/start', {});
    await runChatTurn(provider, thread.id, 'native-tool');
    expect(steps).toEqual(['item/started', 'item/completed']);
  } finally { await provider.stop(); }
});

test('Claude full profile preserves the preset, project settings and standard tools', async () => {
  const { ClaudeProvider } = await import('../src/providers/claude/adapter');
  const { scriptedClaude } = await import('./fakes/claude-sdk');
  let captured: Parameters<import('../src/providers/claude/adapter').ClaudeQueryFactory>[0] | undefined;
  let composed: boolean | undefined;
  const provider = new ClaudeProvider({ query: args => {
    captured = args;
    const query = scriptedClaude()({ ...args, prompt: (async function* () {
      for await (const message of args.prompt) { composed = message.client_composed; yield message; }
    })() });
    return { close: () => query.close(), interrupt: () => query.interrupt(), async *[Symbol.asyncIterator]() {
      // Native init is the source of truth for the preset's evolving tool count.
      yield { type: 'system', subtype: 'init', tools: ['Read', 'Bash', 'Edit', 'Write', 'Skill', 'mcp__kru__echo'],
        model: 'fixture', claude_code_version: 'fixture' } as unknown as import('@anthropic-ai/claude-agent-sdk').SDKMessage;
      yield* query;
    } };
  } });
  try {
    await provider.start(); const { thread } = await provider.request('thread/start', { promptProfile: 'full', instructions: 'Keep the public API.' });
    expect(thread.prompt?.builtinToolCount).toBeUndefined();
    await runChatTurn(provider, thread.id, 'hello');
    expect(captured?.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Keep the public API.' });
    expect(captured?.options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(captured?.options.settingSources).toEqual(['project', 'local']);
    expect(composed).toBeUndefined(); // Keep native project context/reminder attachments.
    const resumed = await provider.request('thread/resume', { threadId: thread.id });
    expect(resumed.thread.prompt?.prefixHash).toBe(thread.prompt?.prefixHash);
    expect(resumed.thread.prompt?.builtinToolCount).toBe(5);
    await provider.request('thread/resume', { threadId: thread.id, instructions: '' });
    await runChatTurn(provider, thread.id, 'again');
    expect(captured?.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
  } finally { await provider.stop(); }
});
