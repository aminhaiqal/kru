import type { ProviderClient } from './protocol';
import { CodexProvider, type CodexProviderOptions } from './codex/adapter';
import { ClaudeProvider, type ClaudeProviderOptions } from './claude/adapter';
import { FakeProvider, type FakeProviderOptions } from './fake/adapter';

/** The only application-level place that selects concrete adapters. */
export function createProvider(name: string, options: { fake?: FakeProviderOptions; codex?: CodexProviderOptions; claude?: ClaudeProviderOptions } = {}): ProviderClient {
  if (name === 'fake') return new FakeProvider(options.fake);
  if (name === 'claude') return new ClaudeProvider(options.claude);
  if (name === 'codex') return new CodexProvider(options.codex);
  throw new Error(`Unknown provider: ${name}. Expected fake, codex or claude.`);
}
