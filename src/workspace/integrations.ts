import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ProcessScope } from '../boot/types';
import { RpcConnection } from '../rpc';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkspaceRecords, type RecordEntry } from './records';
import { storedError } from '../store/errors';
import { githubTokenReference, connectorAvailable } from '../shared/github';
import { githubAuthorization } from './github';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Reuse Kru's tracked process groups rather than launching unowned MCP children. */
class TrackedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly rpc: RpcConnection;
  constructor(entry: RecordEntry<'connector'>, scope: () => ProcessScope) {
    const env = {
      ...getDefaultEnvironment(),
      ...Object.fromEntries(
        Object.entries(entry.data.env).map(([key, reference]) => [key, requiredEnv(reference)]),
      ),
    };
    this.rpc = new RpcConnection({
      command: entry.data.command,
      args: entry.data.args,
      env,
      inheritEnv: false,
      requestTimeoutMs: 60_000,
      maxLineBytes: 4 * 1024 * 1024,
      maxQueuedWriteBytes: 4 * 1024 * 1024,
      maxBadLines: 3,
    });
    this.rpc.setProcessScope(scope());
    this.rpc.on('notification', (n) =>
      this.onmessage?.({
        jsonrpc: '2.0',
        method: n.method,
        ...(n.params === undefined ? {} : { params: n.params as Record<string, unknown> }),
      }),
    );
    this.rpc.on('exit', () => this.onclose?.());
    this.rpc.onRequest(async () => {
      throw new Error('MCP server-initiated sampling and elicitation are not enabled');
    });
  }
  async start(): Promise<void> {
    this.rpc.start();
  }
  async close(): Promise<void> {
    await this.rpc.stop();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!('method' in message)) throw new Error('Unexpected MCP response');
    if (!('id' in message)) {
      await this.rpc.notify(message.method, message.params);
      return;
    }
    // send() must not await a response; the SDK owns response timeout and correlation.
    void this.rpc.request(message.method, message.params).then(
      (result) =>
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: (result ?? {}) as Record<string, unknown>,
        }),
      (error) =>
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'MCP call failed',
          },
        }),
    );
  }
}
function requiredEnv(name: string): string {
  if (name === githubTokenReference)
    throw new Error('GitHub credentials require the official GitHub connector.');
  const value = process.env[name];
  if (!value) throw new Error(`Set environment variable ${name} before starting KRU`);
  return value;
}
export class IntegrationGateway {
  private readonly clients = new Map<string, { hash: string; client: Client }>();
  private readonly connecting = new Map<string, Promise<Client>>();
  private readonly checks = new Map<
    string,
    { hash: string; checkedAt: string; toolCount: number | null; error: string | null }
  >();
  constructor(
    private readonly records: WorkspaceRecords,
    private readonly scope: () => ProcessScope,
    private readonly request?: FetchLike,
  ) {}
  status(id: string) {
    const entry = this.records.require('connector', id),
      hash = JSON.stringify(entry.data);
    const checked = this.checks.get(id),
      check = checked?.hash === hash ? checked : undefined;
    const connected = this.clients.get(id)?.hash === hash;
    return {
      state: !entry.data.enabled
        ? 'disabled'
        : this.connecting.has(id)
          ? 'connecting'
          : check?.error
            ? 'error'
            : connected
              ? 'connected'
              : check
                ? 'disconnected'
                : 'not_checked',
      checkedAt: check?.checkedAt ?? null,
      toolCount: check?.toolCount ?? null,
      error: check?.error ?? null,
    };
  }
  private async connect(entry: RecordEntry<'connector'>): Promise<Client> {
    const hash = JSON.stringify(entry.data),
      old = this.clients.get(entry.id);
    if (old?.hash === hash) return old.client;
    const pending = this.connecting.get(entry.id);
    if (pending) {
      await pending;
      return this.connect(entry);
    }
    const operation = (async () => {
      if (old) {
        this.clients.delete(entry.id);
        await old.client.close();
      }
      const client = new Client({ name: 'kru', version: '0.1.1' }, { capabilities: {} });
      const transport =
        entry.data.transport === 'stdio'
          ? new TrackedTransport(entry, this.scope)
          : new StreamableHTTPClientTransport(new URL(entry.data.url), {
              ...(this.request ? { fetch: this.request } : {}),
              requestInit: {
                headers: Object.fromEntries(
                  Object.entries(entry.data.headers).map(([key, ref]) => [
                    key,
                    ref === githubTokenReference && key.toLowerCase() === 'authorization'
                      ? githubAuthorization(entry)
                      : requiredEnv(ref),
                  ]),
                ),
              },
            });
      try {
        await client.connect(transport, { timeout: 15_000 });
        this.clients.set(entry.id, { hash, client });
        this.checks.set(entry.id, {
          hash,
          checkedAt: new Date().toISOString(),
          toolCount: null,
          error: null,
        });
        client.onclose = () => {
          if (this.clients.get(entry.id)?.client === client) this.clients.delete(entry.id);
        };
        return client;
      } catch (error) {
        this.failed(entry, error);
        await client.close().catch(() => {});
        throw error;
      }
    })();
    this.connecting.set(entry.id, operation);
    try {
      return await operation;
    } finally {
      this.connecting.delete(entry.id);
    }
  }
  private failed(entry: RecordEntry<'connector'>, error: unknown): void {
    this.checks.set(entry.id, {
      hash: JSON.stringify(entry.data),
      checkedAt: new Date().toISOString(),
      toolCount: null,
      error:
        storedError(error instanceof Error ? error.message : String(error)) ?? 'Connection failed',
    });
  }
  entry(id: string, agentId: string): RecordEntry<'connector'> {
    const entry = this.records.require('connector', id);
    if (!connectorAvailable(entry, agentId))
      throw new Error('Connector is not enabled for this agent');
    return entry;
  }
  async tools(id: string, agentId: string) {
    const entry = this.entry(id, agentId);
    try {
      const client = await this.connect(entry);
      const tools = [];
      let cursor: string | undefined,
        pages = 0;
      const seen = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
        pages++;
        if (cursor && seen.has(cursor)) throw new Error('MCP server repeated its tool cursor');
        if (cursor) seen.add(cursor);
      } while (cursor && tools.length < 200 && pages < 10);
      const discovered = tools.slice(0, 200);
      this.checks.set(id, {
        hash: JSON.stringify(entry.data),
        checkedAt: new Date().toISOString(),
        toolCount: discovered.length,
        error: null,
      });
      return discovered;
    } catch (error) {
      this.failed(entry, error);
      throw error;
    }
  }
  async call(
    id: string,
    agentId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error('Tool call cancelled');
    const entry = this.entry(id, agentId),
      snapshot = JSON.stringify(entry.data);
    const client = await this.connect(entry);
    if (signal?.aborted) throw new Error('Tool call cancelled');
    if (JSON.stringify(this.entry(id, agentId).data) !== snapshot)
      throw new Error('Connector configuration changed before execution');
    return client.callTool({ name, arguments: args }, undefined, {
      timeout: 60_000,
      ...(signal ? { signal } : {}),
    });
  }
  async invalidate(id: string): Promise<void> {
    const entry = this.clients.get(id);
    this.clients.delete(id);
    this.checks.delete(id);
    await entry?.client.close();
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.connecting.values()]);
    const entries = [...this.clients.values()];
    this.clients.clear();
    this.checks.clear();
    await Promise.allSettled(entries.map((entry) => entry.client.close()));
  }
}
