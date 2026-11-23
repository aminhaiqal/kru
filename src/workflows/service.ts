import { z } from 'zod';
import type { Store } from '../store';
import { AgentRegistry } from '../agents';
import { SqliteMailbox } from '../mailbox';
import { WorkspaceRecords } from '../workspace/records';
import { TaskRunner } from '../workspace/tasks';
import type { IntegrationGateway } from '../workspace/integrations';
import { storedError } from '../store/errors';
import { workflowSchema, starterGraph, type DefinitionRow, type RunRow, type NodeRow, type Graph, type Node } from './types';
import { mapped, pathValue, jsonData } from './data';

const at = () => new Date().toISOString();
const open = (status: string) => ['running', 'waiting'].includes(status);
export class WorkflowService {
  private readonly records: WorkspaceRecords;
  private readonly tasks: TaskRunner;
  private readonly agents: AgentRegistry;
  private readonly mailbox: SqliteMailbox;
  private readonly live = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(readonly store: Store, private readonly integrations: IntegrationGateway, private readonly interrupt?: (agent: string, lane: string) => void, private readonly guard: () => void = () => {}) {
    this.records = new WorkspaceRecords(store); this.tasks = new TaskRunner(this.records); this.agents = new AgentRegistry(store); this.mailbox = new SqliteMailbox(store);
  }
  private changed(id: string) { this.store.publishChanges([{ topic: 'workflow', id }]); }
  private saveDefinition(row: DefinitionRow) { this.store.emit('workflow.saved', { row }); this.changed(row.id); return row; }
  private saveRun(row: RunRow) { this.store.emit('workflow.run_saved', { row }); this.changed(row.id); return row; }
  private saveNode(row: NodeRow) { this.store.emit('workflow.node_saved', { row }); this.changed(row.run_id); return row; }
  private definition(id: string) { const row = this.store.db.query<DefinitionRow, [string]>('SELECT * FROM workflow_definitions WHERE id=?').get(id); if (!row) throw new Error('Workflow not found'); return row; }
  private runRow(id: string) { const row = this.store.db.query<RunRow, [string]>('SELECT * FROM workflow_runs WHERE id=?').get(id); if (!row) throw new Error('Workflow run not found'); return row; }
  private nodes(id: string) { return this.store.db.query<NodeRow, [string]>('SELECT * FROM workflow_node_runs WHERE run_id=? ORDER BY rowid').all(id); }
  private view(row: DefinitionRow) { return { id: row.id, agentId: row.agent_id, name: row.name, description: row.description, graph: JSON.parse(row.graph_json) as Graph, active: !!row.active, intervalMinutes: row.interval_minutes, nextRunAt: row.next_run_at, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }; }
  list() { return this.store.db.query<DefinitionRow, []>('SELECT * FROM workflow_definitions ORDER BY updated_at DESC,id').all().map(row => this.view(row)); }
  get(id: string) { return this.view(this.definition(id)); }
  save(input: unknown, id?: string, revision?: number) {
    const data = workflowSchema.parse(input); if (!this.agents.get(data.agentId)) throw new Error('Unknown workflow bot');
    if (data.active) this.validate(data.graph, data.agentId);
    return this.store.atomic(() => {
      const old = id ? this.definition(id) : null;
      if (old && old.revision !== revision) throw new Error('Workflow changed. Refresh before saving.');
      const now = at(), scheduleChanged = !old || old.active !== Number(data.active) || old.interval_minutes !== data.intervalMinutes;
      const row = this.saveDefinition({ id: id ?? crypto.randomUUID(), agent_id: data.agentId, name: data.name, description: data.description, graph_json: JSON.stringify(data.graph), active: Number(data.active), interval_minutes: data.intervalMinutes, next_run_at: data.active ? scheduleChanged ? new Date(Date.now() + data.intervalMinutes! * 60000).toISOString() : old!.next_run_at : null, legacy_skill_id: old?.legacy_skill_id ?? null, revision: (old?.revision ?? 0) + 1, created_at: old?.created_at ?? now, updated_at: now });
      return this.view(row);
    });
  }
  importSkills(): void {
    for (const skill of this.records.list('skill')) {
      if (!skill.agentId || this.store.db.query('SELECT 1 FROM workflow_definitions WHERE legacy_skill_id=?').get(skill.id)) continue;
      this.store.atomic(() => {
        const saved = this.save({ name: skill.data.name, description: skill.data.description, agentId: skill.agentId, graph: starterGraph(skill.data.instructions) });
        this.saveDefinition({ ...this.definition(saved.id), legacy_skill_id: skill.id });
      });
    }
  }
  private validate(graph: Graph, agentId: string) {
    const starts = graph.nodes.filter(node => node.type === 'trigger'); if (starts.length !== 1) throw new Error('A workflow needs exactly one trigger');
    const reached = new Set<string>(); const visit = (id: string) => { if (reached.has(id)) return; reached.add(id); graph.edges.filter(edge => edge.from === id).forEach(edge => visit(edge.to)); }; visit(starts[0]!.id);
    if (reached.size !== graph.nodes.length) throw new Error('Connect every node to the trigger before running');
    for (const node of graph.nodes) {
      const config = node.config;
      if (node.type === 'agent') { z.string().trim().min(1).max(9000).parse(config.prompt); z.number().int().min(1).max(50).parse(config.maxTurns ?? 8); if (!this.agents.get(typeof config.agentId === 'string' && config.agentId ? config.agentId : agentId)) throw new Error('Choose a valid bot for ' + node.name); }
      if (node.type === 'connector') { const id = z.string().min(1).parse(config.connectorId); this.integrations.entry(id, agentId); z.string().trim().min(1).max(200).parse(config.tool); z.record(z.string(), z.unknown()).parse(config.arguments ?? {}); }
      if (node.type === 'set') z.record(z.string(), z.unknown()).parse(config.values ?? {});
      if (node.type === 'if') { z.string().min(1).parse(config.path); z.enum(['equals', 'not_equals', 'contains', 'greater_than', 'exists']).parse(config.operator); }
    }
  }
  start(id: string, input: unknown = {}, key: string = crypto.randomUUID()): ReturnType<WorkflowService['detail']> {
    const payload = z.record(z.string(), z.unknown()).parse(input); jsonData(payload);
    return this.store.command('workflow.start', () => {
      const definition = this.definition(id), graph = JSON.parse(definition.graph_json) as Graph; this.validate(graph, definition.agent_id);
      if (this.store.db.query('SELECT 1 FROM workflow_runs WHERE workflow_id=? AND status IN (\'running\',\'waiting\')').get(id)) throw new Error('This workflow already has an active run');
      const run = this.saveRun({ id: crypto.randomUUID(), workflow_id: id, agent_id: definition.agent_id, name: definition.name, graph_json: definition.graph_json, input_json: JSON.stringify(payload), status: 'running', error: null, started_at: at(), ended_at: null });
      for (const node of graph.nodes) this.saveNode({ id: `${run.id}:${node.id}`, run_id: run.id, node_id: node.id, status: 'pending', input_json: 'null', output_json: 'null', binding_json: null, error: null, task_id: null, approval_id: null, started_at: null, ended_at: null });
      return this.detail(run.id);
    }, { id: `workflow-start:${id}:${key}`, input: payload });
  }
  recentRuns(workflowId?: string) { return (workflowId ? this.store.db.query<RunRow, [string]>('SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC,rowid DESC LIMIT 50').all(workflowId) : this.store.db.query<RunRow, []>('SELECT * FROM workflow_runs ORDER BY started_at DESC,rowid DESC LIMIT 100').all()).map(row => ({ id: row.id, workflowId: row.workflow_id, agentId: row.agent_id, name: row.name, status: row.status, error: row.error, startedAt: row.started_at, endedAt: row.ended_at })); }
  detail(id: string) { const row = this.runRow(id); return { id: row.id, workflowId: row.workflow_id, name: row.name, agentId: row.agent_id, status: row.status, error: row.error, graph: JSON.parse(row.graph_json) as Graph, input: JSON.parse(row.input_json), startedAt: row.started_at, endedAt: row.ended_at, nodes: this.nodes(id).map(node => ({ id: node.node_id, status: node.status, input: JSON.parse(node.input_json), output: JSON.parse(node.output_json), error: node.error, taskId: node.task_id, approvalId: node.approval_id, startedAt: node.started_at, endedAt: node.ended_at })) }; }
  private activeTask(taskId: string): boolean { return this.records.require('task', taskId).data.deliveryIds.some(id => ['queued', 'starting', 'running'].includes(this.mailbox.get(id)?.status ?? '')); }
  private stopTask(id: string): void { const task = this.records.require('task', id); if (['queued', 'running', 'blocked'].includes(task.data.status)) this.tasks.cancel(id); if (task.agentId) this.interrupt?.(task.agentId, 'task:' + id); }
  cancel(id: string) {
    const tasks: string[] = [];
    this.store.atomic(() => {
      const run = this.runRow(id); if (!open(run.status)) throw new Error('Workflow run is no longer active');
      for (const node of this.nodes(id)) if (['pending', 'running', 'waiting'].includes(node.status)) { this.expireApproval(node, 'Workflow cancelled.'); this.saveNode({ ...node, status: 'cancelled', ended_at: at() }); if (node.task_id) tasks.push(node.task_id); }
      this.saveRun({ ...run, status: 'cancelled', ended_at: at() });
    });
    this.live.get(id)?.controller.abort(); for (const task of tasks) this.stopTask(task); return this.detail(id);
  }
  resume(id: string) {
    this.store.atomic(() => {
      const run = this.runRow(id); if (!['failed', 'interrupted'].includes(run.status)) throw new Error('Only stopped or failed runs can resume');
      if (!this.nodes(id).length) throw new Error('Start a new run after correcting this workflow');
      if (this.store.db.query("SELECT 1 FROM workflow_runs WHERE workflow_id=? AND id<>? AND status IN ('running','waiting')").get(run.workflow_id, id)) throw new Error('This workflow already has an active run');
      if (this.live.has(id) || this.nodes(id).some(node => node.task_id && this.activeTask(node.task_id))) throw new Error('Previous execution is still stopping');
      for (const node of this.nodes(id)) if (!['completed', 'skipped'].includes(node.status)) {
        this.expireApproval(node, 'A new request is required after resume.');
        if (node.task_id) { const task = this.records.require('task', node.task_id); if (task.data.status !== 'blocked') throw new Error('Start a new run for this bot step; its previous result was uncertain'); this.tasks.resume(task.id); this.saveNode({ ...node, status: 'running', error: null, ended_at: null, approval_id: null }); }
        else this.saveNode({ ...node, status: 'pending', error: null, ended_at: null, approval_id: null, binding_json: null });
      }
      this.saveRun({ ...run, status: 'running', error: null, ended_at: null });
    }); return this.detail(id);
  }
  private expireApproval(node: NodeRow, reason: string) { const approval = node.approval_id ? this.records.get('approval', node.approval_id) : null; if (approval?.data.status === 'pending') this.records.put('approval', approval.agentId, { ...approval.data, status: 'expired', reason }, approval.id); }
  recover(): void {
    for (const run of this.store.db.query<RunRow, []>("SELECT * FROM workflow_runs WHERE status IN ('running','waiting')").all()) this.store.atomic(() => {
      for (const node of this.nodes(run.id)) if (['running', 'waiting'].includes(node.status)) { this.expireApproval(node, 'Execution stopped.'); this.saveNode({ ...node, status: 'interrupted', error: 'Execution stopped; inspect effects before resuming.', ended_at: at() }); }
      this.saveRun({ ...run, status: 'interrupted', error: 'KRU restarted. Inspect effects before resuming.', ended_at: at() });
    });
  }
  private fail(run: RunRow, node: NodeRow, error: unknown) {
    this.store.atomic(() => { if (!open(this.runRow(run.id).status)) return; const message = storedError(error instanceof Error ? error.message : String(error)) ?? 'Workflow step failed'; this.expireApproval(node, message); this.saveNode({ ...node, status: 'failed', error: message, ended_at: at() }); this.saveRun({ ...run, status: 'failed', error: `${node.node_id}: ${message}`, ended_at: at() }); });
  }
  private complete(node: NodeRow, output: unknown) { this.saveNode({ ...node, status: 'completed', output_json: jsonData(output), error: null, ended_at: at() }); }
  private executeConnector(run: RunRow, step: NodeRow, node: Node) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        this.guard();
        const binding = this.integrations.entry(String(node.config.connectorId), run.agent_id);
        if (JSON.stringify(binding.data) !== step.binding_json) throw new Error('Connector changed after this step was prepared. Resume to request a fresh connection grant.');
        const result = await this.integrations.call(binding.id, run.agent_id, String(node.config.tool), JSON.parse(step.input_json).arguments, controller.signal);
        if (result.isError) throw new Error('App tool returned an error: ' + JSON.stringify(result.content).slice(0, 2000));
        let data: unknown = result.structuredContent;
        if (data === undefined) { const text = Array.isArray(result.content) ? result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n') : ''; try { data = JSON.parse(text); } catch { data = text; } }
        this.store.atomic(() => { if (open(this.runRow(run.id).status) && !controller.signal.aborted) this.complete(step, { ...result, data }); });
      } catch (error) { if (!controller.signal.aborted) this.fail(run, step, error); }
      finally { this.live.delete(run.id); }
    });
    void promise.catch(() => {}); // Ownership loss is handled by daemon recovery; retain the uncertain step.
    this.live.set(run.id, { controller, promise });
  }
  private advance(id: string) {
    for (let pass = 0; pass < 65; pass++) {
      const run = this.runRow(id); if (!open(run.status) || this.live.has(id)) return;
      const graph = JSON.parse(run.graph_json) as Graph, states = this.nodes(id);
      const active = states.find(node => node.status === 'running' || node.status === 'waiting');
      if (active) {
        const node = graph.nodes.find(node => node.id === active.node_id)!;
        try {
          if (active.task_id) {
            const task = this.records.require('task', active.task_id); if (this.activeTask(task.id)) return;
            if (task.data.status !== 'completed' || task.data.deliveryIds.some(id => this.mailbox.get(id)?.status !== 'completed')) throw new Error(task.data.error || 'Bot step ended without confirmed completion');
            this.store.atomic(() => this.complete(active, { result: task.data.result, steps: task.data.steps })); continue;
          }
          if (active.status === 'waiting') {
            const approval = this.records.require('approval', active.approval_id!);
            if (approval.data.status === 'pending' && Date.parse(approval.data.expiresAt) > Date.now()) return;
            if (approval.data.status !== 'accepted') throw new Error('App action was declined or its request expired');
            const started = this.store.atomic(() => { this.saveRun({ ...run, status: 'running' }); return this.saveNode({ ...active, status: 'running' }); });
            this.executeConnector(run, started, node); return;
          }
          throw new Error('Uncertain external execution. Resume explicitly after checking its effects.');
        } catch (error) { this.fail(run, active, error); return; }
      }
      const ready = states.find(step => step.status === 'pending' && (graph.nodes.find(node => node.id === step.node_id)!.type === 'trigger' || graph.edges.some(edge => edge.to === step.node_id && ['completed', 'skipped'].includes(states.find(parent => parent.node_id === edge.from)!.status))));
      if (!ready) { this.store.atomic(() => this.saveRun({ ...run, status: states.every(node => ['completed', 'skipped'].includes(node.status)) ? 'completed' : 'failed', error: states.every(node => ['completed', 'skipped'].includes(node.status)) ? null : 'No reachable next node', ended_at: at() })); return; }
      const node = graph.nodes.find(node => node.id === ready.node_id)!, edge = graph.edges.find(edge => edge.to === node.id), parent = edge ? states.find(step => step.node_id === edge.from)! : null;
      const parentOutput = parent ? JSON.parse(parent.output_json) : JSON.parse(run.input_json);
      if (parent && (parent.status === 'skipped' || (edge!.port !== 'main' && parentOutput.branch !== edge!.port))) { this.store.atomic(() => this.saveNode({ ...ready, status: 'skipped', ended_at: at() })); continue; }
      const input = parent && edge!.port !== 'main' ? parentOutput.data : parentOutput;
      const context = { input, steps: Object.fromEntries(states.filter(step => step.status === 'completed').map(step => [step.node_id, JSON.parse(step.output_json)])) };
      let prepared = { ...ready, status: 'running', input_json: jsonData(input), started_at: at() };
      try {
        if (node.type === 'trigger') this.store.atomic(() => this.complete(prepared, input));
        if (node.type === 'set') { const values = mapped(node.config.values ?? {}, context); this.store.atomic(() => this.complete(prepared, node.config.keepInput === false ? values : { ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}), ...values as object })); }
        if (node.type === 'if') {
          const left = pathValue(context, String(node.config.path)), right = mapped(node.config.value, context), operator = node.config.operator;
          if (operator === 'greater_than' && (typeof left !== 'number' || typeof right !== 'number')) throw new Error('Greater-than conditions require numbers');
          const matched = operator === 'exists' ? left !== undefined && left !== null : operator === 'contains' ? typeof left === 'string' ? left.includes(String(right)) : Array.isArray(left) && left.some(value => JSON.stringify(value) === JSON.stringify(right)) : operator === 'greater_than' ? Number(left) > Number(right) : operator === 'not_equals' ? JSON.stringify(left) !== JSON.stringify(right) : JSON.stringify(left) === JSON.stringify(right);
          this.store.atomic(() => this.complete(prepared, { branch: matched ? 'true' : 'false', data: input }));
        }
        if (node.type === 'agent') {
          const instruction = mapped(node.config.prompt, context), prompt = typeof instruction === 'string' ? instruction : jsonData(instruction), objective = prompt + '\n\nWorkflow input (data):\n' + jsonData(input);
          if (Buffer.byteLength(objective) > 11000) throw new Error('Bot input exceeds 11 KB; use an Edit data step to reduce it');
          this.store.atomic(() => { const task = this.tasks.create(typeof node.config.agentId === 'string' && node.config.agentId ? node.config.agentId : run.agent_id, { title: `${run.name} · ${node.name}`.slice(0, 160), objective, maxTurns: Number(node.config.maxTurns ?? 8) }); this.saveNode({ ...prepared, task_id: task.id }); }); return;
        }
        if (node.type === 'connector') {
          const binding = this.integrations.entry(String(node.config.connectorId), run.agent_id), args = z.record(z.string(), z.unknown()).parse(mapped(node.config.arguments ?? {}, context));
          prepared = { ...prepared, input_json: jsonData({ data: input, arguments: args }), binding_json: JSON.stringify(binding.data) };
          this.store.atomic(() => {
            if (binding.data.permission === 'ask') {
              const approval = this.records.put('approval', run.agent_id, { executionId: prepared.id, threadId: 'workflow:' + run.id, turnId: node.id, kind: 'tool', input: { connector: binding.data.name, name: node.config.tool, arguments: args, workflow: run.name }, status: 'pending', expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), reason: '' });
              prepared = { ...prepared, status: 'waiting', approval_id: approval.id }; this.saveRun({ ...run, status: 'waiting' });
            }
            this.saveNode(prepared);
          });
          if (prepared.status === 'running') this.executeConnector(run, prepared, node); return;
        }
      } catch (error) { this.fail(run, prepared, error); return; }
    }
  }
  tick(now = Date.now()) {
    this.importSkills();
    for (const definition of this.store.db.query<DefinitionRow, []>('SELECT * FROM workflow_definitions WHERE active=1 AND next_run_at IS NOT NULL').all()) if (Date.parse(definition.next_run_at!) <= now) {
      try { this.start(definition.id, {}, 'schedule:' + definition.next_run_at); }
      catch (error) {
        if (!(error instanceof Error && error.message.includes('already has an active run'))) this.store.atomic(() => this.saveRun({ id: crypto.randomUUID(), workflow_id: definition.id, agent_id: definition.agent_id, name: definition.name, graph_json: definition.graph_json, input_json: '{}', status: 'failed', error: storedError(error instanceof Error ? error.message : String(error)) ?? 'Scheduled trigger failed', started_at: at(), ended_at: at() }));
      }
      this.store.atomic(() => this.saveDefinition({ ...definition, next_run_at: new Date(now + definition.interval_minutes! * 60000).toISOString() }));
    }
    for (const run of this.store.db.query<RunRow, []>("SELECT * FROM workflow_runs WHERE status IN ('running','waiting') ORDER BY started_at,id").all()) this.advance(run.id);
  }
  async close() { for (const operation of this.live.values()) operation.controller.abort(); await Promise.allSettled([...this.live.values()].map(operation => operation.promise)); this.live.clear(); }
}
