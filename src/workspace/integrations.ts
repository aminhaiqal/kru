import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ProcessScope } from '../boot/types';
import { RpcConnection } from '../rpc';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkspaceRecords, type RecordEntry } from './records';

/** Reuse Kru's tracked process groups rather than launching unowned MCP children. */
class TrackedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly rpc: RpcConnection;
  constructor(entry: RecordEntry<'connector'>, scope: ProcessScope) {
    const env = { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(entry.data.env).map(([key, reference]) => [key, requiredEnv(reference)])) };
    this.rpc = new RpcConnection({ command: entry.data.command, args: entry.data.args, env, inheritEnv: false,
      requestTimeoutMs: 60_000, maxLineBytes: 4 * 1024 * 1024, maxQueuedWriteBytes: 4 * 1024 * 1024, maxBadLines: 3 });
    this.rpc.setProcessScope(scope);
    this.rpc.on('notification', n => this.onmessage?.({ jsonrpc: '2.0', method: n.method, ...(n.params === undefined ? {} : { params: n.params as Record<string, unknown> }) }));
    this.rpc.on('exit', () => this.onclose?.());
    this.rpc.onRequest(async () => { throw new Error('MCP server-initiated sampling and elicitation are not enabled'); });
  }
  async start(): Promise<void> { this.rpc.start(); }
  async close(): Promise<void> { await this.rpc.stop(); }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!('method' in message)) throw new Error('Unexpected MCP response');
    if (!('id' in message)) { await this.rpc.notify(message.method, message.params); return; }
    // send() must not await a response; the SDK owns response timeout and correlation.
    void this.rpc.request(message.method, message.params).then(
      result => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: (result ?? {}) as Record<string, unknown> }),
      error => this.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : 'MCP call failed' } }),
    );
  }
}
function requiredEnv(name: string): string {
  const value = process.env[name]; if (!value) throw new Error(`Set environment variable ${name} before starting KRU`); return value;
}
export class IntegrationGateway {
  private readonly clients = new Map<string, { hash: string; client: Client }>();
  private readonly connecting = new Map<string, Promise<Client>>();
  constructor(private readonly records: WorkspaceRecords, private readonly scope: () => ProcessScope) {}
  private async connect(entry: RecordEntry<'connector'>): Promise<Client> {
    const hash = JSON.stringify(entry.data), old = this.clients.get(entry.id);
    if (old?.hash === hash) return old.client;
    const pending = this.connecting.get(entry.id); if (pending) { await pending; return this.connect(entry); }
    const operation = (async () => {
      if (old) { this.clients.delete(entry.id); await old.client.close(); }
      const client = new Client({ name: 'kru', version: '0.1.1' }, { capabilities: {} });
      const transport = entry.data.transport === 'stdio' ? new TrackedTransport(entry, this.scope())
        : new StreamableHTTPClientTransport(new URL(entry.data.url), { requestInit: { headers: Object.fromEntries(Object.entries(entry.data.headers).map(([key, ref]) => [key, requiredEnv(ref)])) } });
      try {
        await client.connect(transport, { timeout: 15_000 });
        this.clients.set(entry.id, { hash, client });
        client.onclose = () => { if (this.clients.get(entry.id)?.client === client) this.clients.delete(entry.id); };
        return client;
      } catch (error) { await client.close().catch(() => {}); throw error; }
    })();
    this.connecting.set(entry.id, operation);
    try { return await operation; } finally { this.connecting.delete(entry.id); }
  }
  entry(id: string, agentId: string): RecordEntry<'connector'> {
    const entry = this.records.require('connector', id);
    if (!entry.data.enabled || entry.agentId !== agentId) throw new Error('Connector is not enabled for this agent');
    return entry;
  }
  async tools(id: string, agentId: string) {
    const client = await this.connect(this.entry(id, agentId));
    const tools = []; let cursor: string | undefined, pages = 0;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor; pages++;
      if (cursor && seen.has(cursor)) throw new Error('MCP server repeated its tool cursor');
      if (cursor) seen.add(cursor);
    } while (cursor && tools.length < 200 && pages < 10);
    return tools.slice(0, 200);
  }
  async call(id: string, agentId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Tool call cancelled');
    const entry = this.entry(id, agentId), snapshot = JSON.stringify(entry.data);
    const client = await this.connect(entry);
    if (signal?.aborted) throw new Error('Tool call cancelled');
    if (JSON.stringify(this.entry(id, agentId).data) !== snapshot) throw new Error('Connector configuration changed before execution');
    return client.callTool({ name, arguments: args }, undefined, { timeout: 60_000, ...(signal ? { signal } : {}) });
  }
  async invalidate(id: string): Promise<void> { const entry = this.clients.get(id); this.clients.delete(id); await entry?.client.close(); }
  async close(): Promise<void> {
    await Promise.allSettled([...this.connecting.values()]);
    const entries = [...this.clients.values()]; this.clients.clear();
    await Promise.allSettled(entries.map(entry => entry.client.close()));
  }
}
