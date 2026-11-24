import type { ApprovalCall, ApprovalResult } from '../providers/protocol';
import type { ToolContext } from '../tools/ports';
import { WorkspaceRecords, type RecordEntry } from './records';

interface Pending {
  settle: (result: ApprovalResult) => void;
  signal: AbortSignal;
  context: ToolContext;
}
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly records: WorkspaceRecords,
    readonly timeoutMs = 10 * 60_000,
  ) {}
  request(context: ToolContext, call: ApprovalCall, signal: AbortSignal): Promise<ApprovalResult> {
    if (signal.aborted) return Promise.resolve({ decision: 'decline' });
    const entry = this.records.put('approval', context.agent.id, {
      executionId: context.batch.id,
      threadId: call.threadId,
      turnId: call.turnId,
      kind: call.kind,
      input: call.input,
      status: 'pending',
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      reason: '',
    });
    return new Promise((resolve) => {
      let finished = false;
      const settle = (result: ApprovalResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(poll);
        signal.removeEventListener('abort', abort);
        this.pending.delete(entry.id);
        resolve(result);
      };
      const expire = (reason: string) => {
        try {
          this.expire(entry.id, reason);
        } finally {
          settle({ decision: 'decline' });
        }
      };
      const abort = () => expire('The provider request ended or was cancelled.');
      const timer = setTimeout(() => expire('Approval deadline elapsed.'), this.timeoutMs);
      // Separate UI/daemon processes can share the durable decision channel.
      const poll = setInterval(() => {
        try {
          const current = this.records.require('approval', entry.id);
          if (current.data.status !== 'pending')
            settle({
              decision:
                current.data.status === 'accepted' && !signal.aborted ? 'accept' : 'decline',
            });
        } catch {
          settle({ decision: 'decline' });
        }
      }, 100);
      this.pending.set(entry.id, { settle, signal, context });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  decide(id: string, decision: 'accept' | 'decline'): RecordEntry<'approval'> {
    return this.records.store.atomic(() => {
      const entry = this.records.require('approval', id);
      const active = this.records.store.db
        .query('SELECT 1 FROM active_lanes WHERE batch_id=? AND turn_id=?')
        .get(entry.data.executionId, entry.data.turnId);
      const workflow = this.records.store.db
        .query(
          "SELECT 1 FROM workflow_node_runs n JOIN workflow_runs r ON r.id=n.run_id WHERE n.id=? AND n.node_id=? AND n.approval_id=? AND n.status='waiting' AND r.status='waiting' AND r.agent_id=?",
        )
        .get(entry.data.executionId, entry.data.turnId, id, entry.agentId);
      if (
        entry.data.status !== 'pending' ||
        Date.parse(entry.data.expiresAt) <= Date.now() ||
        (!active && !workflow)
      )
        throw new Error('Approval is no longer active');
      if (this.pending.get(id)?.signal.aborted) throw new Error('Approval request was cancelled');
      return this.records.put(
        'approval',
        entry.agentId,
        {
          ...entry.data,
          status: decision === 'accept' ? 'accepted' : 'declined',
          reason: 'User decision',
        },
        id,
      );
    });
  }
  private expire(id: string, reason: string): void {
    const entry = this.records.require('approval', id);
    if (entry.data.status === 'pending')
      this.records.put('approval', entry.agentId, { ...entry.data, status: 'expired', reason }, id);
  }
  recover(): void {
    for (const entry of this.records.list('approval'))
      if (entry.data.status === 'pending')
        this.expire(entry.id, 'The previous execution ended. A new request is required.');
  }
  close(): void {
    for (const [id, pending] of this.pending) {
      try {
        this.expire(id, 'Workspace stopped.');
      } finally {
        pending.settle({ decision: 'decline' });
      }
    }
  }
}
