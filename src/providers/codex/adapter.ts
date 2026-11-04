import packageJson from '../../../package.json';
import { createHash } from 'node:crypto';
import { RpcResponseError, RequestTimeoutError, type RpcConnection, type RpcRequest, type RpcRequestOptions } from '../../rpc';
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
  private generation = 0;
  private readonly retiredThreads = new Map<string, Set<string>>();
  private checking: Promise<void> | undefined;
  private checkingGeneration = -1;
  private readonly answerTimeoutMs: number;
  constructor(options: { transport?: CodexConnectionOptions; maxBadNotifications?: number; answerTimeoutMs?: number } = {}) {
    const threshold = options.maxBadNotifications ?? 3;
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new RangeError('maxBadNotifications must be positive');
    this.answerTimeoutMs = options.answerTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.answerTimeoutMs) || this.answerTimeoutMs < 1 || this.answerTimeoutMs > 2_147_483_647) throw new RangeError('answerTimeoutMs must be a positive timer duration');
    this.connection = createCodexRpcConnection(options.transport);
    this.connection.on('exit', error => {
      this.initialized = undefined; this.bad = 0; this.generation++; this.retiredThreads.clear();
      const clients = [...this.clients]; this.clients.clear(); this.owners.clear();
      for (const client of clients) client.exited(error);
    });
    this.connection.on('diagnostic', d => { for (const client of this.clients) client.emit('diagnostic', { kind: d.kind }); });
    this.connection.on('notification', n => {
      let raw: Record<string, unknown> | undefined;
      try { raw = object(n.params); } catch { /* handled by boundary decoder */ }
      if (typeof raw?.threadId === 'string' && this.retiredThreads.has(raw.threadId)) {
        if (n.method === 'turn/started') {
          const id = (raw.turn as { id?: unknown } | undefined)?.id;
          if (typeof id === 'string') this.interruptRetired(raw.threadId, id);
        }
        return; // Includes output, usage and malformed notifications from abandoned work.
      }
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
      if (this.retiredThreads.has(raw.threadId)) {
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) return { decision: 'decline' };
        if (request.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
        if (request.method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
        if (request.method === 'item/tool/requestUserInput') return { answers: {} };
        throw new RpcResponseError(-32601, 'Thread retired');
      }
      let owner = this.owners.get(raw.threadId);
      if (!owner && this.registering) { owner = this.registering; this.claim(raw.threadId, owner); }
      if (!owner) throw new RpcResponseError(-32601, 'No owner for provider request');
      return owner.handleNativeRequest(request);
    });
  }
  /** A timed-out model request does not imply that the shared server is dead. */
  async request<T = unknown>(method: string, params: unknown, options?: RpcRequestOptions<T>): Promise<T> {
    try { return await this.connection.request<T>(method, params, options); }
    catch (error) {
      if (error instanceof RequestTimeoutError) this.probe();
      throw error;
    }
  }
  private probe(): void {
    void this.checkAnswering().catch(error => {
      for (const client of this.clients) client.emit('diagnostic', { kind: 'liveness-error', message: String(error) });
    });
  }
  checkAnswering(): Promise<void> {
    const generation = this.generation;
    if (this.checking && this.checkingGeneration === generation) return this.checking;
    this.checkingGeneration = generation;
    const pending = this.connection.request('config/read', { includeLayers: false }, { timeoutMs: this.answerTimeoutMs })
      .then(() => {}, async error => {
        // Even an RPC error proves the server is answering. Local failures do not prove a hang.
        if (error instanceof RequestTimeoutError && this.generation === generation) await this.connection.forceStop();
      }).finally(() => { if (this.checking === pending) this.checking = undefined; });
    this.checking = pending;
    return pending;
  }
  retireThread(threadId: string, turnId?: string): void {
    if (!this.retiredThreads.has(threadId)) this.retiredThreads.set(threadId, new Set());
    this.owners.delete(threadId);
    if (turnId) this.interruptRetired(threadId, turnId);
    this.probe();
  }
  isRetired(threadId: string): boolean { return this.retiredThreads.has(threadId); }
  interruptRetired(threadId: string, turnId: string): void {
    const turns = this.retiredThreads.get(threadId);
    if (!turns || turns.has(turnId)) return;
    turns.add(turnId);
    void this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: this.answerTimeoutMs }).catch(() => {});
  }
  async acquire(client: CodexProvider): Promise<void> {
    await this.shutdown;
    this.clients.add(client);
    this.initialized ??= this.initialize();
    try { await this.initialized; }
    catch (error) { this.clients.delete(client); throw error; }
  }
  private async initialize(): Promise<void> {
    this.generation++;
    this.connection.start();
    await this.connection.request('initialize', { clientInfo: { name: 'kru', title: 'Kru', version: packageJson.version }, capabilities: { experimentalApi: true } }, {
      decode: value => { if (typeof object(value).userAgent !== 'string') throw new TypeError('Missing initialize userAgent'); return value; },
    });
    await this.connection.notify('initialized');
  }
  claim(id: string, client: CodexProvider): void {
    if (this.retiredThreads.has(id)) throw new RpcResponseError(-32602, 'Native thread was retired');
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
export interface CodexProviderOptions { transport?: CodexConnectionOptions; runtime?: CodexRuntime; maxBadNotifications?: number; toolTimeoutMs?: number; answerTimeoutMs?: number }
export class CodexProvider extends ProviderBase {
  override async sessionScope(params?:ThreadParams):Promise<string>{
    this.requireReady();const local=await super.sessionScope(params),reply=await this.runtime.request<{account:unknown}>('account/read',{refreshToken:false});
    if(!reply||!Object.hasOwn(reply,'account'))throw new Error('Invalid local account/read result');
    return createHash('sha256').update(local+'\n'+JSON.stringify(reply.account)).digest('hex');
  }
  override sessionRuntimeToken():string{return `codex:${this.connection.pid??'stopped'}`;}
  async discardSession(threadId:string):Promise<void>{
    // A never-used thread can exist only in memory, with no rollout to archive.
    await this.runtime.request('thread/unsubscribe',{threadId});
    try{await this.runtime.request('thread/archive',{threadId});}
    catch(error){if(this.classifySessionFailure(error)!=='missing')throw error;}
    this.configs.delete(threadId);this.parameters.delete(threadId);this.cancelThreadCalls(threadId);
  }
  setProcessScope(scope:import('../../boot/types').ProcessScope):string { return this.connection.setProcessScope(scope); }
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
    this.runtime = options.runtime ?? (options.transport || options.maxBadNotifications || options.answerTimeoutMs ? new CodexRuntime(options) : (sharedRuntime ??= new CodexRuntime()));
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
    void this.runtime.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  }
  async handleNativeRequest(request: RpcRequest): Promise<unknown> {
    this.requireReady();
    if (request.method === 'item/tool/call') {
      let call:ReturnType<typeof decodeToolCall>|undefined,result:unknown;
      try {call=decodeToolCall(request.params);this.emit('notification',{method:'item/started',params:{threadId:call.threadId,turnId:call.turnId,item:{id:call.callId,type:'dynamicToolCall',details:{name:call.tool,input:call.arguments}}}});result=await this.callTool(call,request.signal);return result; }
      catch (error) { if (error instanceof TypeError) throw new RpcResponseError(-32602, 'Invalid tool call'); throw error; }
      finally{if(call&&!request.signal.aborted)this.emit('notification',{method:'item/completed',params:{threadId:call.threadId,turnId:call.turnId,item:{id:call.callId,type:'dynamicToolCall',details:{name:call.tool,input:call.arguments,...(result===undefined?{}:{result})}}}});}
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
      return turn.id ? this.runtime.request('turn/interrupt', { threadId, turnId: turn.id }) : Promise.resolve();
    });
    const interrupted = Promise.allSettled(interrupts);
    await this.runtime.release(this);
    if (this.generation === generation) this.exited(new Error('Codex provider stopped'));
    await interrupted;
  }
  async forceStop(): Promise<void> { await this.connection.forceStop(); this.exited(new Error('Codex provider force-stopped')); }
  override async retireThread(threadId: string): Promise<void> {
    const turnId = this.activeTurns.get(threadId)?.id;
    this.cancelThreadCalls(threadId);
    this.activeTurns.delete(threadId); this.configs.delete(threadId); this.parameters.delete(threadId);
    if (this.phase !== 'stopped') this.runtime.retireThread(threadId, turnId);
  }
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
      const result = await this.runtime.request(method, { ...rest, sandbox: prepared.permissions.sandbox, approvalPolicy: prepared.permissions.approvalPolicy,
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
      const result = await this.runtime.request(method, params, { ...(timeoutMs === undefined ? {} : { timeoutMs }), decode: value => decodeResult(method, value) });
      if (method === 'turn/start' && this.runtime.isRetired(p.threadId)) {
        const { turn } = result as Methods['turn/start']['result'];
        if (turn.status === 'inProgress') this.runtime.interruptRetired(p.threadId, turn.id);
      }
      if (method === 'turn/start' && this.phase !== 'ready') {
        const { turn } = result as Methods['turn/start']['result'];
        if (turn.status === 'inProgress') void this.runtime.request('turn/interrupt', { threadId: p.threadId, turnId: turn.id }).catch(() => {});
      }
      if (method === 'turn/start' && this.activeTurns.get(p.threadId) === reservation) {
        const { turn } = result as Methods['turn/start']['result'];
        if (reservation.completed === turn.id || turn.status !== 'inProgress') this.activeTurns.delete(p.threadId); else reservation.id = turn.id;
      }
      return result;
    } catch (error) { if (error instanceof RpcResponseError && this.activeTurns.get(p.threadId) === reservation) this.activeTurns.delete(p.threadId); throw error; }
  }
}
