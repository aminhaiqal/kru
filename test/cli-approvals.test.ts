import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachApprovals } from '../src/cli/approvals';
import { TerminalInput } from '../src/cli/terminal-input';
import { FakeProvider } from '../src/providers/fake/adapter';
import { CodexProvider } from '../src/providers/codex/adapter';
import { runChatTurn } from '../src/chat/turn';
import type { ApprovalCall } from '../src/providers/protocol';

class ApprovalProvider extends FakeProvider {
  ask(kind: ApprovalCall['kind'] = 'command', input: unknown = { command: 'echo hello' }, signal = new AbortController().signal) {
    return this.callApproval({ threadId: 'thread', turnId: 'turn', kind, input }, signal);
  }
  tool() {
    return this.callTool({ threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'unknown', arguments: {} }, new AbortController().signal);
  }
}

function setup(policy: 'on-request' | 'never' = 'on-request', toolTimeoutMs = 1_000) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const terminal = new TerminalInput(input, output, false);
  const provider = new ApprovalProvider({ toolTimeoutMs });
  const detach = attachApprovals(provider, policy, terminal);
  return { input, terminal, provider, detach, text: () => text };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 2_000; i++) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error('Prompt did not appear');
}

test('Codex native approval requests use CLI answers and send only a per-action decision', async () => {
  for (const [answer, decision] of [['yes', 'accept'], ['no', 'decline'], ['', 'decline']] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'kru-cli-codex-approval-'));
    const capture = join(directory, 'wire.ndjson');
    const provider = new CodexProvider({ transport: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fakes/provider-agent.ts', import.meta.url))],
      env: { KRU_FAKE_MODE: 'stall', KRU_CAPTURE_FILE: capture },
      processRecordDir: join(directory, 'processes'), stopGraceMs: 100,
    } });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', chunk => { text += chunk; });
    const terminal = new TerminalInput(input, output, false);
    const detach = attachApprovals(provider, 'on-request', terminal);
    try {
      await provider.start();
      const { thread } = await provider.request('thread/start', { permissions: { sandbox: 'workspace-write', approvalPolicy: 'on-request' } });
      const turn = provider.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `approval:${decision}` }] });
      await until(() => text.includes('[y/N]'));
      expect(text).toContain('echo test');
      input.write(`${answer}\n`);
      await turn; // The native peer validates the exact decision before replying.
      const messages = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const reply = messages.find(message => String(message.id).startsWith('approval-') && 'result' in message);
      expect(reply?.result).toEqual({ decision });
    } finally {
      detach(); await provider.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('CLI approvals accept only explicit yes and default to no', async () => {
  for (const answer of ['y', 'YES', ' yes ', 'n', 'no', '', 'sure', 'yes please']) {
    const s = setup();
    try {
      const reply = s.provider.ask('command', { name: 'Bash', input: { command: 'echo hello', cwd: '/workspace' } });
      await until(() => s.text().includes('[y/N]'));
      expect(s.text()).toContain('echo hello');
      expect(s.text()).toContain('/workspace');
      s.input.write(`${answer}\n`);
      expect(await reply).toEqual({ decision: /^(y|yes)$/i.test(answer.trim()) ? 'accept' : 'decline' });
    } finally { s.detach(); }
  }
});

test('file approvals show the path and native proposed changes', async () => {
  const s = setup();
  try {
    s.provider.emit('notification', { method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: {
      id: 'file', type: 'fileChange', details: { changes: [{ path: '/outside/config', diff: '+proposed content' }] },
    } } });
    const reply = s.provider.ask('file', { itemId: 'file', reason: 'Write outside cwd' });
    await until(() => s.text().includes('[y/N]'));
    expect(s.text()).toContain('/outside/config');
    expect(s.text()).toContain('+proposed content');
    s.input.write('yes\n');
    expect(await reply).toEqual({ decision: 'accept' });
  } finally { s.detach(); }
});

test('never, non-terminal and structured approval requests decline without prompting', async () => {
  const s = setup('never');
  try {
    expect(await s.provider.ask()).toEqual({ decision: 'decline' });
    expect(s.text()).toBe('');
  } finally { s.detach(); }
  const provider = new ApprovalProvider();
  const detach = attachApprovals(provider, 'on-request');
  try { expect(await provider.ask()).toEqual({ decision: 'decline' }); }
  finally { detach(); }
  const unsupported = setup();
  try {
    for (const kind of ['permissions', 'elicitation', 'tool'] as const) {
      expect(await unsupported.provider.ask(kind)).toEqual({ decision: 'decline' });
    }
    expect(unsupported.text()).toBe('');
    await expect(unsupported.provider.tool()).rejects.toThrow('no tool handler');
  } finally { unsupported.detach(); }
});

test('opaque approval requests cannot be accepted without a command or file path', async () => {
  const s = setup();
  try {
    expect(await s.provider.ask('command', { itemId: 'unknown' })).toEqual({ decision: 'decline' });
    expect(await s.provider.ask('file', { itemId: 'unknown' })).toEqual({ decision: 'decline' });
    expect(s.text()).toContain('no command or file path');
    expect(s.text()).not.toContain('[y/N]');
  } finally { s.detach(); }
});

test('EOF declines the active approval and all subsequent requests', async () => {
  const s = setup();
  try {
    const first = s.provider.ask();
    const second = s.provider.ask();
    await until(() => s.text().includes('[y/N]'));
    s.input.end();
    expect(await first).toEqual({ decision: 'decline' });
    expect(await second).toEqual({ decision: 'decline' });
  } finally { s.detach(); }
});

test('cancellation closes approval input so late consent cannot approve a queued request', async () => {
  const s = setup();
  try {
    const controller = new AbortController();
    const first = s.provider.ask('command', undefined, controller.signal).catch(error => error);
    const second = s.provider.ask('command', { command: 'other command' });
    await until(() => s.text().includes('[y/N]'));
    controller.abort(new Error('Turn cancelled'));
    s.input.write('yes\n');
    expect((await first).message).toBe('Turn cancelled');
    expect(await second).toEqual({ decision: 'decline' });
    expect(s.text()).toContain('cancelled or expired');
  } finally { s.detach(); }
});

test('an approval deadline releases terminal input and rejects without a stale response', async () => {
  const s = setup('on-request', 20);
  try {
    await expect(s.provider.ask()).rejects.toThrow('Tool response timed out');
    expect(await s.terminal.read('you> ')).toBeUndefined();
  } finally { s.detach(); }
});

test('concurrent requests require separate answers and discard pretyped consent', async () => {
  const s = setup();
  try {
    s.input.write('yes\n'); // No prompt exists yet.
    const first = s.provider.ask('command', { command: 'first command' });
    const second = s.provider.ask('command', { command: 'second command' });
    await until(() => s.text().includes('[y/N]'));
    expect(s.text()).not.toContain('second command');
    s.input.write('yes\nyes\n'); // The extra line must not approve the next request.
    expect(await first).toEqual({ decision: 'accept' });
    await until(() => s.text().includes('second command'));
    s.input.write('no\n');
    expect(await second).toEqual({ decision: 'decline' });
  } finally { s.detach(); }
});

test('partial consent typed before a terminal prompt is cleared', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const terminal = new TerminalInput(input, output, true);
  try {
    input.write('yes');
    const answer = terminal.read('Allow? [y/N] ');
    input.write('\n');
    expect(await answer).toBe('');
  } finally { terminal.close(); }
});

test('Ctrl+C closes the pending terminal reader through the interrupt handler', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let interrupts = 0;
  const terminal = new TerminalInput(input, output, true, () => { interrupts++; terminal.close(); });
  try {
    const answer = terminal.read('Allow? [y/N] ');
    input.write('\u0003');
    expect(await answer).toBeUndefined();
    expect(interrupts).toBe(1);
  } finally { terminal.close(); }
});

test('approval previews escape terminal sequences and direction controls', async () => {
  const s = setup();
  try {
    const reply = s.provider.ask('command', { command: 'echo safe\u001b[2J\u009b2J\u202eevil' });
    await until(() => s.text().includes('[y/N]'));
    expect(s.text()).toContain('\\u001b');
    expect(s.text()).toContain('\\u009b');
    expect(s.text()).toContain('\\u202e');
    expect(s.text()).not.toContain('\u001b');
    expect(s.text()).not.toContain('\u202e');
    s.input.write('n\n');
    await reply;
  } finally { s.detach(); }
});

test('chat and approvals share one reader without turning consent into a chat message', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const terminal = new TerminalInput(input, output, false);
  const provider = new FakeProvider({ mode: 'permissions' });
  const detach = attachApprovals(provider, 'on-request', terminal);
  try {
    await provider.start();
    const { thread } = await provider.request('thread/start', { promptProfile: 'coding', permissions: { sandbox: 'workspace-write', approvalPolicy: 'on-request' } });
    const chat = terminal.read('you> ');
    input.write('{"name":"Bash","input":{"command":"echo hello"}}\n');
    const turn = runChatTurn(provider, thread.id, (await chat)!);
    await until(() => text.includes('[y/N]'));
    input.write('yes\n');
    expect((await turn).messages[0]?.text).toBe('allowed');
    const next = terminal.read('you> ');
    input.write('/quit\n');
    expect(await next).toBe('/quit');
  } finally { detach(); await provider.stop(); }
});
