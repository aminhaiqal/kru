import type { Methods, Notification, ToolCall } from './protocol';
import { codexTokens } from './token-usage';
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected protocol object');
  return value as Record<string, unknown>;
};
const string = (value: unknown): void => { if (typeof value !== 'string') throw new TypeError('Expected protocol string'); };
function turn(value: unknown): void {
  const t = object(value); string(t.id);
  if (!['inProgress', 'completed', 'interrupted', 'failed'].includes(String(t.status))) throw new TypeError('Invalid turn status');
  if (t.error != null) string(object(t.error).message);
}
export function decodeResult<M extends keyof Methods>(method: M, value: unknown): Methods[M]['result'] {
  const result = object(value);
  if (method === 'thread/start' || method === 'thread/resume') string(object(result.thread).id);
  else if (method === 'turn/start') turn(result.turn);
  return result as unknown as Methods[M]['result'];
}
export function decodeNotification(method: string, value: unknown): Notification | undefined {
  if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'thread/tokenUsage/updated'].includes(method)) return;
  const p = object(value); string(p.threadId);
  if (method === 'turn/started' || method === 'turn/completed') {
    turn(p.turn);
    const status = object(p.turn).status;
    if (method === 'turn/started' ? status !== 'inProgress' : status === 'inProgress') throw new TypeError('Invalid turn boundary');
  } else {
    string(p.turnId);
    if (method === 'item/agentMessage/delta') { string(p.itemId); string(p.delta); }
    else if (method === 'thread/tokenUsage/updated') {
      const usage = object(p.tokenUsage);
      return { method, params: { threadId: p.threadId as string, turnId: p.turnId as string,
        tokenUsage: { last: codexTokens(object(usage.last)), total: codexTokens(object(usage.total)),
          ...(usage.modelContextWindow === undefined ? {} : { modelContextWindow: usage.modelContextWindow as number | null }) } } };
    } else { const item = object(p.item); string(item.id); string(item.type); if (item.text !== undefined) string(item.text); }
  }
  return { method, params: p } as Notification;
}
export function decodeToolCall(value: unknown): ToolCall {
  const p = object(value);
  for (const key of ['threadId', 'turnId', 'callId', 'tool']) string(p[key]);
  if (!('arguments' in p)) throw new TypeError('Missing tool arguments');
  return p as unknown as ToolCall;
}
