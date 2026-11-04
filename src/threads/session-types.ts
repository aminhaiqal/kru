export interface GenerationRow {
  id:string;thread_id:string;generation:number;provider:string;config_hash:string;runtime_scope_hash:string;
  reason:string;previous_id:string|null;status:'active'|'retired'|'quarantined';handoff_id:string|null;
  created_at:string;retired_at:string|null;retired_reason:string|null;
}
export interface HandoffRow {
  id:string;thread_id:string;generation_id:string;renderer_version:number;snapshot_seq:number;reason:string;
  included_json:string;omitted_json:string;packet:string;packet_hash:string;char_budget:number;byte_budget:number;created_at:string;
}
export interface SetupRequest {
  agentId:string;laneId:string|null;provider:string;configHash:string;runtimeScopeHash:string;runtimeToken:string;
  config:unknown;reason:string;batchId?:string;excludeMessageIds:string[];maxChars:number;maxBytes:number;
}
export interface SetupIntent {
  id:string;thread_id:string;agent_id:string;lane_key:string;provider:string;batch_id:string|null;owner_epoch:string|null;
  expected_id:string|null;expected_generation:number;config_hash:string;runtime_scope_hash:string;runtime_token:string;
  config_json:string;reason:string;snapshot_seq:number;packet_json:string;state:string;
  candidate_native_id:string|null;candidate_prompt_hash:string|null;error:string|null;created_at:string;updated_at:string;
}
export class SessionInputError extends Error {}
export class SessionSetupHeld extends Error {}
