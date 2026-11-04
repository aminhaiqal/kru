import { FakeProvider } from '../../src/providers/fake/adapter';
import type { Methods } from '../../src/providers/protocol';
import { RequestTimeoutError, RpcResponseError } from '../../src/rpc';

export class SchedulerFake extends FakeProvider {
  available = true;
  threadReady = true;
  starts: string[] = [];
  nativeStarts = 0;
  calls: string[] = [];
  attempts = 0;
  forces = 0;
  mode: 'normal' | 'unknown' | 'late' | 'refused' = 'normal';
  private delayed = new Set<ReturnType<typeof setTimeout>>();
  constructor(delayMs = 20, stall = false, failure = false) {
    super({ delayMs, ...(stall ? { mode: 'stall' } : failure ? { mode: 'failure' } : {}) });
    this.on('notification', n => { if (n.method === 'turn/started') this.nativeStarts++; });
  }
  override async start(): Promise<void> {
    this.attempts++;
    if (!this.available) throw new Error('Provider is not signed in');
    await super.start();
  }
  override async forceStop(): Promise<void> { this.forces++; await super.forceStop(); }
  override async stop(): Promise<void> {
    for (const timer of this.delayed) clearTimeout(timer);
    this.delayed.clear(); await super.stop();
  }
  override async request<M extends keyof Methods>(method: M, params: Methods[M]['params'], _timeoutMs?: number): Promise<Methods[M]['result']> {
    this.calls.push(method);
    if (!this.threadReady && (method === 'thread/start' || method === 'thread/resume')) throw new RpcResponseError(-32000, 'Session service unavailable');
    if (method === 'turn/start') {
      const p = params as Methods['turn/start']['params'];
      this.starts.push(p.input.map(i => i.text).join('\n'));
      if (this.mode === 'refused') throw new RpcResponseError(-32602, 'Definite start refusal');
      if (this.mode === 'unknown' || this.mode === 'late') {
        if (this.mode === 'late') {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => {
            this.delayed.delete(timer);
            this.emit('notification', { method: 'turn/started', params: { threadId: p.threadId, turn: { id, status: 'inProgress' } } });
            this.emit('notification', { method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed' } } });
          }, 25); this.delayed.add(timer);
        }
        throw new RequestTimeoutError('turn/start', 5);
      }
    }
    return super.request(method, params);
  }
}
