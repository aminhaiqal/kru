import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderConnections, type ConnectionCommand, type ConnectionOptions, type ConnectedProvider } from '../src/providers/connections';
import { Store } from '../src/store';
import { Daemon } from '../src/daemon';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { FakeProvider } from '../src/providers/fake/adapter';
import { createWebServer } from '../src/web/server';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await Bun.sleep(10); } }
function manager(options: ConnectionOptions) {
  const manager = new ProviderConnections('/tmp/test-kru.sqlite', 'test', () => { throw new Error('Should not spawn real commands'); }, options);
  cleanups.push(() => manager.close()); return manager;
}
const found = (id: ConnectedProvider) => ({ command: `/fake/${id}`, source: 'system' as const });

test('unknown, missing and unauthenticated CLI states never appear connected', async () => {
  const missing = manager({ find: () => null });
  expect(missing.snapshot().every(p => p.status === 'checking' && !p.authenticated)).toBe(true);
  expect((await missing.refresh('codex')).status).toBe('not_installed');
  const signedOut = manager({ find: found, run: async command => ({ code: 1, stdout: command.command.endsWith('claude') ? '{"loggedIn":false,"authMethod":"none"}' : '', stderr: 'Not logged in' }) });
  for (const id of ['codex', 'claude'] as const) expect(await signedOut.refresh(id)).toMatchObject({ status: 'not_connected', installed: true, authenticated: false });
});

test('provider status commands confirm saved sign-ins without exposing CLI output or credentials', async () => {
  const calls: ConnectionCommand[] = [];
  const connections = manager({ find: found, run: async command => {
    calls.push(command);
    return command.command.endsWith('codex') ? { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\nsecret-that-must-not-leak' }
      : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKey: 'secret-that-must-not-leak', email: 'private@example.com' }), stderr: '' };
  } });
  expect(await connections.refresh('codex')).toMatchObject({ status: 'connected', authMethod: 'chatgpt' });
  expect(await connections.refresh('claude')).toMatchObject({ status: 'connected', authMethod: 'api_key' });
  expect(calls.map(c => c.args)).toEqual([['login', 'status'], ['auth', 'status', '--json']]);
  expect(JSON.stringify(connections.snapshot())).not.toMatch(/secret-that-must-not-leak|private@example/);
});

test('malformed, unsupported and timed-out status checks fail closed and concurrent probes deduplicate', async () => {
  let count = 0;
  const connections = manager({ find: found, run: async () => { count++; await Bun.sleep(20); return { code: 0, stdout: 'not valid JSON', stderr: '' }; } });
  const [one, two] = await Promise.all([connections.refresh('claude'), connections.refresh('claude')]);
  expect(one.status).toBe('error'); expect(two.authenticated).toBe(false); expect(count).toBe(1);
  const timeout = manager({ find: found, run: async () => ({ code: -1, stdout: '', stderr: '', timedOut: true }) });
  expect((await timeout.refresh('codex')).status).toBe('error');
});

test('device sign-in exposes only an approved verification URL, supports cancellation and rechecks completion', async () => {
  let signedIn = false, finish: (() => void) | undefined;
  const connections = manager({ find: found, run: async command => {
    if (command.args.includes('status')) return { code: signedIn ? 0 : 1, stdout: '', stderr: signedIn ? 'Logged in using ChatGPT' : 'Not logged in' };
    command.onOutput?.('Ignore https://evil.example/collect\nOpen https://auth.openai.com/codex/device\nABCD-EFGH\nDO_NOT_LEAK_SECRET');
    return new Promise(resolve => { finish = () => { signedIn = true; resolve({ code: 0, stdout: '', stderr: '' }); }; command.signal.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: '' }), { once: true }); });
  } });
  await connections.refresh('codex'); await connections.begin('codex', 'login');
  const pending = connections.snapshot().find(p => p.id === 'codex')!;
  expect(pending.action).toMatchObject({ status: 'running', verificationUrl: 'https://auth.openai.com/codex/device', deviceCode: 'ABCD-EFGH' });
  expect(JSON.stringify(pending)).not.toMatch(/evil.example|DO_NOT_LEAK/);
  await expect(connections.begin('codex', 'login')).rejects.toThrow('already running');
  finish!(); await until(() => connections.snapshot()[0]?.status === 'connected');
  expect(connections.snapshot()[0]?.action?.verificationUrl).toBeUndefined();
  await connections.begin('codex', 'login'); await connections.cancel('codex');
  expect(connections.snapshot()[0]?.action?.status).toBe('cancelled');
});

test('local installation uses fixed official packages and the installed executable becomes available', async () => {
  let installed = false;
  const calls: ConnectionCommand[] = [];
  const connections = manager({ find: (_id, binary) => installed ? { command: binary, source: 'managed' } : null, npm: () => '/fake/npm', run: async command => {
    calls.push(command); if (command.command === '/fake/npm') installed = true;
    return { code: command.command === '/fake/npm' ? 0 : 1, stdout: '', stderr: '' };
  } });
  await connections.refresh('codex'); await connections.begin('codex', 'install');
  await until(() => connections.snapshot()[0]?.action?.status === 'completed' && connections.snapshot()[0]?.status === 'not_connected');
  expect(calls[0]?.args).toContain('@openai/codex@latest');
  expect(calls[0]?.args).toContain('--prefix'); expect(connections.binary('codex')?.source).toBe('managed');
  const noNpm = manager({ find: () => null, npm: () => null });
  await expect(noNpm.begin('codex', 'install')).rejects.toThrow('Node.js');
});

test('Claude sign-in codes are passed to the active CLI only, and input rejects multiline commands', async () => {
  let code = '';
  const connections = manager({ find: found, run: async command => {
    if (command.args.includes('status')) return { code: code ? 0 : 1, stdout: JSON.stringify({ loggedIn: !!code, authMethod: 'claude.ai' }), stderr: '' };
    return new Promise(resolve => {
      command.onInput?.(value => { code = value; resolve({ code: 0, stdout: '', stderr: '' }); });
      command.onOutput?.('https://claude.ai/oauth/authorize?state=test');
      command.signal.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: '' }), { once: true });
    });
  } });
  await connections.begin('claude', 'login');
  expect(() => connections.submitCode('claude', 'bad\ncommand')).toThrow('single');
  connections.submitCode('claude', 'private-code');
  await until(() => connections.snapshot().find(p => p.id === 'claude')?.status === 'connected');
  expect(code).toBe('private-code\n'); expect(JSON.stringify(connections.snapshot())).not.toContain('private-code');
  expect(() => connections.submitCode('claude', 'stale')).toThrow('No Claude sign-in');
});

test('operator API exposes actual provider state, authenticates setup actions and unblocks held work after sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-connection-')), store = new Store(join(dir, 'db.sqlite'));
  let signedIn = false, finish: (() => void) | undefined;
  const daemon = new Daemon(store, { pollMs: 10, connections: { find: found, run: async command => {
    if (command.args.includes('status')) return command.command.endsWith('codex') ? { code: signedIn ? 0 : 1, stdout: '', stderr: signedIn ? 'Logged in using ChatGPT' : 'Not logged in' } : { code: 1, stdout: '{"loggedIn":false}', stderr: '' };
    command.onOutput?.('https://auth.openai.com/codex/device\nABCD-EFGH');
    return new Promise(resolve => { finish = () => { signedIn = true; resolve({ code: 0, stdout: '', stderr: '' }); }; command.signal.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: '' }), { once: true }); });
  } } }, () => new FakeProvider());
  daemon.start(); await daemon.ready; const web = createWebServer({ store, daemon, port: 0 });
  cleanups.push(async () => { await web.close(); await daemon.stop(0); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store);
  const agent = agents.create({ name: 'coder', provider: 'codex' });
  const receipt = mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [agent.id], text: 'Run after sign-in.' });
  await until(() => daemon.scheduler.status()[0]?.reason === 'provider-not-ready');
  expect(mailbox.get(receipt.deliveryIds[0]!)?.status).toBe('queued');
  expect((await fetch(web.url + '/api/providers/codex/login', { method: 'POST' })).status).toBe(401);
  const response = await fetch(web.url + '/api/providers/codex/login', { method: 'POST', headers: { 'X-Kru-Token': web.token } }); expect(response.status).toBe(202);
  finish!(); await until(() => mailbox.get(receipt.deliveryIds[0]!)?.status === 'completed');
  const state = await (await fetch(web.url + '/api/state', { headers: { 'X-Kru-Token': web.token } })).json() as any;
  expect(state.providers.find((p: any) => p.id === 'codex').status).toBe('connected');
});
