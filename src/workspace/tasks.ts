import type { ToolContext } from '../tools/ports';
import { SqliteMailbox } from '../mailbox';
import { WorkspaceRecords, taskSchema, type RecordEntry } from './records';
import { z } from 'zod';

export class TaskRunner {
  constructor(
    private readonly records: WorkspaceRecords,
    private readonly mailbox = new SqliteMailbox(records.store),
  ) {}
  /** Delivery state is authoritative while a task's native execution is still settling. */
  execution(task: RecordEntry<'task'> | null) {
    const deliveries = task?.data.deliveryIds.map((id) => this.mailbox.get(id)) ?? [];
    const running = deliveries.some((delivery) => delivery?.status === 'running');
    const queued = deliveries.some(
      (delivery) => delivery && ['queued', 'starting'].includes(delivery.status),
    );
    return {
      active: running || queued,
      confirmed: deliveries.every((delivery) => delivery?.status === 'completed'),
      state: running ? 'working' : queued ? 'queued' : (task?.data.status ?? 'idle'),
    };
  }
  /** Cancel pending task work inside the caller's transaction; interrupt native work after commit. */
  cancelPending(task: RecordEntry<'task'>): boolean {
    if (['running', 'queued', 'blocked'].includes(task.data.status)) {
      this.cancel(task.id);
      return true;
    }
    return this.execution(task).active;
  }
  create(agentId: string, input: unknown, id: string = crypto.randomUUID()): RecordEntry<'task'> {
    const data = taskSchema.parse(input);
    return this.records.store.atomic(() => {
      const task = this.records.put(
        'task',
        agentId,
        { ...data, status: 'queued', attempts: 0, deliveryIds: [], error: null, result: '' },
        id,
      );
      return this.enqueue(task);
    });
  }
  private enqueue(entry: RecordEntry<'task'>): RecordEntry<'task'> {
    const attempt = entry.data.attempts + 1;
    const prompt = [
      `Work on task ${entry.id}: ${entry.data.title}`,
      entry.data.objective,
      `Success criteria: ${entry.data.successCriteria || 'Complete the requested work and verify the result.'}`,
      `Progress: ${JSON.stringify(entry.data.steps)}`,
      `Previous result: ${entry.data.result || 'No previous result.'}`,
      `This is turn ${attempt} of ${entry.data.maxTurns}. Use task_update to record steps, evidence, blockers, and explicit completion. Do not mark complete until the success criteria are met. Stop and mark blocked if you need user input.`,
    ].join('\n\n');
    const receipt = this.mailbox.enqueue({
      sender: { kind: 'user' },
      recipientIds: [entry.agentId!],
      text: prompt,
      laneId: `task:${entry.id}`,
      idempotencyKey: `task:${entry.id}:${attempt}`,
    });
    return this.records.put(
      'task',
      entry.agentId,
      {
        ...entry.data,
        status: 'running',
        attempts: attempt,
        deliveryIds: receipt.deliveryIds,
        error: null,
      },
      entry.id,
    );
  }
  update(context: ToolContext, input: unknown): RecordEntry<'task'> {
    const lane = context.batch.laneId;
    if (!lane?.startsWith('task:'))
      throw new Error('task_update is only available within an assigned task');
    const task = this.records.require('task', lane.slice(5));
    if (
      task.agentId !== context.agent.id ||
      task.data.status !== 'running' ||
      !task.data.deliveryIds.some((id) => context.batch.deliveries.some((d) => d.id === id))
    )
      throw new Error('Task is not owned by this execution');
    const patch = z
      .object({
        steps: taskSchema.shape.steps.removeDefault().optional(),
        status: z.enum(['running', 'blocked', 'completed']).optional(),
        result: z.string().max(16000).optional(),
        error: z.string().max(4000).nullable().optional(),
      })
      .strict()
      .parse(input);
    const data = taskSchema.parse({ ...task.data, ...patch });
    if (
      data.status === 'completed' &&
      (!data.result.trim() || data.steps.some((step) => !step.done))
    )
      throw new Error('Completion needs a result and all steps checked');
    if (data.status === 'blocked' && !data.error?.trim() && !data.result.trim())
      throw new Error('A blocked task needs a reason in error or result');
    return this.records.put('task', task.agentId, data, task.id);
  }
  finish(
    context: ToolContext,
    answer: string,
    status: 'completed' | 'failed' | 'interrupted',
  ): void {
    if (!context.batch.laneId?.startsWith('task:')) return;
    const entry = this.records.get('task', context.batch.laneId.slice(5));
    if (!entry || entry.data.status === 'cancelled') return;
    if (status !== 'completed') {
      this.records.put(
        'task',
        entry.agentId,
        {
          ...entry.data,
          status: 'blocked',
          error: `Execution ${status}. Inspect effects before resuming.`,
          result: answer.slice(0, 16000) || entry.data.result,
        },
        entry.id,
      );
      return;
    }
    // The next tick starts continuation only after this delivery has committed and released its lane.
    if (entry.data.status === 'running')
      this.records.put(
        'task',
        entry.agentId,
        { ...entry.data, result: answer.slice(0, 16000) || entry.data.result },
        entry.id,
      );
  }
  tick(): void {
    for (const entry of this.records.list('task')) {
      if (!['running', 'queued'].includes(entry.data.status)) continue;
      const execution = this.execution(entry);
      if (execution.active) continue;
      this.records.store.atomic(() => {
        const current = this.records.require('task', entry.id);
        if (!['running', 'queued'].includes(current.data.status)) return;
        if (!execution.confirmed || current.data.attempts >= current.data.maxTurns) {
          this.records.put(
            'task',
            current.agentId,
            {
              ...current.data,
              status: 'blocked',
              error:
                current.data.attempts >= current.data.maxTurns
                  ? 'Turn limit reached. Review progress before resuming.'
                  : 'Execution ended without confirmed success. Inspect effects before resuming.',
            },
            current.id,
          );
        } else this.enqueue(current);
      });
    }
  }
  resume(id: string): RecordEntry<'task'> {
    return this.records.store.atomic(() => {
      const entry = this.records.require('task', id);
      if (entry.data.status !== 'blocked') throw new Error('Only blocked tasks can resume');
      if (entry.data.attempts >= 50)
        throw new Error(
          'This task reached the 50-turn limit. Create a new task with the remaining work.',
        );
      if (this.execution(entry).active)
        throw new Error('The previous task execution is still active');
      // User explicitly authorizes another bounded run after inspecting uncertain effects.
      return this.enqueue({
        ...entry,
        data: {
          ...entry.data,
          maxTurns: Math.min(50, Math.max(entry.data.maxTurns, entry.data.attempts + 4)),
        },
      });
    });
  }
  cancel(id: string): RecordEntry<'task'> {
    return this.records.store.atomic(() => {
      const entry = this.records.require('task', id);
      if (entry.data.status === 'completed') throw new Error('Completed tasks cannot be cancelled');
      for (const id of entry.data.deliveryIds)
        if (this.mailbox.get(id)?.status === 'queued') this.mailbox.cancel(id);
      return this.records.put('task', entry.agentId, { ...entry.data, status: 'cancelled' }, id);
    });
  }
}
