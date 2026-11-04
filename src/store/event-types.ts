/** Version 1 payloads are frozen. Changes require an upcaster or a new version. */
export interface AgentRow { id: string; name: string; provider: string; config_json: string; created_at: string }
export interface MessageRow {
  id: string; sender_kind: string; sender_agent_id: string | null; sender_routine_id: string | null;
  text: string; reply_to: string | null; expects_reply: number; idempotency_key: string | null;
  request_hash: string | null; created_at: string;
}
export interface DeliveryRow {
  seq: number; id: string; message_id: string; recipient_id: string; lane_id: string | null;
  status: string; turn_id: string | null; error: string | null; retry_of: string | null;
  chain_id: string; hop: number; updated_at: string; batch_id: string | null;
}
export interface PriceRow {
  id: string; provider: string; model: string; input_usd: number; cache_write_5m_usd: number;
  cache_write_1h_usd: number; cache_read_usd: number; output_usd: number;
  effective_from: string; source_url: string; snapshot_json: string;
}
export interface UsageRow {
  batch_id: string; agent_id: string; provider: string; model: string; thread_id: string | null; turn_id: string | null;
  cause: string; deliveries_json: string; chains_json: string; phase: string; outcome: string | null;
  usage_json: string | null; cost_json: string | null; complete: number; resolution_json: string | null;
  started_at: string; updated_at: string; lane_key: string; price_id: string | null; recorded_at: string;
  input_total: number | null; cached_read: number | null; cache_write: number | null;
  cache_write_5m: number | null; cache_write_1h: number | null; output: number | null;
  cost_usd: number | null; estimated: number;
}
export interface TurnRow {
  id: string; agent_id: string; lane_key: string; provider: string; native_thread_id: string;
  native_turn_id: string | null; model: string; profile: string; prefix_hash: string; status: string;
  error: string | null; started_at: string; completed_at: string | null; duration_ms: number | null;
  deliveries_json: string; chains_json: string;
}
export interface ItemRow {
  seq: number; turn_id: string; item_id: string; agent_id: string; lane_key: string;
  type: string; text: string | null; details_json: string | null; completed_at: string;
}
type DeliveryEvent = 'delivery.imported' | 'delivery.claimed' | 'delivery.running' | 'delivery.restored' | 'delivery.finished' | 'delivery.cancelled' | 'delivery.retried';
export type Payloads = {
  'history.initialized': { id:1 };
  'history.imported': { row: import('../threads/records').HistoryRecord };
  'message.thread_linked': { row:{message_id:string;thread_id:string} };
  'history.gap_recorded': { row:{thread_id:string;before_seq:number;reason:string;recorded_at:string} };
  'session.generation_activated': { row:import('../threads/session-types').GenerationRow };
  'session.generation_retired': { row:import('../threads/session-types').GenerationRow };
  'handoff.created': { row:import('../threads/session-types').HandoffRow };
  'handoff.used': { row:{execution_id:string;handoff_id:string;generation_id:string;confirmed_at:string} };
  'turn.generation_linked':{row:{turn_id:string;generation_id:string}};
  'execution.recovered': { row: import('../boot/types').RecoveryRow };
  'item.recovered': { row: ItemRow; executionId:string; checkpointAt:string; checkpointSeq:number; partial:boolean };
  'session.quarantined': { row: import('../boot/types').QuarantineRow };
  'recovery.usage_observed': { row: import('../boot/types').RecoveryUsageRow };
  'recovery.usage_resolved': { row: import('../boot/types').RecoveryUsageRow };
  'thread.created': { row: { id: string; agent_id: string; lane_key: string; created_at: string } };
  'turn.thread_linked': { row: { turn_id: string; thread_id: string } };
  'message.key_expired': { messageId: string };
  'message.routed': { row: { message_id: string; sender_lane_key: string } };
  'delivery.replied': { row: { delivery_id: string; message_id: string | null; outcome: 'sent' | 'suppressed'; reason: string | null; created_at: string } };
  'agent.configured': { row: AgentRow };
  'message.enqueued': { row: MessageRow; deliveries: DeliveryRow[] };
  'message.imported': { row: MessageRow };
  'price.configured': { row: PriceRow };
  'usage.recorded': { row: UsageRow };
  'usage.prepared': { row: UsageRow };
  'usage.checkpointed': { row: UsageRow };
  'usage.resolved': { row: UsageRow };
  'usage.imported': { row: UsageRow };
  'usage.abandoned': { batchId: string };
  'turn.prepared': { row: TurnRow };
  'turn.started': { row: TurnRow };
  'turn.completed': { row: TurnRow };
  'item.completed': { row: ItemRow };
} & { [K in DeliveryEvent]: { row: DeliveryRow } };
export type EventType = keyof Payloads;
export type DomainEvent = { [K in EventType]: { seq: number; id: string; commandId: string; type: K; version: 1; payload: Payloads[K]; occurredAt: string } }[EventType];
