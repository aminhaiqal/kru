import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeProvider } from '../src/providers/claude/adapter';
import { runChatTurn } from '../src/chat/turn';

test.skipIf(process.env.KRU_TEST_CLAUDE_CHAT !== '1')('real Claude streams through its input queue, reports usage and calls an in-process MCP tool', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kru-claude-live-'));
  const provider = new ClaudeProvider({ processRecordDir: join(cwd, 'processes') });
  try {
    await provider.start();
    const { thread } = await provider.request('thread/start', { cwd, promptProfile: 'minimal', tools: [{ name: 'kru_echo', description: 'Return a test marker.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] });
    const first = await runChatTurn(provider, thread.id, 'Reply with exactly KRU_CLAUDE_OK. Do not use tools.', { idleTimeoutMs: 90_000 });
    expect(first.messages.map(m => m.text).join('').trim()).toBe('KRU_CLAUDE_OK');
    expect(first.usage?.last.totalTokens).toBeGreaterThan(0);
    provider.on('request', request => {
      if (request.method === 'approval/request') provider.respond(request.id, { decision: 'decline' });
      else provider.respond(request.id, { success: true, contentItems: [{ type: 'inputText', text: 'CLAUDE_TOOL_OK' }] });
    });
    expect((await provider.request('thread/resume', { threadId: thread.id })).thread.prompt?.prefixHash).toBe(thread.prompt?.prefixHash);
    const second = await runChatTurn(provider, thread.id, 'Call kru_echo with text "test" then reply only with the tool result.', { idleTimeoutMs: 90_000 });
    expect(second.messages.map(m => m.text).join('').trim()).toBe('CLAUDE_TOOL_OK');
    expect(second.turn.id).not.toBe(first.turn.id);
    await provider.stop();
    const replacement = new ClaudeProvider({ processRecordDir: join(cwd, 'processes') });
    try {
      await replacement.start();
      const resumed = await replacement.request('thread/resume', { threadId: thread.id, cwd });
      expect(resumed.thread.id).toBe(thread.id);
    } finally { await replacement.stop(); }
  } finally { await provider.stop(); rmSync(cwd, { recursive: true, force: true }); }
}, 240_000);
