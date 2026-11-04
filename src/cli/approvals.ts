import type { AgentItem, Notification, ProviderClient, ProviderRequest } from '../providers/protocol';
import type { TerminalInput } from './terminal-input';

// Escape terminal controls (JSON handles C0) and invisible direction overrides.
function preview(value: unknown): string {
  return (JSON.stringify(value, null, 2) ?? 'null').replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function hasAction(kind: 'command' | 'file', input: unknown, item?: AgentItem): boolean {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const fields = [object(input), object(object(input).input), object(item), object(item?.details)];
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  return fields.some(value => kind === 'command'
    ? text(value.command)
    : ['file_path', 'notebook_path', 'path', 'grantRoot'].some(name => text(value[name])) ||
      (Array.isArray(value.changes) && value.changes.some(change => text(object(change).path))));
}

/** Approvals are per action. Non-terminal and unsupported requests fail closed. */
export function attachApprovals(provider: ProviderClient, policy: 'on-request' | 'never', terminal?: TerminalInput): () => void {
  let queue = Promise.resolve();
  let disposed = false;
  const items = new Map<string, AgentItem>();
  const key = (thread: string, turn: string, item: string) => JSON.stringify([thread, turn, item]);
  const notification = (n: Notification) => {
    if (n.method === 'item/started' && ['commandExecution', 'fileChange'].includes(n.params.item.type)) {
      items.set(key(n.params.threadId, n.params.turnId, n.params.item.id), n.params.item);
    } else if (n.method === 'item/completed') items.delete(key(n.params.threadId, n.params.turnId, n.params.item.id));
    else if (n.method === 'turn/completed') {
      // The CLI owns one active thread/turn at a time.
      items.clear();
    }
  };
  const request = (r: ProviderRequest): Promise<void> => {
    const handle = async () => {
      if (r.signal.aborted) return;
      if (r.method !== 'approval/request') {
        provider.respondError(r.id, { code: -32601, message: 'The chat CLI has no tool handler' });
        return;
      }
      let accept = false;
      if (!disposed && terminal && policy === 'on-request' && (r.params.kind === 'command' || r.params.kind === 'file')) {
        const input = r.params.input;
        const itemId = input && typeof input === 'object' && 'itemId' in input ? input.itemId : undefined;
        const item = typeof itemId === 'string' ? items.get(key(r.params.threadId, r.params.turnId, itemId)) : undefined;
        if (!hasAction(r.params.kind, input, item)) terminal.write('\nDeclined: the provider supplied no command or file path to review.\n');
        else {
          terminal.write(`\nApproval requested (${r.params.kind}):\n${preview(item ? { request: input, item } : input)}\n`);
          const answer = await terminal.read('Allow this action? [y/N] ', r.signal);
          accept = answer !== undefined && /^(y|yes)$/i.test(answer.trim());
          if (!r.signal.aborted) terminal.write(accept ? 'Approved once.\n' : 'Declined.\n');
        }
      }
      if (!r.signal.aborted) provider.respond(r.id, { decision: accept ? 'accept' : 'decline' });
    };
    // A separate prompt and explicit answer are required for every request.
    const pending = queue.then(handle);
    queue = pending.catch(() => {});
    return pending;
  };
  provider.on('notification', notification);
  provider.on('request', request);
  return () => {
    disposed = true;
    terminal?.close();
    provider.off('notification', notification);
    provider.off('request', request);
    items.clear();
  };
}
