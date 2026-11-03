import packageJson from '../../../package.json';
import { RpcResponseError, type RpcConnection, type RpcRequest } from '../../rpc';
import { ProviderBase } from '../base';
import type { Methods, Notification, ThreadParams, ApprovalCall } from '../protocol';
import { prepareThread, promptMetadata, type PreparedThread } from '../prompt-profile';
import { decodeNotification, decodeResult, decodeToolCall, object } from '../validation';
import { createCodexRpcConnection, type CodexConnectionOptions } from './transport';

export class CodexRuntime {
  readonly connection: RpcConnection;
  private clients = new Set<CodexProvider>();
  private owners = new Map<string, CodexProvider>();
  private initialized: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  private registration = Promise.resolve();
  private registering: CodexProvider | undefined;
  private bad = 0;
  constructor(options: { transport?: CodexConnectionOptions; maxBadNotifications?: number } = {}) {
    const threshold = options.maxBadNotifications ?? 3;
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new RangeError('maxBadNotifications must be positive');
    this.connection = createCodexRpcConnection(options.transport);
    this.connection.on('exit', error => {
      this.initialized = undefined; this.bad = 0;
      const clients = [...this.clients]; this.clients.clear(); this.owners.clear();
      for (const client of clients) client.exited(error);
    });
    this.connection.on('diagnostic', d => { for (const client of this.clients) client.emit('diagnostic', { kind: d.kind }); });
    this.connection.on('notification', n => {
      let raw: Record<string, unknown> | undefined;
      try { raw = object(n.params); } catch { /* handled by boundary decoder */ }
      const owner = typeof raw?.threadId === 'string' ? this.owners.get(raw.threadId) : undefined;
      try {
        const notification = decodeNotification(n.method, n.params);
        if (notification) { this.bad = 0; owner?.receive(notification); }
        else if (owner && typeof raw?.threadId === 'string') owner.emit('activity', { threadId: raw.threadId, ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}) });
      } catch (error) {
        const diagnostic = { kind: 'invalid-message', method: n.method, message: error instanceof Error ? error.message : String(error) };
        if (owner) { owner.emit('diagnostic', diagnostic); owner.invalidNotification(raw!, diagnostic.message); }
        else for (const client of this.clients) client.emit('diagnostic', diagnostic);
        if (++this.bad >= threshold) void this.connection.forceStop();
      }
    });
    this.connection.onRequest(async request => {
      const raw = object(request.params);
      if (typeof raw.threadId !== 'string') throw new RpcResponseError(-32602, 'Missing request threadId');
      let owner = this.owners.get(raw.threadId);
      if (!owner && this.registering) { owner = this.registering; this.claim(raw.threadId, owner); }
      if (!owner) throw new RpcResponseError(-32601, 'No owner for provider request');
      return owner.handleNativeRequest(request);
    });
  }
  async acquire(client: CodexProvider): Promise<void> {
    await this.shutdown;
    this.clients.add(client);
    this.initialized ??= this.initialize();
    try { await this.initialized; }
    catch (error) { this.clients.delete(client); throw error; }
  }
  private async initialize(): Promise<void> {
    this.connection.start();
    await this.connection.request('initialize', { clientInfo: { name: 'kru', title: 'Kru', version: packageJson.version }, capabilities: { experimentalApi: true } }, {
      decode: value => { if (typeof object(value).userAgent !== 'string') throw new TypeError('Missing initialize userAgent'); return value; },
    });
    await this.connection.notify('initialized');
  }
  claim(id: string, client: CodexProvider): void {
    if (this.owners.has(id) && this.owners.get(id) !== client) throw new Error('Thread already belongs to another provider view');
    this.owners.set(id, client);
  }
  async register<T>(client: CodexProvider, fn: () => Promise<T>): Promise<T> {
    const previous = this.registration;
    let release!: () => void;
    this.registration = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const before = new Set(this.owners.keys()); this.registering = client;
    try { return await fn(); }
    catch (error) { for (const [id, owner] of this.owners) if (owner === client && !before.has(id)) this.owners.delete(id); throw error; }
    finally { this.registering = undefined; release(); }
  }
  async release(client: CodexProvider): Promise<void> {
    this.clients.delete(client);
    for (const [id, owner] of this.owners) if (owner === client) this.owners.delete(id);
    if (this.clients.size === 0) {
      this.shutdown = this.connection.stop();
      try { await this.shutdown; } finally { this.shutdown = undefined; this.initialized = undefined; }
    }
  }
}
let sharedRuntime: CodexRuntime | undefined;
export interface CodexProviderOptions { transport?: CodexConnectionOptions; runtime?: CodexRuntime; maxBadNotifications?: number; toolTimeoutMs?: number }
export class CodexProvider extends ProviderBase {
  readonly provider = 'codex';
  readonly capabilities = Object.freeze({ steering: false, subagents: false, compaction: 'none' as const });
  readonly runtime: CodexRuntime;
  get connection(): RpcConnection { return this.runtime.connection; }
  private activeTurns = new Map<string, { id?: string; completed?: string }>();
  private failedTurns = new Set<string>();
  private configs = new Map<string, PreparedThread>();
  private parameters = new Map<string, ThreadParams>();
  constructor(options: CodexProviderOptions = {}) {
    super(options.toolTimeoutMs);
    this.runtime = options.runtime ?? (options.transport || options.maxBadNotifications ? new CodexRuntime(options) : (sharedRuntime ??= new CodexRuntime()));
  }
  exited(error: Error): void { this.activeTurns.clear(); this.failedTurns.clear(); this.ended(error); }
  receive(notification: Notification): void {
    if (this.phase === 'stopped' || this.phase === 'stopping') return;
    const p = notification.params;
    const turnId = 'turn' in p ? p.turn.id : p.turnId;
    if (notification.method === 'turn/started') {
      const state = this.activeTurns.get(p.threadId) ?? {}; state.id = turnId; this.activeTurns.set(p.threadId, state);
    }
    if (notification.method === 'turn/completed') {
      const state = this.activeTurns.get(p.threadId);
      if (state) { state.completed = turnId; if (state.id === turnId) this.activeTurns.delete(p.threadId); }
      this.cancelTurnCalls(p.threadId, turnId);
      if (this.failedTurns.delete(turnId)) return;
    } else if (this.failedTurns.has(turnId)) return;
    this.emit('notification', notification);
  }
  invalidNotification(raw: Record<string, unknown>, message: string): void {
    const threadId = String(raw.threadId);
    const state = this.activeTurns.get(threadId);
    const turnId = typeof raw.turnId === 'string' ? raw.turnId : typeof (raw.turn as { id?: unknown } | undefined)?.id === 'string' ? (raw.turn as { id: string }).id : state?.id;
    if (!turnId || this.failedTurns.has(turnId)) return;
    this.failedTurns.add(turnId); this.cancelTurnCalls(threadId, turnId);
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message: `Invalid provider notification: ${message}` } } } });
    void this.connection.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  }
  async handleNativeRequest(request: RpcRequest): Promise<unknown> {
    this.requireReady();
    if (request.method === 'item/tool/call') {
      try { return await this.callTool(decodeToolCall(request.params), request.signal); }
      catch (error) { if (error instanceof TypeError) throw new RpcResponseError(-32602, 'Invalid tool call'); throw error; }
    }
    const kinds: Record<string, ApprovalCall['kind']> = {
      'item/commandExecution/requestApproval': 'command', 'item/fileChange/requestApproval': 'file',
      'item/permissions/requestApproval': 'permissions', 'mcpServer/elicitation/request': 'elicitation', 'item/tool/requestUserInput': 'tool',
    };
    const kind = kinds[request.method];
    if (!kind) throw new RpcResponseError(-32601, `Method not found: ${request.method}`);
    const p = object(request.params); const threadId = String(p.threadId);
    const readonlyEscape = this.configs.get(threadId)?.permissions.sandbox === 'read-only' && ['command', 'file', 'permissions'].includes(kind);
    const result = readonlyEscape ? { decision: 'decline' as const, content: undefined } : await this.callApproval({ threadId, turnId: typeof p.turnId === 'string' ? p.turnId : this.activeTurns.get(threadId)?.id ?? '', kind, input: p }, request.signal);
    if (kind === 'elicitation') return { action: result.decision === 'accept' ? 'accept' : 'decline', content: result.content ?? null };
    if (kind === 'permissions') return { permissions: result.decision === 'accept' ? result.content ?? {} : {}, scope: 'turn' };
    if (kind === 'tool') return { answers: result.decision === 'accept' ? result.content ?? {} : {} };
    return { decision: result.decision === 'accept' ? 'accept' : 'decline' };
  }
  async start(): Promise<void> {
    const generation = this.begin();
    try {
      await this.runtime.acquire(this);
      if (this.generation !== generation || this.phase !== 'starting') throw new Error('Provider initialization interrupted');
      this.phase = 'ready';
    } catch (error) { await this.runtime.release(this); this.exited(error instanceof Error ? error : new Error(String(error))); throw error; }
  }
  async stop(): Promise<void> {
    if (this.phase === 'stopped') return;
    const generation = this.generation;
    this.phase = 'stopping';
    const interrupts = [...this.activeTurns].map(([threadId, turn]) => {
      if (turn.id) this.cancelTurnCalls(threadId, turn.id);
      return turn.id ? this.connection.request('turn/interrupt', { threadId, turnId: turn.id }) : Promise.resolve();
    });
    const interrupted = Promise.allSettled(interrupts);
    await this.runtime.release(this);
    if (this.generation === generation) this.exited(new Error('Codex provider stopped'));
    await interrupted;
  }
  async forceStop(): Promise<void> { await this.connection.forceStop(); this.exited(new Error('Codex provider force-stopped')); }
  async request<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs?: number): Promise<Methods[M]['result']> {
    this.requireReady();
    if (!['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'].includes(method)) throw new RpcResponseError(-32601, `Method not found: ${method}`);
    if (method === 'thread/start' || method === 'thread/resume') return this.runtime.register(this, async () => {
      const p = params as ThreadParams & { threadId?: string };
      const effective = { ...(p.threadId ? this.parameters.get(p.threadId) : {}), ...p };
      if (effective.promptProfile === 'full') throw new RpcResponseError(-32602, 'The full Claude Code profile requires the Claude provider');
      const prepared = prepareThread(effective);
      const { tools: _tools, instructions: _instructions, promptProfile: _profile, permissions: _permissions, ...rest } = p;
      if (p.threadId) this.runtime.claim(p.threadId, this);
      const result = await this.connection.request(method, { ...rest, sandbox: prepared.permissions.sandbox, approvalPolicy: prepared.permissions.approvalPolicy,
        config: { 'sandbox_workspace_write.writable_roots': prepared.permissions.writableRoots,
          'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true },
        baseInstructions: prepared.instructions,
        ...(method === 'thread/start' ? { dynamicTools: prepared.tools.map(tool => ({ ...tool, type: 'function', deferLoading: false })) } : {}),
      }, { ...(timeoutMs === undefined ? {} : { timeoutMs }), decode: value => decodeResult(method, value) });
      const id = (result as Methods['thread/start']['result']).thread.id;
      this.runtime.claim(id, this); this.configs.set(id, prepared); this.parameters.set(id, structuredClone(effective)); return { ...result, thread: { ...(result as Methods['thread/start']['result']).thread, prompt: promptMetadata(prepared) } } as Methods[M]['result'];
    });
    const p = params as Methods['turn/start']['params'];
    if (!this.configs.has(p.threadId)) throw new RpcResponseError(-32602, 'Unknown thread');
    const reservation: { id?: string; completed?: string } = {};
    if (method === 'turn/start') {
      if (this.activeTurns.has(p.threadId)) throw new RpcResponseError(-32600, 'A turn is already active');
      this.activeTurns.set(p.threadId, reservation);
    }
    try {
      const result = await this.connection.request(method, params, { ...(timeoutMs === undefined ? {} : { timeoutMs }), decode: value => decodeResult(method, value) });
      if (method === 'turn/start' && this.phase !== 'ready') {
        const { turn } = result as Methods['turn/start']['result'];
        if (turn.status === 'inProgress') void this.connection.request('turn/interrupt', { threadId: p.threadId, turnId: turn.id }).catch(() => {});
      }
      if (method === 'turn/start' && this.activeTurns.get(p.threadId) === reservation) {
        const { turn } = result as Methods['turn/start']['result'];
        if (reservation.completed === turn.id || turn.status !== 'inProgress') this.activeTurns.delete(p.threadId); else reservation.id = turn.id;
      }
      return result;
    } catch (error) { if (error instanceof RpcResponseError && this.activeTurns.get(p.threadId) === reservation) this.activeTurns.delete(p.threadId); throw error; }
  }
}
