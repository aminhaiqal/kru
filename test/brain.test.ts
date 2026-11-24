import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { AgentMemory, ObsidianBrain, WorkspaceRecords } from '../src/workspace';
import { Conversations } from '../src/threads/conversations';
import { Daemon } from '../src/daemon';
import { SqliteMailbox } from '../src/mailbox';
import { FakeProvider } from '../src/providers/fake/adapter';
import { verifyReplay } from '../src/store/replay';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function environment() {
  const directory = mkdtempSync(join(tmpdir(), 'kru-brain-test-'));
  const store = new Store(join(directory, 'workspace.sqlite'));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const agents = new AgentRegistry(store),
    first = agents.create({ name: 'Research', provider: 'fake' }),
    second = agents.create({ name: 'Writing', provider: 'fake' });
  const records = new WorkspaceRecords(store),
    brain = new ObsidianBrain(store);
  return {
    directory,
    store,
    agents,
    first,
    second,
    records,
    brain,
    memory: new AgentMemory(records, brain),
  };
}

test('dedicated Obsidian vault stores private memory as Markdown and reflects human edits', () => {
  const e = environment();
  expect(existsSync(join(e.brain.root, '.obsidian'))).toBe(true);
  expect(readFileSync(join(e.brain.root, 'KRU Brain.md'), 'utf8')).toContain('dedicated knowledge');
  const saved = e.memory.remember(e.first.id, { key: 'review/style', text: 'Concise reviews.' });
  const file = join(
    e.brain.root,
    'Memory',
    'Bots',
    e.first.id,
    readdirSync(join(e.brain.root, 'Memory', 'Bots', e.first.id))[0]!,
  );
  expect(readFileSync(file, 'utf8')).toContain('kru_owner:');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('Concise reviews.', 'Concise reviews with evidence.'),
  );
  expect(e.memory.read(e.first.id, 'review/style')?.data.text).toBe(
    'Concise reviews with evidence.',
  );
  const updated = e.memory.remember(e.first.id, {
    key: 'review/style',
    text: 'Use evidence and examples.',
  });
  expect(updated.id).toBe(saved.id);
  expect(readFileSync(file, 'utf8')).toContain('Use evidence and examples.');
  expect(e.records.list('memory', e.first.id)).toHaveLength(1);
  expect(e.memory.forget(e.first.id, 'review/style').forgotten).toBe(true);
  expect(existsSync(file)).toBe(false);
  expect(readdirSync(join(e.brain.root, '.trash'))).toHaveLength(1);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('legacy memory imports once and deleted Obsidian notes are not resurrected', () => {
  const e = environment();
  const old = e.records.put('memory', e.first.id, {
    key: 'old/preferences',
    text: 'Imported once.',
  });
  e.brain.importLegacy(e.records);
  const path = e.brain.search(e.first.id, 'Imported')[0]!.path;
  expect(e.memory.read(e.first.id, old.data.key)?.id).toBe(old.id);
  unlinkSync(join(e.brain.root, path));
  const reopened = new ObsidianBrain(e.store);
  reopened.importLegacy(e.records);
  expect(new AgentMemory(e.records, reopened).read(e.first.id, old.data.key)).toBeNull();
  expect(e.records.require('memory', old.id).data.text).toBe('Imported once.');
});

test('first legacy import preserves an already edited and renamed memory note', () => {
  const e = environment();
  const old = e.records.put('memory', e.first.id, { key: 'review', text: 'Old database value.' });
  e.brain.saveMemory({ ...old, data: { key: 'review', text: 'Newer Obsidian value.' } });
  const folder = join(e.brain.root, 'Memory', 'Bots', e.first.id);
  renameSync(join(folder, readdirSync(folder)[0]!), join(folder, 'Human name.md'));
  e.brain.importLegacy(e.records);
  expect(e.memory.read(e.first.id, 'review')?.data.text).toBe('Newer Obsidian value.');
  expect(readdirSync(folder)).toEqual(['Human name.md']);
});

test('shared knowledge preserves properties and rejects stale updates or forget actions', () => {
  const e = environment();
  let note = e.brain.write(
    e.first.id,
    'Knowledge/Launch.md',
    '---\naliases: [Launch plan]\ntags: [project]\n---\n\nLaunch in June.',
  );
  expect(e.brain.read(e.second.id, note.path).text).toBe('Launch in June.');
  expect(() => e.brain.write(e.second.id, note.path, 'Overwrite without reading.')).toThrow(
    'Note changed',
  );
  writeFileSync(
    join(e.brain.root, note.path),
    readFileSync(join(e.brain.root, note.path), 'utf8').replace('June', 'July'),
  );
  expect(() => e.brain.write(e.second.id, note.path, 'Stale change.', note.hash)).toThrow(
    'Note changed',
  );
  expect(() => e.brain.forget(e.second.id, note.path, note.hash)).toThrow('Note changed');
  note = e.brain.read(e.second.id, note.path);
  e.brain.write(e.second.id, note.path, 'Launch in August.', note.hash);
  expect(readFileSync(join(e.brain.root, note.path), 'utf8')).toContain('Launch plan');
  note = e.brain.read(e.first.id, note.path);
  expect(e.brain.forget(e.first.id, note.path, note.hash).forgotten).toBe(true);
  expect(e.brain.search(e.first.id, 'August')).toEqual([]);
});

test('brain retrieval confines notes to shared knowledge and the requesting identity', () => {
  const e = environment();
  e.memory.remember(e.first.id, { key: 'private', text: 'Private research preference.' });
  e.memory.remember(e.second.id, { key: 'private', text: 'Private writing preference.' });
  const firstPath = e.brain.search(e.first.id, 'research')[0]!.path;
  expect(() => e.brain.read(e.second.id, firstPath)).toThrow('not available');
  expect(e.brain.search(e.second.id, 'research')).toEqual([]);
  for (const path of [
    '../outside.md',
    'Knowledge/../../outside.md',
    '/outside.md',
    'Knowledge/..\\outside.md',
    '.obsidian/config.md',
  ])
    expect(() => e.brain.write(e.first.id, path, 'Escape')).toThrow();
  const outside = join(e.directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.md'), 'Outside secret');
  symlinkSync(outside, join(e.brain.root, 'Knowledge', 'linked'));
  expect(() => e.brain.read(e.first.id, 'Knowledge/linked/private.md')).toThrow('Linked');
  expect(() => e.brain.write(e.first.id, 'Knowledge/linked/private.md', 'Escape')).toThrow(
    'Linked',
  );
  expect(e.brain.search(e.first.id, 'Outside secret')).toEqual([]);
});

test('context is valid byte-bounded Unicode and bad notes do not disable good knowledge', () => {
  const e = environment();
  for (let i = 0; i < 12; i++)
    e.brain.write(e.first.id, `Knowledge/Topic-${i}.md`, '研究🧠'.repeat(400));
  writeFileSync(join(e.brain.root, 'Knowledge', 'Broken.md'), '---\na: [broken\n---\nBad metadata');
  const context = e.brain.context('研究', 2600);
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(2600);
  expect(context).not.toContain('\uFFFD');
  expect(JSON.parse(context.slice(context.indexOf('{'))).notes.length).toBeGreaterThan(0);
  expect(e.brain.status().state).toBe('ready');
  expect(e.brain.context('研究', 0)).toBe('');
});

test('ordinary Obsidian notes are searchable without requiring a special folder', () => {
  const e = environment();
  writeFileSync(join(e.brain.root, 'User project.md'), '# Studio\n\nWe ship desktop software.');
  expect(e.brain.search(e.first.id, 'desktop software')[0]?.path).toBe('User project.md');
  expect(e.brain.context('Studio', 2000)).toContain('We ship desktop software.');
  const note = e.brain.read(e.first.id, 'User project.md');
  expect(e.brain.write(e.first.id, note.path, 'Updated project.', note.hash).text).toBe(
    'Updated project.',
  );
  expect(() => e.brain.read(e.first.id, 'memory/Bots/another/private.md')).toThrow('not available');
});

test('renamed memory notes remain editable and Unicode keys fit real filenames', () => {
  const e = environment();
  const key = '\u{10400}'.repeat(50);
  e.memory.remember(e.first.id, { key, text: 'Unicode preference.' });
  const own = join(e.brain.root, 'Memory', 'Bots', e.first.id);
  const file = readdirSync(own)[0]!;
  expect(Buffer.byteLength(file)).toBeLessThan(255);
  renameSync(join(own, file), join(own, 'My preference.md'));
  expect(e.memory.read(e.first.id, key)?.data.text).toBe('Unicode preference.');
  e.memory.remember(e.first.id, { key, text: 'Edited after renaming.' });
  expect(readdirSync(own)).toEqual(['My preference.md']);
  expect(readFileSync(join(own, 'My preference.md'), 'utf8')).toContain('Edited after renaming.');
  e.memory.forget(e.first.id, key);
  expect(readdirSync(own)).toEqual([]);
});

test('moving a managed private note into a shared folder does not expose it', () => {
  const e = environment();
  e.memory.remember(e.first.id, { key: 'private', text: 'Keep research preferences private.' });
  const privatePath = e.brain.search(e.first.id, 'research')[0]!.path;
  renameSync(join(e.brain.root, privatePath), join(e.brain.root, 'Knowledge', 'Moved.md'));
  expect(e.brain.search(e.second.id, 'research')).toEqual([]);
  expect(e.brain.context('research', 6000)).not.toContain('Keep research preferences private.');
  expect(() => e.brain.read(e.second.id, 'Knowledge/Moved.md')).toThrow('not available');
  expect(() => e.brain.write(e.second.id, 'Knowledge/Moved.md', 'Overwrite private note.')).toThrow(
    'not available',
  );
});

test('personal chat and bots recall shared knowledge while private memory stays isolated', async () => {
  const e = environment(),
    personal = new Conversations(e.store).personal(),
    mailbox = new SqliteMailbox(e.store);
  const personalThread = new Conversations(e.store).create(personal.id, 'brain-chat');
  let recalled = 0;
  const daemon = new Daemon(
    e.store,
    { pollMs: 10 },
    (agent) =>
      new FakeProvider({
        script: async (prompt, call) => {
          if (prompt.endsWith('Save the launch decision.')) {
            expect(
              (
                await call('workspace', {
                  action: 'brain_write',
                  path: 'Knowledge/Launch.md',
                  text: 'Launch date: June 18.',
                })
              ).success,
            ).toBe(true);
            return 'Saved';
          }
          expect(prompt).toContain('Launch date: June 18.');
          if (agent.id === personal.id) {
            expect(
              (
                await call('workspace', {
                  action: 'remember',
                  key: 'style',
                  text: 'Prefer concise personal answers.',
                })
              ).success,
            ).toBe(true);
            expect(
              (await call('workspace', { action: 'brain_search', query: 'Launch date' })).success,
            ).toBe(true);
            recalled++;
          } else {
            expect(prompt).not.toContain('Prefer concise personal answers.');
            recalled++;
          }
          return 'June 18';
        },
      }),
  );
  cleanups.push(() => daemon.stop(0));
  daemon.start();
  await daemon.ready;
  const send = async (agentId: string, text: string, laneId: string | null = null) => {
    const id = mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [agentId], text, laneId })
      .deliveryIds[0]!;
    const until = Date.now() + 5000;
    while (['queued', 'starting', 'running'].includes(mailbox.get(id)!.status)) {
      if (Date.now() > until) throw new Error('Brain turn timed out');
      await Bun.sleep(10);
    }
    expect(mailbox.get(id)?.status).toBe('completed');
  };
  await send(e.first.id, 'Save the launch decision.');
  await send(personal.id, 'Recall our launch date.', personalThread.laneId);
  await send(e.second.id, 'Recall shared knowledge.');
  expect(recalled).toBe(2);
  expect(daemon.workspace.memory.read(personal.id, 'style')?.data.text).toBe(
    'Prefer concise personal answers.',
  );
  expect(e.brain.search(e.second.id, 'Prefer concise personal answers.')).toEqual([]);
  expect(verifyReplay(e.store).matches).toBe(true);
});
