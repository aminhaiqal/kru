import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store';
import { verifyReplay } from '../src/store/replay';
import { WorkService } from '../src/work/service';
import { standardStages, type ProjectRow } from '../src/work/types';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { WorkspaceRecords } from '../src/workspace/records';
import { TaskRunner } from '../src/workspace/tasks';
import { Daemon } from '../src/daemon';
import { FakeProvider } from '../src/providers/fake/adapter';
import { createWebServer } from '../src/web/server';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await Bun.sleep(10);
  }
}
function env() {
  const dir = mkdtempSync(join(tmpdir(), 'kru-work-')),
    store = new Store(join(dir, 'db.sqlite'));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    work: new WorkService(store),
    agents: new AgentRegistry(store),
    mailbox: new SqliteMailbox(store),
    records: new WorkspaceRecords(store),
  };
}

test('human work is durable, revision guarded, three-category and replayable without an agent', () => {
  const e = env();
  let item = e.work.create({ title: 'Write a launch brief', description: 'Define the audience.' });
  expect(item.identifier).toBe('KRU-1');
  expect(item.stageId).toBe('brief');
  expect(e.records.list('task')).toHaveLength(0);
  item = e.work.update(
    item.id,
    { priority: 'high', labels: ['launch'], dueDate: '2026-12-01' },
    item.revision,
  );
  expect(() => e.work.update(item.id, { title: 'stale edit' }, 1)).toThrow('changed');
  item = e.work.update(item.id, { stageId: 'in_progress' }, item.revision);
  item = e.work.update(item.id, { stageId: 'done' }, item.revision);
  expect(item.stageId).toBe('done');
  expect(e.work.detail(item.id).activity.map((a) => a.kind)).toContain('stage_changed');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('completion dates survive edits, clear on reopening and preserve completion history', () => {
  const e = env();
  let item = e.work.create({ title: 'Ship release' });
  expect(item.completedAt).toBeNull();
  item = e.work.update(item.id, { stageId: 'done' }, item.revision);
  const completedAt = item.completedAt;
  expect(completedAt).not.toBeNull();
  expect(item.completedBy).toBeNull();
  item = e.work.update(item.id, { title: 'Release shipped' }, item.revision);
  expect(item.completedAt).toBe(completedAt);
  item = e.work.update(item.id, { stageId: 'in_progress' }, item.revision);
  expect(item.completedAt).toBeNull();
  item = e.work.update(item.id, { stageId: 'done' }, item.revision);
  expect(item.completedAt).not.toBeNull();
  expect(
    e.work
      .detail(item.id)
      .activity.filter((a) => a.kind === 'stage_changed' && a.metadata.to === 'done'),
  ).toHaveLength(2);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('project prefixes are generated and context files persist across project edits and replay', async () => {
  const e = env();
  const first = e.work.saveProject({ name: 'Autopilots launch', stages: standardStages() });
  const second = e.work.saveProject({ name: 'Automatic tests', stages: standardStages() });
  expect(first.key).toBe('AUT');
  expect(second.key).toBe('AUT2');
  expect(e.work.saveProject({ name: 'ai', stages: standardStages() }).key).toBe('AIX');
  const attached = await e.work.attachFile(
    first.id,
    new File(['Customer requirements: fast and simple'], 'requirements.txt'),
  );
  expect(attached.files[0]?.name).toBe('requirements.txt');
  expect(e.work.projectContext(first.id)).toContain('fast and simple');
  const renamed = e.work.saveProject(
    { name: 'Renamed', description: 'New context', stages: first.stages },
    first.id,
  );
  expect(renamed.key).toBe('AUT');
  expect(renamed.files).toEqual(attached.files);
  expect(e.work.projectContext(first.id)).toContain('New context');
  await expect(
    e.work.attachFile(first.id, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.bin')),
  ).rejects.toThrow('5 MB');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('workflow validation protects used stages and explicit unassignment overrides a stage agent', () => {
  const e = env(),
    agent = e.agents.create({ name: 'researcher', provider: 'fake' });
  const stages = standardStages().map((s) =>
    s.category === 'active' ? { ...s, agentId: agent.id } : s,
  );
  const project = e.work.saveProject({ name: 'Launch', key: 'LAU', stages });
  const human = e.work.create({
    projectId: project.id,
    title: 'Human draft',
    stageId: 'in_progress',
    assigneeId: null,
  });
  expect(human.taskId).toBeNull();
  const auto = e.work.create({
    projectId: project.id,
    title: 'Agent draft',
    stageId: 'in_progress',
  });
  expect(auto.assigneeId).toBe(agent.id);
  expect(auto.taskId).not.toBeNull();
  expect(e.mailbox.listQueue(agent.id)).toHaveLength(1);
  expect(() =>
    e.work.saveProject({
      name: 'Bad',
      key: 'BAD',
      stages: stages.filter((s) => s.category !== 'active'),
    }),
  ).toThrow();
  expect(() =>
    e.work.saveProject(
      {
        name: 'Launch',
        key: 'LAU',
        stages: stages.map((s) => (s.id === 'in_progress' ? { ...s, id: 'new' } : s)),
      },
      project.id,
    ),
  ).toThrow('Move work');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('stage handoffs run the configured agents, carry evidence forward, and complete in Done', async () => {
  const e = env(),
    researcher = e.agents.create({ name: 'researcher', provider: 'fake' }),
    writer = e.agents.create({ name: 'writer', provider: 'fake' });
  let writerSawResearch = false;
  const daemon = new Daemon(
    e.store,
    { pollMs: 10 },
    (agent) =>
      new FakeProvider({
        script: async (prompt, call) => {
          if (agent.id === writer.id)
            writerSawResearch = prompt.includes('Research evidence from interviews');
          const result = await call('task_update', {
            status: 'completed',
            result:
              agent.id === researcher.id
                ? 'Research evidence from interviews'
                : 'Launch draft ready for review',
            steps: [{ text: 'Verify stage deliverable', done: true }],
          });
          expect(result.success).toBe(true);
          return 'Stage completed.';
        },
      }),
  );
  cleanups.push(() => daemon.stop(0));
  daemon.start();
  await daemon.ready;
  const stages = standardStages();
  stages.splice(
    1,
    1,
    {
      id: 'research',
      name: 'Research',
      category: 'active',
      agentId: researcher.id,
      instructions: 'Research customer needs.',
    },
    {
      id: 'writing',
      name: 'Writing',
      category: 'active',
      agentId: writer.id,
      instructions: 'Write the launch post using research.',
    },
  );
  const project = e.work.saveProject({ name: 'Launch', key: 'LAU', stages });
  const item = e.work.create({
    projectId: project.id,
    title: 'Launch post',
    description: 'Explain the product.',
    stageId: 'research',
  });
  await until(() => e.work.detail(item.id).item.stageId === 'done');
  const detail = e.work.detail(item.id);
  expect(detail.runs).toHaveLength(2);
  expect(writerSawResearch).toBe(true);
  expect(detail.runs.map((run) => run.agentId)).toEqual([researcher.id, writer.id]);
  expect(detail.activity.filter((a) => a.kind === 'agent_result')).toHaveLength(2);
  await Bun.sleep(60);
  expect(e.work.detail(item.id).item.stageId).toBe('done');
  e.work.update(item.id, { stageId: 'done' }, detail.item.revision);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('leaving In Progress cancels its task and Done waits for native execution to stop', () => {
  const e = env(),
    agent = e.agents.create({ name: 'coder', provider: 'fake' });
  const item = e.work.create({
    title: 'Implement feature',
    stageId: 'in_progress',
    assigneeId: agent.id,
  });
  const batch = e.mailbox.claimBatch(agent.id, 'task:' + item.taskId)!;
  e.mailbox.markBatchRunning(batch.id, 'native-turn');
  const review = e.work.update(item.id, { stageId: 'brief' }, item.revision);
  expect(e.records.require('task', item.taskId!).data.status).toBe('cancelled');
  expect(() => e.work.update(item.id, { stageId: 'done' }, review.revision)).toThrow(
    'finish running',
  );
  e.mailbox.finishBatch(batch.id, 'interrupted');
  expect(e.work.update(item.id, { stageId: 'done' }, review.revision).stageId).toBe('done');
});

test('custom statuses require one of three categories and legacy Review stays readable and replayable', () => {
  const e = env();
  expect(standardStages().map((s) => s.name)).toEqual(['To Do', 'In Progress', 'Done']);
  const stages = standardStages();
  stages.splice(2, 0, {
    id: 'quality',
    name: 'Quality check',
    category: 'active',
    agentId: null,
    instructions: '',
  });
  const project = e.work.saveProject({ name: 'Custom', key: 'CUS', stages });
  expect(project.stages.find((s) => s.id === 'quality')?.category).toBe('active');
  expect(() =>
    e.work.saveProject({
      name: 'Invalid',
      key: 'BAD',
      stages: stages.map((s) => ({ ...s, category: 'unknown' })),
    }),
  ).toThrow();
  const row = e.store.db
    .query<ProjectRow, [string]>('SELECT * FROM work_projects WHERE id=?')
    .get(project.id)!;
  e.store.atomic(() =>
    e.store.emit('work.project_saved', {
      row: {
        ...row,
        stages_json: JSON.stringify(
          stages.map((s) => (s.id === 'quality' ? { ...s, category: 'review' } : s)),
        ),
      },
    }),
  );

  const restored = e.work.projects().find((p) => p.id === project.id)!;
  expect(restored.stages.find((s) => s.id === 'quality')?.category).toBe('active');
  const item = e.work.create({
    projectId: project.id,
    stageId: 'quality',
    title: 'Preserved status',
  });
  expect(e.work.update(item.id, { stageId: 'done' }, item.revision).stageId).toBe('done');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('existing tasks import once, retain their lanes/history and do not create duplicate deliveries', () => {
  const e = env(),
    agent = e.agents.create({ name: 'worker', provider: 'fake' });
  const task = new TaskRunner(e.records).create(agent.id, {
    title: 'Existing task',
    objective: 'Preserve it.',
  });
  const receipt = e.mailbox.listQueue(agent.id)[0]!;
  e.work.importTasks();
  e.work.importTasks();
  expect(e.work.list()).toHaveLength(1);
  expect(e.work.list()[0]?.taskId).toBe(task.id);
  expect(e.work.detail(e.work.list()[0]!.id).runs[0]?.taskId).toBe(task.id);
  expect(e.mailbox.listQueue(agent.id).map((d) => d.id)).toEqual([receipt.id]);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('early completion never bypasses native cancellation and late results cannot advance a moved item', () => {
  const e = env(),
    agent = e.agents.create({ name: 'worker', provider: 'fake' }),
    interrupted: string[] = [];
  const work = new WorkService(e.store, (_agentId, laneId) => interrupted.push(laneId));
  const item = work.create({
    title: 'Verify delivery',
    stageId: 'in_progress',
    assigneeId: agent.id,
  });
  const batch = e.mailbox.claimBatch(agent.id, 'task:' + item.taskId)!;
  e.mailbox.markBatchRunning(batch.id, 'native-turn');
  const task = e.records.require('task', item.taskId!);
  e.records.put(
    'task',
    task.agentId,
    { ...task.data, status: 'completed', result: 'Early result' },
    task.id,
  );
  work.update(item.id, { stageId: 'brief' }, item.revision);
  expect(interrupted).toEqual(['task:' + task.id]);
  e.mailbox.finishBatch(batch.id, 'completed');
  work.tick();
  work.tick();
  const detail = work.detail(item.id);
  expect(detail.item.stageId).toBe('brief');
  expect(detail.runs).toHaveLength(1);
  expect(detail.activity.filter((a) => a.kind === 'agent_result')).toHaveLength(1);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('comments deduplicate, archive stops queued work, and restore never restarts it implicitly', () => {
  const e = env(),
    agent = e.agents.create({ name: 'worker', provider: 'fake' });
  const item = e.work.create({
    title: 'Review work',
    stageId: 'in_progress',
    assigneeId: agent.id,
  });
  const one = e.work.comment(item.id, 'Use the latest feedback.', 'comment-1');
  expect(e.work.comment(item.id, 'Use the latest feedback.', 'comment-1')).toEqual(one);
  expect(() => e.work.comment(item.id, 'different', 'comment-1')).toThrow('different input');
  expect(e.work.detail(item.id).activity.filter((a) => a.kind === 'comment')).toHaveLength(1);
  const archived = e.work.archive(item.id, item.revision);
  expect(archived.item.archivedAt).not.toBeNull();
  expect(e.mailbox.get(item.task!.deliveryIds[0]!)?.status).toBe('cancelled');
  const restored = e.work.archive(item.id, archived.item.revision, true);
  expect(restored.item.archivedAt).toBeNull();
  expect(e.mailbox.listQueue(agent.id)).toHaveLength(0);
  expect(restored.runs).toHaveLength(1);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('authenticated work API validates writes and round-trips project, board, detail and comments', async () => {
  const e = env(),
    daemon = new Daemon(e.store, {}, () => new FakeProvider());
  daemon.start();
  await daemon.ready;
  const web = createWebServer({ store: e.store, daemon, port: 0 });
  cleanups.push(async () => {
    await web.close();
    await daemon.stop(0);
  });
  const request = (path: string, method = 'GET', body?: unknown, headers = {}) =>
    fetch(web.url + '/api/work' + path, {
      method,
      headers: { 'X-Kru-Token': web.token, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await fetch(web.url + '/api/work')).status).toBe(401);
  const longContext = 'Project requirements — '.repeat(5000) + 'FINAL CONTEXT MARKER';
  const project = (await (
    await request('/projects', 'POST', {
      name: 'Product',
      key: 'PRD',
      description: longContext,
      stages: standardStages(),
    })
  ).json()) as any;
  expect(project.description).toBe(longContext);
  const updatedContext = longContext + '\nMore requirements';
  const updatedProject = await request('/projects/' + project.id, 'PATCH', {
    name: 'Product',
    description: updatedContext,
    stages: standardStages(),
  });
  expect(updatedProject.status).toBe(200);
  expect(((await updatedProject.json()) as any).description).toBe(updatedContext);
  const nativeContext = e.work.projectContext(project.id);
  const fullContextPath = nativeContext.match(/^Full project context: (.+)\n/)![1]!;
  expect(await Bun.file(fullContextPath).text()).toBe(updatedContext);
  const item = (await (
    await request('/items', 'POST', {
      projectId: project.id,
      title: 'A real work item',
      description: 'Define the outcome.',
    })
  ).json()) as any;
  expect(item.identifier).toBe('PRD-1');
  expect(
    (await request('/items/' + item.id, 'PATCH', { revision: 999, priority: 'high' })).status,
  ).toBe(409);
  expect(
    (
      await request(
        '/items/' + item.id + '/comments',
        'POST',
        { body: 'Feedback' },
        { 'Idempotency-Key': 'test' },
      )
    ).status,
  ).toBe(201);
  const detail = (await (await request('/items/' + item.id)).json()) as any;
  expect(detail.activity.at(-1).body).toBe('Feedback');
  const board = (await (await request('')).json()) as any;
  expect(board.items).toHaveLength(1);
  expect(board.projects[0].name).toBe('Product');
  expect(board.projects[0].description).toBe(updatedContext);
  expect(verifyReplay(e.store).matches).toBe(true);
});
