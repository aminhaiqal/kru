/** Kru's provider port. No process, transport, or provider imports belong here. */
export interface ProviderCapabilities {
  readonly steering: boolean;
  readonly subagents: boolean;
  readonly compaction: 'none' | 'provider';
}
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ThreadParams {
  cwd?: string; model?: string; tools?: ToolDefinition[]; instructions?: string;
  promptProfile?: 'minimal' | 'coding' | 'full';
  permissions?: { sandbox?: 'read-only' | 'workspace-write'; approvalPolicy?: 'on-request' | 'never'; writableRoots?: string[] };
}
export interface Thread { id: string; prompt?: { profile: 'minimal' | 'coding' | 'full'; instructionBytes: number; toolCount: number; builtinToolCount?: number; prefixHash: string } }
export interface AgentItem { id: string; type: string; text?: string; details?: unknown }
export interface Turn { id: string; status: 'inProgress' | 'completed' | 'failed' | 'interrupted'; error?: { message: string } | null }
export interface Methods {
  'thread/start': { params: ThreadParams; result: { thread: Thread } };
  'thread/resume': { params: ThreadParams & { threadId: string }; result: { thread: Thread } };
  'turn/start': { params: { threadId: string; input: { type: 'text'; text: string }[] }; result: { turn: Turn } };
  'turn/interrupt': { params: { threadId: string; turnId: string }; result: Record<string, never> };
}
export interface TokenUsage { last: TokenCount; total: TokenCount; modelContextWindow?: number | null }
/** Cache reads/writes are disjoint subsets of inputTotal, never additions to it. */
export interface TokenCount { inputTotal: number; cachedRead: number; cacheWrite: number; output: number; totalTokens: number }
export type Notification =
  | { method: 'turn/started' | 'turn/completed'; params: { threadId: string; turn: Turn } }
  | { method: 'item/started' | 'item/completed'; params: { threadId: string; turnId: string; item: AgentItem } }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'thread/tokenUsage/updated'; params: { threadId: string; turnId: string; tokenUsage: TokenUsage } };
export interface ToolCall { threadId: string; turnId: string; callId: string; tool: string; arguments: unknown }
export interface ToolResult { success: boolean; contentItems: { type: 'inputText'; text: string }[] }
export interface ApprovalCall { threadId: string; turnId: string; kind: 'command' | 'file' | 'permissions' | 'elicitation' | 'tool'; input: unknown }
export interface ApprovalResult { decision: 'accept' | 'decline'; content?: unknown }
export type ProviderRequest =
  | { id: string | number; method: 'item/tool/call'; params: ToolCall; signal: AbortSignal }
  | { id: string | number; method: 'approval/request'; params: ApprovalCall; signal: AbortSignal };
export interface ProviderDiagnostic { kind: string; message?: string; method?: string }
export interface ProviderEvents {
  notification: [Notification]; request: [ProviderRequest]; exit: [Error]; diagnostic: [ProviderDiagnostic];
  activity: [{ threadId: string; turnId?: string }];
}
export interface ProviderClient {
  readonly provider: string;
  readonly capabilities: ProviderCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
  request<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs?: number): Promise<Methods[M]['result']>;
  respond(id: string | number, result: ToolResult | ApprovalResult): void;
  respondError(id: string | number, error: { code: number; message: string }): void;
  on(event: 'notification', fn: (n: Notification) => void): unknown;
  on(event: 'request', fn: (r: ProviderRequest) => void): unknown;
  on(event: 'exit', fn: (error: Error) => void): unknown;
  on(event: 'diagnostic', fn: (d: ProviderDiagnostic) => void): unknown;
  on(event: 'activity', fn: (a: { threadId: string; turnId?: string }) => void): unknown;
  off(event: 'notification', fn: (n: Notification) => void): unknown;
  off(event: 'request', fn: (r: ProviderRequest) => void): unknown;
  off(event: 'exit', fn: (error: Error) => void): unknown;
  off(event: 'diagnostic', fn: (d: ProviderDiagnostic) => void): unknown;
  off(event: 'activity', fn: (a: { threadId: string; turnId?: string }) => void): unknown;
}
