import type { Agent } from '../agents';
import type { Batch } from '../mailbox';
import type { Notification } from '../providers/protocol';
import type { TurnOutcome } from '../scheduler/runner';
export interface TurnRecording {
  started(turnId: string): void;
  observe(notification: Notification): void;
  finish(outcome: TurnOutcome): void;
}
export interface TurnHistory {
  prepare(batch: Batch, agent: Agent, threadId: string, prefixHash: string): TurnRecording;
}
