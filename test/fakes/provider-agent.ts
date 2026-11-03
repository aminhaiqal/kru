// Scripted native Codex peer: exercises the real adapter and stdio, without a model.
import { appendFileSync } from 'node:fs';
import { FakeProvider, type FakeMode } from '../../src/providers/fake/adapter';
import type { Methods, ToolResult, ApprovalResult } from '../../src/providers/protocol';
import { ByteLineFramer } from '../../src/rpc/framing';
import { RpcResponseError } from '../../src/rpc';

const mode = (process.env.KRU_FAKE_MODE ?? 'echo') as FakeMode;
const provider = new FakeProvider({ mode, toolTimeoutMs: 500 });
await provider.start();
let initialized = false;
let acknowledged = false;
const approvals = new Map<string, (value: unknown) => void>();
const nativeTools = new Map<string | number, string | number>();
const send = (value: unknown) => { process.stdout.write(JSON.stringify(value) + '\n'); };
const cacheTotals = new Map<string, { read: number; write: number }>();
provider.on('notification', n => {
  if (n.method !== 'thread/tokenUsage/updated') { send(n); return; }
  // Emit native Codex counters, not the port's normalized representation.
  const last = n.params.tokenUsage.last;
  const read = Math.min(2, last.inputTotal);
  const write = Math.min(1, Math.max(0, last.inputTotal - 2));
  const previous = cacheTotals.get(n.params.threadId) ?? { read: 0, write: 0 };
  const total = { read: previous.read + read, write: previous.write + write };
  cacheTotals.set(n.params.threadId, total);
  const native = (count: typeof last, reads: number, writes: number) => ({ inputTokens: count.inputTotal,
    cachedInputTokens: reads, cacheWriteInputTokens: writes,
    outputTokens: count.output, totalTokens: count.totalTokens, reasoningOutputTokens: 0 });
  send({ ...n, params: { ...n.params, tokenUsage: { ...n.params.tokenUsage,
    last: native(last, read, write), total: native(n.params.tokenUsage.total, total.read, total.write) } } });
});
provider.on('exit', () => { process.stderr.write('scripted provider exited', () => process.exit(23)); });
provider.on('request', request => {
  nativeTools.set(request.id, request.id);
  request.signal.addEventListener('abort', () => nativeTools.delete(request.id), { once: true });
  send({ id: request.id, method: request.method === 'approval/request'
    ? request.params.kind === 'file' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval'
    : request.method, params: request.params });
});
async function handle(message: Record<string, unknown>) {
  if (process.env.KRU_CAPTURE_FILE) appendFileSync(process.env.KRU_CAPTURE_FILE, JSON.stringify(message) + '\n');
  if ('jsonrpc' in message) throw new Error('Codex wire messages must omit jsonrpc');
  const id = message.id as string | number;
  if (typeof message.method !== 'string') {
    const approval = approvals.get(String(id)); if (approval) { approvals.delete(String(id)); approval(message.result); return; }
    const publicId = nativeTools.get(id);
    if (publicId === undefined) return;
    nativeTools.delete(id);
    if (message.error) {
      const error = message.error as { code: number; message: string };
      provider.respondError(publicId, error);
    } else provider.respond(publicId, message.result as ToolResult | ApprovalResult);
    return;
  }
  if (message.method === 'initialized') { acknowledged = true; return; }
  try {
    let result: unknown;
    if (message.method === 'initialize') {
      if (process.env.KRU_INIT_FAILURE) throw new Error('Scripted initialization failure');
      if (initialized) throw new RpcResponseError(-32600, 'Already initialized');
      const p = message.params as { capabilities?: { experimentalApi?: boolean } };
      if (!p.capabilities?.experimentalApi) throw new Error('Dynamic tools require experimentalApi');
      initialized = true; result = { userAgent: 'scripted-codex' };
    } else {
      if (!acknowledged) throw new Error('Not initialized');
      const p = message.params as Record<string, unknown>;
      if (message.method === 'thread/start' || message.method === 'thread/resume') {
        if (typeof p.baseInstructions !== 'string' || Buffer.byteLength(p.baseInstructions) >= 8192) throw new Error('Invalid instruction budget');
        if (!['never', 'on-request'].includes(String(p.approvalPolicy)) || !['read-only', 'workspace-write'].includes(String(p.sandbox))) throw new Error('Invalid agent permissions');
        const tools = p.dynamicTools as { type: string; name: string; description: string; inputSchema: Record<string, unknown> }[] | undefined;
        if (tools?.some(tool => tool.type !== 'function')) throw new Error('Invalid native tool spec');
        result = await provider.request(message.method, {
          ...(p as unknown as Methods['thread/resume']['params']), ...(tools ? { tools } : {}),
          permissions: { sandbox: p.sandbox as 'read-only' | 'workspace-write', approvalPolicy: p.approvalPolicy as 'on-request' | 'never',
            writableRoots: ((p.config as Record<string, unknown> | undefined)?.['sandbox_workspace_write.writable_roots'] ?? []) as string[] },
        });
      } else result = await provider.request(message.method as keyof Methods, p as unknown as Methods['turn/start']['params']);
    }
    if (message.method === 'turn/start') {
      const p = message.params as Methods['turn/start']['params'];
      const nativeCommand = p.input[0]?.text.match(/^native-command:(quiet|post-quiet|output|progress)$/);
      if (nativeCommand) {
        const turnId = (result as Methods['turn/start']['result']).turn.id;
        void (async () => {
          const command = nativeCommand[1];
          const params = { threadId: p.threadId, turnId, item: { id: 'quiet-command', type: 'commandExecution' } };
          if (command === 'quiet' || command === 'post-quiet') {
            send({ method: 'item/started', params }); await Bun.sleep(240);
            send({ method: 'item/completed', params });
          } else for (let i = 0; i < 12; i++) {
            send({ method: command === 'output' ? 'item/commandExecution/outputDelta' : 'item/mcpToolCall/progress', params: { threadId: p.threadId, turnId, itemId: 'quiet-command', delta: '.', progress: i } });
            await Bun.sleep(20);
          }
          if (command !== 'post-quiet') send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed' } } });
        })();
      }
      const approval = p.input[0]?.text.match(/^(approval|elicitation):(accept|decline)$/);
      if (approval) {
        const requestId = `approval-${id}`;
        const answer = new Promise<unknown>(resolve => approvals.set(requestId, resolve));
        send({ id: requestId, method: approval[1] === 'approval' ? 'item/commandExecution/requestApproval' : 'mcpServer/elicitation/request', params: { threadId: p.threadId, turnId: (result as Methods['turn/start']['result']).turn.id, command: 'echo test', mode: 'form', message: 'test', requestedSchema: { type: 'object' } } });
        const response = await answer as { decision?: string; action?: string };
        if ((approval[1] === 'approval' ? response.decision : response.action) !== approval[2]) throw new Error('Wrong approval response');
      }
    }
    if (process.env.KRU_BAD_RESULT === message.method) result = { turn: { id: 42, status: 'bad' } };
    if (message.method === 'turn/start') {
      const p = message.params as Methods['turn/start']['params'];
      const corrupt = p.input[0]?.text.match(/^corrupt:(\d+)$/);
      if (corrupt) {
        const turnId = (result as Methods['turn/start']['result']).turn.id;
        process.stdout.write(Array.from({ length: Number(corrupt[1]) }, () => JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId, itemId: 42, delta: false } }) + '\n').join(''));
      }
    }
    if (process.env.KRU_BAD_NOTIFICATION === message.method) send({ method: 'turn/completed', params: { threadId: 'broken' } });
    if (message.method === 'turn/start' && process.env.KRU_REPLY_DELAY_MS) await Bun.sleep(Number(process.env.KRU_REPLY_DELAY_MS));
    send({ id, result });
  } catch (error) {
    send({ id, error: { code: error instanceof RpcResponseError ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } });
  }
}
const framer = new ByteLineFramer(4 * 1024 * 1024);
process.stdin.on('data', (chunk: Buffer) => framer.push(chunk, line => { void handle(JSON.parse(line.toString())).catch(error => { console.error(error); process.exit(24); }); }));
