import { createHash } from 'node:crypto';
import type { ToolCall } from '../providers/protocol';
/** Length-bounded and separator-safe; provider namespaces prevent cross-runtime collisions. */
export function toolCallKey(provider: string, call: Pick<ToolCall, 'threadId' | 'turnId' | 'callId'>): string {
  return `tool:${createHash('sha256').update(JSON.stringify([provider, call.threadId, call.turnId, call.callId])).digest('hex')}`;
}
