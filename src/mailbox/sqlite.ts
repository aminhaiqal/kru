import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store';
import { allowedTransitions, DeliveryTransitionError, IdempotencyConflictError } from './state';
import type { Delivery, DeliveryStatus, EnqueueInput, EnqueueReceipt, FinalStatus, Mailbox, MailboxChange, Sender } from './types';

interface Row {
  seq: number; id: string; message_id: string; recipient_id: string; lane_id: string | null;
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
  turnId: r.turn_id, error: r.error, retryOf: r.retry_of, chainId: r.chain_id, hop: r.hop,
  idempotencyKey: r.idempotency_key, createdAt: r.created_at, updatedAt: r.updated_at,
});
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
}

export class SqliteMailbox implements Mailbox {
  private readonly listeners = new Set<(change: MailboxChange) => void>();
  private readonly notifications: MailboxChange[] = [];
  private publishing = false;
  constructor(private readonly store: Store) {}

  enqueue(input: EnqueueInput): EnqueueReceipt {
    const sender = input.sender;
    if (!sender || !['user', 'agent', 'routine'].includes(sender.kind)) throw new Error('Invalid sender');
    if (sender.kind === 'agent') nonempty(sender.agentId, 'Sender agent id');
    if (sender.kind === 'routine') nonempty(sender.routineId, 'Sender routine id');
    if (!Array.isArray(input.recipientIds) || !input.recipientIds.length) throw new Error('At least one recipient is required');
    for (const id of input.recipientIds) nonempty(id, 'Recipient id');
    if (new Set(input.recipientIds).size !== input.recipientIds.length) throw new Error('Duplicate recipients are not allowed');
    nonempty(input.text, 'Message text');
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
    const receipt = this.store.write(() => {
      if (input.idempotencyKey !== undefined) {
        const existing = this.store.db.query<{ id: string; request_hash: string }, [string]>(
          'SELECT id, request_hash FROM messages WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing) {
          if (existing.request_hash !== hash) throw new IdempotencyConflictError();
          return { messageId: existing.id, deliveryIds: this.store.db.query<{ id: string }, [string]>(
            'SELECT id FROM deliveries WHERE message_id = ? AND retry_of IS NULL ORDER BY seq').all(existing.id).map(r => r.id), duplicate: true };
        }
      }
      for (const id of recipients) this.requireAgent(id);
      if (sender.kind === 'agent') this.requireAgent(sender.agentId);
      const messageId = randomUUID();
      const now = new Date().toISOString();
      this.store.db.query(`INSERT INTO messages (id, sender_kind, sender_agent_id, sender_routine_id, text, reply_to,
        expects_reply, idempotency_key, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        messageId, sender.kind, sender.kind === 'agent' ? sender.agentId : null,
        sender.kind === 'routine' ? sender.routineId : null, input.text, input.replyTo ?? null,
        Number(input.expectsReply ?? false), input.idempotencyKey ?? null, input.idempotencyKey === undefined ? null : hash, now);
      const chainId = input.chain?.id ?? randomUUID();
      const deliveryIds = recipients.map(recipient => {
        const id = randomUUID();
        this.store.db.query(`INSERT INTO deliveries (id, message_id, recipient_id, lane_id, status, chain_id, hop, updated_at)
          VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, messageId, recipient, input.laneId ?? null, chainId, input.chain?.hop ?? 0, now);
        return id;
      });
      return { messageId, deliveryIds, duplicate: false };
    });
    if (!receipt.duplicate) this.publish(receipt.deliveryIds.map(deliveryId => ({ deliveryId, status: 'queued' })));
    return receipt;
  }

  claimNext(agentId: string, laneId: string | null): Delivery | null {
    const delivery = this.store.write(() => {
      this.requireAgent(agentId);
      const row = this.store.db.query<Row, [string, string | null]>(`${select}
        WHERE d.recipient_id = ? AND d.lane_id IS ? AND d.status = 'queued' ORDER BY d.seq LIMIT 1`).get(agentId, laneId);
      if (!row) return null;
      this.transition(row.id, 'queued', 'starting');
      return this.get(row.id)!;
    });
    if (delivery) this.publish([{ deliveryId: delivery.id, status: 'starting' }]);
    return delivery;
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
    const receipt = this.store.write(() => {
      const old = this.get(deliveryId);
      if (!old) throw new Error(`Unknown delivery: ${deliveryId}`);
      if (allowedTransitions[old.status].length) throw new Error('Only a final delivery can be retried');
      const id = randomUUID();
      this.store.db.query(`INSERT INTO deliveries (id, message_id, recipient_id, lane_id, status, retry_of, chain_id, hop, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, old.messageId, old.recipientAgentId, old.laneId, old.id, old.chainId, old.hop, new Date().toISOString());
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
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private requireAgent(id: string): void {
    if (!this.store.db.query('SELECT id FROM agents WHERE id = ?').get(id)) throw new Error(`Unknown agent: ${id}`);
  }
  private change(id: string, status: DeliveryStatus, from: DeliveryStatus[], turnId?: string, error?: string): void {
    this.store.write(() => {
      const row = this.get(id);
      if (!row) throw new Error(`Unknown delivery: ${id}`);
      if (!from.includes(row.status)) throw new DeliveryTransitionError(id, row.status, status);
      this.transition(id, row.status, status, turnId, error);
    });
    this.publish([{ deliveryId: id, status }]);
  }
  private transition(id: string, from: DeliveryStatus, to: DeliveryStatus, turnId?: string, error?: string): void {
    if (!allowedTransitions[from].includes(to)) throw new DeliveryTransitionError(id, from, to);
    const result = this.store.db.query(`UPDATE deliveries SET status = ?, turn_id = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = ?`).run(to, turnId ?? this.get(id)?.turnId ?? null, error ?? null, new Date().toISOString(), id, from);
    if (result.changes !== 1) throw new Error(`Delivery ${id} changed concurrently`);
  }
  private publish(changes: MailboxChange[]): void {
    this.notifications.push(...changes);
    if (this.publishing) return;
    this.publishing = true;
    try {
      for (let change = this.notifications.shift(); change; change = this.notifications.shift()) {
        for (const listener of [...this.listeners]) {
          try { listener({ ...change }); }
          // A committed command must not appear to fail because an observer threw.
          catch (error) { process.emitWarning(`Mailbox listener failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
    } finally { this.publishing = false; }
  }
}
