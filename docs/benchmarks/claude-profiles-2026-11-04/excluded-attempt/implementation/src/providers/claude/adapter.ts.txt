import type { Options, SDKMessage, SDKUserMessage, Query } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { ProviderBase } from '../base';
import { prepareThread, promptMetadata, type PreparedThread } from '../prompt-profile';
import type { Methods, ThreadParams, TokenCount } from '../protocol';
import { RpcResponseError } from '../../rpc';
import { prepareProcessRecordDir, writeProcessRecord, removeProcessRecord } from '../../rpc/process-record';
import { terminateTree } from '../../rpc/process-tree';
import { resolve } from 'node:path';
import { fileDecision } from '../permissions';
import { InputQueue } from './input-queue';
import { addTokens, claudeTokens, zeroTokens } from '../token-usage';

export type ClaudeQuery = AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };
export type ClaudeQueryFactory = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;
export interface ClaudeProviderOptions { query?: ClaudeQueryFactory; processRecordDir?: string; stopGraceMs?: number; toolTimeoutMs?: number }
interface Active {
  id: string; controller: AbortController; interrupted: boolean; messageId: string;
  blocks: Map<string, { text: string; completed: boolean }>;
  nativeTools: Map<string, string>; approvedTools: Set<string>; modelSteps: Set<string>; toolCalls: Set<string>;
}
interface Session {
  id: string; params: ThreadParams; profile: PreparedThread; nativeId?: string;
  query?: ClaudeQuery; input: InputQueue<SDKUserMessage>; reader?: Promise<void>;
  child?: ChildProcess; record?: string; force: AbortController; closing: boolean;
  model?: string; nativeTools?: string[]; active?: Active; total: TokenCount; nativeTotal: TokenCount;
}
function builtinTools(profile: PreparedThread): string[] | undefined {
  if (profile.promptProfile === 'full') return undefined;
  if (profile.promptProfile !== 'coding') return [];
  return profile.permissions.sandbox === 'read-only'
    ? ['Read', 'Glob', 'Grep'] : ['Read', 'Edit', 'Bash', 'Write', 'Glob', 'Grep'];
}
export class ClaudeProvider extends ProviderBase {
  readonly provider = 'claude';
  readonly capabilities = Object.freeze({ steering: false, subagents: false, compaction: 'none' as const });
  private sdk: typeof import('@anthropic-ai/claude-agent-sdk') | undefined;
  private sessions = new Map<string, Session>();
  private failure: Error | undefined;
  constructor(private readonly options: ClaudeProviderOptions = {}) { super(options.toolTimeoutMs); }
  async start(): Promise<void> {
    const generation = this.begin();
    this.failure = undefined;
    try {
      this.sdk = await import('@anthropic-ai/claude-agent-sdk');
      if (this.phase !== 'starting' || this.generation !== generation) throw new Error('Provider initialization interrupted');
      this.phase = 'ready';
    } catch (error) { if (this.generation === generation) this.ended(error instanceof Error ? error : new Error(String(error))); throw error; }
  }
  async stop(): Promise<void> { await this.shutdown(false); }
  async forceStop(): Promise<void> { await this.shutdown(true); }
  private async shutdown(force: boolean): Promise<void> {
    if (this.phase === 'stopped') return;
    this.phase = 'stopping';
    if (force) for (const session of this.sessions.values()) session.force.abort();
    const closed = await Promise.allSettled([...this.sessions.values()].map(session => this.closeSession(session)));
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') this.failure ??= failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    this.ended(this.failure ?? new Error('Claude provider stopped'));
  }
  private async closeSession(session: Session): Promise<void> {
    session.closing = true; session.input.close(); session.query?.close();
    session.active?.controller.abort(new Error('Session stopped')); delete session.active;
    const child = session.child;
    const record = session.record;
    if (child) {
      await terminateTree(child, this.options.stopGraceMs ?? 3_000, session.force.signal);
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (record) removeProcessRecord(record);
      delete session.child; delete session.record;
    }
    await session.reader;
    delete session.query; delete session.reader;
  }
  private session(params: ThreadParams, id: string = crypto.randomUUID(), nativeId?: string): Session {
    const session: Session = { id, params: structuredClone(params), profile: prepareThread(params), input: new InputQueue(), force: new AbortController(), closing: false, total: zeroTokens(), nativeTotal: zeroTokens(), ...(nativeId ? { nativeId } : {}) };
    this.sessions.set(id, session); return session;
  }
  async request<M extends keyof Methods>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    this.requireReady(); let result: unknown;
    if (method === 'thread/start') {
      const p = params as ThreadParams;
      const session = this.session(p); result = { thread: { id: session.id, prompt: promptMetadata(session.profile, session.profile.promptProfile === 'full' ? session.nativeTools : builtinTools(session.profile)) } };
    } else {
      const p = params as Methods['turn/start']['params'] & { turnId?: string };
      let session = this.sessions.get(p.threadId);
      if (!session && method === 'thread/resume' && /^[0-9a-f-]{36}$/i.test(p.threadId)) {
        const { threadId, ...config } = params as Methods['thread/resume']['params'];
        const stored = await this.sdk!.getSessionInfo(threadId, config.cwd ? { dir: config.cwd } : {});
        if (stored) session = this.session(config, threadId, threadId);
      }
      if (!session) throw new RpcResponseError(-32602, 'Unknown thread');
      if (method === 'thread/resume') {
        const { threadId: _id, ...updates } = params as Methods['thread/resume']['params'];
        if (Object.keys(updates).length) {
          if (session.active) throw new RpcResponseError(-32600, 'Cannot reconfigure an active session');
          const next = { ...session.params, ...updates }; const profile = prepareThread(next);
          await this.closeSession(session); delete session.nativeTools; session.params = structuredClone(next); session.profile = profile;
        }
        result = { thread: { id: session.id, prompt: promptMetadata(session.profile, session.profile.promptProfile === 'full' ? session.nativeTools : builtinTools(session.profile)) } };
      }
      else if (method === 'turn/interrupt') {
        if (!session.active || session.active.id !== p.turnId) throw new RpcResponseError(-32602, 'Unknown active turn');
        session.active.interrupted = true;
        this.cancelTurnCalls(session.id, session.active.id);
        await session.query?.interrupt(); result = {};
      } else if (method === 'turn/start') {
        if (session.active) throw new RpcResponseError(-32600, 'A turn is already active');
        if (!Array.isArray(p.input) || !p.input.every(i => i.type === 'text' && typeof i.text === 'string')) throw new RpcResponseError(-32602, 'Invalid text input');
        if (!session.query) this.open(session);
        const active: Active = { id: crypto.randomUUID(), controller: new AbortController(), interrupted: false, messageId: crypto.randomUUID(), blocks: new Map(), nativeTools: new Map(), approvedTools: new Set(), modelSteps: new Set(), toolCalls: new Set() };
        session.active = active;
        session.input.push({ type: 'user', ...(session.profile.promptProfile === 'full' ? {} : { client_composed: true as const }), session_id: session.nativeId ?? session.id, uuid: active.id as `${string}-${string}-${string}-${string}-${string}`, parent_tool_use_id: null, message: { role: 'user', content: p.input.map(i => i.text).join('\n') } });
        this.emit('notification', { method: 'turn/started', params: { threadId: session.id, turn: { id: active.id, status: 'inProgress' } } });
        result = { turn: { id: active.id, status: 'inProgress' } };
      } else throw new RpcResponseError(-32601, `Method not found: ${method}`);
    }
    return result as Methods[M]['result'];
  }
  private open(session: Session): void {
    const sdk = this.sdk!;
    session.input = new InputQueue(); session.force = new AbortController(); session.closing = false;
    const definitions = session.profile.tools.map(def => {
      const schema = z.fromJSONSchema(def.inputSchema);
      if (!(schema instanceof z.ZodObject)) throw new TypeError('MCP tools require object schemas');
      return sdk.tool(def.name, def.description, schema.shape, async args => {
        const active = session.active;
        if (!active) throw new Error('No active turn for tool call');
        const callId = crypto.randomUUID();
        this.emit('notification', { method: 'item/started', params: { threadId: session.id, turnId: active.id, item: { id: callId, type: 'dynamicToolCall' } } });
        try {
          const result = await this.callTool({ threadId: session.id, turnId: active.id, callId, tool: def.name, arguments: args }, active.controller.signal);
          return { isError: !result.success, content: result.contentItems.map(item => ({ type: 'text' as const, text: item.text })) };
        } catch (error) {
          throw error instanceof RpcResponseError ? error : new RpcResponseError(-32603, 'Internal error');
        } finally {
          if (session.active === active) this.emit('notification', { method: 'item/completed', params: { threadId: session.id, turnId: active.id, item: { id: callId, type: 'dynamicToolCall' } } });
        }
      });
    });
    const decide = async (name: string, input: Record<string, unknown>, signal: AbortSignal) => {
      if (name === 'Bash' && session.profile.permissions.sandbox === 'read-only') return false;
      const file = ['Write', 'Edit', 'NotebookEdit'].includes(name);
      const decision = file ? fileDecision(session.profile, resolve(session.params.cwd ?? process.cwd()), input.file_path ?? input.notebook_path, true)
        : ['Read', 'Glob', 'Grep'].includes(name) ? 'allow'
        : session.profile.permissions.approvalPolicy === 'never' ? 'deny' : 'ask';
      if (decision === 'allow') return true;
      if (decision === 'deny') return false;
      return (await this.callApproval({ threadId: session.id, turnId: session.active?.id ?? '',
        kind: file ? 'file' : name === 'Bash' ? 'command' : 'tool', input: { name, input } }, signal)).decision === 'accept';
    };
    const options: Options = {
      ...(session.params.cwd ? { cwd: session.params.cwd } : {}), ...(session.params.model ? { model: session.params.model } : {}),
      ...(session.nativeId ? { resume: session.nativeId } : { sessionId: session.id }),
      systemPrompt: session.profile.promptProfile === 'full'
        ? { type: 'preset', preset: 'claude_code', ...(session.profile.instructions ? { append: session.profile.instructions } : {}) }
        : session.profile.instructions,
      tools: builtinTools(session.profile) ?? { type: 'preset', preset: 'claude_code' },
      settingSources: session.profile.promptProfile === 'full' ? ['project', 'local'] : [], includePartialMessages: true,
      ...(session.profile.permissions.sandbox === 'read-only' ? { disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'] } : {}),
      permissionMode: session.profile.permissions.approvalPolicy === 'never' ? 'dontAsk' : 'default',
      additionalDirectories: session.profile.permissions.writableRoots,
      hooks: { PreToolUse: [{ onFailure: 'block', hooks: [async (input, _id, context) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        // Run before project allow rules and dontAsk, which can bypass canUseTool.
        if (!['Write', 'Edit', 'NotebookEdit', 'Bash'].includes(input.tool_name)) return {};
        const allowed = await decide(input.tool_name, input.tool_input as Record<string, unknown>, context.signal);
        if (allowed) session.active?.approvedTools.add(input.tool_use_id);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny' } };
      }] }] },
      mcpServers: definitions.length ? { kru: sdk.createSdkMcpServer({ name: 'kru', tools: definitions }) } : {},
      canUseTool: async (name, input, context) => {
        if (definitions.some(def => name === `mcp__kru__${def.name}`) && context.mcpServer?.source === 'sdk' && context.mcpServer.name === 'kru') return { behavior: 'allow', updatedInput: input };
        const allowed = session.active?.approvedTools.delete(context.toolUseID) || await decide(name, input, context.signal);
        return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Tool declined by agent permissions' };
      },
      spawnClaudeCodeProcess: opts => {
        const directory = prepareProcessRecordDir(this.options.processRecordDir);
        const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        session.child = child;
        try { if (child.pid) session.record = writeProcessRecord(directory, child.pid); }
        catch (error) { void terminateTree(child, 0, session.force.signal); throw error; }
        child.stderr.on('data', (data: Buffer) => this.emit('diagnostic', { kind: 'stderr', message: data.toString() }));
        return child;
      },
    };
    session.query = (this.options.query ?? sdk.query)({ prompt: session.input, options });
    session.reader = this.read(session).catch(error => {
      if (!session.closing) { this.failure = error instanceof Error ? error : new Error(String(error)); this.emit('diagnostic', { kind: 'sdk-error', message: String(error) }); void this.forceStop().catch(error => this.emit('diagnostic', { kind: 'shutdown-error', message: String(error) })); }
    });
  }
  private item(session: Session, active: Active, id: string) {
    let item = active.blocks.get(id);
    if (!item) {
      item = { text: '', completed: false }; active.blocks.set(id, item);
      this.emit('notification', { method: 'item/started', params: { threadId: session.id, turnId: active.id, item: { id, type: 'agentMessage', text: '' } } });
    }
    return item;
  }
  private text(session: Session, active: Active, id: string, text: string, final: boolean): void {
    const item = this.item(session, active, id);
    if (item.completed) return;
    const delta = final ? (text.startsWith(item.text) ? text.slice(item.text.length) : '') : text;
    item.text = final ? text : item.text + text;
    if (delta) this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: session.id, turnId: active.id, itemId: id, delta } });
    if (final) { item.completed = true; this.emit('notification', { method: 'item/completed', params: { threadId: session.id, turnId: active.id, item: { id, type: 'agentMessage', text: item.text } } }); }
  }
  private async read(session: Session): Promise<void> {
    for await (const message of session.query!) {
      if (session.closing) break;
      if ('session_id' in message) session.nativeId = message.session_id;
      if (message.type === 'system' && message.subtype === 'init') {
        session.model = message.model;
        session.nativeTools = message.tools.filter(name => !name.startsWith('mcp__'));
        this.emit('diagnostic', { kind: 'sdk-init', message: JSON.stringify({ model: message.model, version: message.claude_code_version, tools: session.nativeTools }) });
      }
      const active = session.active;
      if (!active) continue;
      this.emit('activity', { threadId: session.id, turnId: active.id });
      if ('parent_tool_use_id' in message && message.parent_tool_use_id) continue;
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'message_start') { active.messageId = event.message.id; active.modelSteps.add(event.message.id); }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') this.text(session, active, `${active.messageId}:${event.index}`, event.delta.text, false);
        if (event.type === 'content_block_stop') {
          const id = `${active.messageId}:${event.index}`; const item = active.blocks.get(id);
          if (item) this.text(session, active, id, item.text, true);
        }
      } else if (message.type === 'assistant') {
        active.modelSteps.add(message.message.id);
        for (const block of message.message.content) if (block.type === 'tool_use') active.toolCalls.add(block.id);
        message.message.content.forEach((block, index) => {
          if (block.type === 'text') {
            const existing = [...active.blocks].find(([key, item]) => key.startsWith(message.message.id + ':') && item.text === block.text);
            this.text(session, active, existing?.[0] ?? `${message.message.id}:${index}`, block.text, true);
          } else if (block.type === 'tool_use' && !block.name.startsWith('mcp__kru__') && !active.nativeTools.has(block.id)) {
            active.nativeTools.set(block.id, block.name);
            this.emit('notification', { method: 'item/started', params: { threadId: session.id, turnId: active.id, item: { id: block.id, type: block.name === 'Bash' ? 'commandExecution' : 'tool', text: block.name, details: { name: block.name, input: block.input } } } });
          }
        });
      } else if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_result' && active.nativeTools.has(block.tool_use_id)) {
            const name = active.nativeTools.get(block.tool_use_id); active.nativeTools.delete(block.tool_use_id); active.approvedTools.delete(block.tool_use_id);
            this.emit('notification', { method: 'item/completed', params: { threadId: session.id, turnId: active.id, item: { id: block.tool_use_id, type: name === 'Bash' ? 'commandExecution' : 'tool', details: { content: block.content, isError: block.is_error ?? false } } } });
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success' && active.blocks.size === 0 && message.result) this.text(session, active, `${active.messageId}:0`, message.result, true);
        const models = Object.values(message.modelUsage ?? {});
        const current = models.reduce((sum, m) => addTokens(sum, claudeTokens({ input_tokens: m.inputTokens, output_tokens: m.outputTokens,
          cache_read_input_tokens: m.cacheReadInputTokens, cache_creation_input_tokens: m.cacheCreationInputTokens })), zeroTokens());
        // usage is explicitly per turn; modelUsage is cumulative across SDK
        // queries/resumes and must never be mistaken for the current turn.
        const last = claudeTokens(message.usage);
        if (models.length && current.totalTokens >= session.nativeTotal.totalTokens) session.total = current;
        else session.total = addTokens(session.total, last);
        session.nativeTotal = current;
        this.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId: session.id, turnId: active.id, tokenUsage: { ...(session.model ?? session.params.model ? { model: session.model ?? session.params.model! } : {}), modelSteps: active.modelSteps.size, toolCalls: active.toolCalls.size, last, total: { ...session.total }, modelContextWindow: models[0]?.contextWindow ?? null } } });
        this.cancelTurnCalls(session.id, active.id); active.controller.abort(new Error('Turn ended')); delete session.active;
        const failed = message.subtype !== 'success' || message.is_error;
        this.emit('notification', { method: 'turn/completed', params: { threadId: session.id, turn: { id: active.id, status: active.interrupted ? 'interrupted' : failed ? 'failed' : 'completed', error: failed && !active.interrupted ? { message: message.subtype === 'success' ? message.result : message.errors.join('; ') } : null } } });
      }
    }
    if (!session.closing) throw new Error('Claude SDK stream exited unexpectedly');
  }
}
