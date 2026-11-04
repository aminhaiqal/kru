import { prepareThread, promptMetadata, type PreparedThread } from '../prompt-profile';
import { addTokens, tokenCount, zeroTokens } from '../token-usage';
import { ProviderBase } from '../base';
import { RpcResponseError } from '../../rpc';
import { resolve } from 'node:path';
import { fileDecision } from '../permissions';
import type { Methods, ThreadParams, ToolDefinition, Turn, TokenCount, ToolResult } from '../protocol';

export type FakeMode = 'echo' | 'stall' | 'crash' | 'failure' | 'tool' | 'permissions';
export type FakeTurnScript = (input: string, call: (tool: string, args: unknown, callId?: string) => Promise<ToolResult>) => Promise<string>;
export interface FakeProviderOptions { mode?: FakeMode; deltaBeforeItem?: boolean; delayMs?: number; toolTimeoutMs?: number; script?: FakeTurnScript }
interface Active { id: string; controller: AbortController; timer?: ReturnType<typeof setTimeout>; text: string; itemId: string }
interface Session { id: string; params: ThreadParams; profile: PreparedThread; tools: ToolDefinition[]; total: TokenCount; active?: Active }
export class FakeProvider extends ProviderBase {
  readonly provider = 'fake';
  readonly capabilities = Object.freeze({ steering: false, subagents: false, compaction: 'none' as const });
  private threads = new Map<string, Session>();
  constructor(private readonly options: FakeProviderOptions = {}) { super(options.toolTimeoutMs); }
  async start(): Promise<void> { this.begin(); this.phase = 'ready'; }
  async stop(): Promise<void> {
    if (this.phase === 'stopped') return;
    this.phase = 'stopping'; this.clearTurns(); this.ended(new Error('Fake provider stopped'));
  }
  forceStop(): Promise<void> { return this.stop(); }
  async discardSession(id:string):Promise<void>{const s=this.threads.get(id);if(s?.active)throw new Error('Cannot discard an active session');this.threads.delete(id);}
  private clearTurns(): void {
    for (const session of this.threads.values()) {
      if (session.active) { clearTimeout(session.active.timer); session.active.controller.abort(new Error('Provider exited')); delete session.active; }
    }
  }
  async request<M extends keyof Methods>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    this.requireReady();
    let result: unknown;
    if (method === 'thread/start') {
      const p = prepareThread(params as ThreadParams);
      const thread = { id: crypto.randomUUID(), params: structuredClone(params as ThreadParams), profile: p, tools: p.tools ?? [], total: zeroTokens() };
      this.threads.set(thread.id, thread); result = { thread: { id: thread.id, prompt: promptMetadata(thread.profile) } };
    } else {
      const p = params as Methods['turn/start']['params'] & { turnId?: string; tools?: ToolDefinition[] };
      const session = this.threads.get(p.threadId);
      if (!session) throw new RpcResponseError(-32602, 'Unknown thread');
      if (method === 'thread/resume') {
        const { threadId: _id, ...updates } = params as Methods['thread/resume']['params'];
        const next = { ...session.params, ...updates }; const profile = prepareThread(next);
        if (session.active && Object.keys(updates).length) throw new RpcResponseError(-32600, 'Cannot reconfigure an active session');
        session.params = structuredClone(next); session.profile = profile; session.tools = profile.tools;
        result = { thread: { id: session.id, prompt: promptMetadata(session.profile) } };
      }
      else if (method === 'turn/interrupt') {
        if (!session.active || session.active.id !== p.turnId) throw new RpcResponseError(-32602, 'Unknown active turn');
        this.complete(session, session.active, 'interrupted'); result = {};
      } else if (method === 'turn/start') {
        if (session.active) throw new RpcResponseError(-32600, 'A turn is already active');
        if (!Array.isArray(p.input) || !p.input.every(i => i.type === 'text' && typeof i.text === 'string')) throw new RpcResponseError(-32602, 'Invalid text input');
        const active: Active = { id: crypto.randomUUID(), controller: new AbortController(), text: '', itemId: crypto.randomUUID() };
        session.active = active;
        this.emit('notification', { method: 'turn/started', params: { threadId: session.id, turn: { id: active.id, status: 'inProgress' } } });
        if (session.active === active) active.timer = setTimeout(() => { void this.run(session, active, p.input.map(i => i.text).join('\n')); }, this.options.delayMs ?? 1);
        result = { turn: { id: active.id, status: 'inProgress' } };
      } else throw new RpcResponseError(-32601, `Method not found: ${method}`);
    }
    return result as Methods[M]['result'];
  }
  private async run(session: Session, active: Active, prompt: string): Promise<void> {
    if (session.active !== active) return;
    const mode = this.options.mode ?? 'echo';
    if (mode === 'stall') return;
    if (mode === 'crash') { this.clearTurns(); this.ended(new Error('Scripted fake crash')); return; }
    let text = `Echo: ${prompt}`;
    if (this.options.script) {
      try {
        text = await this.options.script(prompt, async (name, args, callId = crypto.randomUUID()) => {
          if (!session.tools.some(t => t.name === name)) throw new Error(`Unregistered scripted tool: ${name}`);
          const item = { id: callId, type: 'dynamicToolCall', details: { name, input: args } };
          this.emit('notification', { method: 'item/started', params: { threadId: session.id, turnId: active.id, item } });
          const result = await this.callTool({ threadId: session.id, turnId: active.id, callId, tool: name, arguments: args }, active.controller.signal);
          if (session.active === active) this.emit('notification', { method: 'item/completed', params: {
            threadId: session.id, turnId: active.id, item: { ...item, details: { ...item.details, result } },
          } });
          return result;
        });
        if (session.active !== active) return;
      } catch (error) {
        if (session.active === active) this.complete(session, active, 'failed', error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (mode === 'permissions') {
      const action = JSON.parse(prompt) as { name: string; input: Record<string, unknown> };
      const file = ['Write', 'Edit', 'NotebookEdit'].includes(action.name);
      let decision = file ? fileDecision(session.profile, resolve(session.params.cwd ?? process.cwd()), action.input.file_path ?? action.input.notebook_path, true)
        : session.profile.permissions.approvalPolicy === 'never' ? 'deny' : 'ask';
      try {
        if (decision === 'ask') decision = (await this.callApproval({ threadId: session.id, turnId: active.id,
          kind: file ? 'file' : 'command', input: action }, active.controller.signal)).decision === 'accept' ? 'allow' : 'deny';
      } catch (error) {
        if (session.active === active) this.complete(session, active, 'failed', String(error));
        return;
      }
      if (session.active !== active) return;
      text = decision === 'allow' ? 'allowed' : 'denied';
    }
    if (mode === 'tool') {
      const tool = session.tools[0];
      if (!tool) { this.complete(session, active, 'failed', 'No tool registered'); return; }
      this.emit('notification', { method: 'item/started', params: { threadId: session.id, turnId: active.id, item: { id: active.itemId, type: 'dynamicToolCall' } } });
      try {
        const reply = await this.callTool({ threadId: session.id, turnId: active.id, callId: active.itemId, tool: tool.name, arguments: { text: prompt } }, active.controller.signal);
        if (session.active !== active) return;
        text = reply.contentItems.map(item => item.text).join('');
        this.emit('notification', { method: 'item/completed', params: { threadId: session.id, turnId: active.id, item: { id: active.itemId, type: 'dynamicToolCall' } } });
        if (session.active !== active) return;
        if (!reply.success) { this.complete(session, active, 'failed', text); return; }
        active.itemId = crypto.randomUUID();
      } catch (error) {
        if (session.active === active) {
          this.emit('notification', { method: 'item/completed', params: { threadId: session.id, turnId: active.id, item: { id: active.itemId, type: 'dynamicToolCall' } } });
          if (session.active === active) this.complete(session, active, 'failed', error instanceof RpcResponseError ? error.message : 'Internal error');
        }
        return;
      }
    }
    const itemParams = () => ({ threadId: session.id, turnId: active.id, item: { id: active.itemId, type: 'agentMessage', text: active.text } });
    if (this.options.deltaBeforeItem === false) this.emit('notification', { method: 'item/started', params: itemParams() });
    for (const [index, delta] of [text.slice(0, 6), text.slice(6)].entries()) {
      if (session.active !== active) return;
      active.text += delta;
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: session.id, turnId: active.id, itemId: active.itemId, delta } });
      if (session.active !== active) return;
      if (index === 0 && this.options.deltaBeforeItem !== false) this.emit('notification', { method: 'item/started', params: itemParams() });
    }
    if (session.active !== active) return;
    this.emit('notification', { method: 'item/completed', params: itemParams() });
    if (session.active !== active) return;
    const count = tokenCount(prompt.length, 0, 0, text.length);
    session.total = addTokens(session.total, count);
    this.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId: session.id, turnId: active.id, tokenUsage: { last: count, total: { ...session.total }, modelContextWindow: 128_000 } } });
    if (session.active !== active) return;
    this.complete(session, active, mode === 'failure' ? 'failed' : 'completed', mode === 'failure' ? 'Scripted turn failure' : undefined);
  }
  private complete(session: Session, active: Active, status: Exclude<Turn['status'], 'inProgress'>, message?: string): void {
    clearTimeout(active.timer); delete session.active;
    active.controller.abort(new Error(`Turn ${status}`));
    this.emit('notification', { method: 'turn/completed', params: { threadId: session.id, turn: { id: active.id, status, error: message ? { message } : null } } });
  }
}
