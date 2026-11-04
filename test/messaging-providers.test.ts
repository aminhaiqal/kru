import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { ClaudeProvider, CodexProvider, FakeProvider } from '../src/providers';
import type { ToolCall, ToolResult } from '../src/providers/protocol';
import { scriptedClaude } from './fakes/claude-sdk';

let dir: string, path: string, store: Store, agents: AgentRegistry, mailbox: SqliteMailbox;
const daemons: Daemon[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kru-m5-providers-')); path = join(dir, 'db.sqlite'); store = new Store(path); agents = new AgentRegistry(store); mailbox = new SqliteMailbox(store); });
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(0); store.close(); rmSync(dir, { recursive: true, force: true }); });
async function until(fn: () => boolean, timeout = 3000) { const end = performance.now() + timeout; while (!fn()) { if (performance.now() > end) throw new Error('Timed out'); await Bun.sleep(3); } }
const enqueue = (id: string) => mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [id], text: 'send a message' }).deliveryIds[0]!;
for (const kind of ['codex', 'claude'] as const) test(`${kind} native adapter routes send_message through the daemon without model calls`, async () => {
  const a = agents.create({ name: 'a', provider: kind }), b = agents.create({ name: 'b', provider: 'fake', config: { paused: true } });
  const args = { to: [b.id], text: 'native message' };
  const provider = kind === 'codex' ? new CodexProvider({ transport: {
    command: process.execPath, args: [new URL('./fakes/provider-agent.ts', import.meta.url).pathname],
    env: { KRU_SCRIPTED_TOOL: 'send_message', KRU_SCRIPTED_TOOL_ARGS: JSON.stringify(args) }, processRecordDir: join(dir, 'processes'), stopGraceMs: 50,
  } }) : new ClaudeProvider({ query: scriptedClaude('tool', undefined, { name: 'send_message', arguments: args }) });
  const calls: ToolCall[] = []; provider.on('request', r => { if (r.method === 'item/tool/call') calls.push(r.params); });
  const first = enqueue(a.id), d = new Daemon(store, {}, () => provider); daemons.push(d); d.start();
  await until(() => mailbox.get(first)!.status === 'completed'); expect(d.failure).toBeUndefined(); expect(calls).toHaveLength(1);
  if (kind === 'claude') expect(calls[0]!.callId).toStartWith('mcp:');
  expect(mailbox.listQueue(b.id)).toHaveLength(1); expect(mailbox.listQueue(b.id)[0]!).toMatchObject({ text: 'native message', sender: { kind: 'agent', agentId: a.id }, expectsReply: false, hop: 1 });
  expect(verifyReplay(store).matches).toBe(true);
});

class RawProvider extends FakeProvider {
  raw(params: ToolCall, signal = new AbortController().signal): Promise<ToolResult> { return this.callTool(params, signal); }
}
test('stale, foreign and cancelled calls cannot enqueue; a lost reply can replay its committed receipt', async () => {
  const a = agents.create({ name: 'a', provider: 'fake' }), b = agents.create({ name: 'b', provider: 'fake', config: { paused: true } });
  const p = new RawProvider({ mode: 'stall' }); let threadId = '', turnId = '';
  p.on('notification', n => { if (n.method === 'turn/started') { threadId = n.params.threadId; turnId = n.params.turn.id; } });
  const id = enqueue(a.id), d = new Daemon(store, {}, () => p); daemons.push(d); d.start(); await until(() => mailbox.get(id)!.status === 'running');
  const request: ToolCall = { threadId, turnId, callId: 'once', tool: 'send_message', arguments: { to: [b.id], text: 'once' } };
  await expect(p.raw({ ...request, threadId: 'foreign' })).rejects.toThrow('active');
  await expect(p.raw({ ...request, turnId: 'foreign' })).rejects.toThrow('active');
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'));
  await expect(p.raw(request, cancelled.signal)).rejects.toThrow('cancelled'); expect(mailbox.listQueue(b.id)).toHaveLength(0);
  const lost = new AbortController();
  const off = mailbox.onChange(c => { if (mailbox.get(c.deliveryId)!.recipientAgentId === b.id) lost.abort(new Error('reply lost')); });
  await expect(p.raw(request, lost.signal)).rejects.toThrow('reply lost'); off();
  expect(mailbox.listQueue(b.id)).toHaveLength(1); expect((await p.raw(request)).success).toBe(true); expect(mailbox.listQueue(b.id)).toHaveLength(1);
  await p.request('turn/interrupt', { threadId, turnId }); await until(() => mailbox.get(id)!.status === 'interrupted');
  await expect(p.raw({ ...request, callId: 'late' })).rejects.toThrow('active'); expect(mailbox.listQueue(b.id)).toHaveLength(1); expect(d.failure).toBeUndefined();
});

test('frozen v4 upgrades to tool routing without changing old events; failed v5 upgrade rolls back and retries', () => {
  const old = join(dir, 'v4.sqlite'), db = new Database(old); db.exec(readFileSync(new URL('./fixtures/store/v4.sql', import.meta.url), 'utf8'));
  const events = db.query('SELECT * FROM events ORDER BY seq').all();
  db.exec("CREATE TRIGGER reject_v5 BEFORE INSERT ON schema_migrations WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'reject v5'); END"); db.close();
  expect(() => new Store(old)).toThrow('reject v5'); const inspect = new Database(old);
  expect(inspect.query("SELECT name FROM sqlite_master WHERE name='message_routes'").all()).toEqual([]);
  inspect.exec('DROP TRIGGER reject_v5'); inspect.close(); const migrated = new Store(old);
  try { expect(migrated.db.query('SELECT * FROM events ORDER BY seq LIMIT ?').all(events.length)).toEqual(events); expect(verifyReplay(migrated).matches).toBe(true); expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]); }
  finally { migrated.close(); }
});

test('frozen v5 preserves routed request and reply rows and replays all eleven projections', () => {
  const path = join(dir, 'v5.sqlite'), db = new Database(path);
  db.exec(readFileSync(new URL('./fixtures/store/v5.sql', import.meta.url), 'utf8')); db.close();
  const migrated = new Store(path);
  try {
    expect(verifyReplay(migrated)).toMatchObject({ matches: true, projections: 11 });
    expect(migrated.db.query('SELECT * FROM message_routes').all()).toHaveLength(2);
    expect(migrated.db.query('SELECT outcome FROM delivery_replies').get()).toEqual({ outcome: 'sent' });
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { migrated.close(); }
});

test('daemon CLI validates max-hops and permits zero', async () => {
  for (const value of ['-1', '1.5', 'x']) {
    const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'daemon', '--max-hops', value, '--db', path], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(1); expect(await new Response(child.stderr).text()).toContain('max-hops');
  }
  const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'daemon', '--max-hops', '0', '--db', path], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stderr.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready'); reader.releaseLock(); child.kill('SIGTERM'); await child.exited;
});
