import type { Store } from '../store';
import type { ReplyRecord, ToolState } from './ports';

/** Tool effects, routing and reply deduplication join the event dispatcher's transaction. */
export class SqliteToolState implements ToolState {
  constructor(private readonly store: Store) {}
  command<T>(id: string, input: unknown, operation: () => T): T {
    return this.store.command('tools', operation, { id, input });
  }
  returnLane(messageId: string): string | null {
    return this.store.db.query<{ sender_lane_key: string }, [string]>('SELECT sender_lane_key FROM message_routes WHERE message_id = ?').get(messageId)?.sender_lane_key || null;
  }
  route(messageId: string, senderLaneId: string | null): void {
    this.store.emit('message.routed', { row: { message_id: messageId, sender_lane_key: senderLaneId ?? '' } });
  }
  reply(deliveryId: string): ReplyRecord | null {
    const row = this.store.db.query<{ message_id: string | null; outcome: 'sent' | 'suppressed'; reason: string | null }, [string]>('SELECT * FROM delivery_replies WHERE delivery_id = ?').get(deliveryId);
    return row ? { deliveryId, messageId: row.message_id, outcome: row.outcome, reason: row.reason } : null;
  }
  recordReply(record: ReplyRecord): void {
    this.store.emit('delivery.replied', { row: { delivery_id: record.deliveryId, message_id: record.messageId,
      outcome: record.outcome, reason: record.reason, created_at: new Date().toISOString() } });
  }
}
