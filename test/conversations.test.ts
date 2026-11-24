import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { Daemon } from '../src/daemon';
import { FakeProvider } from '../src/providers/fake/adapter';
import { SqliteMailbox } from '../src/mailbox';
import { Conversations } from '../src/threads/conversations';
import { SqliteSessions } from '../src/daemon/sessions';
import { createWebServer } from '../src/web/server';
import { ConversationMedia } from '../src/threads/media';
import { readLog } from '../src/turns/log';
import type { Methods, ThreadParams } from '../src/providers/protocol';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function environment() {
  const dir = mkdtempSync(join(tmpdir(), 'kru-conversations-')), store = new Store(join(dir, 'db.sqlite'));
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const agents = new AgentRegistry(store), agent = agents.create({ name: 'Teammate', provider: 'fake', config: { model: 'original', promptProfile: 'coding' } });
  return { store, agents, agent, conversations: new Conversations(store), mailbox: new SqliteMailbox(store) };
}
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await Bun.sleep(5); } }

test('conversation models are thread-scoped, revision guarded and survive replay', () => {
  const e = environment(), a = e.conversations.create(e.agent.id, 'a'), b = e.conversations.create(e.agent.id, 'b');
  expect(e.conversations.create(e.agent.id, 'a').id).toBe(a.id);
  expect(a.laneId).not.toBe(b.laneId);
  const changed = e.conversations.save(a.id, { provider: 'codex', model: 'account-model', title: 'Launch plan', revision: 0 });
  expect(changed.provider).toBe('codex'); expect(changed.model).toBe('account-model');
  expect(e.conversations.current(e.agent.id, b.laneId).model).toBe('original');
  expect(e.agents.get(e.agent.id)?.provider).toBe('fake');
  expect(e.conversations.list().find(row => row.id === a.id)?.title).toBe('Launch plan');
  expect(() => e.conversations.save(a.id, { provider: 'claude', revision: 0 })).toThrow('changed');
  expect(e.conversations.save(a.id, { provider: null, revision: 1 })).toMatchObject({ provider: 'fake', model: 'original', inherited: true });
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('provider and model changes preserve the logical thread and hand off earlier context both ways', async () => {
  const e = environment(), thread = e.conversations.create(e.agent.id, 'switch'), other = e.conversations.create(e.agent.id, 'other');
  const prompts: { provider: string; model: unknown; lane: string | null; text: string }[] = [];
  const daemon = new Daemon(e.store, { pollMs: 10 }, (agent, lane) => new FakeProvider({ script: async text => { prompts.push({ provider: agent.provider, model: agent.config.model, lane, text }); return 'Confirmed ' + agent.provider; } }));
  cleanup.push(() => daemon.stop(0)); daemon.start(); await daemon.ready;
  const send = async (text: string, laneId = thread.laneId) => { const id = e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [e.agent.id], laneId, text }).deliveryIds[0]!; await until(() => e.mailbox.get(id)?.status === 'completed'); };
  await send('Keep the launch date: June 18');
  e.conversations.save(thread.id, { provider: 'codex', model: 'codex-account-model', revision: 0 }); await send('Draft the launch plan');
  e.conversations.save(thread.id, { provider: 'claude', model: 'claude-account-model', revision: 1 }); await send('What date did we agree?');
  expect(prompts[1]).toMatchObject({ provider: 'codex', model: 'codex-account-model' }); expect(prompts[1]!.text).toContain('June 18');
  expect(prompts[2]).toMatchObject({ provider: 'claude', model: 'claude-account-model' }); expect(prompts[2]!.text).toContain('June 18'); expect(prompts[2]!.text).toContain('Draft the launch plan');
  e.conversations.save(thread.id, { provider: 'claude', model: 'another-claude-model', revision: 2 }); await send('Continue on another model'); expect(prompts[3]!.text).toContain('June 18');
  await send('Separate topic', other.laneId); expect(prompts[4]!.provider).toBe('fake'); expect(prompts[4]!.text).not.toContain('June 18');
  expect(new SqliteSessions(e.store).get(e.agent.id, thread.laneId, 'claude')?.logicalThreadId).toBe(thread.id);
  expect(e.store.db.query('SELECT * FROM session_generations WHERE thread_id=?').all(thread.id)).toHaveLength(4);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('model switching cannot change queued or active work, while renaming remains available', async () => {
  const e = environment(), thread = e.conversations.create(e.agent.id, 'busy');
  e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [e.agent.id], laneId: thread.laneId, text: 'Queued request' });
  expect(() => e.conversations.save(thread.id, { provider: 'claude', revision: 0 })).toThrow('Finish or stop');
  const renamed = e.conversations.save(thread.id, { title: 'Queued conversation', revision: 0 }); expect(renamed.provider).toBe('fake');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('authenticated conversations API lists past threads and pages every earlier message without crossing lanes', async () => {
  const e = environment(); e.agents.update(e.agent.id, { config: { paused: true } });
  const thread = e.conversations.create(e.agent.id, 'history'), other = e.conversations.create(e.agent.id, 'private');
  for (let i = 0; i < 220; i++) e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [e.agent.id], laneId: thread.laneId, text: 'History entry ' + i });
  e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [e.agent.id], laneId: other.laneId, text: 'Other lane secret' });
  const daemon = new Daemon(e.store, {}, () => new FakeProvider()); cleanup.push(() => daemon.stop(0)); daemon.start(); await daemon.ready;
  const web = createWebServer({ store: e.store, daemon, port: 0 }); cleanup.push(() => web.close());
  const request = (path: string, method = 'GET', body?: unknown) => fetch(web.url + '/api' + path, { method, headers: { 'X-Kru-Token': web.token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect((await fetch(web.url + '/api/conversations')).status).toBe(401);
  expect((await (await request('/conversations?agent=' + e.agent.id)).json() as any).conversations).toHaveLength(2);
  const messages = '/agents/' + e.agent.id + '/messages?lane=' + encodeURIComponent(thread.laneId!);
  const recent = await (await request(messages)).json() as any; expect(recent.entries).toHaveLength(200); expect(recent.hasMore).toBe(true);
  const older = await (await request(messages + '&before=' + encodeURIComponent(recent.entries[0].id))).json() as any;
  expect(older.entries).toHaveLength(20); expect(older.entries[0].text).toBe('History entry 0'); expect(older.hasMore).toBe(false);
  expect([...recent.entries, ...older.entries].some((entry: any) => entry.text === 'Other lane secret')).toBe(false);
  expect((await request(messages + '&before=missing')).status).toBe(400);
  expect((await request('/conversations/' + thread.id, 'PATCH', { title: 'Renamed via API', revision: 0 })).status).toBe(200);
  expect((await request('/conversations/' + thread.id, 'PATCH', { title: 'Stale', revision: 0 })).status).toBe(409);
});

test('browser tools start with default access and retain conversation approval for actions', async () => {
  const e = environment(), calls: string[] = [];
  const daemon = new Daemon(e.store, { pollMs: 10 }, () => new FakeProvider({ script: async (_prompt, call) => {
    const read = await call('use_tool', { target: 'browser', arguments: { action: 'read' } }); expect(read.success).toBe(true);
    const action = await call('use_tool', { target: 'browser', arguments: { action: 'search', query: 'KRU browser' } }); return action.success ? 'Searched' : 'Declined';
  } }));
  daemon.workspace.browser.act = async (_agent, input) => { calls.push((input as any).action); return { url: '', title: '', text: '', elements: [], screenshot: '' }; };
  cleanup.push(() => daemon.stop(0)); daemon.start(); await daemon.ready;
  const delivery = e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [e.agent.id], text: 'Search with Firefox' }).deliveryIds[0]!;
  await until(() => daemon.workspace.records.list('approval').some(entry => entry.data.status === 'pending'));
  expect(calls).toEqual(['read']);
  const approval = daemon.workspace.records.list('approval')[0]!; expect(approval.data.input).toMatchObject({ browser: { action: 'search', query: 'KRU browser' } });
  daemon.workspace.approvals.decide(approval.id, 'accept'); await until(() => e.mailbox.get(delivery)?.status === 'completed');
  expect(calls).toEqual(['read', 'search']); expect(verifyReplay(e.store).matches).toBe(true);
});

test('upgrading enables browser access once and preserves subsequent explicit opt-outs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kru-browser-upgrade-')), path = join(dir, 'db.sqlite');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const old = new Store(path), agent = new AgentRegistry(old).create({ name: 'Existing', provider: 'fake', config: { browser: { enabled: false, permission: 'ask' } } });
  // Recreate the preceding schema boundary, before conversation data exists.
  old.db.exec('DROP TABLE conversation_message_media; DROP TABLE conversation_media; DROP TABLE conversation_settings; DELETE FROM schema_migrations WHERE version=13'); old.close();
  const upgraded = new Store(path); expect(new AgentRegistry(upgraded).get(agent.id)?.config.browser).toEqual({ enabled: true, permission: 'ask' });
  expect(verifyReplay(upgraded).matches).toBe(true);
  new AgentRegistry(upgraded).update(agent.id, { config: { browser: { enabled: false, permission: 'ask' } } }); upgraded.close();
  const reopened = new Store(path); try { expect(new AgentRegistry(reopened).get(agent.id)?.config.browser).toEqual({ enabled: false, permission: 'ask' }); expect(verifyReplay(reopened).matches).toBe(true); } finally { reopened.close(); }
});

test('personal chats have a private execution identity, separate history and thread deletion', () => {
  const e = environment(), personal = e.conversations.personal(), same = e.conversations.personal(); expect(personal.id).toBe(same.id); expect(personal.id).not.toBe(e.agent.id);
  const thread = e.conversations.create(personal.id, 'personal'); e.conversations.save(thread.id, { provider: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh', revision: 0 });
  expect(e.conversations.current(personal.id, thread.laneId)).toMatchObject({ effort: 'xhigh', provider: 'codex' });
  expect(e.conversations.effective(personal, thread.laneId).config.reasoningEffort).toBe('xhigh');
  e.conversations.remove(thread.id); expect(e.conversations.list(personal.id)).toHaveLength(0);
  expect(() => e.conversations.current(personal.id, thread.laneId)).toThrow('deleted'); expect(verifyReplay(e.store).matches).toBe(true);
});

test('personal LLM sessions receive user text without bot task instructions or delegation tools', async () => {
  const e = environment(), profile = e.conversations.personal(), thread = e.conversations.create(profile.id, 'direct-chat');
  let captured: ThreadParams | undefined, prompt = '';
  class Inspect extends FakeProvider {
    override async request<M extends keyof Methods>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> { if (method === 'thread/start') captured = params as ThreadParams; return super.request(method, params); }
  }
  const daemon = new Daemon(e.store, { pollMs: 10 }, () => new Inspect({ script: async text => { prompt = text; return 'Hello'; } })); cleanup.push(() => daemon.stop(0)); daemon.start(); await daemon.ready;
  const id = e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [profile.id], laneId: thread.laneId, text: 'Hello directly' }).deliveryIds[0]!; await until(() => e.mailbox.get(id)?.status === 'completed');
  expect(prompt).toBe('Hello directly'); expect(captured?.tools?.map(tool => tool.name).sort()).toEqual(['history_search', 'use_tool', 'workspace']);
  expect(captured?.instructions).not.toContain('task_update'); expect(captured?.instructions).not.toContain('Automatic memory');
});

test('images stay scoped to their conversation and are replayed as native image input after a model switch', async () => {
  const e = environment(), thread = e.conversations.create(e.agent.id, 'images'), other = e.conversations.create(e.agent.id, 'other-images'), media = new ConversationMedia(e.store);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1cAAAAASUVORK5CYII=', 'base64');
  const image = await media.upload(thread.id, new File([png], 'screen.png', { type: 'image/png' }));
  expect(() => media.validate(other.id, [image.id])).toThrow('another conversation');
  const delivery = e.store.atomic(() => { const sent = e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [e.agent.id], laneId: thread.laneId, text: 'What is in this image?' }); media.link(thread.id, sent.messageId, [image.id]); return sent; });
  const batch = e.mailbox.claimBatch(e.agent.id, thread.laneId)!;
  expect(media.inputs(batch, false)[0]).toMatchObject({ type: 'localImage', mime: 'image/png' }); expect(media.inputs(batch, true)).toHaveLength(1);
  e.mailbox.markBatchRunning(batch.id, 'media-test-turn'); e.mailbox.finishBatch(batch.id, 'completed'); expect(media.messages([delivery.messageId])[0]?.id).toBe(image.id);
  expect(verifyReplay(e.store).matches).toBe(true); e.conversations.remove(thread.id); media.purge(thread.id);
  expect(() => media.get(image.id)).toThrow('deleted');
});

test('folder text files reach the CLI input and retain their contents on model handoff', async () => {
  const e = environment(), thread = e.conversations.create(e.agent.id, 'folder-files'), media = new ConversationMedia(e.store);
  const file = await media.upload(thread.id, new File(['Launch date: June 18'], 'plan.md'), 'launch/docs/plan.md');
  expect(file.name).toBe('launch/docs/plan.md');
  const sent = e.store.atomic(() => { const sent = e.mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [e.agent.id], laneId: thread.laneId, text: 'Summarize the plan' }); media.link(thread.id, sent.messageId, [file.id]); return sent; });
  const batch = e.mailbox.claimBatch(e.agent.id, thread.laneId)!;
  for (const handoff of [false, true]) {
    const input = media.inputs(batch, handoff)[0]; expect(input?.type).toBe('text');
    if (input?.type === 'text') { expect(input.text).toContain('launch/docs/plan.md'); expect(input.text).toContain('Launch date: June 18'); }
  }
  expect(media.messages([sent.messageId])[0]?.id).toBe(file.id);
  expect(verifyReplay(e.store).matches).toBe(true);
  await expect(media.upload(thread.id, new File(['No traversal'], 'plan.md'), '../plan.md')).rejects.toThrow('Invalid folder file path');
  await expect(media.upload(thread.id, new File([new Uint8Array([0, 1, 255])], 'archive.bin'))).rejects.toThrow('text/code file');
  await expect(media.upload(thread.id, new File(['x'.repeat(128 * 1024 + 1)], 'large.txt'))).rejects.toThrow('128 KB');
});
