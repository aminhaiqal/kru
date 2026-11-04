import { EventEmitter } from 'node:events';
import { RpcResponseError } from '../rpc';
import type { ProviderCapabilities, ProviderClient, ProviderEvents, Methods, ToolCall, ToolResult, ApprovalCall, ApprovalResult, ProviderRequest } from './protocol';

type Reply = { resolve: (value: ToolResult | ApprovalResult) => void; reject: (error: unknown) => void; cleanup: () => void; controller: AbortController; params: ToolCall | ApprovalCall; method: ProviderRequest['method'] };
export abstract class ProviderBase extends EventEmitter<ProviderEvents> implements ProviderClient {
  abstract readonly provider: string;
  abstract readonly capabilities: ProviderCapabilities;
  protected phase: 'stopped' | 'starting' | 'ready' | 'stopping' = 'stopped';
  protected generation = 0;
  private sequence = 0;
  private replies = new Map<string | number, Reply>();
  private exitEmitted = true;
  constructor(private readonly toolTimeoutMs = 30_000) {
    super();
    if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs <= 0 || toolTimeoutMs > 2_147_483_647) throw new RangeError('toolTimeoutMs must be between 1 and 2147483647');
  }
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract forceStop(): Promise<void>;
  async retireThread(_threadId: string): Promise<void> { await this.forceStop(); }
  abstract request<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs?: number): Promise<Methods[M]['result']>;
  protected begin(): number {
    if (this.phase !== 'stopped') throw new Error('Provider is already started or stopping');
    this.phase = 'starting'; this.exitEmitted = false;
    return ++this.generation;
  }
  protected requireReady(): void { if (this.phase !== 'ready') throw new Error('Provider is not started'); }
  protected ended(error: Error): void {
    this.phase = 'stopped';
    for (const reply of [...this.replies.values()]) reply.controller.abort(error);
    if (!this.exitEmitted) { this.exitEmitted = true; this.emit('exit', error); }
  }
  protected callTool(params: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.callEngine('item/tool/call', params, signal) as Promise<ToolResult>;
  }
  protected callApproval(params: ApprovalCall, signal: AbortSignal): Promise<ApprovalResult> {
    if (this.listenerCount('request') === 0) return Promise.resolve({ decision: 'decline' });
    return this.callEngine('approval/request', params, signal) as Promise<ApprovalResult>;
  }
  private callEngine(method: ProviderRequest['method'], params: ToolCall | ApprovalCall, signal: AbortSignal): Promise<ToolResult | ApprovalResult> {
    this.emit('activity', { threadId: params.threadId, turnId: params.turnId });
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.listenerCount('request') === 0) return Promise.reject(new RpcResponseError(-32601, 'Method not found: item/tool/call'));
    const controller = new AbortController();
    // Public IDs never repeat, even when a native process restarts and reuses IDs.
    const id = `${this.provider}:request:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = (error: unknown) => {
        const reply = this.replies.get(id);
        if (!reply) return;
        this.replies.delete(id); reply.cleanup(); reject(error);
      };
      const abort = () => finish(controller.signal.reason);
      const parentAbort = () => controller.abort(signal.reason);
      const timer = setTimeout(() => controller.abort(new RpcResponseError(-32603, 'Tool response timed out')), this.toolTimeoutMs);
      this.replies.set(id, { resolve, reject, controller, params, method, cleanup: () => {
        clearTimeout(timer); signal.removeEventListener('abort', parentAbort); controller.signal.removeEventListener('abort', abort);
      } });
      signal.addEventListener('abort', parentAbort, { once: true });
      controller.signal.addEventListener('abort', abort, { once: true });
      const request = { id, method, params, signal: controller.signal } as ProviderRequest;
      // Routers commonly await I/O before replying. Observe rejected async
      // listeners too; EventEmitter.emit alone would leave them unhandled.
      for (const handler of this.rawListeners('request')) {
        try { void Promise.resolve(handler.call(this, request)).catch(finish); }
        catch (error) { finish(error); }
      }
    });
  }
  protected cancelThreadCalls(threadId: string): void {
    for (const reply of [...this.replies.values()]) {
      if (reply.params.threadId === threadId) reply.controller.abort(new Error('Thread retired'));
    }
  }
  protected cancelTurnCalls(threadId: string, turnId: string): void {
    for (const reply of [...this.replies.values()]) {
      if (reply.params.threadId === threadId && reply.params.turnId === turnId) reply.controller.abort(new Error('Turn ended'));
    }
  }
  respond(id: string | number, result: ToolResult | ApprovalResult): void {
    const reply = this.replies.get(id);
    if (!reply) throw new Error(`Unknown or completed provider request: ${id}`);
    if (reply.method === 'approval/request') {
      if (!('decision' in result) || !['accept', 'decline'].includes(result.decision)) throw new TypeError('Invalid approval result');
    } else if (!('success' in result) || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems) ||
      !result.contentItems.every(item => item.type === 'inputText' && typeof item.text === 'string')) throw new TypeError('Invalid tool result');
    this.takeReply(id).resolve(result);
  }
  respondError(id: string | number, error: { code: number; message: string }): void {
    if (!Number.isInteger(error.code) || typeof error.message !== 'string') throw new TypeError('Invalid tool error');
    this.takeReply(id).reject(new RpcResponseError(error.code, error.message));
  }
  private takeReply(id: string | number): Reply {
    const reply = this.replies.get(id);
    if (!reply) throw new Error(`Unknown or completed provider request: ${id}`);
    this.replies.delete(id); reply.cleanup(); return reply;
  }
}
