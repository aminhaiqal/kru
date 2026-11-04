/** Data shared by engine and process adapters; no process operations in this port. */
export interface ProcessScope {
  databaseId: string; hostId: string; ownerEpoch: string; ownerStartIdentity: string;
  runtimeId: string; directory: string;
  /** Local adapter hooks are omitted when the ownership record is serialized. */
  onRecord?:(path:string,record:unknown)=>void;
  onContained?:(path:string)=>void;
}
export type BootPhase = 'inspect' | 'reconcile' | 'contain' | 'verify' | 'ready' | 'blocked';
export interface RecoveryRow {
  execution_id: string; agent_id: string; lane_key: string; old_epoch: string | null;
  recovered_epoch: string; delivery_ids_json: string; reason: string; recovered_at: string;
  checkpoint_at: string | null; runtime_id: string | null; generation_id: string | null;
}
export interface QuarantineRow {
  generation_id: string; agent_id: string; lane_key: string; provider: string;
  native_thread_id: string; execution_id: string; reason: string; quarantined_at: string;
}
export interface RecoveryUsageRow {
  execution_id: string; agent_id: string; provider: string; model: string; lane_key: string;
  recorded_at: string; chains_json: string; deliveries_json: string; status: 'partial' | 'missing';
  usage_json: string | null; cost_json: string | null; price_id: string | null; resolution_json: string | null;
}
