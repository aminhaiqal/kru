import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';

let dir: string, path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kru-mail-cli-')); path = join(dir, 'state.sqlite'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const cli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
async function run(args: string[], env: Record<string, string | undefined> = {}, cwd = dir) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd,
    env: { ...process.env, KRU_DB: path, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test('CLI creates agents, sends durable fanout, lists, cancels and explicitly retries', async () => {
  expect((await run(['agent', 'create', 'reviewer', '--provider', 'fake'])).code).toBe(0);
  expect((await run(['agent', 'create', 'coder', '--provider', 'codex', '--cwd', dir])).code).toBe(0);
  expect((await run(['agent', 'list'])).stdout).toContain('"reviewer" fake');
  const args = ['send', 'reviewer,coder', 'review this', '--idempotency-key', 'cli-key'];
  const receipt = await run(args);
  expect(receipt.code).toBe(0); expect(receipt.stdout).toMatch(/^queued message .+ delivery .+,.+\n$/);
  expect((await run(args)).stdout).toBe(receipt.stdout.replace('queued', 'duplicate'));
  const conflict = await run(['send', 'reviewer,coder', 'other text', '--idempotency-key', 'cli-key']);
  expect(conflict.code).toBe(1); expect(conflict.stderr).toContain('different content');
  const queue = await run(['queue', 'reviewer']);
  expect(queue.stdout).toMatch(/^\S+ queued user "review this"\n$/);
  const id = queue.stdout.split(' ')[0]!;
  expect((await run(['cancel', id])).code).toBe(0);
  expect((await run(['queue', 'reviewer'])).stdout).toBe('');
  expect((await run(['queue', 'coder'])).stdout).toContain('review this');
  expect((await run(['retry', id])).code).toBe(0);
  expect((await run(['queue', 'reviewer'])).stdout).toContain('review this');
  const store = new Store(path);
  try {
    const agent = new AgentRegistry(store).resolve('reviewer')!;
    expect(realpathSync(agent.config.cwd as string)).toBe(realpathSync(dir));
    expect(new SqliteMailbox(store).get(id)!.status).toBe('cancelled');
    expect(new SqliteMailbox(store).listQueue(agent.id)[0]!.retryOf).toBe(id);
  } finally { store.close(); }
});

test('CLI selects lanes and explicit --db overrides KRU_DB', async () => {
  const explicit = join(dir, 'explicit.sqlite');
  expect((await run(['agent', 'create', 'a', '--provider', 'fake', '--db', explicit])).code).toBe(0);
  expect(existsSync(path)).toBe(false);
  expect((await run(['send', 'a', '--lane', 'side', '--db', explicit, '--', '--literal'])).code).toBe(0);
  expect((await run(['send', 'a', '--lane', 'side', '--db', explicit, '--', '--help'])).stdout).toContain('queued message');
  expect((await run(['queue', 'a', '--main', '--db', explicit])).stdout).toBe('');
  expect((await run(['queue', 'a', '--lane', 'side', '--db', explicit])).stdout).toContain('"--literal"');
});

test('CLI help, invalid arguments and unknown agents return useful failures', async () => {
  expect((await run(['send', '--help'])).stdout).toContain('--idempotency-key');
  expect(existsSync(path)).toBe(false);
  for (const args of [['agent', 'create'], ['agent', 'create', 'a', '--provider', 'unknown'],
    ['agent', 'list', '--provider', 'fake'], ['send', 'a'], ['send', 'a', 'hi', '--unknown'],
    ['send', 'a', 'hi', '--db'], ['queue', 'a', '--main', '--lane', 'side'], ['cancel'],
    ['queue', 'a', '--lane', 'x', '--lane', 'y']]) {
    const result = await run(args); expect(result.code).toBe(1); expect(result.stderr).toContain('error:');
  }
  expect(existsSync(path)).toBe(false);
  expect((await run(['send', 'missing', 'hi'])).stderr).toContain('Unknown agent');
  expect((await run(['queue', 'missing'])).code).toBe(1);
  expect((await run(['cancel', 'missing'])).code).toBe(1);
});


test('init discovers the same project from subfolders and never creates a second mailbox', async () => {
  const env = { KRU_DB: undefined };
  const subfolder = join(dir, 'src', 'nested'); mkdirSync(subfolder, { recursive: true });
  const missing = await run(['send', 'a', 'hello'], env, subfolder);
  expect(missing.code).toBe(1); expect(missing.stderr).toContain('kru init');
  expect(existsSync(join(subfolder, '.kru'))).toBe(false);
  expect((await run(['init'], env)).code).toBe(0);
  expect((await run(['agent', 'create', 'a', '--provider', 'fake'], env)).code).toBe(0);
  expect((await run(['send', 'a', 'from subfolder'], env, subfolder)).code).toBe(0);
  expect((await run(['queue', 'a'], env)).stdout).toContain('from subfolder');
  expect((await run(['init'], env, subfolder)).stdout).toContain(realpathSync(dir));
  expect((await run(['queue', 'a'], env, subfolder)).stdout).toContain('from subfolder');
  expect(existsSync(join(subfolder, '.kru'))).toBe(false);
  expect(existsSync(join(dir, '.kru', 'kru.sqlite'))).toBe(true);
});

test('init handles an existing marker without a database and honors explicit overrides', async () => {
  mkdirSync(join(dir, '.kru'));
  const env = { KRU_DB: undefined };
  const result = await run(['agent', 'list'], env);
  expect(result.code).toBe(1); expect(result.stderr).toContain('kru init');
  expect(existsSync(join(dir, '.kru', 'kru.sqlite'))).toBe(false);
  expect((await run(['init'], env)).code).toBe(0);
  const external = join(dir, 'external.sqlite');
  expect((await run(['init', '--db', external])).code).toBe(0);
  expect(existsSync(external)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect((await run(['init'])).code).toBe(0); // KRU_DB override
  expect(existsSync(path)).toBe(true);
  expect((await run(['init', 'unexpected'], env)).code).toBe(1);
});
