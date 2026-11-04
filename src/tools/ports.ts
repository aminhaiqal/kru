import type { Agent } from '../agents';
import type { Batch } from '../mailbox';
import type { ToolCall, ToolDefinition, ToolResult } from '../providers/protocol';

export interface ToolContext { agent: Agent; batch: Batch; threadId: string; turnId: string; maxToolResultBytes?:number }
export interface ReplyRecord { deliveryId: string; messageId: string | null; outcome: 'sent' | 'suppressed'; reason: string | null }
export interface ToolState {
  command<T>(id: string, input: unknown, operation: () => T): T;
  returnLane(messageId: string): string | null;
  route(messageId: string, senderLaneId: string | null): void;
  reply(deliveryId: string): ReplyRecord | null;
  recordReply(record: ReplyRecord): void;
}
export interface AgentTools {
  readonly definitions: readonly ToolDefinition[];
  readonly instructions: string;
  render(batch: Batch): string;
  handle(context: ToolContext, call: ToolCall): ToolResult;
  finish(context: ToolContext, answer: string, status: 'completed' | 'failed' | 'interrupted'): void;
}
