import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeProvider, CodexProvider } from '../src/providers';
import { runChatTurn } from '../src/chat/turn';
import { scriptedClaude } from './fakes/claude-sdk';

for (const kind of ['claude', 'codex'] as const) {
  for (const mode of ['quiet', 'output', 'progress', 'post-quiet', 'cancel'] as const) test(`${kind}: native command ${mode} liveness`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kru-liveness-'));
    const provider = kind === 'claude' ? new ClaudeProvider({ query: scriptedClaude('stall') })
      : new CodexProvider({ transport: { command: process.execPath, args: [fileURLToPath(new URL('./fakes/provider-agent.ts', import.meta.url))], env: { KRU_FAKE_MODE: 'stall' }, processRecordDir: directory, stopGraceMs: 100 } });
    try {
      await provider.start(); const { thread } = await provider.request('thread/start', {});
      const abort = new AbortController();
      const started = performance.now();
      const running = runChatTurn(provider, thread.id, `native-command:${mode === 'cancel' ? 'quiet' : mode}`, { idleTimeoutMs: 80, signal: abort.signal });
      if (mode === 'cancel') {
        const timer = setTimeout(() => abort.abort(new Error('cancelled')), 120);
        try { await expect(running).rejects.toThrow('cancelled'); }
        finally { clearTimeout(timer); }
      } else if (mode === 'post-quiet') {
        await expect(running).rejects.toThrow('idle timed out');
        expect(performance.now() - started).toBeGreaterThan(280);
      } else {
        expect((await running).turn.status).toBe('completed');
        expect(performance.now() - started).toBeGreaterThan(200);
      }
      expect(provider.listenerCount('activity')).toBe(0);
      expect(provider.listenerCount('notification')).toBe(0);
    } finally { await provider.stop(); rmSync(directory, { recursive: true, force: true }); }
  });
}
