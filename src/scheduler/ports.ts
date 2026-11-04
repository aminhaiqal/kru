import type { Agent } from '../agents';
import type { ProviderClient } from '../providers/protocol';
import type { HandoffPacket } from '../threads/types';

export interface AgentSource { get(id: string): Agent | null; list(): Agent[]; onChange(listener: (agentId: string) => void): () => void }
export interface SessionBinding {
  generationId?:string;generation?:number;runtimeScopeHash?:string;handoffId?:string|null;
  logicalThreadId?: string; handoffPending?: boolean;
  agentId: string; laneId: string | null; provider: string;
  nativeThreadId: string; promptHash: string; configHash: string;
}
export interface SessionStore {
  beginSetup?(request:import('../threads/session-types').SetupRequest):import('../threads/session-types').SetupIntent;
  recordCandidate?(intentId:string,nativeId:string,promptHash:string):void;
  activate?(intentId:string):SessionBinding;
  setupState?(intentId:string,state:string,error?:string):void;
  pendingSetups?(agentId:string,laneId:string|null):import('../threads/session-types').SetupIntent[];
  quarantine?(binding:SessionBinding,executionId:string,reason:string):void;
  get(agentId: string, laneId: string | null, provider: string): SessionBinding | null;
  put(binding: SessionBinding): void;
  remove(agentId: string, laneId: string | null, provider: string): void;
  handoff?(binding: SessionBinding, excludedMessageIds: string[], maxChars: number, maxBytes: number): HandoffPacket;
  acknowledgeHandoff?(binding: SessionBinding,executionId?:string): void;
}
export type ProviderFactory = (agent: Agent, laneId: string | null) => ProviderClient;
