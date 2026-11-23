import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { Daemon } from '../src/daemon';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { FakeProvider, type FakeProviderOptions } from '../src/providers/fake/adapter';
import { createWebServer } from '../src/web/server';
import { verifyReplay } from '../src/store/replay';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Condition timed out'); await Bun.sleep(10); } }
async function env(fake: FakeProviderOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kru-web-')), store = new Store(join(dir, 'db.sqlite'));
  const daemon = new Daemon(store, { pollMs: 10 }, () => new FakeProvider(fake));
  daemon.start(); await daemon.ready;
  const web = createWebServer({ store, daemon, port: 0 });
  cleanups.push(async () => { await web.close(); await daemon.stop(0); store.close(); rmSync(dir, { force: true, recursive: true }); });
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(web.url + '/api' + path, { method, headers: { 'x-kru-token': web.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (path: string, method = 'GET', body?: unknown) => { const response = await request(path, method, body); const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data as any; };
  const agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store);
  return { dir, store, daemon, web, request, json, agents, mailbox };
}

test('operator API requires its session token, rejects foreign origins and serves only bundled assets', async () => {
  const e = await env();
  const page = await fetch(e.web.url); expect(page.status).toBe(200); const html = await page.text();
  expect(html).toContain('name="kru-token"'); expect(html).not.toContain('__KRU_TOKEN__');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect((await fetch(e.web.url + '/api/state')).status).toBe(401);
  expect((await e.request('/state', 'GET', undefined, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await e.request('/state', 'GET', undefined, { host: 'evil.example:' + e.web.server.port })).status).toBe(403);
  expect((await fetch(e.web.url + '/package.json')).status).toBe(404);
  expect((await fetch(e.web.url + '/app.js')).headers.get('content-type')).toContain('javascript');
  expect((await e.request('/agents', 'POST', { name: 'invalid', provider: 'unknown' })).status).toBe(400);
});

test('UI API creates agents, streams work, sends idempotently, persists context and reports execution history', async () => {
  const e = await env();
  const agent = await e.json('/agents', 'POST', { name: 'Demo', provider: 'fake', config: { promptProfile: 'coding' } });
  await e.json('/agents/' + agent.id, 'PATCH', { config: { dailyTokens: 100, model: 'temporary-model' } });
  const cleared = await e.json('/agents/' + agent.id, 'PATCH', { config: { dailyTokens: null, model: null } });
  expect(cleared.config.dailyTokens).toBeUndefined(); expect(cleared.config.model).toBeUndefined();
  const receipt = await (await e.request(`/agents/${agent.id}/messages`, 'POST', { text: 'Hello from UI' }, { 'Idempotency-Key': 'ui-message' })).json() as any;
  const again = await (await e.request(`/agents/${agent.id}/messages`, 'POST', { text: 'Hello from UI' }, { 'Idempotency-Key': 'ui-message' })).json() as any;
  expect(again.duplicate).toBe(true); expect(again.deliveryIds).toEqual(receipt.deliveryIds);
  await until(() => e.mailbox.get(receipt.deliveryIds[0])?.status === 'completed');
  const messages = await e.json(`/agents/${agent.id}/messages`);
  expect(messages.entries.some((m: any) => m.role === 'assistant' && m.text.includes('Hello from UI'))).toBe(true);
  const memory = await e.json('/records/memory', 'POST', { agentId: agent.id, data: { key: 'language', text: 'English' } });
  await e.json('/records/memory/' + memory.id, 'PATCH', { text: 'Malay' });
  let state = await e.json('/state'); expect(state.records.memory).toBeUndefined(); expect(state.activity[0].status).toBe('completed');
  expect(e.daemon.workspace.memory.read(agent.id, 'language')?.data.text).toBe('Malay');
  await e.json('/records/memory/' + memory.id, 'DELETE'); state = await e.json('/state'); expect(state.records.memory).toBeUndefined();
  expect(e.daemon.workspace.memory.read(agent.id, 'language')).toBeNull();
  const controller = new AbortController();
  const stream = await fetch(e.web.url + '/api/events', { headers: { 'x-kru-token': e.web.token }, signal: controller.signal });
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  const reader = stream.body!.getReader(), first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('event: ready');
  controller.abort(); await reader.cancel().catch(() => {});
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('UI native approval decisions are applied only to the current active request', async () => {
  const e = await env({ mode: 'permissions' });
  const agent = e.agents.create({ name: 'worker', provider: 'fake' });
  const receipt = await e.json(`/agents/${agent.id}/messages`, 'POST', { text: JSON.stringify({ name: 'Bash', input: { command: 'echo hello' } }), laneId: 'draft-review' });
  await until(() => e.daemon.workspace.records.list('approval').length === 1);
  const approval = e.daemon.workspace.records.list('approval')[0]!;
  const state = await e.json('/state');
  expect(state.records.approval[0].laneId).toBe('draft-review');
  expect((await e.json(`/agents/${agent.id}/messages`)).approvals).toHaveLength(0);
  const conversation = await e.json(`/agents/${agent.id}/messages?lane=draft-review`);
  expect(conversation.approvals.map((r: any) => r.id)).toEqual([approval.id]);
  const other = e.agents.create({ name: 'other', provider: 'fake' });
  expect((await e.json(`/agents/${other.id}/messages?lane=draft-review`)).approvals).toHaveLength(0);
  const response = await e.request(`/records/approval/${approval.id}/decide`, 'POST', { decision: 'accept' }); expect(response.status).toBe(200);
  await until(() => e.mailbox.get(receipt.deliveryIds[0])?.status === 'completed');
  expect((await e.json(`/agents/${agent.id}/messages?lane=draft-review`)).approvals[0].data.status).toBe('accepted');
  expect((await e.request(`/records/approval/${approval.id}/decide`, 'POST', { decision: 'accept' })).status).toBe(409);
});

test('MCP discovery and calls use tracked processes, explicit credentials, and per-agent approval', async () => {
  process.env.KRU_MAPPED_TEST_SECRET = 'test-value'; process.env.KRU_UNMAPPED_TEST_SECRET = 'must-not-leak';
  cleanups.push(() => { delete process.env.KRU_MAPPED_TEST_SECRET; delete process.env.KRU_UNMAPPED_TEST_SECRET; });
  let connectorId = '';
  const e = await env({ script: async (_prompt, call) => {
    const result = await call('use_tool', { target: 'mcp', connectorId, name: 'echo', arguments: { text: 'approved call' } });
    if (!result.success) throw new Error(result.contentItems[0]?.text);
    return result.contentItems[0]?.text ?? '';
  } });
  const agent = e.agents.create({ name: 'worker', provider: 'fake' }), other = e.agents.create({ name: 'other', provider: 'fake' });
  const connector = await e.json('/records/connector', 'POST', { agentId: agent.id, data: { name: 'Echo test', transport: 'stdio', command: process.execPath, args: [new URL('./fakes/workspace-mcp.ts', import.meta.url).pathname], env: { MAPPED_TEST_KEY: 'KRU_MAPPED_TEST_SECRET' } } });
  connectorId = connector.id;
  expect((await e.json('/state')).connectorStatus[connector.id].state).toBe('not_checked');
  const discovered = await e.json(`/records/connector/${connector.id}/tools`, 'POST', {}); expect(discovered.tools[0].name).toBe('echo');
  expect((await e.json('/state')).connectorStatus[connector.id]).toMatchObject({ state: 'connected', toolCount: 1, error: null });
  expect(() => e.daemon.workspace.integrations.entry(connector.id, other.id)).toThrow('not enabled');
  expect(e.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM cleanup_journal WHERE state='active'").get()!.n).toBe(1);
  const receipt = await e.json(`/agents/${agent.id}/messages`, 'POST', { text: 'Use the connector.' });
  await until(() => e.daemon.workspace.records.list('approval').length === 1);
  const approval = e.daemon.workspace.records.list('approval')[0]!;
  expect(approval.data.input).toMatchObject({ connector: 'Echo test', name: 'echo' });
  await e.json(`/records/approval/${approval.id}/decide`, 'POST', { decision: 'accept' });
  await until(() => e.mailbox.get(receipt.deliveryIds[0])?.status === 'completed');
  const messages = await e.json(`/agents/${agent.id}/messages`);
  const text = JSON.stringify(messages.entries.filter((m: any) => m.role === 'assistant'));
  expect(text).toContain('approved call'); expect(text).toContain('mapped'); expect(text).toContain('false'); expect(text).not.toContain('must-not-leak');
  await e.daemon.workspace.integrations.close();
  expect(e.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM cleanup_journal WHERE state<>'complete'").get()!.n).toBe(0);
}, 15000);

test('HTTP webhooks authenticate, deduplicate events, hide token hashes and pause correctly', async () => {
  const e = await env(), agent = e.agents.create({ name: 'worker', provider: 'fake', config: { paused: true } });
  const routine = await e.json('/records/routine', 'POST', { agentId: agent.id, data: { name: 'Hook', prompt: 'Check event', schedule: { type: 'webhook' } } });
  const connection = await e.json(`/records/routine/${routine.id}/token`, 'POST');
  const hook = (bearer: string) => fetch(e.web.url + connection.path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer, 'Idempotency-Key': 'event-1' }, body: JSON.stringify({ changed: true }) });
  expect((await hook('bad')).status).toBe(401);
  expect((await hook(connection.token)).status).toBe(202); const duplicate = await (await hook(connection.token)).json() as any; expect(duplicate.duplicate).toBe(true);
  expect(e.mailbox.listQueue(agent.id)).toHaveLength(1);
  const state = await e.json('/state'); expect(state.records.routine[0].data.tokenHash).toBeUndefined();
  await e.json(`/records/routine/${routine.id}`, 'PATCH', { enabled: false }); expect((await hook(connection.token)).status).toBe(400);
});

test('Connector reports failed setup accurately and clears stale status when settings change', async () => {
  const e = await env(), agent = e.agents.create({ name: 'worker', provider: 'fake' });
  const missing = 'KRU_TEST_MISSING_APP_AUTH_' + crypto.randomUUID().replaceAll('-', '');
  const connector = await e.json('/records/connector', 'POST', { agentId: agent.id, data: { name: 'Issue tracker', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: missing } } });
  expect((await e.json('/state')).connectorStatus[connector.id].state).toBe('not_checked');
  expect((await e.request(`/records/connector/${connector.id}/tools`, 'POST', {})).ok).toBe(false);
  const failed = (await e.json('/state')).connectorStatus[connector.id];
  expect(failed.state).toBe('error'); expect(failed.error).toContain(missing); expect(failed.checkedAt).not.toBeNull();
  await e.json('/records/connector/' + connector.id, 'PATCH', { headers: {} });
  expect((await e.json('/state')).connectorStatus[connector.id]).toMatchObject({ state: 'not_checked', checkedAt: null, error: null });
  await e.json('/records/connector/' + connector.id, 'PATCH', { enabled: false });
  expect((await e.json('/state')).connectorStatus[connector.id].state).toBe('disabled');
});

test('Streamable HTTP MCP uses environment-backed headers and real discovery/call protocol', async () => {
  process.env.KRU_TEST_HTTP_AUTH = 'Bearer test-token';
  cleanups.push(() => { delete process.env.KRU_TEST_HTTP_AUTH; });
  let calls = 0;
  const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('authorization') !== 'Bearer test-token') return new Response('Unauthorized', { status: 401 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const input = await request.json() as any;
    if (!('id' in input)) return new Response(null, { status: 202 });
    const result = input.method === 'initialize' ? { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-test', version: '1' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'count', description: 'Count calls', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: String(++calls) }] };
    return Response.json({ jsonrpc: '2.0', id: input.id, result });
  } });
  cleanups.push(async () => { await remote.stop(true); });
  const e = await env(), agent = e.agents.create({ name: 'worker', provider: 'fake' });
  const connector = await e.json('/records/connector', 'POST', { agentId: agent.id, data: { name: 'HTTP tool', transport: 'http', url: `http://127.0.0.1:${remote.port}/mcp`, headers: { Authorization: 'KRU_TEST_HTTP_AUTH' }, permission: 'allow' } });
  const tools = await e.daemon.workspace.integrations.tools(connector.id, agent.id); expect(tools[0]?.name).toBe('count');
  const result = await e.daemon.workspace.integrations.call(connector.id, agent.id, 'count', {});
  expect(result.content).toEqual([{ type: 'text', text: '1' }]); expect(calls).toBe(1);
});

test('revoking connector access while approval is pending prevents the external action', async () => {
  let connectorId = '';
  const e = await env({ script: async (_prompt, call) => {
    const result = await call('use_tool', { target: 'mcp', connectorId, name: 'echo', arguments: { text: 'must not execute' } });
    return result.success ? 'unexpected success' : 'Permission change prevented execution.';
  } });
  const agent = e.agents.create({ name: 'worker', provider: 'fake' });
  const connector = await e.json('/records/connector', 'POST', { agentId: agent.id, data: { name: 'Tool', transport: 'http', url: 'http://127.0.0.1:1/mcp' } }); connectorId = connector.id;
  const receipt = await e.json(`/agents/${agent.id}/messages`, 'POST', { text: 'Try tool.' });
  await until(() => e.daemon.workspace.records.list('approval').length === 1);
  const approval = e.daemon.workspace.records.list('approval')[0]!;
  await e.json('/records/connector/' + connectorId, 'PATCH', { enabled: false });
  await e.json(`/records/approval/${approval.id}/decide`, 'POST', { decision: 'accept' });
  await until(() => e.mailbox.get(receipt.deliveryIds[0])?.status === 'completed');
  const messages = await e.json(`/agents/${agent.id}/messages`);
  expect(messages.entries.some((m: any) => m.text === 'Permission change prevented execution.')).toBe(true);
  expect(e.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM cleanup_journal').get()!.n).toBe(0);
});
