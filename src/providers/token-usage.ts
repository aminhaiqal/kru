import type { TokenCount } from './protocol';

export const zeroTokens = (): TokenCount => ({ inputTotal: 0, cachedRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 });
export function tokenCount(inputTotal: number, cachedRead: number, cacheWrite: number, output: number): TokenCount {
  const totalTokens = inputTotal + output;
  if (![inputTotal, cachedRead, cacheWrite, output, totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)
    || inputTotal < cachedRead + cacheWrite) throw new TypeError('Invalid token usage');
  return { inputTotal, cachedRead, cacheWrite, output, totalTokens };
}
/** Anthropic reports uncached input separately from reads and writes. */
export function claudeTokens(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): TokenCount {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0) throw new TypeError('Invalid token usage');
  return tokenCount(usage.input_tokens + read + write, read, write, usage.output_tokens);
}
/** Codex inputTokens already includes cache reads and writes. Older versions omit writes. */
export function codexTokens(usage: Record<string, unknown>): TokenCount {
  return tokenCount(usage.inputTokens as number, usage.cachedInputTokens as number,
    (usage.cacheWriteInputTokens ?? 0) as number, usage.outputTokens as number);
}
export function addTokens(a: TokenCount, b: TokenCount): TokenCount {
  return tokenCount(a.inputTotal + b.inputTotal, a.cachedRead + b.cachedRead, a.cacheWrite + b.cacheWrite, a.output + b.output);
}
