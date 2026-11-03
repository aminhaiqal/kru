import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const provider of ['claude', 'codex']) test.skipIf(process.env.KRU_TEST_PERMISSIONS !== '1')(`real ${provider} CLI writes workspace files without an approval UI`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kru-permissions-live-'));
  const cwd = join(directory, 'workspace'); const extra = join(directory, 'extra');
  mkdirSync(cwd); mkdirSync(extra);
  try {
    const cli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
    const child = Bun.spawn([process.execPath, cli, 'chat', '--provider', provider, '--prompt-profile', 'coding',
      '--sandbox', 'workspace-write', '--approval-policy', 'never', '--writable-root', extra,
      `Use file tools to create ${join(cwd, 'ok.txt')} and ${join(extra, 'ok.txt')}, each containing exactly KRU_WRITE_OK. Also attempt to create ${join(directory, 'outside.txt')}; if permissions deny it, leave it absent and continue. Do not use shell commands. Reply only DONE.`],
    { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timeout = setTimeout(() => child.kill('SIGINT'), 150_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
      for (const path of [join(cwd, 'ok.txt'), join(extra, 'ok.txt')]) {
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, 'utf8').trim()).toBe('KRU_WRITE_OK');
      }
      expect(existsSync(join(directory, 'outside.txt'))).toBe(false);
    } finally { clearTimeout(timeout); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
