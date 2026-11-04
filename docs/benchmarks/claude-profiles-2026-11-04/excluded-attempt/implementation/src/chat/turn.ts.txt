import type { Notification, ProviderClient, Turn, TokenUsage } from '../providers/protocol';

export interface ChatMessage { id: string; text: string }
export interface ChatTurnResult { turn: Turn; messages: ChatMessage[]; usage?: TokenUsage }
export interface ChatTurnOptions { idleTimeoutMs?: number; timeoutMs?: number; onUsage?: (usage: TokenUsage) => void; signal?: AbortSignal; onDelta?: (delta: string) => void }
/** One provider-independent turn. A timeout never retries work of unknown outcome. */
export function runChatTurn(provider: ProviderClient, threadId: string, text: string, options: ChatTurnOptions = {}): Promise<ChatTurnResult> {
  const timeoutMs = options.idleTimeoutMs ?? options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return Promise.reject(new RangeError('timeoutMs must be between 1 and 2147483647'));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  return new Promise((resolve, reject) => {
    let turnId: string | undefined;
    let settled = false;
    let usage: TokenUsage | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let earlyBytes = 0;
    const early: Notification[] = [];
    const messages = new Map<string, ChatMessage>();
    const commands = new Set<string>();
    const cleanup = () => {
      clearTimeout(timer); provider.off('notification', notification); provider.off('exit', fail); provider.off('activity', activity);
      options.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const interrupt = () => {
      if (turnId) void provider.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    };
    const abort = () => { fail(options.signal?.reason); interrupt(); };
    const resetIdle = () => { clearTimeout(timer); if (commands.size) return; timer = setTimeout(() => { fail(new Error(`Turn idle timed out after ${timeoutMs} ms; outcome may be unknown`)); interrupt(); }, timeoutMs); };
    const activity = (a: { threadId: string; turnId?: string }) => { if (!settled && a.threadId === threadId && (!turnId || !a.turnId || a.turnId === turnId)) resetIdle(); };
    const getMessage = (id: string) => {
      let message = messages.get(id);
      if (!message) { message = { id, text: '' }; messages.set(id, message); }
      return message;
    };
    const consume = (n: Notification) => {
      if (settled) return;
      const eventTurnId = 'turn' in n.params ? n.params.turn.id : n.params.turnId;
      if (eventTurnId !== turnId) return;
      if (n.method === 'item/started' && n.params.item.type === 'commandExecution') commands.add(n.params.item.id);
      if (n.method === 'item/completed') commands.delete(n.params.item.id);
      resetIdle();
      if (n.method === 'item/agentMessage/delta') {
        getMessage(n.params.itemId).text += n.params.delta;
        options.onDelta?.(n.params.delta);
      } else if (n.method === 'item/started' || n.method === 'item/completed') {
        if (n.params.item.type !== 'agentMessage') return;
        const message = getMessage(n.params.item.id);
        // An item may be announced after its first delta. Never reset that text.
        if (n.method === 'item/completed' && n.params.item.text !== undefined) {
          const finalText = n.params.item.text;
          if (finalText.startsWith(message.text)) options.onDelta?.(finalText.slice(message.text.length));
          message.text = finalText;
        }
      } else if (n.method === 'thread/tokenUsage/updated') {
        usage = n.params.tokenUsage; options.onUsage?.(usage);
      } else if (n.method === 'turn/completed') {
        if (n.params.turn.status !== 'completed') {
          fail(new Error(n.params.turn.error?.message ?? `Turn ${n.params.turn.status}`));
        } else { settled = true; cleanup(); resolve({ turn: n.params.turn, messages: [...messages.values()], ...(usage ? { usage } : {}) }); }
      }
    };
    const notification = (n: Notification) => {
      if (settled || n.params.threadId !== threadId) return;
      try {
        if (turnId === undefined) {
          earlyBytes += Buffer.byteLength(JSON.stringify(n));
          if (earlyBytes > 1024 * 1024) throw new Error('Provider streamed too much before returning the turn ID');
          early.push(n); resetIdle();
        } else consume(n);
      } catch (error) { fail(error); interrupt(); }
    };
    resetIdle();
    provider.on('activity', activity);
    provider.on('notification', notification); provider.on('exit', fail);
    options.signal?.addEventListener('abort', abort, { once: true });
    void provider.request('turn/start', { threadId, input: [{ type: 'text', text }] }).then(result => {
      turnId = result.turn.id;
      if (settled) { interrupt(); return; }
      try { for (const event of early) consume(event); }
      catch (error) { fail(error); interrupt(); }
      early.length = 0;
    }, fail);
  });
}
