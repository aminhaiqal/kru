import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  RpcConnection, ProcessExitError, RequestTimeoutError, RpcResponseError, WriteQueueFullError,
  type Diagnostic, type RpcConnectionOptions,
} from "../src/rpc";

const fake = fileURLToPath(new URL("./fakes/fake-agent.ts", import.meta.url));
const connections: RpcConnection[] = [];
const pids: number[] = [];
let unhandled: unknown[] = [];
let recordDir: string;
const recordUnhandled = (error: unknown) => { unhandled.push(error); };

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(() => { throw new Error("expected request to reject"); }, (error: unknown) => {
    if (!(error instanceof Error)) throw error;
    return error;
  });
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  // Killed orphans may remain zombies until PID 1 reaps them. They have no
  // running code or open descriptors. Read procfs without depending on ps.
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return !status.stdout.trim().startsWith("Z") && status.stdout.trim() !== "";
}

function connection(overrides: Partial<RpcConnectionOptions> = {}, start = true): RpcConnection {
  const rpc = new RpcConnection({
    command: process.execPath, args: [fake], requestTimeoutMs: 1_000,
    maxLineBytes: 2 * 1024 * 1024, maxQueuedWriteBytes: 4 * 1024 * 1024,
    maxBadLines: 3, stopGraceMs: 100, stderrDrainTimeoutMs: 50, processRecordDir: recordDir, ...overrides,
  });
  connections.push(rpc);
  if (start) {
    rpc.start();
    if (rpc.pid) pids.push(rpc.pid);
  }
  return rpc;
}

function diagnostics(rpc: RpcConnection): Diagnostic[] {
  const values: Diagnostic[] = [];
  rpc.on("diagnostic", (value) => values.push(value));
  return values;
}

function nextDiagnostic(rpc: RpcConnection, kind: Diagnostic["kind"]): Promise<Diagnostic> {
  return new Promise((resolve) => {
    const listener = (value: Diagnostic) => {
      if (value.kind !== kind) return;
      rpc.removeListener("diagnostic", listener);
      resolve(value);
    };
    rpc.on("diagnostic", listener);
  });
}

beforeEach(() => {
  recordDir = mkdtempSync(join(tmpdir(), "kru-rpc-"));
  unhandled = [];
  process.on("unhandledRejection", recordUnhandled);
});

afterEach(async () => {
  await Promise.all(connections.map((rpc) => rpc.stop()));
  for (const rpc of connections) {
    expect(rpc.pendingRequestCount).toBe(0);
    expect(rpc.queuedWriteBytes).toBe(0);
    expect(rpc.pid).toBeUndefined();
  }
  for (const pid of pids) expect(running(pid)).toBe(false);
  await delay(0);
  process.removeListener("unhandledRejection", recordUnhandled);
  expect(unhandled).toEqual([]);
  expect(readdirSync(recordDir)).toEqual([]);
  rmSync(recordDir, { recursive: true, force: true });
  connections.length = 0;
  pids.length = 0;
});

describe("M0 acceptance tests", () => {
  test("1. ping returns pong", async () => {
    expect(await connection().request("ping", {})).toBe("pong");
  });

  test("2. 100 concurrent requests get their own answers in shuffled order", async () => {
    const rpc = connection();
    const completed: number[] = [];
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      rpc.request("reverse", { index: i }).then((value) => { completed.push(i); return value; }),
    ));
    expect(results).toEqual(Array.from({ length: 100 }, (_, index) => ({ index })));
    expect(completed).not.toEqual(Array.from({ length: 100 }, (_, index) => index));
  });

  test("3. error responses retain code, message and data", async () => {
    const error = await failure(connection().request("error", {}));
    expect(error).toBeInstanceOf(RpcResponseError);
    if (!(error instanceof RpcResponseError)) throw error;
    expect(error.code).toBe(-32042);
    expect(error.message).toBe("scripted failure");
    expect(error.data).toEqual({ retry: false });
  });

  test("4. a stalled request times out", async () => {
    const rpc = connection();
    const error = await failure(rpc.request("stall", {}, { timeoutMs: 40 }));
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error.message).toBe('request "stall" timed out after 40 ms');
    expect(rpc.pendingRequestCount).toBe(0);
    expect(await rpc.request("ping", {})).toBe("pong");
  });

  test("5. five notifications arrive in order", async () => {
    const rpc = connection();
    const received: unknown[] = [];
    rpc.on("notification", (message) => received.push(message));
    await rpc.request("notifications", {});
    expect(received).toEqual(Array.from({ length: 5 }, (_, index) => ({ method: "tick", params: { index } })));
  });

  test("6. a reverse request receives the handler's answer", async () => {
    const rpc = connection();
    rpc.onRequest(async ({ method, params, signal }) => {
      expect(method).toBe("question");
      expect(params).toEqual({ text: "hello" });
      expect(signal.aborted).toBe(false);
      return "answer";
    });
    expect(await rpc.request("ask", {})).toEqual({ result: "answer" });
  });

  test("7. split multibyte UTF-8 and merged messages frame correctly", async () => {
    const rpc = connection();
    const received: unknown[] = [];
    rpc.on("notification", (message) => received.push(message));
    await rpc.request("fragments", {});
    expect(received).toEqual([
      { method: "fragment", params: { text: "kru 🦜 café" } },
      { method: "merged", params: { index: 1 } },
      { method: "merged", params: { index: 2 } },
    ]);
  });

  test("8. a bad line between good lines does not drop either message", async () => {
    const rpc = connection();
    const received: unknown[] = [];
    const events = diagnostics(rpc);
    rpc.on("notification", (message) => received.push(message.params));
    await rpc.request("bad-between", {});
    expect(received).toEqual([{ index: 1 }, { index: 2 }]);
    expect(events.filter((event) => event.kind === "bad-line")).toHaveLength(1);
    expect(await rpc.request("ping", {})).toBe("pong");
  });

  test("9. a crash rejects all pending requests with final stderr and emits one exit", async () => {
    const rpc = connection();
    const exits: ProcessExitError[] = [];
    rpc.on("exit", (error) => exits.push(error));
    const results = await Promise.allSettled([
      rpc.request("stall", {}), rpc.request("stall", {}), rpc.request("crash", {}),
    ]);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.exitCode).toBe(23);
    expect(exits[0]!.lastStderrLine).toBe("final crash detail");
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe(exits[0]);
    }
    await rpc.stop();
    expect(exits).toHaveLength(1);
  });

  test("10. stop kills the whole process tree and requests fail immediately", async () => {
    const rpc = connection();
    const { pid } = await rpc.request<{ pid: number }>("descendant", {});
    pids.push(pid);
    expect(running(pid)).toBe(true);
    await Promise.all([rpc.stop(), rpc.stop()]);
    expect(running(pid)).toBe(false);
    await expect(rpc.request("ping", {})).rejects.toThrow("not running");
  });

  test("11. stderr is diagnostic output, never JSON-RPC", async () => {
    const rpc = connection();
    const events = diagnostics(rpc);
    const stderr = nextDiagnostic(rpc, "stderr");
    expect(await rpc.request("stderr", {})).toBe("ok");
    expect(await stderr).toEqual({ kind: "stderr", line: "diagnostic 🦜" });
    expect(events.filter((event) => event.kind === "bad-line")).toHaveLength(0);
  });

  test("12. 50 MiB of writes to a non-reading child obey a bounded budget", async () => {
    const limit = 4 * 1024 * 1024;
    const rpc = connection({ args: [fake, "--no-read"], maxQueuedWriteBytes: limit }, false);
    const ready = new Promise<void>((resolve) => rpc.once("notification", () => resolve()));
    const events = diagnostics(rpc);
    rpc.start();
    pids.push(rpc.pid!);
    await ready;
    const payload = "x".repeat(1024 * 1024);
    // Do not retain all 50 MiB: the same payload is serialized per attempt and
    // the queue only holds the frames that fit within its configured budget.
    const writes = Array.from({ length: 50 }, () => rpc.notify("large", { payload }));
    const settled = Promise.allSettled(writes);
    expect(rpc.queuedWriteBytes).toBeLessThanOrEqual(limit);
    await delay(20);
    expect(events.some((event) => event.kind === "write-blocked")).toBe(true);
    expect(rpc.queuedWriteBytes).toBeLessThanOrEqual(limit);
    await rpc.stop();
    const results = await settled;
    expect(results.some((value) => value.status === "rejected" && value.reason instanceof WriteQueueFullError)).toBe(true);
    expect(rpc.queuedWriteBytes).toBe(0);
  });

  test("13. a late answer emits exactly one diagnostic with method and delay", async () => {
    const rpc = connection();
    const events = diagnostics(rpc);
    const late = nextDiagnostic(rpc, "late-response");
    await expect(rpc.request("late", { delayMs: 80 }, { timeoutMs: 40 })).rejects.toBeInstanceOf(RequestTimeoutError);
    const diagnostic = await late;
    expect(diagnostic.kind).toBe("late-response");
    if (diagnostic.kind === "late-response") {
      expect(diagnostic.method).toBe("late");
      expect(diagnostic.delayMs).toBeGreaterThan(0);
    }
    expect(await rpc.request("ping", {})).toBe("pong");
    expect(events.filter((event) => event.kind === "late-response")).toHaveLength(1);
  });

  test("14. a reverse request without a handler receives -32601", async () => {
    expect(await connection().request("ask", {})).toEqual({ error: { code: -32601, message: "Method not found: question" } });
  });
});

describe("transport edge cases", () => {
  test("omitted incoming jsonrpc works with the default outgoing format", async () => {
    const rpc = connection({ args: [fake, "--omit-jsonrpc", "--require-jsonrpc"] });
    expect(await rpc.request("ping", {})).toBe("pong");
    const events = diagnostics(rpc);
    await rpc.request("notifications", {});
    expect(events.filter((event) => event.kind === "bad-line")).toHaveLength(0);
  });

  test.each([false, true])("all outbound message types honor jsonrpcField=%s", async (jsonrpcField) => {
    const rpc = connection({ jsonrpcField, args: [fake, ...(jsonrpcField ? ["--require-jsonrpc"] : ["--omit-jsonrpc", "--require-omitted-jsonrpc"])] });
    expect(await rpc.request("ping", {})).toBe("pong");
    const notified = new Promise<unknown>((resolve) => rpc.once("notification", resolve));
    await rpc.notify("notify-echo", { value: 42 });
    expect(await notified).toEqual({ method: "notified", params: { value: 42 } });
    await expect(rpc.request("error", {})).rejects.toBeInstanceOf(RpcResponseError);
    expect(await rpc.request("ask", {})).toEqual({ error: { code: -32601, message: "Method not found: question" } });
    rpc.onRequest(async () => "answer");
    expect(await rpc.request("ask", {})).toEqual({ result: "answer" });
    rpc.onRequest(async () => { throw new Error("failed"); });
    expect(await rpc.request("ask", {})).toEqual({ error: { code: -32603, message: "Internal error" } });
    await rpc.request("fragments", {});
  });

  test.each(["1.0", null, false, 2])("an explicit wrong jsonrpc value %s is rejected", async (value) => {
    const rpc = connection();
    const events = diagnostics(rpc);
    expect(await rpc.request("wrong-jsonrpc", { value })).toBe("valid");
    expect(events.filter((event) => event.kind === "bad-line")).toHaveLength(1);
  });

  test("stop allows a real shutdown longer than the old 100 ms grace", async () => {
    const rpc = connection({ stopGraceMs: 500, stderrDrainTimeoutMs: 250 });
    const exited = new Promise<ProcessExitError>((resolve) => rpc.once("exit", resolve));
    await rpc.request("graceful-stop", { delayMs: 200 });
    await rpc.stop();
    const error = await exited;
    expect(error.exitCode).toBe(0);
    expect(error.signal).toBeNull();
    expect(error.lastStderrLine).toBe("session saved");
  });

  test("running process records include the owner, group, and start identity", async () => {
    const rpc = connection();
    await rpc.request("ping", {});
    const files = readdirSync(recordDir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(recordDir, files[0]!), "utf8"));
    expect(record.ownerPid).toBe(process.pid);
    expect(record.childPid).toBe(rpc.pid);
    expect(record.processGroupId).toBe(rpc.pid);
    expect(record.childStartIdentity).toBeString();
    expect(record.recordedAt).toBeString();
    await rpc.stop();
    expect(readdirSync(recordDir)).toEqual([]);
  });

  test("an unavailable record directory prevents spawning a child", () => {
    const file = join(recordDir, "not-a-directory");
    writeFileSync(file, "occupied");
    const rpc = connection({ processRecordDir: file }, false);
    try {
      expect(() => rpc.start()).toThrow();
      expect(rpc.pid).toBeUndefined();
    } finally { rmSync(file); }
  });

  test("writes resume after backpressure without losing or reordering frames", async () => {
    const rpc = connection();
    const events = diagnostics(rpc);
    const payload = "🦜".repeat(32 * 1024);
    const params = Array.from({ length: 12 }, (_, index) => ({ index, payload }));
    const replies = await Promise.all(params.map((value) => rpc.request("echo", value)));
    expect(replies).toEqual(params);
    expect(rpc.queuedWriteBytes).toBe(0);
    expect(events.some((event) => event.kind === "write-blocked")).toBe(true);
  });

  test("a crash while stdin is blocked still rejects every request with final stderr", async () => {
    const rpc = connection({ args: [fake, "--no-read", "--crash-after-ready"] }, false);
    const ready = new Promise<void>((resolve) => rpc.once("notification", () => resolve()));
    rpc.start();
    pids.push(rpc.pid!);
    await ready;
    const payload = "x".repeat(1024 * 1024);
    const results = await Promise.allSettled([rpc.request("echo", { payload }), rpc.request("echo", { payload })]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("expected rejection");
      expect(result.reason).toBeInstanceOf(ProcessExitError);
      expect(result.reason.lastStderrLine).toBe("blocked stdin crash");
      expect(result.reason.exitCode).toBe(23);
    }
  });

  test("cancelling a queued request removes its unsent frame", async () => {
    const rpc = connection({ args: [fake, "--no-read"] }, false);
    const ready = new Promise<void>((resolve) => rpc.once("notification", () => resolve()));
    rpc.start();
    pids.push(rpc.pid!);
    await ready;
    const active = failure(rpc.request("echo", { payload: "x".repeat(1024 * 1024) }));
    const before = rpc.queuedWriteBytes;
    const controller = new AbortController();
    const queued = failure(rpc.request("echo", { payload: "y".repeat(1024 * 1024) }, { signal: controller.signal }));
    expect(rpc.queuedWriteBytes).toBeGreaterThan(before);
    controller.abort(new Error("cancel queued"));
    expect((await queued).message).toBe("cancel queued");
    expect(rpc.queuedWriteBytes).toBe(before);
    await rpc.stop();
    expect(await active).toBeInstanceOf(ProcessExitError);
  });

  test("a thrown handler and an unserializable result each receive -32603", async () => {
    const rpc = connection();
    rpc.onRequest(async () => { throw new Error("private handler detail"); });
    expect(await rpc.request("ask", {})).toEqual({ error: { code: -32603, message: "Internal error" } });
    rpc.onRequest(async () => { const cycle: unknown[] = []; cycle.push(cycle); return cycle; });
    expect(await rpc.request("ask", { numericId: true })).toEqual({ error: { code: -32603, message: "Internal error" } });
  });

  test("consecutive bad lines fail the connection, but good lines reset the count", async () => {
    const rpc = connection({ maxBadLines: 2 });
    await rpc.request("bad-between", {});
    await rpc.request("bad-between", {});
    const error = await failure(rpc.request("bad-lines", { count: 2 }));
    expect(error).toBeInstanceOf(ProcessExitError);
    expect(error.message).toContain("2 consecutive bad lines");
  });

  test("oversized unterminated input is fatal", async () => {
    const rpc = connection({ maxLineBytes: 256 });
    const error = await failure(rpc.request("oversize", { bytes: 257 }));
    expect(error).toBeInstanceOf(ProcessExitError);
    expect(error.message).toContain("line exceeds 256 bytes");
  });

  test("invalid UTF-8 is diagnosed instead of silently corrupted", async () => {
    const rpc = connection();
    const events = diagnostics(rpc);
    await rpc.request("invalid-utf8", {});
    expect(events.filter((event) => event.kind === "bad-line")).toHaveLength(1);
  });

  test("decode validates results at the boundary and failure does not kill the connection", async () => {
    const rpc = connection();
    expect(await rpc.request("ping", {}, { decode: (value) => String(value).toUpperCase() })).toBe("PONG");
    await expect(rpc.request("ping", {}, { decode: () => { throw new Error("bad result"); } })).rejects.toThrow("bad result");
    expect(await rpc.request("ping", {})).toBe("pong");
  });

  test("abort removes pending requests and already aborted calls never write", async () => {
    const rpc = connection();
    const controller = new AbortController();
    const pending = failure(rpc.request("stall", {}, { signal: controller.signal }));
    controller.abort(new Error("cancelled"));
    expect((await pending).message).toBe("cancelled");
    expect(rpc.pendingRequestCount).toBe(0);
    await expect(rpc.request("ping", {}, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(await rpc.request("ping", {})).toBe("pong");
  });

  test("shutdown aborts inbound handlers and ignores their late completions after restart", async () => {
    const rpc = connection();
    let complete!: (value: unknown) => void;
    let observedSignal!: AbortSignal;
    const entered = new Promise<void>((resolve) => {
      rpc.onRequest(({ signal }) => {
        observedSignal = signal;
        resolve();
        return new Promise((resolve) => { complete = resolve; });
      });
    });
    const pending = rpc.request("ask", {}).catch((error) => error);
    await entered;
    await rpc.stop();
    expect(observedSignal.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(ProcessExitError);
    rpc.start();
    pids.push(rpc.pid!);
    complete("stale");
    expect(await rpc.request("ping", {})).toBe("pong");
  });

  test("restart never reuses request ids and emits one exit per process", async () => {
    const rpc = connection();
    const exits: unknown[] = [];
    rpc.on("exit", (error) => exits.push(error));
    const first = await rpc.request<string>("request-id", {});
    await rpc.stop();
    rpc.start();
    pids.push(rpc.pid!);
    const second = await rpc.request<string>("request-id", {});
    expect(Number(second)).toBeGreaterThan(Number(first));
    await rpc.stop();
    expect(exits).toHaveLength(2);
  });

  test("missing executables reject pending requests and emit one useful exit", async () => {
    const rpc = connection({ command: "/definitely-not-a-kru-executable" });
    const exits: ProcessExitError[] = [];
    rpc.on("exit", (error) => exits.push(error));
    const error = await failure(rpc.request("ping", {}));
    expect(error).toBeInstanceOf(ProcessExitError);
    expect(error.message).toContain("ENOENT");
    expect(exits).toHaveLength(1);
  });

  test("lifecycle, configuration and outgoing serialization errors fail cleanly", async () => {
    expect(() => connection({ maxLineBytes: 0 })).toThrow("maxLineBytes");
    expect(() => connection({ stopGraceMs: -1 })).toThrow("stopGraceMs");
    expect(() => connection({ stderrDrainTimeoutMs: 0.5 })).toThrow("stderrDrainTimeoutMs");
    const rpc = connection({}, false);
    await expect(rpc.request("ping", {})).rejects.toThrow("not running");
    await rpc.stop();
    rpc.start();
    pids.push(rpc.pid!);
    expect(() => rpc.start()).toThrow("already started");
    await expect(rpc.request("ping", {}, { timeoutMs: 0 })).rejects.toThrow("timeoutMs");
    const circular: unknown[] = []; circular.push(circular);
    await expect(rpc.request("echo", circular)).rejects.toThrow();
    await expect(rpc.notify("echo", circular)).rejects.toThrow();
    expect(rpc.pendingRequestCount).toBe(0);
  });
});
