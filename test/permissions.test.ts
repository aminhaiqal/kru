import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeProvider, CodexProvider, FakeProvider, type ProviderClient } from '../src/providers';
import { scriptedClaude } from './fakes/claude-sdk';
import { runChatTurn } from '../src/chat/turn';

for (const kind of ['fake', 'codex', 'claude'] as const) {
  for (const approvalPolicy of ['on-request', 'never'] as const) test(`${kind}: identical workspace writes and denied escapes with ${approvalPolicy}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kru-permissions-'));
    const cwd = join(directory, 'work'); const extra = join(directory, 'extra'); const outside = join(directory, 'outside');
    for (const path of [cwd, extra, outside]) mkdirSync(path);
    symlinkSync(outside, join(cwd, 'escape'));
    symlinkSync(join(outside, 'missing'), join(cwd, 'dangling'));
    writeFileSync(join(outside, 'existing'), 'test');
    const provider: ProviderClient = kind === 'fake' ? new FakeProvider({ mode: 'permissions' })
      : kind === 'claude' ? new ClaudeProvider({ query: scriptedClaude('permissions') })
      : new CodexProvider({ transport: { command: process.execPath, args: [fileURLToPath(new URL('./fakes/provider-agent.ts', import.meta.url))],
        env: { KRU_FAKE_MODE: 'permissions' }, processRecordDir: join(directory, 'processes'), stopGraceMs: 100 } });
    try {
      await provider.start();
      const { thread } = await provider.request('thread/start', { cwd, promptProfile: 'coding', permissions: { sandbox: 'workspace-write', approvalPolicy, writableRoots: [extra] } });
      const action = async (name: string, path: string) => (await runChatTurn(provider, thread.id,
        JSON.stringify({ name, input: name === 'Bash' ? { command: 'echo test' } : { file_path: path, notebook_path: path } }))).messages.map(m => m.text).join('');
      for (const name of ['Write', 'Edit', 'NotebookEdit']) {
        // No host listener: the CLI must still be able to edit these paths.
        expect(await action(name, join(cwd, 'new', 'file'))).toBe('allowed');
        expect(await action(name, join(extra, 'file'))).toBe('allowed');
        for (const path of [join(outside, 'existing'), join(cwd + '-sibling', 'file'), join(cwd, '..', 'outside', 'file'), join(cwd, 'escape', 'new'), join(cwd, 'dangling'), join(cwd, '.git', 'config'), '~/kru-permission-check']) {
          expect(await action(name, path)).toBe('denied');
        }
      }
      expect(await action('Bash', '')).toBe('denied');
      let requests = 0;
      provider.on('request', r => { requests++; provider.respond(r.id, { decision: 'accept' }); });
      expect(await action('Write', join(outside, 'file'))).toBe(approvalPolicy === 'on-request' ? 'allowed' : 'denied');
      expect(await action('Bash', '')).toBe(approvalPolicy === 'on-request' ? 'allowed' : 'denied');
      expect(requests).toBe(approvalPolicy === 'on-request' ? 2 : 0);
      await provider.request('thread/resume', { threadId: thread.id, permissions: { sandbox: 'read-only', approvalPolicy, writableRoots: [extra] } });
      expect(await action('Write', join(cwd, 'file'))).toBe('denied');
      expect(await action('Edit', join(extra, 'file'))).toBe('denied');
    } finally { await provider.stop(); rmSync(directory, { recursive: true, force: true }); }
  });
}
