import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import { createCodexRpcConnection } from "../src/providers/codex/transport";
import type { RpcConnection } from "../src/rpc";
import { CodexProvider } from '../src/providers/codex/adapter';
import { agentToolDefinitions, historyToolDefinition } from '../src/tools/definitions';

let directory: string;
let rpc: RpcConnection | undefined;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "kru-codex-")); });
afterEach(async () => {
  if (rpc) {
    await rpc.stop();
    expect(rpc.pendingRequestCount).toBe(0);
    expect(rpc.queuedWriteBytes).toBe(0);
    expect(rpc.pid).toBeUndefined();
    expect(readdirSync(join(directory, "processes"))).toEqual([]);
  }
  rpc = undefined;
  rmSync(directory, { recursive: true, force: true });
});

test("the Codex connection factory always selects the headerless wire format", async () => {
  rpc = createCodexRpcConnection({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fakes/fake-agent.ts", import.meta.url)), "--omit-jsonrpc", "--require-omitted-jsonrpc"],
    processRecordDir: join(directory, "processes"), stopGraceMs: 100,
  });
  rpc.start();
  expect(await rpc.request("ping", {})).toBe("pong");
});

test.skipIf(process.env.KRU_TEST_CODEX !== "1")("real Codex initializes with the exact headerless bytes Kru sends", async () => {
  const capture = join(directory, "stdin.ndjson");
  rpc = createCodexRpcConnection({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fakes/stdio-recorder.ts", import.meta.url)), capture,
      process.env.KRU_CODEX_COMMAND ?? "codex", "app-server", "--listen", "stdio://"],
    processRecordDir: join(directory, "processes"),
  });
  rpc.start();
  const result = await rpc.request("initialize", {
    clientInfo: { name: "kru", title: "Kru", version: packageJson.version },
  }, {
    decode(value) {
      if (!value || typeof value !== "object" || typeof (value as { userAgent?: unknown }).userAgent !== "string") {
        throw new Error("Codex initialize did not return userAgent");
      }
      return value;
    },
  });
  expect(result).toBeObject();
  await rpc.notify("initialized");
  // A second initialize is local and must be rejected as already initialized.
  // Its response is also a barrier proving the recorder forwarded initialized.
  await expect(rpc.request("initialize", { clientInfo: { name: "kru", title: "Kru", version: packageJson.version } })).rejects.toMatchObject({ message: "Already initialized" });
  const initialize = `{"id":"1","method":"initialize","params":{"clientInfo":{"name":"kru","title":"Kru","version":"${packageJson.version}"}}}\n`;
  const repeated = `{"id":"2","method":"initialize","params":{"clientInfo":{"name":"kru","title":"Kru","version":"${packageJson.version}"}}}\n`;
  expect(readFileSync(capture)).toEqual(Buffer.from(initialize + '{"method":"initialized"}\n' + repeated));
}, 20_000);

test.skipIf(process.env.KRU_TEST_CODEX !== '1')('real Codex registers Kru tools, classifies missing resume and cleans candidates without a model call', async () => {
  const provider = new CodexProvider({ transport: { command: process.env.KRU_CODEX_COMMAND ?? 'codex', processRecordDir: join(directory, 'processes') } });
  try {
    await provider.start();
    const params = { cwd: directory, tools: [...agentToolDefinitions, historyToolDefinition] };
    expect(await provider.sessionScope(params)).toMatch(/^[a-f0-9]{64}$/);
    const { thread } = await provider.request('thread/start', params);
    expect(thread.id).toBeString(); expect(thread.prompt?.toolCount).toBe(3);
    try {
      await provider.request('thread/resume', { ...params, threadId: '00000000-0000-4000-8000-000000000000' });
      throw new Error('Expected a missing native session');
    } catch (error) { expect(provider.classifySessionFailure(error)).toBe('missing'); }
    await provider.discardSession(thread.id);
  } finally { await provider.stop(); }
}, 20_000);

test.skipIf(process.env.KRU_TEST_CODEX !== '1')('real Codex receives the configured workspace and additional writable roots', async () => {
  const cwd = join(directory, 'workspace'); const extra = join(directory, 'extra');
  mkdirSync(cwd); mkdirSync(extra);
  const provider = new CodexProvider({ transport: { command: process.env.KRU_CODEX_COMMAND ?? 'codex', processRecordDir: join(directory, 'processes') } });
  try {
    await provider.start();
    const native = await provider.request('thread/start', { cwd, permissions: { sandbox: 'workspace-write', approvalPolicy: 'on-request', writableRoots: [extra] } }) as unknown as { sandbox: { type: string; writableRoots: string[] } };
    expect(native.sandbox.type).toBe('workspaceWrite');
    expect(native.sandbox.writableRoots.map(path => realpathSync(path))).toContain(realpathSync(extra));
  } finally { await provider.stop(); }
}, 20_000);
