import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
const cli = new URL('../src/cli/index.ts', import.meta.url).pathname;
let dir: string, path: string;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kru-m3-cli-')); path = join(dir, 'db.sqlite'); });
afterEach(async () => { if (daemon) { daemon.kill(); await daemon.exited; daemon = undefined; } rmSync(dir, { recursive: true, force: true }); });
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args, '--db', path], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}
async function statusUntil(predicate: (s: { daemon: unknown; lanes: { state: string; reason?: string; queued: number }[] }) => boolean) {
  const end = performance.now() + 2_000;
  for (;;) {
    const result = await run(['status', '--json']); expect(result.code).toBe(0);
    const value = JSON.parse(result.out);
    if (predicate(value)) return value;
    if (performance.now() > end) throw new Error(`Status did not match: ${result.out}`);
    await Bun.sleep(10);
  }
}

test('CLI daemon honors pause, budget and resume controls; status reports the hold', async () => {
  expect((await run(['agent', 'create', 'a', '--provider', 'fake'])).code).toBe(0);
  expect((await run(['agent', 'pause', 'a'])).code).toBe(0);
  expect((await run(['agent', 'set', 'a', '--daily-tokens', '0'])).code).toBe(0);
  expect((await run(['send', 'a', 'queued through CLI'])).code).toBe(0);
  daemon = Bun.spawn([process.execPath, cli, 'daemon', '--db', path, '--shutdown-grace-ms', '10', '--budget-timezone', 'Asia/Kuala_Lumpur'], { stdout: 'pipe', stderr: 'pipe' });
  const initial = await statusUntil(s => s.lanes[0]?.reason === 'paused');
  expect(initial.daemon.budgetTimezone).toBe('Asia/Kuala_Lumpur');
  expect((await run(['agent', 'resume', 'a'])).code).toBe(0);
  await statusUntil(s => s.lanes[0]?.reason === 'budget');
  expect((await run(['status'])).out).toContain('budget (0 of 0 tokens today)');
  expect((await run(['agent', 'set', 'a', '--daily-tokens', '10000'])).code).toBe(0);
  await statusUntil(s => s.lanes.length === 0);
  const store = new Store(path);
  try {
    expect(store.db.query<{ status: string }, []>('SELECT status FROM deliveries').get()!.status).toBe('completed');
  } finally { store.close(); }
  daemon.kill('SIGTERM'); await daemon.exited;
  expect((await run(['status'])).out).toContain('daemon offline');
});

test('CLI validates daemon flags and agent settings without changing stored configuration', async () => {
  expect((await run(['daemon', '--max-turns', '0'])).code).toBe(1);
  expect((await run(['daemon', '--poll-ms', 'invalid'])).code).toBe(1);
  expect((await run(['daemon', '--shutdown-grace-ms', '-1'])).code).toBe(1);
  expect((await run(['status', '--unknown'])).code).toBe(1);
  expect((await run(['daemon', '--budget-timezone', 'Mars/Olympus'])).err).toContain('Invalid budget timezone');
  expect((await run(['agent', 'create', 'a', '--provider', 'fake'])).code).toBe(0);
  for (const args of [['agent', 'set', 'a', '--daily-tokens', '-1'], ['agent', 'set', 'a', '--prompt-profile', 'invalid'],
    ['agent', 'set', 'a', '--sandbox', 'invalid'], ['agent', 'set', 'a'], ['agent', 'pause', 'missing']]) {
    expect((await run(args)).code).toBe(1);
  }
  const store = new Store(path);
  try { expect(new AgentRegistry(store).resolve('a')!.config.dailyTokens).toBeUndefined(); }
  finally { store.close(); }
});

test('second signal bypasses shutdown grace and interrupts an active daemon turn', async () => {
  const store = new Store(path);
  try {
    const agent = new AgentRegistry(store).create({ name: 'stall', provider: 'fake', config: { testMode: 'stall' } });
    new SqliteMailbox(store).enqueue({ sender: { kind: 'user' }, recipientIds: [agent.id], text: 'stall' });
  } finally { store.close(); }
  // Production signal wiring with a fake in-process provider that never completes.
  daemon = Bun.spawn([process.execPath, new URL('./fakes/scheduler-daemon.ts', import.meta.url).pathname, path, '30000'], { stdout: 'pipe', stderr: 'pipe' });
  await statusUntil(s => s.lanes[0]?.state === 'running');
  const began = performance.now();
  daemon.kill('SIGTERM'); await Bun.sleep(20); daemon.kill('SIGINT');
  await daemon.exited;
  expect(performance.now() - began).toBeLessThan(1_000);
  const inspect = new Store(path);
  try {
    expect(new SqliteMailbox(inspect).activeLanes()).toEqual([]);
    expect(inspect.db.query<{ status: string }, []>('SELECT status FROM deliveries').get()!.status).toBe('interrupted');
  } finally { inspect.close(); }
});
