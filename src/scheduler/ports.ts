import type { Agent } from '../agents';
import type { ProviderClient } from '../providers/protocol';
import type { HandoffPacket } from '../threads/types';

export interface AgentSource { get(id: string): Agent | null; list(): Agent[]; onChange(listener: (agentId: string) => void): () => void }
export interface SessionBinding {
  logicalThreadId?: string; handoffPending?: boolean;
  agentId: string; laneId: string | null; provider: string;
  nativeThreadId: string; promptHash: string; configHash: string;
}
export interface SessionStore {
  get(agentId: string, laneId: string | null, provider: string): SessionBinding | null;
  put(binding: SessionBinding): void;
  remove(agentId: string, laneId: string | null, provider: string): void;
  handoff?(binding: SessionBinding, excludedMessageIds: string[], maxChars: number, maxBytes: number): HandoffPacket;
  acknowledgeHandoff?(binding: SessionBinding): void;
}
export type ProviderFactory = (agent: Agent, laneId: string | null) => ProviderClient;
