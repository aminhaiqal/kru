import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store';
import { ThreadStore } from '../threads/store';
import { nextSequence } from '../store/events';
import type { DeliveryRow } from '../store/event-types';
import { storedError } from '../store/errors';
import { allowedTransitions, DeliveryTransitionError, IdempotencyConflictError } from './state';
import type { Delivery, DeliveryStatus, EnqueueInput, EnqueueReceipt, FinalStatus, Mailbox, MailboxChange, Sender, Batch, LaneHead, ActiveLane } from './types';

interface Row {
  batch_id: string | null; seq: number; id: string; message_id: string; recipient_id: string; lane_id: string | null;
  status: DeliveryStatus; turn_id: string | null; error: string | null; retry_of: string | null;
  chain_id: string; hop: number; updated_at: string; sender_kind: Sender['kind'];
  sender_agent_id: string | null; sender_routine_id: string | null; text: string;
  reply_to: string | null; expects_reply: number; idempotency_key: string | null; created_at: string;
}
const select = `SELECT d.*, m.sender_kind, m.sender_agent_id, m.sender_routine_id, m.text,
  m.reply_to, m.expects_reply, m.idempotency_key, m.created_at FROM deliveries d JOIN messages m ON m.id = d.message_id`;
const decode = (r: Row): Delivery => ({
  seq: r.seq, id: r.id, messageId: r.message_id, recipientAgentId: r.recipient_id, laneId: r.lane_id,
  sender: r.sender_kind === 'agent' ? { kind: 'agent', agentId: r.sender_agent_id! }
    : r.sender_kind === 'routine' ? { kind: 'routine', routineId: r.sender_routine_id! } : { kind: 'user' },
  text: r.text, replyToMessageId: r.reply_to, expectsReply: Boolean(r.expects_reply), status: r.status,
  batchId: r.batch_id, turnId: r.turn_id, error: r.error, retryOf: r.retry_of, chainId: r.chain_id, hop: r.hop,
  idempotencyKey: r.idempotency_key, createdAt: r.created_at, updatedAt: r.updated_at,
});
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
}

export class SqliteMailbox implements Mailbox {
  constructor(private readonly store: Store, private readonly options: { now?: () => number } = {}) {}
  private cutoff(): string { return new Date((this.options.now ?? Date.now)() - 30 * 86400_000).toISOString(); }
  private expireKey(id: string, createdAt: string): boolean {
    if (createdAt > this.cutoff() || this.store.db.query("SELECT 1 FROM deliveries WHERE message_id=? AND status IN ('queued','starting','running') LIMIT 1").get(id)) return false;
    this.store.emit('message.key_expired', { messageId: id }); return true;
  }
  pruneIdempotencyKeys(limit = 100): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid key maintenance limit');
    const select = () => this.store.db.query<{ id: string; created_at: string }, [string, number]>(`SELECT id, created_at FROM messages
      WHERE idempotency_key IS NOT NULL AND created_at<=? AND NOT EXISTS
      (SELECT 1 FROM deliveries WHERE message_id=messages.id AND status IN ('queued','starting','running')) ORDER BY created_at,id LIMIT ?`).all(this.cutoff(), limit);
    if (!select().length) return 0;
    return this.store.command('mailbox.expireKeys', () => {
      const rows = select(); for (const row of rows) this.expireKey(row.id, row.created_at); return rows.length;
    });
  }

  enqueue(input: EnqueueInput): EnqueueReceipt {
    const sender = input.sender;
    if (!sender || !['user', 'agent', 'routine'].includes(sender.kind)) throw new Error('Invalid sender');
    if (sender.kind === 'agent') nonempty(sender.agentId, 'Sender agent id');
    if (sender.kind === 'routine') nonempty(sender.routineId, 'Sender routine id');
    if (!Array.isArray(input.recipientIds) || !input.recipientIds.length) throw new Error('At least one recipient is required');
    for (const id of input.recipientIds) nonempty(id, 'Recipient id');
    if (new Set(input.recipientIds).size !== input.recipientIds.length) throw new Error('Duplicate recipients are not allowed');
    nonempty(input.text, 'Message text');
    if (Buffer.byteLength(input.text) > 1024 * 1024) throw new Error('Mailbox text exceeds the 1 MiB storage input limit');
    if (input.laneId != null) nonempty(input.laneId, 'Lane id');
    if (input.replyTo != null) nonempty(input.replyTo, 'Reply message id');
    if (input.idempotencyKey !== undefined) nonempty(input.idempotencyKey, 'Idempotency key');
    if (input.expectsReply !== undefined && typeof input.expectsReply !== 'boolean') throw new Error('Invalid expectsReply');
    if (input.chain) {
      nonempty(input.chain.id, 'Chain id');
      if (!Number.isSafeInteger(input.chain.hop) || input.chain.hop < 0) throw new Error('Invalid chain hop');
    }
    // Recipient order has no meaning; defaults and sender field order normalize too.
    const recipients = [...input.recipientIds].sort();
    const canonicalSender: Sender = sender.kind === 'agent' ? { kind: 'agent', agentId: sender.agentId }
      : sender.kind === 'routine' ? { kind: 'routine', routineId: sender.routineId } : { kind: 'user' };
    const hash = createHash('sha256').update(JSON.stringify({
      sender: canonicalSender, recipientIds: recipients, text: input.text, laneId: input.laneId ?? null,
      replyTo: input.replyTo ?? null, expectsReply: input.expectsReply ?? false,
      chain: input.chain ? { id: input.chain.id, hop: input.chain.hop } : null,
    })).digest('hex');
    const receipt = this.store.command('mailbox.enqueue', () => {
      if (input.idempotencyKey !== undefined) {
        const existing = this.store.db.query<{ id: string; request_hash: string; created_at: string }, [string]>(
          'SELECT id, request_hash, created_at FROM messages WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing && !this.expireKey(existing.id, existing.created_at)) {
          if (existing.request_hash !== hash) throw new IdempotencyConflictError();
          return { messageId: existing.id, deliveryIds: this.store.db.query<{ id: string }, [string]>(
            'SELECT id FROM deliveries WHERE message_id = ? AND retry_of IS NULL ORDER BY seq').all(existing.id).map(r => r.id), duplicate: true };
        }
      }
      for (const id of recipients) this.requireAgent(id);
      if (sender.kind === 'agent') this.requireAgent(sender.agentId);
      const messageId = randomUUID();
      const now = new Date((this.options.now ?? Date.now)()).toISOString();
      const chainId = input.chain?.id ?? randomUUID();
      const seq = nextSequence(this.store.db, 'deliveries');
      const deliveries = recipients.map((recipient, index): DeliveryRow => ({ seq: seq + index, id: randomUUID(),
        message_id: messageId, recipient_id: recipient, lane_id: input.laneId ?? null, status: 'queued',
        chain_id: chainId, hop: input.chain?.hop ?? 0, updated_at: now, turn_id: null, batch_id: null, error: null, retry_of: null }));
      this.store.emit('message.enqueued', { row: {
        id: messageId, sender_kind: sender.kind, sender_agent_id: sender.kind === 'agent' ? sender.agentId : null,
        sender_routine_id: sender.kind === 'routine' ? sender.routineId : null, text: input.text, reply_to: input.replyTo ?? null,
        expects_reply: Number(input.expectsReply ?? false), idempotency_key: input.idempotencyKey ?? null,
        request_hash: input.idempotencyKey === undefined ? null : hash, created_at: now,
      }, deliveries });
      for(const recipient of recipients){
        const thread=new ThreadStore(this.store).ensure(recipient,input.laneId??null);
        this.store.emit('message.thread_linked',{row:{message_id:messageId,thread_id:thread.id}});
      }
      const deliveryIds = deliveries.map(row => row.id);
      return { messageId, deliveryIds, duplicate: false };
    });
    if (!receipt.duplicate) this.publish(receipt.deliveryIds.map(deliveryId => ({ deliveryId, status: 'queued' })));
    return receipt;
  }

  claimNext(agentId: string, laneId: string | null): Delivery | null {
    const delivery = this.store.command('mailbox.claim', () => {
      this.requireAgent(agentId);
      if (this.store.db.query('SELECT 1 FROM active_lanes WHERE agent_id = ? AND lane_key = ?').get(agentId, laneId ?? '')) return null;
      const row = this.store.db.query<Row, [string, string | null]>(`${select}
        WHERE d.recipient_id = ? AND d.lane_id IS ? AND d.status = 'queued' ORDER BY d.seq LIMIT 1`).get(agentId, laneId);
      if (!row) return null;
      this.transition(row.id, 'queued', 'starting');
      return this.get(row.id)!;
    });
    if (delivery) this.publish([{ deliveryId: delivery.id, status: 'starting' }]);
    return delivery;
  }

  claimBatch(agentId: string, laneId: string | null): Batch | null {
    const batch = this.store.command('mailbox.claimBatch', () => {
      this.requireAgent(agentId);
      if (this.laneBusy(agentId, laneId)) return null;
      const rows = this.store.db.query<Row, [string, string | null]>(`${select}
        WHERE d.recipient_id = ? AND d.lane_id IS ? AND d.status = 'queued' ORDER BY d.seq LIMIT 10`).all(agentId, laneId);
      if (!rows.length) return null;
      const selected: Row[] = [];
      let bytes = 0;
      for (const row of rows) {
        if (selected.length && (rows[0]!.sender_kind !== 'user' || row.sender_kind !== 'user')) break;
        const size = Buffer.byteLength(row.text) + (selected.length ? Buffer.byteLength('\n\n--- Kru message ---\n\n') : 0);
        if (selected.length && bytes + size > 32 * 1024) break;
        // Reserve an oversized head alone so the runner can reject it without blocking the queue.
        selected.push(row); bytes += size;
        if (bytes >= 32 * 1024) break;
      }
      const id = randomUUID();
      this.store.db.query('INSERT INTO active_lanes (agent_id, lane_key, batch_id, started_at) VALUES (?, ?, ?, ?)')
        .run(agentId, laneId ?? '', id, new Date().toISOString());
      for (const row of selected) {
        this.transition(row.id, 'queued', 'starting', undefined, undefined, id);
      }
      return { id, agentId, laneId, deliveries: selected.map(row => this.get(row.id)!) };
    });
    if (batch) this.publish(batch.deliveries.map(d => ({ deliveryId: d.id, status: 'starting' })));
    return batch;
  }

  markBatchRunning(batchId: string, turnId: string): void {
    nonempty(turnId, 'Turn id');
    this.changeBatch(batchId, 'running', undefined, turnId);
  }
  finishBatch(batchId: string, status: Exclude<FinalStatus, 'cancelled'>, error?: string): void {
    if (!['completed', 'failed', 'interrupted'].includes(status)) throw new Error('Invalid finish status');
    this.changeBatch(batchId, status, error);
  }
  restoreBatch(batchId: string): void { this.changeBatch(batchId, 'queued'); }

  laneBusy(agentId: string, laneId: string | null): boolean {
    return Boolean(this.store.db.query('SELECT 1 FROM active_lanes WHERE agent_id = ? AND lane_key = ?').get(agentId, laneId ?? '') ||
      this.store.db.query("SELECT 1 FROM deliveries WHERE recipient_id = ? AND lane_id IS ? AND status IN ('starting','running') LIMIT 1").get(agentId, laneId));
  }
  activeLanes(): ActiveLane[] {
    return this.store.db.query<{ agent_id: string; lane_key: string; batch_id: string; turn_id: string | null; started_at: string }, []>(
      'SELECT * FROM active_lanes ORDER BY started_at, batch_id').all().map(r => ({
        agentId: r.agent_id, laneId: r.lane_key || null, batchId: r.batch_id, turnId: r.turn_id, startedAt: r.started_at,
      }));
  }
  listLanes(): LaneHead[] {
    return this.store.db.query<{ recipient_id: string; lane_id: string | null }, []>(
      "SELECT recipient_id, lane_id FROM deliveries WHERE status IN ('queued','starting','running') GROUP BY recipient_id, lane_id").all()
      .map(r => ({ agentId: r.recipient_id, laneId: r.lane_id,
        head: this.listQueue(r.recipient_id, r.lane_id).find(d => d.status === 'queued') ?? null }));
  }
  /** Only the owner daemon calls this before any provider starts. */
  recoverInterrupted(): number {
    const ids = this.store.command('mailbox.recover', () => {
      const rows = this.store.db.query<{ id: string; status: DeliveryStatus }, []>(
        "SELECT id, status FROM deliveries WHERE status IN ('starting','running') ORDER BY seq").all();
      for (const row of rows) this.transition(row.id, row.status, 'interrupted', undefined, 'daemon restarted');
      // Preserve native bindings. Resume is attempted on the next delivery before replacing a cache.
      this.store.db.exec('DELETE FROM active_lanes');
      return rows.map(r => r.id);
    });
    this.publish(ids.map(deliveryId => ({ deliveryId, status: 'interrupted' })));
    return ids.length;
  }

  private changeBatch(batchId: string, status: DeliveryStatus, error?: string, turnId?: string): void {
    const ids = this.store.command('mailbox.changeBatch', () => {
      if (!this.store.db.query('SELECT 1 FROM active_lanes WHERE batch_id = ?').get(batchId)) throw new Error(`Unknown active batch: ${batchId}`);
      const rows = this.store.db.query<{ id: string; status: DeliveryStatus }, [string]>(
        "SELECT id, status FROM deliveries WHERE batch_id = ? AND status IN ('starting','running') ORDER BY seq").all(batchId);
      if (!rows.length) throw new Error('Active batch has no deliveries');
      for (const row of rows) this.transition(row.id, row.status, status, turnId, error, status === 'queued' ? null : undefined);
      if (status === 'running') this.store.db.query('UPDATE active_lanes SET turn_id = ? WHERE batch_id = ?').run(turnId!, batchId);
      else {
        this.store.db.query('DELETE FROM active_lanes WHERE batch_id = ?').run(batchId);
      }
      return rows.map(r => r.id);
    });
    this.publish(ids.map(deliveryId => ({ deliveryId, status })));
  }

  markRunning(deliveryId: string, turnId: string): void {
    nonempty(turnId, 'Turn id');
    this.change(deliveryId, 'running', ['starting'], turnId);
  }
  finish(deliveryId: string, status: Exclude<FinalStatus, 'cancelled'>, error?: string): void {
    if (!['completed', 'failed', 'interrupted'].includes(status)) throw new Error('Invalid finish status');
    if (error !== undefined && typeof error !== 'string') throw new Error('Invalid delivery error');
    this.change(deliveryId, status, status === 'completed' ? ['running'] : ['starting', 'running'], undefined, error);
  }
  restore(deliveryId: string): void { this.change(deliveryId, 'queued', ['starting']); }
  cancel(deliveryId: string): void { this.change(deliveryId, 'cancelled', ['queued']); }

  retry(deliveryId: string): EnqueueReceipt {
    const receipt = this.store.command('mailbox.retry', () => {
      const old = this.get(deliveryId);
      if (!old) throw new Error(`Unknown delivery: ${deliveryId}`);
      if (allowedTransitions[old.status].length) throw new Error('Only a final delivery can be retried');
      const id = randomUUID();
      this.store.emit('delivery.retried', { row: { seq: nextSequence(this.store.db, 'deliveries'), id, message_id: old.messageId,
        recipient_id: old.recipientAgentId, lane_id: old.laneId, status: 'queued', retry_of: old.id,
        chain_id: old.chainId, hop: old.hop, updated_at: new Date().toISOString(), turn_id: null, batch_id: null, error: null } });
      return { messageId: old.messageId, deliveryIds: [id], duplicate: false };
    });
    this.publish(receipt.deliveryIds.map(id => ({ deliveryId: id, status: 'queued' })));
    return receipt;
  }

  get(deliveryId: string): Delivery | null {
    const row = this.store.db.query<Row, [string]>(`${select} WHERE d.id = ?`).get(deliveryId);
    return row ? decode(row) : null;
  }
  /** Omitted lane lists all open work; null selects the main lane only. */
  listQueue(agentId: string, laneId?: string | null): Delivery[] {
    this.requireAgent(agentId);
    const sql = `${select} WHERE d.recipient_id = ? AND d.status IN ('queued','starting','running')`;
    const rows = laneId === undefined
      ? this.store.db.query<Row, [string]>(`${sql} ORDER BY d.seq`).all(agentId)
      : this.store.db.query<Row, [string, string | null]>(`${sql} AND d.lane_id IS ? ORDER BY d.seq`).all(agentId, laneId);
    return rows.map(decode);
  }
  onChange(listener: (change: MailboxChange) => void): () => void {
    return this.store.onChange(change => {
      if (change.topic === 'mailbox') listener({ deliveryId: change.id, status: change.value as DeliveryStatus });
    });
  }

  private requireAgent(id: string): void {
    if (!this.store.db.query('SELECT id FROM agents WHERE id = ?').get(id)) throw new Error(`Unknown agent: ${id}`);
  }
  private change(id: string, status: DeliveryStatus, from: DeliveryStatus[], turnId?: string, error?: string): void {
    this.store.command('mailbox.change', () => {
      const row = this.get(id);
      if (!row) throw new Error(`Unknown delivery: ${id}`);
      if (row.batchId) throw new Error('Use batch operations for a batched delivery');
      if (!from.includes(row.status)) throw new DeliveryTransitionError(id, row.status, status);
      this.transition(id, row.status, status, turnId, error);
    });
    this.publish([{ deliveryId: id, status }]);
  }
  private transition(id: string, from: DeliveryStatus, to: DeliveryStatus, turnId?: string, error?: string, batchId?: string | null): void {
    if (!allowedTransitions[from].includes(to)) throw new DeliveryTransitionError(id, from, to);
    const row = this.store.db.query<DeliveryRow, [string]>('SELECT * FROM deliveries WHERE id = ?').get(id);
    if (!row || row.status !== from) throw new Error(`Delivery ${id} changed concurrently`);
    const type = to === 'starting' ? 'delivery.claimed' : to === 'running' ? 'delivery.running'
      : to === 'queued' ? 'delivery.restored' : to === 'cancelled' ? 'delivery.cancelled' : 'delivery.finished';
    this.store.emit(type, { row: { ...row, status: to, turn_id: to === 'queued' ? null : turnId ?? row.turn_id,
      batch_id: batchId === undefined ? row.batch_id : batchId, error: storedError(error) ?? null, updated_at: new Date().toISOString() } });
  }
  private publish(changes: MailboxChange[]): void {
    this.store.publishChanges(changes.map(change => ({ topic: 'mailbox', id: change.deliveryId, value: change.status })));
  }
}
