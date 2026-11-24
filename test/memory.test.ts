import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { FakeProvider } from '../src/providers/fake/adapter';
import { AgentMemory, WorkspaceRecords } from '../src/workspace';
import { verifyReplay } from '../src/store/replay';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function env() {
  const dir = mkdtempSync(join(tmpdir(), 'kru-memory-')),
    path = join(dir, 'db.sqlite'),
    store = new Store(path);
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const records = new WorkspaceRecords(store),
    memory = new AgentMemory(records),
    agents = new AgentRegistry(store);
  const first = agents.create({ name: 'first', provider: 'fake' }),
    second = agents.create({ name: 'second', provider: 'fake' });
  return { path, store, records, memory, agents, first, second };
}

test('bot memory updates in place, survives reopening and forgets only the owning bot note', () => {
  const e = env();
  const first = e.memory.remember(e.first.id, { key: 'review/style', text: 'Brief reviews.' });
  const second = e.memory.remember(e.second.id, { key: 'review/style', text: 'Detailed reviews.' });
  const updated = e.memory.remember(e.first.id, {
    key: 'review/style',
    text: 'Concise reviews with evidence.',
  });
  expect(updated.id).toBe(first.id);
  expect(updated.id).not.toBe(second.id);
  expect(e.memory.remember(e.first.id, updated.data)).toEqual(updated);
  expect(e.records.list('memory', e.first.id)).toHaveLength(1);
  const reopened = new Store(e.path);
  try {
    expect(
      new AgentMemory(new WorkspaceRecords(reopened)).read(e.first.id, 'review/style')?.data.text,
    ).toBe(updated.data.text);
  } finally {
    reopened.close();
  }
  expect(e.memory.forget(e.first.id, 'review/style').forgotten).toBe(true);
  expect(e.memory.forget(e.first.id, 'review/style').forgotten).toBe(false);
  expect(e.memory.read(e.second.id, 'review/style')?.id).toBe(second.id);
  expect(() => e.memory.forget(e.first.id, '')).toThrow();
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('private memory summaries paginate and full notes remain retrievable without cross-bot leakage', () => {
  const e = env();
  for (const key of ['a', 'b', 'c']) e.memory.remember(e.first.id, { key, text: key.repeat(600) });
  e.memory.remember(e.second.id, { key: 'secret', text: 'Other bot private context.' });
  const first = e.memory.list(e.first.id, undefined, 2);
  expect(first.entries.map((note) => note.key)).toEqual(['a', 'b']);
  expect(first.nextCursor).toBe('b');
  expect(first.entries[0]?.preview).toHaveLength(160);
  expect(e.memory.list(e.first.id, first.nextCursor!, 2).entries.map((note) => note.key)).toEqual([
    'c',
  ]);
  expect(e.memory.read(e.first.id, 'a')?.data.text).toHaveLength(600);
  expect(e.memory.read(e.first.id, 'secret')).toBeNull();
});

test('empty bots need no saved context and populated context stays valid and byte bounded', () => {
  const e = env();
  expect(e.memory.context(e.first.id, [], 6000)).toBe('');
  expect(e.memory.context(e.first.id, [], 0)).toBe('');
  for (let i = 0; i < 12; i++)
    e.memory.remember(e.first.id, { key: 'topic-' + i, text: '你好🧠'.repeat(500) });
  e.memory.remember(e.second.id, { key: 'secret', text: 'Do not include this bot context.' });
  const context = e.memory.context(
    e.first.id,
    [{ id: 'skill-1', name: 'Review', description: 'Review changes.' }],
    6000,
  );
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(6000);
  expect(context).not.toContain('Do not include this bot context.');
  const snapshot = JSON.parse(context.slice(context.indexOf('{')));
  expect(snapshot.memoryCount).toBe(12);
  expect(snapshot.memories.length).toBeGreaterThan(0);
  expect(snapshot.memories.every((note: any) => note.truncated)).toBe(true);
  expect(context).not.toContain('\uFFFD');
});

test('bots maintain memory during normal turns and recall corrections across isolated lanes', async () => {
  const e = env(),
    mailbox = new SqliteMailbox(e.store);
  const daemon = new Daemon(
    e.store,
    { pollMs: 10 },
    (agent) =>
      new FakeProvider({
        script: async (prompt, call) => {
          if (!daemon.workspace.tools.instructions.includes('Automatic memory:'))
            throw new Error('Missing automatic maintenance guidance');
          if (agent.id === e.second.id) {
            if (prompt.includes('Concise with evidence') || prompt.includes('Brief reviews'))
              throw new Error('Another bot memory leaked');
            const response = await call('workspace', { action: 'forget', key: 'review/style' });
            if (!response.success) throw new Error('Scoped forget failed');
            return 'Independent context.';
          }
          if (prompt.includes('My review preference is concise.')) {
            if (!prompt.endsWith('My review preference is concise.'))
              throw new Error('Current request must remain last');
            const saved = await call('workspace', {
              action: 'remember',
              key: 'review/style',
              text: 'Brief reviews',
            });
            if (!saved.success) throw new Error('Memory write failed');
          } else if (prompt.includes('Use evidence too.')) {
            if (!prompt.endsWith('Use evidence too.'))
              throw new Error('Private context displaced the current request');
            if (!prompt.includes('Brief reviews'))
              throw new Error('Previous lane memory was not loaded');
            const saved = await call('workspace', {
              action: 'remember',
              key: 'review/style',
              text: 'Concise with evidence',
            });
            if (!saved.success) throw new Error('Memory correction failed');
          } else if (prompt.includes('Forget my review preference.')) {
            if (!prompt.includes('Concise with evidence'))
              throw new Error('Corrected memory was not loaded');
            const removed = await call('workspace', { action: 'forget', key: 'review/style' });
            if (!removed.success) throw new Error('Memory removal failed');
          }
          return 'Done.';
        },
      }),
  );
  cleanups.push(() => daemon.stop(0));
  daemon.start();
  await daemon.ready;
  const send = async (agentId: string, laneId: string | null, text: string) => {
    const receipt = mailbox.enqueue({
      sender: { kind: 'user' },
      recipientIds: [agentId],
      laneId,
      text,
    });
    const deadline = Date.now() + 5000;
    while (
      ['queued', 'starting', 'running'].includes(mailbox.get(receipt.deliveryIds[0]!)!.status)
    ) {
      if (Date.now() > deadline) throw new Error('Turn timed out');
      await Bun.sleep(10);
    }
    expect(mailbox.get(receipt.deliveryIds[0]!)?.status).toBe('completed');
  };
  await send(e.first.id, null, 'My review preference is concise.');
  const id = e.memory.read(e.first.id, 'review/style')!.id;
  await send(e.first.id, 'project-review', 'Use evidence too.');
  expect(e.memory.read(e.first.id, 'review/style')?.id).toBe(id);
  expect(e.memory.read(e.first.id, 'review/style')?.data.text).toBe('Concise with evidence');
  await send(e.second.id, null, 'Check independent context.');
  expect(e.memory.read(e.first.id, 'review/style')).not.toBeNull();
  await send(e.first.id, 'later-conversation', 'Forget my review preference.');
  expect(e.memory.read(e.first.id, 'review/style')).toBeNull();
  expect(verifyReplay(e.store).matches).toBe(true);
});
