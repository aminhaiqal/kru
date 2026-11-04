import { expect, test } from 'bun:test';
import { claudeTokens, codexTokens } from '../src/providers/token-usage';
import { decodeNotification } from '../src/providers/validation';
import { ClaudeProvider } from '../src/providers/claude/adapter';
import { scriptedClaude } from './fakes/claude-sdk';
import { runChatTurn } from '../src/chat/turn';

test('equivalent provider usage normalizes identically, with and without cache writes', () => {
  expect(claudeTokens({ input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: 7 }))
    .toEqual(codexTokens({ inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 30, outputTokens: 7 }));
  expect(codexTokens({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 7 }))
    .toEqual({ inputTotal: 100, cachedRead: 60, cacheWrite: 0, output: 7, totalTokens: 107 });
  expect(claudeTokens({ input_tokens: 10, output_tokens: 7 }))
    .toEqual({ inputTotal: 10, cachedRead: 0, cacheWrite: 0, output: 7, totalTokens: 17 });
});

test('invalid native usage is rejected at the Codex notification boundary', () => {
  for (const overrides of [{ cachedInputTokens: 101 }, { cacheWriteInputTokens: 41 }, { cachedInputTokens: -1 }, { outputTokens: NaN }, { inputTokens: 1.5 }]) {
    const count = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 7, ...overrides };
    expect(() => decodeNotification('thread/tokenUsage/updated', { threadId: 'thread', turnId: 'turn', tokenUsage: { last: count, total: count } })).toThrow('Invalid token usage');
  }
  expect(() => claudeTokens({ input_tokens: -1, cache_read_input_tokens: 60, output_tokens: 7 })).toThrow('Invalid token usage');
});

test('Claude separates per-turn cache counts from cumulative resumed-session usage', async () => {
  const provider = new ClaudeProvider({ query: args => {
    const query = scriptedClaude()(args);
    return { interrupt: () => query.interrupt(), close: () => query.close(),
      async *[Symbol.asyncIterator]() {
        let turns = 0;
        for await (const message of query) {
          if (message.type !== 'result') { yield message; continue; }
          turns++;
          yield { ...message, modelUsage: { model: {
            inputTokens: 10 + 5 * turns, cacheReadInputTokens: 40 + 20 * turns,
            cacheCreationInputTokens: 60 + 30 * turns, outputTokens: 22 + 11 * turns,
            costUSD: 0, webSearchRequests: 0, contextWindow: 128000, maxOutputTokens: 1000,
          } } };
        }
      } };
  } });
  try {
    await provider.start(); const { thread } = await provider.request('thread/start', {});
    for (let turn = 1; turn <= 2; turn++) {
      const { usage } = await runChatTurn(provider, thread.id, 'hello');
      expect(usage!.last).toEqual({ inputTotal: 55, cachedRead: 20, cacheWrite: 30, output: 11, totalTokens: 66 });
      expect(usage!.total).toEqual({ inputTotal: 110 + 55 * turn, cachedRead: 40 + 20 * turn,
        cacheWrite: 60 + 30 * turn, output: 22 + 11 * turn, totalTokens: 132 + 66 * turn });
      await provider.request('thread/resume', { threadId: thread.id });
    }
  } finally { await provider.stop(); }
});

test('Claude reports cache lifetimes and counts unique model steps and tool calls per turn', async () => {
  const provider = new ClaudeProvider({ query: args => {
    const source = scriptedClaude()(args);
    return { interrupt: () => source.interrupt(), close: () => source.close(), async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'fixture', model: 'claude-sonnet-5-5', claude_code_version: 'fixture', tools: ['Read', 'Bash'] } as unknown as import('@anthropic-ai/claude-agent-sdk').SDKMessage;
      for await (const message of source) {
        if (message.type === 'result') yield { ...message, usage: { ...message.usage,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } };
        else { yield message; if (message.type === 'assistant') yield message; }
      }
    } };
  } });
  try {
    await provider.start(); const { thread } = await provider.request('thread/start', {});
    const result = await runChatTurn(provider, thread.id, 'native-tool');
    expect(result.usage).toMatchObject({ model: 'claude-sonnet-5-5', modelSteps: 2, toolCalls: 1,
      last: { cacheWrite: 30, cacheWriteByLifetime: { fiveMinutes: 10, oneHour: 20 } } });
  } finally { await provider.stop(); }
});
