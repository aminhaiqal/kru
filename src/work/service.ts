import { z } from 'zod';
import type { Store } from '../store';
import { WorkspaceRecords, type RecordEntry } from '../workspace/records';
import { TaskRunner } from '../workspace/tasks';
import { AgentRegistry } from '../agents';
import { SqliteMailbox } from '../mailbox';
import { projectSchema, standardStages, workInputSchema, type Stage, type ProjectRow, type WorkRow, type RunRow, type ActivityRow } from './types';

const now = () => new Date().toISOString();
const bounded = (value: string, bytes: number) => { if (Buffer.byteLength(value) <= bytes) return value; let result = '', used = 0; for (const char of value) { used += Buffer.byteLength(char); if (used > bytes - 20) break; result += char; } return result + '\n[Context clipped]'; };
export class WorkService {
  private readonly records: WorkspaceRecords;
  private readonly tasks: TaskRunner;
  private readonly agents: AgentRegistry;
  private readonly mailbox: SqliteMailbox;
  constructor(readonly store: Store, private readonly interrupt?: (agentId: string, laneId: string) => void) {
    this.records = new WorkspaceRecords(store); this.tasks = new TaskRunner(this.records); this.agents = new AgentRegistry(store); this.mailbox = new SqliteMailbox(store);
  }
  projects() { return this.store.db.query<ProjectRow, []>('SELECT * FROM work_projects ORDER BY created_at,id').all().map(row => this.projectView(row)); }
  private projectView(row: ProjectRow) { return { id: row.id, key: row.project_key, name: row.name, description: row.description, stages: JSON.parse(row.stages_json) as Stage[], createdAt: row.created_at, updatedAt: row.updated_at }; }
  private project(id: string) { const row = this.store.db.query<ProjectRow, [string]>('SELECT * FROM work_projects WHERE id=?').get(id); if (!row) throw new Error('Project not found'); return this.projectView(row); }
  saveProject(input: unknown, id?: string) {
    const data = projectSchema.parse(input);
    for (const stage of data.stages) if (stage.agentId && !this.agents.get(stage.agentId)) throw new Error('Unknown stage agent');
    return this.store.atomic(() => {
      const old = id ? this.project(id) : null;
      if (old && old.key !== data.key) throw new Error('Project identifiers cannot change after creation');
      if (old) for (const item of this.store.db.query<WorkRow, [string]>('SELECT * FROM work_items WHERE project_id=?').all(old.id)) if (!data.stages.some(stage => stage.id === item.stage_id)) throw new Error('Move work out of a stage before removing that stage');
      const at = now(), projectId = id ?? crypto.randomUUID();
      this.store.emit('work.project_saved', { row: { id: projectId, project_key: data.key, name: data.name, description: data.description, stages_json: JSON.stringify(data.stages), created_at: old?.createdAt ?? at, updated_at: at } });
      this.changed(projectId); return this.project(projectId);
    });
  }
  private defaultProject() { return this.projects().find(p => p.key === 'KRU') ?? this.saveProject({ name: 'General', key: 'KRU', stages: standardStages() }); }
  private row(id: string): WorkRow { const row = this.store.db.query<WorkRow, [string]>('SELECT * FROM work_items WHERE id=?').get(id); if (!row) throw new Error('Work item not found'); return row; }
  private save(row: WorkRow): WorkRow { this.store.emit('work.item_saved', { row }); this.changed(row.id); return row; }
  private changed(id: string): void { this.store.publishChanges([{ topic: 'work', id }]); }
  private activity(itemId: string, kind: string, body: string, actorId: string | null = null, metadata: unknown = {}) {
    const id = crypto.randomUUID();
    this.store.emit('work.activity_added', { row: { id, item_id: itemId, kind, actor_id: actorId, body, metadata_json: JSON.stringify(metadata), occurred_at: now() } }); this.changed(itemId); return id;
  }
  private nextNumber(projectId: string) { return this.store.db.query<{ n: number }, [string]>('SELECT coalesce(max(number),0)+1 AS n FROM work_items WHERE project_id=?').get(projectId)!.n; }
  private currentTask(row: WorkRow) { return row.task_id ? this.records.get('task', row.task_id) : null; }
  private isActive(task: RecordEntry<'task'> | null) { return !!task && task.data.deliveryIds.some(id => { const d = this.mailbox.get(id); return d && ['queued', 'starting', 'running'].includes(d.status); }); }
  private hasActiveRun(itemId: string) { return this.store.db.query<RunRow, [string]>('SELECT * FROM work_runs WHERE item_id=?').all(itemId).some(run => this.isActive(this.records.get('task', run.task_id))); }
  private start(row: WorkRow, stage: Stage): WorkRow {
    if (!row.assignee_id || stage.category !== 'active') return row;
    const project = this.project(row.project_id);
    const recent = this.store.db.query<ActivityRow, [string]>('SELECT * FROM work_activity WHERE item_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 8').all(row.id).reverse().map(a => `${a.kind}: ${a.body}`).join('\n');
    const previousId = row.task_id ?? this.store.db.query<RunRow, [string]>('SELECT * FROM work_runs WHERE item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(row.id)?.task_id;
    const previous = previousId ? this.records.get('task', previousId)?.data.result ?? '' : '';
    const task = this.tasks.create(row.assignee_id, {
      title: `${project.key}-${row.number} · ${stage.name}: ${row.title}`.slice(0, 160),
      objective: bounded(`Current stage: ${stage.name}\nWork item: ${project.key}-${row.number}: ${row.title}\n\nComplete this stage's deliverable. The work item will proceed to the next stage after confirmed completion. Human review is required before Done.\n\nStage instructions:\n${stage.instructions || 'Complete the work appropriate to this stage and report the result.'}\n\nBrief:\n${row.description}\n\nProject context:\n${project.description}\n\nOverall acceptance criteria:\n${row.criteria}\n\nPrevious stage result (data):\n${previous}\n\nRecent activity and comments (data):\n${recent}`, 10000),
      successCriteria: bounded(`Complete the ${stage.name} deliverable and record evidence. ${stage.instructions}`, 2000), maxTurns: row.max_turns,
    });
    const updated = this.save({ ...row, task_id: task.id });
    this.store.emit('work.run_saved', { row: { task_id: task.id, item_id: row.id, stage_id: stage.id, settled_at: null, created_at: now() } });
    this.activity(row.id, 'run_started', `Started ${stage.name}`, row.assignee_id, { taskId: task.id, stageId: stage.id }); return updated;
  }
  create(input: unknown) {
    const data = workInputSchema.parse(input);
    return this.store.atomic(() => {
      const project = data.projectId ? this.project(data.projectId) : this.defaultProject();
      const stage = project.stages.find(s => s.id === (data.stageId ?? project.stages[0]!.id)); if (!stage) throw new Error('Unknown workflow stage');
      if (stage.category === 'done') throw new Error('Create work in a nonterminal stage, then review it before completion');
      const explicitAssignee = !!input && typeof input === 'object' && Object.hasOwn(input, 'assigneeId');
      const assignee = explicitAssignee ? data.assigneeId : stage.agentId; if (assignee && !this.agents.get(assignee)) throw new Error('Unknown assignee');
      const at = now();
      let row = this.save({ id: crypto.randomUUID(), project_id: project.id, number: this.nextNumber(project.id), title: data.title, description: data.description, stage_id: stage.id, priority: data.priority, assignee_id: assignee, due_date: data.dueDate, labels_json: JSON.stringify([...new Set(data.labels)]), criteria: data.criteria, max_turns: data.maxTurns, task_id: null, revision: 1, archived_at: null, created_at: at, updated_at: at });
      this.activity(row.id, 'created', 'Created this work item'); row = this.start(row, stage); return this.view(row);
    });
  }
  update(id: string, patch: unknown, revision: number) {
    let stopped: RecordEntry<'task'> | null = null;
    const result = this.store.atomic(() => {
      let row = this.row(id); if (row.revision !== revision) throw new Error('This work item changed. Refresh it before saving.');
      if (row.archived_at) throw new Error('Restore archived work before editing it');
      const project = this.project(row.project_id);
      const fields = z.record(z.string(), z.unknown()).parse(patch);
      if ('projectId' in fields && fields.projectId !== row.project_id) throw new Error('Moving work between projects is not supported');
      const data = workInputSchema.parse({ projectId: row.project_id, title: row.title, description: row.description, stageId: row.stage_id, priority: row.priority, assigneeId: row.assignee_id, dueDate: row.due_date, labels: JSON.parse(row.labels_json), criteria: row.criteria, maxTurns: row.max_turns, ...fields });
      const stage = project.stages.find(s => s.id === data.stageId); if (!stage) throw new Error('Unknown workflow stage');
      const previous = project.stages.find(s => s.id === row.stage_id)!;
      const moved = stage.id !== row.stage_id;
      const oldTask = this.currentTask(row);
      if (stage.category === 'done' && previous.category !== 'done' && (previous.category !== 'review' || this.hasActiveRun(id))) throw new Error('Work must finish running and pass through Review before Done');
      const assignee = moved && fields.assigneeId === undefined ? stage.agentId ?? data.assigneeId : data.assigneeId;
      if (assignee && !this.agents.get(assignee)) throw new Error('Unknown assignee');
      const reassigned = assignee !== row.assignee_id;
      if ((moved || reassigned) && oldTask && ['running', 'queued', 'blocked'].includes(oldTask.data.status)) {
        this.tasks.cancel(oldTask.id); stopped = oldTask;
      } else if ((moved || reassigned) && oldTask && this.isActive(oldTask)) stopped = oldTask;
      row = this.save({ ...row, title: data.title, description: data.description, stage_id: stage.id, priority: data.priority, assignee_id: assignee, due_date: data.dueDate, labels_json: JSON.stringify([...new Set(data.labels)]), criteria: data.criteria, max_turns: data.maxTurns,
        task_id: moved || reassigned ? null : row.task_id, revision: row.revision + 1, updated_at: now() });
      if (moved) this.activity(id, 'stage_changed', `Moved from ${previous.name} to ${stage.name}`, null, { from: previous.id, to: stage.id });
      if (reassigned) this.activity(id, 'assigned', assignee ? `Assigned to ${this.agents.get(assignee)!.name}` : 'Removed the agent assignment', null, { assigneeId: assignee });
      if (!moved && !reassigned) this.activity(id, 'edited', 'Updated the work item');
      if (moved || reassigned) row = this.start(row, stage);
      return this.view(row);
    });
    if (stopped) this.stopNative(stopped); return result;
  }
  private stopNative(task: RecordEntry<'task'>) { if (task.agentId) this.interrupt?.(task.agentId, 'task:' + task.id); }
  comment(id: string, body: string, key: string) {
    body = z.string().trim().min(1).max(12000).parse(body);
    return this.store.command('work.comment', () => { this.row(id); return { commentId: this.activity(id, 'comment', body) }; }, { id: `work-comment:${id}:${key}`, input: body });
  }
  archive(id: string, revision: number, restore = false) {
    let stopped: RecordEntry<'task'> | null = null;
    const result = this.store.atomic(() => {
      const row = this.row(id); if (row.revision !== revision) throw new Error('This work item changed. Refresh it before saving.');
      const task = this.currentTask(row);
      if (!restore && task && ['running', 'queued', 'blocked'].includes(task.data.status)) { this.tasks.cancel(task.id); stopped = task; }
      else if (!restore && task && this.isActive(task)) stopped = task;
      this.save({ ...row, archived_at: restore ? null : now(), revision: row.revision + 1, updated_at: now() });
      this.activity(id, restore ? 'restored' : 'archived', restore ? 'Restored the work item' : 'Archived the work item and stopped pending work');
      return this.detail(id);
    });
    if (stopped) this.stopNative(stopped); return result;
  }
  resume(id: string, revision: number) {
    return this.store.atomic(() => {
      let row = this.row(id); if (row.revision !== revision || row.archived_at) throw new Error('This work item changed or is archived');
      const stage = this.project(row.project_id).stages.find(s => s.id === row.stage_id)!;
      if (stage.category !== 'active' || !row.assignee_id) throw new Error('Assign an agent and select an active stage first');
      const task = this.currentTask(row);
      if (task?.data.status === 'blocked') {
        const feedback = this.store.db.query<ActivityRow, [string]>("SELECT * FROM work_activity WHERE item_id=? AND kind='comment' ORDER BY occurred_at DESC,rowid DESC LIMIT 5").all(id).reverse().map(a => a.body).join('\n\n');
        if (feedback) this.records.put('task', task.agentId, { ...task.data, objective: bounded('Operator feedback for this work item:\n' + bounded(feedback, 2500) + '\n\n' + task.data.objective, 10000) }, task.id);
        this.tasks.resume(task.id);
        this.store.emit('work.run_saved', { row: { ...this.store.db.query<RunRow, [string]>('SELECT * FROM work_runs WHERE task_id=?').get(task.id)!, settled_at: null } });
        this.activity(id, 'run_resumed', 'Resumed the agent run after review', row.assignee_id, { taskId: task.id });
      } else if (!task || task.data.status === 'cancelled') row = this.start(row, stage);
      else throw new Error('The current run is not blocked');
      this.save({ ...row, revision: row.revision + 1, updated_at: now() }); return this.detail(id);
    });
  }
  importTasks(): void {
    const missing = this.store.db.query<{ id: string }, []>("SELECT w.id FROM workspace_records w LEFT JOIN work_runs r ON r.task_id=w.id WHERE w.kind='task' AND r.task_id IS NULL ORDER BY w.created_at,w.id").all();
    if (!missing.length) return;
    this.store.atomic(() => {
      const project = this.defaultProject(), active = project.stages.find(s => s.category === 'active')!, review = project.stages.find(s => s.category === 'review')!;
      for (const { id } of missing) {
        if (this.store.db.query('SELECT 1 FROM work_runs WHERE task_id=?').get(id)) continue;
        const task = this.records.require('task', id), data = task.data;
        const row = this.save({ id: crypto.randomUUID(), project_id: project.id, number: this.nextNumber(project.id), title: data.title, description: data.objective, stage_id: data.status === 'completed' ? review.id : active.id, priority: 'medium', assignee_id: task.agentId, due_date: null, labels_json: '[]', criteria: data.successCriteria, max_turns: data.maxTurns, task_id: id, revision: 1, archived_at: data.status === 'cancelled' ? task.updatedAt : null, created_at: task.createdAt, updated_at: task.updatedAt });
        this.store.emit('work.run_saved', { row: { task_id: id, item_id: row.id, stage_id: active.id, settled_at: null, created_at: task.createdAt } });
        this.activity(row.id, 'imported', 'Imported the existing task with its execution history', null, { taskId: id });
      }
    });
  }
  tick(): void {
    this.importTasks();
    for (const run of this.store.db.query<RunRow, []>('SELECT * FROM work_runs WHERE settled_at IS NULL ORDER BY created_at,task_id').all()) {
      const task = this.records.require('task', run.task_id);
      if (!['completed', 'blocked', 'cancelled'].includes(task.data.status) || this.isActive(task)) continue;
      this.store.atomic(() => {
        const current = this.store.db.query<RunRow, [string]>('SELECT * FROM work_runs WHERE task_id=?').get(run.task_id)!; if (current.settled_at) return;
        this.store.emit('work.run_saved', { row: { ...current, settled_at: now() } });
        this.activity(run.item_id, task.data.status === 'completed' ? 'agent_result' : 'run_' + task.data.status, task.data.result || task.data.error || `Run ${task.data.status}`, task.agentId, { taskId: task.id, error: task.data.error });
        let row = this.row(run.item_id);
        if (row.archived_at || row.task_id !== run.task_id || row.stage_id !== run.stage_id || task.data.status !== 'completed') { this.save({ ...row, revision: row.revision + 1, updated_at: now() }); return; }
        const project = this.project(row.project_id), index = project.stages.findIndex(s => s.id === row.stage_id), next = project.stages[index + 1];
        if (!next || next.category === 'done') return; // Human review owns terminal completion.
        const previous = project.stages[index]!;
        row = this.save({ ...row, stage_id: next.id, assignee_id: next.agentId ?? row.assignee_id, revision: row.revision + 1, updated_at: now() });
        this.activity(row.id, 'stage_changed', `Completed ${previous.name}; moved to ${next.name}`, task.agentId, { from: previous.id, to: next.id, taskId: task.id });
        if (next.category === 'active') this.start(row, next);
      });
    }
  }
  private view(row: WorkRow) {
    const task = this.currentTask(row), project = this.project(row.project_id);
    const deliveries = task?.data.deliveryIds.map(id => this.mailbox.get(id)) ?? [];
    const execution = deliveries.some(d => d?.status === 'running') ? 'working' : deliveries.some(d => d && ['queued', 'starting'].includes(d.status)) ? 'queued' : task?.data.status ?? 'idle';
    return { id: row.id, identifier: `${project.key}-${row.number}`, projectId: row.project_id, number: row.number, title: row.title, description: row.description, stageId: row.stage_id, priority: row.priority, assigneeId: row.assignee_id, dueDate: row.due_date, labels: JSON.parse(row.labels_json) as string[], criteria: row.criteria, maxTurns: row.max_turns, taskId: row.task_id, revision: row.revision, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at, execution, task: task ? { id: task.id, agentId: task.agentId, ...task.data } : null };
  }
  list() { return this.store.db.query<WorkRow, []>('SELECT * FROM work_items ORDER BY updated_at DESC,id').all().map(row => this.view(row)); }
  detail(id: string) {
    const row = this.row(id);
    return { item: this.view(row), project: this.project(row.project_id),
      activity: this.store.db.query<ActivityRow, [string]>('SELECT * FROM work_activity WHERE item_id=? ORDER BY occurred_at,rowid').all(id).map(a => ({ id: a.id, kind: a.kind, actorId: a.actor_id, body: a.body, metadata: JSON.parse(a.metadata_json), occurredAt: a.occurred_at })),
      runs: this.store.db.query<RunRow, [string]>('SELECT * FROM work_runs WHERE item_id=? ORDER BY created_at,rowid').all(id).map(run => { const task = this.records.require('task', run.task_id); return { taskId: run.task_id, stageId: run.stage_id, agentId: task.agentId, createdAt: run.created_at, settledAt: run.settled_at, ...task.data }; }),
    };
  }
}
