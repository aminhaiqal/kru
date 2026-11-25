import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { Daemon } from '../src/daemon';
import { FakeProvider, type FakeProviderOptions } from '../src/providers/fake/adapter';
import { createWebServer } from '../src/web/server';
import { verifyReplay } from '../src/store/replay';
import { graphSchema, starterGraph, type Graph } from '../src/workflows/types';
import { mapped } from '../src/workflows/data';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function env(options: FakeProviderOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kru-flows-')),
    store = new Store(join(dir, 'db.sqlite'));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const agents = new AgentRegistry(store),
    agent = agents.create({ name: 'worker', provider: 'fake' });
  const factory = () =>
    new FakeProvider({
      script: async (_prompt, call) => {
        const answer = await call('task_update', {
          status: 'completed',
          result: 'Verified workflow result',
          steps: [{ text: 'Verify outcome', done: true }],
        });
        if (!answer.success) throw new Error('Task update failed');
        return 'Done.';
      },
      ...options,
    });
  const daemon = new Daemon(store, { pollMs: 10 }, factory);
  cleanups.push(() => daemon.stop(0));
  daemon.start();
  await daemon.ready;
  return { store, daemon, agents, agent, flows: daemon.workspace.workflows, factory };
}
async function until(e: Awaited<ReturnType<typeof env>>, check: () => boolean) {
  const end = Date.now() + 6000;
  while (!check()) {
    e.daemon.workspace.tick();
    if (Date.now() > end) throw new Error('Workflow timed out');
    await Bun.sleep(10);
  }
}
function dataGraph(): Graph {
  return {
    nodes: [
      { id: 'start', name: 'Start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'map',
        name: 'Map fields',
        type: 'set',
        position: { x: 200, y: 0 },
        config: {
          values: { score: '{{input.score}}', message: 'Hello {{input.name}}' },
          keepInput: false,
        },
      },
      {
        id: 'check',
        name: 'Check score',
        type: 'if',
        position: { x: 400, y: 0 },
        config: { path: 'input.score', operator: 'greater_than', value: 5 },
      },
      {
        id: 'yes',
        name: 'Yes',
        type: 'set',
        position: { x: 600, y: 0 },
        config: { values: { accepted: true } },
      },
      {
        id: 'no',
        name: 'No',
        type: 'set',
        position: { x: 600, y: 200 },
        config: { values: { accepted: false } },
      },
    ],
    edges: [
      { from: 'start', to: 'map', port: 'main' },
      { from: 'map', to: 'check', port: 'main' },
      { from: 'check', to: 'yes', port: 'true' },
      { from: 'check', to: 'no', port: 'false' },
    ],
  };
}
function save(e: Awaited<ReturnType<typeof env>>, graph = dataGraph()) {
  return e.flows.save({ name: 'Review workflow', agentId: e.agent.id, graph });
}
function connector(e: Awaited<ReturnType<typeof env>>, permission = 'allow') {
  return e.daemon.workspace.records.put('connector', e.agent.id, {
    name: 'Echo app',
    transport: 'stdio',
    command: process.execPath,
    args: [new URL('./fakes/workspace-mcp.ts', import.meta.url).pathname],
    permission,
  });
}
function appGraph(connectorId: string): Graph {
  return {
    nodes: [
      { id: 'start', name: 'Start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'app',
        name: 'Echo',
        type: 'connector',
        position: { x: 200, y: 0 },
        config: { connectorId, tool: 'echo', arguments: { text: '{{input.message}}' } },
      },
      {
        id: 'result',
        name: 'Extract result',
        type: 'set',
        position: { x: 400, y: 0 },
        config: { values: { reply: '{{input.data.text}}' }, keepInput: false },
      },
    ],
    edges: [
      { from: 'start', to: 'app', port: 'main' },
      { from: 'app', to: 'result', port: 'main' },
    ],
  };
}

test('workflow graphs reject cycles, duplicate inputs and unsafe mappings', () => {
  const graph = dataGraph();
  expect(graphSchema.parse(graph).nodes).toHaveLength(5);
  expect(() =>
    graphSchema.parse({
      ...graph,
      edges: [...graph.edges, { from: 'yes', to: 'map', port: 'main' }],
    }),
  ).toThrow();
  expect(() => mapped('{{input.__proto__.polluted}}', { input: {} })).toThrow('Invalid data path');
  expect(() => mapped('{{process.env}}', {})).toThrow();
  expect(
    mapped({ number: '{{input.n}}', message: 'Value {{input.n}}' }, { input: { n: 8 } }),
  ).toEqual({ number: 8, message: 'Value 8' });
});

test('mapped node data, branching, immutable run graphs, revisions and idempotent starts survive replay', async () => {
  const e = await env(),
    flow = save(e),
    run = e.flows.start(flow.id, { score: 8, name: 'KRU' }, 'same-start');
  expect(e.flows.start(flow.id, { score: 8, name: 'KRU' }, 'same-start').id).toBe(run.id);
  expect(() => e.flows.start(flow.id, { score: 2 }, 'same-start')).toThrow('different input');
  e.flows.tick();
  const finished = e.flows.detail(run.id);
  expect(finished.status).toBe('completed');
  expect(finished.nodes.find((node) => node.id === 'yes')?.output).toMatchObject({
    message: 'Hello KRU',
    accepted: true,
  });
  expect(finished.nodes.find((node) => node.id === 'no')?.status).toBe('skipped');
  const changed = dataGraph();
  changed.nodes[1]!.config.values = { score: 0 };
  e.flows.save({ name: flow.name, agentId: flow.agentId, graph: changed }, flow.id, flow.revision);
  expect(() =>
    e.flows.save(
      { name: flow.name, agentId: flow.agentId, graph: changed },
      flow.id,
      flow.revision,
    ),
  ).toThrow('changed');
  expect(e.flows.detail(run.id).graph.nodes[1]!.config.values).toEqual(
    dataGraph().nodes[1]!.config.values,
  );
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('bot steps use bounded tasks, expose evidence and never import workflow tasks into Work', async () => {
  const e = await env(),
    flow = save(e, starterGraph('Review {{input.subject}}.')),
    run = e.flows.start(flow.id, { subject: 'the changes' });
  await until(e, () => e.flows.detail(run.id).status === 'completed');
  const detail = e.flows.detail(run.id),
    step = detail.nodes.find((node) => node.id === 'agent')!;
  expect(step.taskId).not.toBeNull();
  expect(step.output).toMatchObject({ result: 'Verified workflow result' });
  e.daemon.workspace.work.importTasks();
  expect(e.daemon.workspace.work.list()).toHaveLength(0);
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('workflow completion waits for native execution after an agent reports its task complete', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const e = await env({
    script: async (_prompt, call) => {
      const result = await call('task_update', {
        status: 'completed',
        result: 'Evidence recorded before native completion',
      });
      if (!result.success) throw new Error('Task update failed');
      await pending;
      return 'Native execution finished.';
    },
  });
  try {
    const flow = save(e, starterGraph('Complete the task.'));
    const run = e.flows.start(flow.id);
    await until(e, () =>
      e.daemon.workspace.records.list('task').some((task) => task.data.status === 'completed'),
    );
    expect(e.flows.detail(run.id).status).toBe('running');
    expect(e.flows.detail(run.id).nodes.find((node) => node.id === 'agent')?.status).toBe(
      'running',
    );
    release();
    await until(e, () => e.flows.detail(run.id).status === 'completed');
    expect(e.flows.detail(run.id).nodes.find((node) => node.id === 'agent')?.output).toMatchObject({
      result: 'Evidence recorded before native completion',
    });
    expect(verifyReplay(e.store).matches).toBe(true);
  } finally {
    release();
  }
});

test('connector nodes use an existing connection and pass typed app results into the next node', async () => {
  const e = await env(),
    app = connector(e),
    flow = save(e, appGraph(app.id)),
    run = e.flows.start(flow.id, { message: 'real MCP result' });
  await until(e, () => e.flows.detail(run.id).status === 'completed');
  expect(e.flows.detail(run.id).nodes.find((node) => node.id === 'result')?.output).toEqual({
    reply: 'real MCP result',
  });
  const other = e.agents.create({ name: 'other', provider: 'fake' });
  const foreign = e.flows.save({
    name: 'Foreign connection',
    agentId: other.id,
    graph: appGraph(app.id),
  });
  expect(() => e.flows.start(foreign.id)).toThrow('not enabled');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('workflow app actions ask in their exact bot conversation and stale connector grants fail', async () => {
  const e = await env(),
    app = connector(e, 'ask'),
    flow = save(e, appGraph(app.id)),
    run = e.flows.start(flow.id, { message: 'approved' });
  e.flows.tick();
  const waiting = e.flows.detail(run.id);
  expect(waiting.status).toBe('waiting');
  const approvalId = waiting.nodes.find((node) => node.id === 'app')!.approvalId!;
  const web = createWebServer({ store: e.store, daemon: e.daemon, port: 0 });
  cleanups.push(() => web.close());
  const response = await fetch(
    web.url + '/api/agents/' + e.agent.id + '/messages?lane=workflow:' + run.id,
    { headers: { 'X-Kru-Token': web.token } },
  );
  expect(((await response.json()) as any).approvals[0].id).toBe(approvalId);
  e.daemon.workspace.approvals.decide(approvalId, 'accept');
  e.daemon.workspace.records.put(
    'connector',
    e.agent.id,
    { ...app.data, name: 'Changed app' },
    app.id,
  );
  await until(e, () => e.flows.detail(run.id).status === 'failed');
  expect(e.flows.detail(run.id).error).toContain('Connector changed');
  expect(() => e.daemon.workspace.approvals.decide(approvalId, 'accept')).toThrow();
});

test('cancelled workflow approvals cannot run, interrupted runs require explicit resume and fresh consent', async () => {
  const e = await env(),
    app = connector(e, 'ask'),
    flow = save(e, appGraph(app.id)),
    run = e.flows.start(flow.id, { message: 'pending' });
  e.flows.tick();
  const firstApproval = e.flows.detail(run.id).nodes.find((node) => node.id === 'app')!.approvalId!;
  await e.daemon.stop(0);
  const replacement = new Daemon(e.store, { pollMs: 10 }, e.factory);
  cleanups.push(() => replacement.stop(0));
  replacement.start();
  await replacement.ready;
  expect(replacement.workspace.workflows.detail(run.id).status).toBe('interrupted');
  expect(() => replacement.workspace.approvals.decide(firstApproval, 'accept')).toThrow();
  const newer = replacement.workspace.workflows.start(flow.id, { message: 'new run' });
  expect(() => replacement.workspace.workflows.resume(run.id)).toThrow('already has an active run');
  replacement.workspace.workflows.cancel(newer.id);
  replacement.workspace.workflows.resume(run.id);
  replacement.workspace.workflows.tick();
  const secondApproval = replacement.workspace.workflows
    .detail(run.id)
    .nodes.find((node) => node.id === 'app')!.approvalId!;
  expect(secondApproval).not.toBe(firstApproval);
  replacement.workspace.workflows.cancel(run.id);
  expect(() => replacement.workspace.approvals.decide(secondApproval, 'accept')).toThrow();
  expect(replacement.workspace.workflows.detail(run.id).status).toBe('cancelled');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('legacy bot skills import once and activated intervals coalesce without duplicating runs', async () => {
  const e = await env();
  e.daemon.workspace.records.put('skill', e.agent.id, {
    name: 'Reusable review',
    instructions: 'Review it.',
    description: 'Preserved prompt.',
  });
  e.flows.importSkills();
  e.flows.importSkills();
  expect(e.flows.list()).toHaveLength(1);
  expect(e.flows.list()[0]?.graph.nodes[1]?.config.prompt).toBe('Review it.');
  const scheduled = e.flows.save({
    name: 'Scheduled mapping',
    agentId: e.agent.id,
    graph: dataGraph(),
    active: true,
    intervalMinutes: 1,
  });
  const due = Date.parse(scheduled.nextRunAt!);
  e.flows.tick(due);
  e.flows.tick(due);
  expect(e.flows.recentRuns(scheduled.id)).toHaveLength(1);
  const app = connector(e),
    appSchedule = e.flows.save({
      name: 'Scheduled app',
      agentId: e.agent.id,
      graph: appGraph(app.id),
      active: true,
      intervalMinutes: 1,
    });
  e.daemon.workspace.records.put('connector', e.agent.id, { ...app.data, enabled: false }, app.id);
  e.flows.tick(Date.parse(appSchedule.nextRunAt!));
  const failedStart = e.flows.recentRuns(appSchedule.id)[0]!;
  expect(failedStart.status).toBe('failed');
  expect(failedStart.error).toContain('not enabled');
  expect(() => e.flows.resume(failedStart.id)).toThrow('Start a new run');
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('cancelled app executions discard late responses and cannot complete downstream steps', async () => {
  const e = await env(),
    app = connector(e),
    flow = save(e, appGraph(app.id));
  let release!: (value: any) => void,
    started = false;
  e.daemon.workspace.integrations.call = async () => {
    started = true;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const run = e.flows.start(flow.id, { message: 'cancel this action' });
  await until(e, () => started);
  e.flows.cancel(run.id);
  release({ content: [{ type: 'text', text: '{"text":"late response"}' }] });
  await Bun.sleep(20);
  e.flows.tick();
  expect(e.flows.detail(run.id).status).toBe('cancelled');
  expect(e.flows.detail(run.id).nodes.find((node) => node.id === 'app')?.status).toBe('cancelled');
  expect(e.flows.detail(run.id).nodes.find((node) => node.id === 'result')?.status).toBe(
    'cancelled',
  );
  expect(verifyReplay(e.store).matches).toBe(true);
});

test('authenticated workflow API creates, runs and inspects a graph with revision and input validation', async () => {
  const e = await env(),
    web = createWebServer({ store: e.store, daemon: e.daemon, port: 0 });
  cleanups.push(() => web.close());
  const request = (path: string, method = 'GET', body?: unknown, headers = {}) =>
    fetch(web.url + '/api/workflows' + path, {
      method,
      headers: { 'X-Kru-Token': web.token, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await fetch(web.url + '/api/workflows')).status).toBe(401);
  const flow = (await (
    await request('', 'POST', { name: 'API workflow', agentId: e.agent.id, graph: dataGraph() })
  ).json()) as any;
  expect((await request('/' + flow.id + '/run', 'POST', { input: {} })).status).toBe(400);
  const response = await request(
    '/' + flow.id + '/run',
    'POST',
    { input: { name: 'API', score: 1 } },
    { 'Idempotency-Key': 'api-run' },
  );
  expect(response.status).toBe(202);
  const run = (await response.json()) as any;
  e.flows.tick();
  const detail = (await (await request('/runs/' + run.id)).json()) as any;
  expect(detail.status).toBe('completed');
  expect(detail.nodes.find((node: any) => node.id === 'yes').status).toBe('skipped');
  expect(
    (
      await request('/' + flow.id, 'PATCH', {
        name: flow.name,
        agentId: flow.agentId,
        graph: flow.graph,
        revision: 99,
      })
    ).status,
  ).toBe(409);
});
