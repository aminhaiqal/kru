import { z } from 'zod';
import type { Store } from '../store';
import type { ProcessScope } from '../boot/types';
import { AgentRegistry } from '../agents';
import { SqliteMailbox } from '../mailbox';
import { ToolRouter, SqliteToolState } from '../tools';
import { SqliteHistory } from '../threads/history';
import type { AgentTools, ToolContext } from '../tools/ports';
import type {
  ApprovalCall,
  ApprovalResult,
  Notification,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../providers/protocol';
import { WorkspaceRecords, skillSchema } from './records';
import { AgentMemory, memoryGuidance, memoryContextBoundary } from './memory';
import { ObsidianBrain, brainActions, brainGuidance } from './brain';
import { ApprovalBroker } from './approvals';
import { TaskRunner } from './tasks';
import { RoutineRunner } from './routines';
import { IntegrationGateway } from './integrations';
import { BrowserGateway, browserActionSchema } from './browser';
import { canonical } from '../store/events';
import { WorkService } from '../work/service';
import { WorkflowService } from '../workflows/service';

const result = (success: boolean, value: unknown, limit = 26000): ToolResult => {
  const text = JSON.stringify(value);
  return {
    success,
    contentItems: [
      {
        type: 'inputText',
        text:
          Buffer.byteLength(text) <= limit
            ? text
            : JSON.stringify({ truncated: true, excerpt: text.slice(0, Math.floor(limit / 4)) }),
      },
    ],
  };
};
const workspaceDefinition: ToolDefinition = {
  name: 'workspace',
  description:
    brainGuidance +
    ' Maintain private memory with remember/forget by key; memories reads a note by key or lists summaries. Discover skills and configured connectors. Only the user changes connector permissions.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: [...brainActions, 'skills', 'save_skill'] },
      path: { type: 'string' },
      query: { type: 'string' },
      expectedHash: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      id: { type: 'string' },
      key: { type: 'string' },
      text: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
    },
  },
};
const taskDefinition: ToolDefinition = {
  name: 'task_update',
  description:
    'Update the task assigned to this lane. Record steps, evidence/result, and status running, blocked or completed. Completion requires all steps done and a nonempty result.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['running', 'blocked', 'completed'] },
      result: { type: 'string' },
      error: { type: ['string', 'null'] },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'done'],
          properties: { text: { type: 'string' }, done: { type: 'boolean' } },
        },
      },
    },
  },
};
const useDefinition: ToolDefinition = {
  name: 'use_tool',
  description:
    'Call an external MCP tool or the agent browser. For MCP use target=mcp, connectorId, name and arguments; discover schemas with workspace connector_tools. For browser use target=browser and arguments containing action=read|search|navigate|click|fill|press|screenshot|back|forward|reload|new_tab|switch_tab|close_tab, query, url, selector, text, key or tabId. The native Chromium browser starts automatically when first used. Use CSS selectors from the current page snapshot. If a challenge says needs-user, wait for the user to complete it in the browser; do not solve or retry it. External actions may wait for user approval. Never bypass a denial through another tool.',
  inputSchema: {
    type: 'object',
    required: ['target', 'arguments'],
    additionalProperties: false,
    properties: {
      target: { type: 'string', enum: ['mcp', 'browser'] },
      connectorId: { type: 'string' },
      name: { type: 'string' },
      arguments: { type: 'object', additionalProperties: true },
    },
  },
};
export interface LiveEvent {
  agentId: string;
  laneId: string | null;
  notification: Notification;
}
export class WorkspaceRuntime {
  readonly records: WorkspaceRecords;
  readonly memory: AgentMemory;
  readonly brain: ObsidianBrain | undefined;
  readonly approvals: ApprovalBroker;
  readonly tasks: TaskRunner;
  readonly work: WorkService;
  readonly routines: RoutineRunner;
  readonly integrations: IntegrationGateway;
  readonly workflows: WorkflowService;
  readonly browser: BrowserGateway;
  readonly tools: AgentTools;
  readonly live = new Map<
    string,
    {
      agentId: string;
      laneId: string | null;
      items: Map<string, { id: string; type: string; text?: string; details?: unknown }>;
    }
  >();
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private readonly calls = new Map<string, { input: string; promise: Promise<ToolResult> }>();
  constructor(
    readonly store: Store,
    scope: () => ProcessScope,
    maxHops?: number,
    interrupt?: (agentId: string, laneId: string) => void,
  ) {
    this.records = new WorkspaceRecords(store);
    this.approvals = new ApprovalBroker(this.records);
    this.brain = store.path === ':memory:' ? undefined : new ObsidianBrain(store);
    this.brain?.importLegacy(this.records);
    this.memory = new AgentMemory(this.records, this.brain);
    this.tasks = new TaskRunner(this.records);
    this.routines = new RoutineRunner(this.records);
    this.work = new WorkService(store, interrupt);
    this.integrations = new IntegrationGateway(this.records, scope);
    this.browser = new BrowserGateway();
    this.workflows = new WorkflowService(store, this.integrations, interrupt, () => {
      scope();
    });
    const base = new ToolRouter(
      new SqliteMailbox(store),
      new AgentRegistry(store),
      new SqliteToolState(store),
      { history: new SqliteHistory(store), ...(maxHops === undefined ? {} : { maxHops }) },
    );
    this.tools = {
      definitions: [...base.definitions, workspaceDefinition, taskDefinition, useDefinition],
      instructions:
        base.instructions +
        '\n' +
        memoryGuidance +
        '\n' +
        brainGuidance +
        '\nUse workspace for skills/connectors, use_tool for integrations/browser, task_update for progress. Native Chromium browser access is enabled by default and starts on first use: use target=browser with action=search and query for web search, navigate and url to open a page, then read/click/fill/press to inspect and act. Respect permissions.',
      render: (batch) => {
        const personal = new AgentRegistry(this.store).get(batch.agentId)?.config.personalChat;
        const skills = this.records
          .list('skill', batch.agentId)
          .map((s) => ({ id: s.id, name: s.data.name, description: s.data.description }));
        const prompt = personal
          ? batch.deliveries.map((delivery) => delivery.text).join('\n\n')
          : base.render(batch);
        const budget = Math.max(
          0,
          Math.min(
            6000,
            28000 - Buffer.byteLength(prompt) - Buffer.byteLength(memoryContextBoundary),
          ),
        );
        const knowledge = this.brain?.context(prompt, Math.floor(budget / 2)) || '';
        const privateContext = this.memory.context(
          batch.agentId,
          personal ? [] : skills,
          budget - Buffer.byteLength(knowledge) - (knowledge ? 2 : 0),
        );
        const context = [knowledge, privateContext].filter(Boolean).join('\n\n');
        return context ? context + memoryContextBoundary + prompt : prompt;
      },
      handle: (context, call, signal) => {
        if (
          context.agent.config.personalChat &&
          (!['history_search', 'workspace', 'use_tool'].includes(call.tool) ||
            (call.tool === 'workspace' &&
              !(brainActions as readonly string[]).includes(
                String((call.arguments as any)?.action),
              )))
        )
          return result(false, { error: 'This tool is not available in personal chat' });
        if (!['workspace', 'task_update', 'use_tool'].includes(call.tool))
          return base.handle(context, call);
        if (call.threadId !== context.threadId || call.turnId !== context.turnId || signal?.aborted)
          return result(false, { error: 'Tool call does not belong to this active turn' });
        const key = JSON.stringify([context.batch.id, call.callId]);
        const input = canonical({ tool: call.tool, arguments: call.arguments });
        const old = this.calls.get(key);
        if (old)
          return old.input === input
            ? old.promise
            : result(false, { error: 'Tool call id reused with different input' });
        const operation = this.handle(context, call, signal).catch((error) =>
          result(
            false,
            { error: error instanceof Error ? error.message : 'Workspace tool failed' },
            context.maxToolResultBytes,
          ),
        );
        this.calls.set(key, { input, promise: operation });
        return operation;
      },
      finish: (context, answer, status) => {
        base.finish(context, answer, status);
        this.tasks.finish(context, answer, status);
        this.live.delete(context.turnId);
        const prefix = JSON.stringify([context.batch.id]).slice(0, -1) + ',';
        for (const key of this.calls.keys()) if (key.startsWith(prefix)) this.calls.delete(key);
      },
    };
  }
  private async handle(
    context: ToolContext,
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const limit = context.maxToolResultBytes;
    if (call.tool === 'task_update')
      return result(
        true,
        this.store.command('task.update', () => this.tasks.update(context, call.arguments), {
          id: `task-tool:${context.batch.id}:${call.callId}`,
          input: call.arguments,
        }),
        limit,
      );
    if (call.tool === 'workspace') {
      const input = z
        .object({
          action: z.enum([...brainActions, 'skills', 'save_skill']),
          path: z.string().max(500).optional(),
          query: z.string().max(1000).optional(),
          expectedHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          id: z.string().optional(),
          key: z.string().optional(),
          text: z.string().max(32768).optional(),
          name: z.string().optional(),
          description: z.string().optional(),
          instructions: z.string().optional(),
          cursor: z.string().max(160).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict()
        .parse(call.arguments);
      if (input.action.startsWith('brain_')) {
        if (!this.brain) throw new Error('KRU Brain requires a persistent workspace');
        if (input.action === 'brain_search')
          return result(true, this.brain.search(context.agent.id, input.query, input.limit), limit);
        if (!input.path) throw new Error('Supply a note path');
        if (input.action === 'brain_read')
          return result(true, this.brain.read(context.agent.id, input.path), limit);
        if (input.action === 'brain_forget')
          return result(
            true,
            this.brain.forget(context.agent.id, input.path, z.string().parse(input.expectedHash)),
            limit,
          );
        return result(
          true,
          this.brain.write(
            context.agent.id,
            input.path,
            z.string().parse(input.text),
            input.expectedHash,
          ),
          limit,
        );
      }
      if (input.action === 'memories')
        return result(
          true,
          input.key
            ? this.memory.read(context.agent.id, input.key)
            : this.memory.list(context.agent.id, input.cursor, input.limit),
          limit,
        );
      if (input.action === 'forget')
        return result(
          true,
          this.memory.forget(context.agent.id, z.string().parse(input.key)),
          limit,
        );
      if (input.action === 'skills') {
        if (input.id) {
          const entry = this.records.require('skill', input.id);
          if (entry.agentId !== context.agent.id)
            throw new Error('Skill does not belong to this agent');
          return result(true, entry, limit);
        }
        return result(
          true,
          this.records.list('skill', context.agent.id).map((entry) => ({
            id: entry.id,
            name: entry.data.name,
            description: entry.data.description,
          })),
          limit,
        );
      }
      if (input.action === 'connectors')
        return result(
          true,
          this.records
            .list('connector', context.agent.id)
            .filter((c) => c.data.enabled)
            .map((c) => ({ id: c.id, name: c.data.name, permission: c.data.permission })),
          limit,
        );
      if (input.action === 'connector_tools')
        return result(true, await this.integrations.tools(input.id ?? '', context.agent.id), limit);
      if (input.action === 'remember') {
        return result(
          true,
          this.memory.remember(context.agent.id, { key: input.key, text: input.text }),
          limit,
        );
      }
      const data = skillSchema.parse({
        name: input.name,
        description: input.description ?? '',
        instructions: input.instructions,
      });
      const existing = this.records
        .list('skill', context.agent.id)
        .find((s) => s.data.name === data.name);
      return result(true, this.records.put('skill', context.agent.id, data, existing?.id), limit);
    }
    const input = z
      .object({
        target: z.enum(['mcp', 'browser']),
        connectorId: z.string().optional(),
        name: z.string().optional(),
        arguments: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(call.arguments);
    if (input.target === 'browser') {
      const config = new AgentRegistry(this.store).get(context.agent.id)?.config.browser as
        { enabled?: boolean; permission?: string } | undefined;
      if (config?.enabled === false) throw new Error('Browser access is disabled for this agent');
      const action = browserActionSchema.parse(input.arguments);
      if (!['read', 'screenshot'].includes(action.action) && config?.permission !== 'allow')
        await this.requireApproval(
          context,
          {
            kind: 'tool',
            threadId: context.threadId,
            turnId: context.turnId,
            input: { browser: action },
          },
          signal,
        );
      if (
        (
          new AgentRegistry(this.store).get(context.agent.id)?.config.browser as
            { enabled?: boolean } | undefined
        )?.enabled === false
      )
        throw new Error('Browser access was disabled');
      return result(true, await this.browser.act(context.agent.id, action, signal), limit);
    }
    const entry = this.integrations.entry(input.connectorId ?? '', context.agent.id);
    if (!input.name) throw new Error('Supply an MCP tool name');
    if (entry.data.permission !== 'allow')
      await this.requireApproval(
        context,
        {
          kind: 'tool',
          threadId: context.threadId,
          turnId: context.turnId,
          input: {
            connector: entry.data.name,
            transport: entry.data.transport,
            destination:
              entry.data.transport === 'http'
                ? entry.data.url
                : { command: entry.data.command, args: entry.data.args },
            name: input.name,
            arguments: input.arguments,
          },
        },
        signal,
      );
    if (
      JSON.stringify(this.integrations.entry(entry.id, context.agent.id).data) !==
      JSON.stringify(entry.data)
    )
      throw new Error('Connector changed while awaiting approval. Request the action again.');
    return result(
      true,
      await this.integrations.call(entry.id, context.agent.id, input.name, input.arguments, signal),
      limit,
    );
  }
  private async requireApproval(
    context: ToolContext,
    call: ApprovalCall,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!signal) throw new Error('External actions require a cancellable provider request');
    const permissions = new AgentRegistry(this.store).get(context.agent.id)?.config.permissions as
      { approvalPolicy?: string } | undefined;
    if (permissions?.approvalPolicy === 'never')
      throw new Error('Action requires approval, but this agent has approvalPolicy=never');
    const answer = await this.approvals.request(context, call, signal);
    if (answer.decision !== 'accept' || signal.aborted)
      throw new Error('Action declined or approval expired');
  }
  approval(context: ToolContext, call: ApprovalCall, signal: AbortSignal): Promise<ApprovalResult> {
    return this.approvals.request(context, call, signal);
  }
  observe(agentId: string, laneId: string | null, notification: Notification): void {
    const params = notification.params;
    const turnId = 'turn' in params ? params.turn.id : params.turnId;
    let live = this.live.get(turnId);
    if (!live) {
      live = { agentId, laneId, items: new Map() };
      this.live.set(turnId, live);
    }
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const old = live.items.get(notification.params.item.id);
      live.items.set(notification.params.item.id, {
        ...old,
        ...notification.params.item,
        text: notification.params.item.text ?? old?.text ?? '',
      });
    } else if (notification.method === 'item/agentMessage/delta') {
      const old = live.items.get(notification.params.itemId) ?? {
        id: notification.params.itemId,
        type: 'agentMessage',
        text: '',
      };
      old.text = ((old.text ?? '') + notification.params.delta).slice(-64000);
      live.items.set(old.id, old);
    }
    if (live.items.size > 200) live.items.delete(live.items.keys().next().value!);
    for (const listener of this.listeners) {
      try {
        listener({ agentId, laneId, notification });
      } catch {}
    }
    if (notification.method === 'turn/completed') this.live.delete(turnId);
  }
  onEvent(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  start(): void {
    this.approvals.recover();
    this.workflows.recover();
  }
  tick(): void {
    this.tasks.tick();
    this.work.tick();
    this.routines.tick();
    this.workflows.tick();
  }
  async close(): Promise<void> {
    this.approvals.close();
    await this.workflows.close();
    await Promise.all([this.integrations.close(), this.browser.close()]);
    this.live.clear();
    this.calls.clear();
  }
}
