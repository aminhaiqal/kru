import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider, type Notification } from '../src/providers';
import { runChatTurn } from '../src/chat/turn';

// Explicit opt-in: these tests use the installed provider's login and model quota.
const live = test.skipIf(process.env.KRU_TEST_CODEX_CHAT !== '1');
live('real Codex streams the same chat path, resumes and answers a dynamic tool call', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kru-live-chat-'));
  const provider = createProvider('codex', { codex: { transport: { processRecordDir: join(cwd, 'processes') } } });
  try {
    await provider.start();
    const { thread } = await provider.request('thread/start', { cwd, ...(process.env.KRU_TEST_MODEL ? { model: process.env.KRU_TEST_MODEL } : {}),
      tools: [{ name: 'kru_echo', description: 'Returns a test marker. Call exactly once when asked.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
    });
    let streamed = '';
    const first = await runChatTurn(provider, thread.id, 'Reply with exactly KRU_M1_OK. Do not use tools.', { timeoutMs: 60_000, onDelta: delta => { streamed += delta; } });
    expect(streamed.trim()).toBe('KRU_M1_OK'); expect(first.messages.map(m => m.text).join('').trim()).toBe('KRU_M1_OK');
    expect(first.usage?.last.totalTokens).toBeGreaterThan(0);
    expect((await provider.request('thread/resume', { threadId: thread.id, cwd })).thread.id).toBe(thread.id);
    let calls = 0;
    provider.on('request', request => {
      if (request.method !== 'item/tool/call') { provider.respond(request.id, { decision: 'decline' }); return; }
      expect(request.params.tool).toBe('kru_echo'); calls++;
      provider.respond(request.id, { success: true, contentItems: [{ type: 'inputText', text: 'KRU_TOOL_OK' }] });
    });
    const second = await runChatTurn(provider, thread.id, 'Call kru_echo exactly once with text "test", then reply with only the text returned by that tool. Do not use any other tool.', { timeoutMs: 60_000 });
    expect(calls).toBe(1);
    expect(second.messages.map(m => m.text).join('').trim()).toBe('KRU_TOOL_OK');
  } finally { await provider.stop(); rmSync(cwd, { recursive: true, force: true }); }
}, 180_000);

live('real Codex interrupts an active turn through the common port', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kru-live-interrupt-'));
  const provider = createProvider('codex', { codex: { transport: { processRecordDir: join(cwd, 'processes') } } });
  try {
    await provider.start();
    const { thread } = await provider.request('thread/start', { cwd });
    let interruption: Promise<unknown> | undefined;
    let overlap: Promise<unknown> | undefined;
    const onNotification = (n: Notification) => {
      if (n.params.threadId !== thread.id) return;
      if (n.method === 'turn/started' && !interruption) {
        overlap = provider.request('turn/start', { threadId: thread.id, input: [] }).catch(error => error);
        interruption = provider.request('turn/interrupt', { threadId: thread.id, turnId: n.params.turn.id });
        void interruption.catch(() => {});
      }
    };
    provider.on('notification', onNotification);
    const result = await runChatTurn(provider, thread.id, 'Write a long essay about trees.', { timeoutMs: 45_000 }).catch(error => error);
    await interruption;
    expect(result.message).toBe('Turn interrupted');
    expect((await overlap as Error).message).toBe('A turn is already active');
    provider.off('notification', onNotification);
  } finally { await provider.stop(); rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);
