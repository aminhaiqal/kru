import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { DomainEvent } from '../event-types';

/** Fixed columns, never payload-derived SQL. Projectors have no clocks or transaction ownership. */
export const columns = {
  message_routes: 'message_id,sender_lane_key',
  delivery_replies: 'delivery_id,message_id,outcome,reason,created_at',
  agents: 'id,name,provider,config_json,created_at',
  messages: 'id,sender_kind,sender_agent_id,sender_routine_id,text,reply_to,expects_reply,idempotency_key,request_hash,created_at',
  deliveries: 'seq,id,message_id,recipient_id,lane_id,status,turn_id,error,retry_of,chain_id,hop,updated_at,batch_id',
  prices: 'id,provider,model,input_usd,cache_write_5m_usd,cache_write_1h_usd,cache_read_usd,output_usd,effective_from,source_url,snapshot_json',
  usage_records: 'batch_id,agent_id,provider,model,thread_id,turn_id,cause,deliveries_json,chains_json,phase,outcome,usage_json,cost_json,complete,resolution_json,started_at,updated_at,lane_key,price_id,recorded_at,input_total,cached_read,cache_write,cache_write_5m,cache_write_1h,output,cost_usd,estimated',
  turns: 'id,agent_id,lane_key,provider,native_thread_id,native_turn_id,model,profile,prefix_hash,status,error,started_at,completed_at,duration_ms,deliveries_json,chains_json',
  thread_messages: 'seq,turn_id,item_id,agent_id,lane_key,type,text,details_json,completed_at',
} as const;
export type ProjectionTable = keyof typeof columns;
const keys: Record<ProjectionTable, string> = { message_routes: 'message_id', delivery_replies: 'delivery_id', agents: 'id', messages: 'id', deliveries: 'id', prices: 'id', usage_records: 'batch_id', turns: 'id', thread_messages: 'turn_id,item_id' };
function put(db: Database, table: ProjectionTable, value: object): void {
  const names = columns[table].split(','), row = value as Record<string, SQLQueryBindings>;
  if (names.some(name => row[name] === undefined)) throw new Error(`Incomplete ${table} event payload`);
  const updates = names.filter(n => !keys[table].split(',').includes(n)).map(n => `${n}=excluded.${n}`).join(',');
  // A price id is a permanent snapshot, not an editable model alias.
  if (table === 'prices') {
    const old = db.query<{ snapshot_json: string }, [string]>('SELECT snapshot_json FROM prices WHERE id = ?').get(String(row.id));
    if (old) { if (old.snapshot_json !== row.snapshot_json) throw new Error('Price snapshot is immutable'); return; }
  }
  db.query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')}) ON CONFLICT(${keys[table]}) DO UPDATE SET ${updates}`)
    .run(...names.map(n => row[n]!));
}
export function project(db: Database, event: DomainEvent): void {
  switch (event.type) {
    case 'message.key_expired':
      if (db.query('UPDATE messages SET idempotency_key=NULL, request_hash=NULL WHERE id=? AND idempotency_key IS NOT NULL').run(event.payload.messageId).changes !== 1) throw new Error('Invalid key expiry event');
      break;
    case 'message.routed': put(db, 'message_routes', event.payload.row); break;
    case 'delivery.replied': put(db, 'delivery_replies', event.payload.row); break;
    case 'agent.configured': put(db, 'agents', event.payload.row); break;
    case 'message.imported': put(db, 'messages', event.payload.row); break;
    case 'message.enqueued':
      put(db, 'messages', event.payload.row);
      for (const row of event.payload.deliveries) put(db, 'deliveries', row);
      break;
    case 'price.configured': put(db, 'prices', event.payload.row); break;
    case 'usage.imported': case 'usage.prepared': case 'usage.checkpointed': case 'usage.resolved': case 'usage.recorded': put(db, 'usage_records', event.payload.row); break;
    case 'usage.abandoned': db.query('DELETE FROM usage_records WHERE batch_id = ?').run(event.payload.batchId); break;
    case 'turn.prepared': case 'turn.started': case 'turn.completed': put(db, 'turns', event.payload.row); break;
    case 'item.completed': put(db, 'thread_messages', event.payload.row); break;
    case 'delivery.imported': case 'delivery.claimed': case 'delivery.running': case 'delivery.restored': case 'delivery.finished': case 'delivery.cancelled': case 'delivery.retried':
      put(db, 'deliveries', event.payload.row); break;
    default: { const exhaustive: never = event; throw new Error(`Unknown event ${(exhaustive as DomainEvent).type}`); }
  }
}
