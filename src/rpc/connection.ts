import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { ByteLineFramer } from "./framing";
import { ProcessExitError, RequestTimeoutError, RpcResponseError } from "./errors";
import { terminateTree } from "./process-tree";
import { WriteQueue } from "./write-queue";
import { prepareProcessRecordDir, writeProcessRecord, removeProcessRecord } from "./process-record";

export interface RpcConnectionOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  requestTimeoutMs: number;
  maxLineBytes: number;
  maxQueuedWriteBytes: number;
  maxBadLines: number;
  jsonrpcField?: boolean;
  stopGraceMs?: number;
  stderrDrainTimeoutMs?: number;
  processRecordDir?: string;
}

export type Diagnostic =
  | { kind: "stderr"; line: string }
  | { kind: "bad-line"; line: string; reason: string; consecutive: number }
  | { kind: "late-response"; id: string | number; method: string; delayMs: number }
  | { kind: "write-blocked"; queuedBytes: number };

export interface RpcRequest {
  id: string | number;
  method: string;
  params: unknown;
  signal: AbortSignal;
}

export interface RpcRequestOptions<T> {
  timeoutMs?: number;
  signal?: AbortSignal;
  decode?: (value: unknown) => T;
}

type Id = string | number;
type Message = Record<string, unknown>;
type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  writeController: AbortController;
};

interface Run {
  child: ChildProcessWithoutNullStreams;
  writer: WriteQueue;
  framer: ByteLineFramer;
  pending: Map<Id, Pending>;
  late: Map<Id, { method: string; timedOutAt: number }>;
  incoming: Map<Id, AbortController>;
  closing: boolean;
  finalized: boolean;
  badLines: number;
  stderrDecoder: StringDecoder;
  stderrTail: string;
  lastStderrLine: string | null;
  stderrEnded: Promise<void>;
  endStderr: () => void;
  exited: Promise<void>;
  markExited: () => void;
  done: Promise<void>;
  finish: () => void;
  code: number | null;
  signal: NodeJS.Signals | null;
  cause: Error | undefined;
  stopped: boolean;
  recordPath: string | undefined;
}

const MAX_LATE_IDS = 1_024;
const STDERR_TAIL_CHARS = 8_192;
const decoder = new TextDecoder("utf-8", { fatal: true });
const isId = (id: unknown): id is Id =>
  typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

export class RpcConnection extends EventEmitter<{
  notification: [{ method: string; params: unknown }];
  diagnostic: [Diagnostic];
  exit: [ProcessExitError];
}> {
  private run: Run | undefined;
  private nextId = 0n;
  private requestHandler: ((request: RpcRequest) => Promise<unknown>) | undefined;
  private readonly options: RpcConnectionOptions;

  constructor(options: RpcConnectionOptions) {
    super();
    for (const key of ["requestTimeoutMs", "maxLineBytes", "maxQueuedWriteBytes", "maxBadLines"] as const) {
      if (!Number.isSafeInteger(options[key]) || options[key] <= 0) throw new RangeError(`${key} must be a positive safe integer`);
    }
    for (const key of ["stopGraceMs", "stderrDrainTimeoutMs"] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)) {
        throw new RangeError(`${key} must be an integer between 0 and 2147483647`);
      }
    }
    if (options.jsonrpcField !== undefined && typeof options.jsonrpcField !== "boolean") throw new TypeError("jsonrpcField must be a boolean");
    if (!options.command) throw new TypeError("command must not be empty");
    this.options = { ...options, args: [...options.args], ...(options.env ? { env: { ...options.env } } : {}) };
  }

  /** Observability for callers and lifecycle hygiene checks. */
  get pendingRequestCount(): number { return this.run?.pending.size ?? 0; }
  get queuedWriteBytes(): number { return this.run?.writer.queuedBytes ?? 0; }
  get pid(): number | undefined { return this.run?.finalized ? undefined : this.run?.child.pid; }

  start(): void {
    if (this.run && !this.run.finalized) throw new Error("RPC connection is already started or stopping");
    const recordDir = prepareProcessRecordDir(this.options.processRecordDir);
    const child = spawn(this.options.command, this.options.args, {
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let endStderr!: () => void;
    let markExited!: () => void;
    let finish!: () => void;
    const run: Run = {
      child,
      writer: new WriteQueue(child.stdin, this.options.maxQueuedWriteBytes, (queuedBytes) => {
        if (this.isCurrent(run)) this.emit("diagnostic", { kind: "write-blocked", queuedBytes });
      }, () => { if (this.isCurrent(run)) this.close(run); }),
      framer: new ByteLineFramer(this.options.maxLineBytes),
      pending: new Map(), late: new Map(), incoming: new Map(),
      closing: false, finalized: false, badLines: 0,
      stderrDecoder: new StringDecoder("utf8"), stderrTail: "", lastStderrLine: null,
      stderrEnded: new Promise<void>((resolve) => { endStderr = resolve; }),
      endStderr: () => endStderr(),
      exited: new Promise<void>((resolve) => { markExited = resolve; }),
      markExited: () => markExited(),
      done: new Promise<void>((resolve) => { finish = resolve; }),
      finish: () => finish(),
      code: null, signal: null, cause: undefined, stopped: false, recordPath: undefined,
    };
    this.run = run;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.isCurrent(run) || run.closing) return;
      try {
        run.framer.push(chunk, (line) => {
          this.handleLine(run, line);
          return !run.closing;
        });
      } catch (error) { this.close(run, asError(error)); }
    });
    child.stdout.on("end", () => {
      if (!this.isCurrent(run) || run.closing) return;
      if (run.framer.hasPartialLine) this.badLine(run, "", "stdout ended with an incomplete line");
      this.close(run, new Error("RPC stdout closed"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.isCurrent(run)) this.readStderr(run, run.stderrDecoder.write(chunk));
    });
    child.stderr.once("end", () => {
      if (this.isCurrent(run)) {
        this.readStderr(run, run.stderrDecoder.end());
        this.flushStderr(run);
      }
      run.endStderr();
    });
    child.once("error", (error) => {
      run.markExited();
      if (this.isCurrent(run)) this.close(run, error);
    });
    child.once("exit", (code, signal) => {
      run.code = code;
      run.signal = signal;
      run.markExited();
      if (this.isCurrent(run)) this.close(run);
    });
    child.stdin.on("error", () => {
      // EPIPE commonly precedes exit. Preserve its actual code and final stderr.
      if (this.isCurrent(run)) this.close(run);
    });
    child.stdout.on("error", (error) => { if (this.isCurrent(run)) this.close(run, error); });
    child.stderr.on("error", () => run.endStderr());
    if (child.pid) {
      try { run.recordPath = writeProcessRecord(recordDir, child.pid); }
      catch (error) { this.close(run, asError(error)); }
    }
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run || run.finalized) return;
    run.stopped = true;
    this.close(run);
    await run.done;
  }

  request<T = unknown>(method: string, params: unknown, options: RpcRequestOptions<T> = {}): Promise<T> {
    const run = this.run;
    if (!run || run.closing || run.finalized) return Promise.reject(new Error("RPC connection is not running"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError("timeoutMs must be a positive safe integer"));
    const id = String(++this.nextId);
    let data: Buffer;
    try { data = this.encode({ id, method, params }); }
    catch (error) { return Promise.reject(error); }
    return new Promise<T>((resolve, reject) => {
      const writeController = new AbortController();
      const abandon = (error: unknown, timedOut: boolean) => {
        if (!run.pending.delete(id)) return;
        pending.cleanup();
        if (timedOut) {
          run.late.set(id, { method, timedOutAt: performance.now() });
          if (run.late.size > MAX_LATE_IDS) run.late.delete(run.late.keys().next().value!);
        }
        writeController.abort(error);
        reject(error);
      };
      const abort = () => abandon(options.signal?.reason, false);
      const timer = setTimeout(() => abandon(new RequestTimeoutError(method, timeoutMs), true), timeoutMs);
      const pending: Pending = {
        method, reject, writeController,
        resolve: (value) => {
          try { resolve(options.decode ? options.decode(value) : value as T); }
          catch (error) { reject(error); }
        },
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      };
      run.pending.set(id, pending);
      options.signal?.addEventListener("abort", abort, { once: true });
      void run.writer.send(data, writeController.signal).catch((error) => {
        if (!run.closing) abandon(error, false);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    const run = this.run;
    if (!run || run.closing || run.finalized) return Promise.reject(new Error("RPC connection is not running"));
    try { return run.writer.send(this.encode({ method, ...(params === undefined ? {} : { params }) })); }
    catch (error) { return Promise.reject(error); }
  }

  onRequest(handler: (request: RpcRequest) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  private isCurrent(run: Run): boolean { return this.run === run && !run.finalized; }

  private encode(message: Message): Buffer {
    const envelope = this.options.jsonrpcField === false ? message : { jsonrpc: "2.0", ...message };
    const data = Buffer.from(JSON.stringify(envelope) + "\n");
    if (data.length - 1 > this.options.maxLineBytes) throw new Error(`outgoing line exceeds ${this.options.maxLineBytes} bytes`);
    return data;
  }

  private handleLine(run: Run, line: Buffer): void {
    let message: Message;
    try {
      const value: unknown = JSON.parse(decoder.decode(line));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON-RPC object");
      message = value as Message;
      if ("jsonrpc" in message && message.jsonrpc !== "2.0") throw new Error("expected jsonrpc: 2.0 or an omitted field");
      if (typeof message.method === "string") {
        if ("id" in message && !isId(message.id)) throw new Error("invalid request id");
      } else {
        if (!isId(message.id) || (("result" in message) === ("error" in message))) throw new Error("invalid response");
        if ("error" in message) {
          const error = message.error as Message | null;
          if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") throw new Error("invalid error response");
        }
      }
    } catch (error) {
      this.badLine(run, line.toString("utf8", 0, 512), asError(error).message);
      return;
    }
    run.badLines = 0;
    if (typeof message.method === "string") {
      if (isId(message.id)) this.handleRequest(run, message.id, message.method, message.params);
      else this.emit("notification", { method: message.method, params: message.params });
      return;
    }
    const id = message.id as Id;
    const pending = run.pending.get(id);
    if (pending) {
      run.pending.delete(id);
      pending.cleanup();
      if ("error" in message) {
        const error = message.error as { code: number; message: string; data?: unknown };
        pending.reject(new RpcResponseError(error.code, error.message, error.data));
      } else pending.resolve(message.result);
    } else {
      const late = run.late.get(id);
      if (late) {
        run.late.delete(id);
        this.emit("diagnostic", { kind: "late-response", id, method: late.method, delayMs: performance.now() - late.timedOutAt });
      }
    }
  }

  private handleRequest(run: Run, id: Id, method: string, params: unknown): void {
    if (run.incoming.has(id)) {
      this.badLine(run, "", "duplicate active request id");
      return;
    }
    const controller = new AbortController();
    run.incoming.set(id, controller);
    const handler = this.requestHandler;
    void (async () => {
      let response: Message;
      if (!handler) response = { error: { code: -32601, message: `Method not found: ${method}` } };
      else {
        try {
          const result = await handler({ id, method, params, signal: controller.signal });
          response = { result: result ?? null };
          // Serialization failures are handler failures too, not unhandled promises.
          this.encode({ id, ...response });
        } catch {
          response = { error: { code: -32603, message: "Internal error" } };
        }
      }
      if (!this.isCurrent(run) || run.closing || controller.signal.aborted) return;
      await run.writer.send(this.encode({ id, ...response }));
    })().catch((error) => {
      // Losing a reply makes the peer wait forever: fail the connection explicitly.
      if (this.isCurrent(run) && !run.closing) this.close(run, asError(error));
    }).finally(() => run.incoming.delete(id));
  }

  private badLine(run: Run, line: string, reason: string): void {
    this.emit("diagnostic", { kind: "bad-line", line, reason, consecutive: ++run.badLines });
    if (run.badLines >= this.options.maxBadLines) this.close(run, new Error(`received ${run.badLines} consecutive bad lines`));
  }

  private readStderr(run: Run, text: string): void {
    for (const [index, part] of text.split("\n").entries()) {
      if (index > 0) this.flushStderr(run);
      run.stderrTail = (run.stderrTail + part).slice(-STDERR_TAIL_CHARS);
    }
  }

  private flushStderr(run: Run): void {
    const line = run.stderrTail.replace(/\r$/, "");
    if (line) {
      run.lastStderrLine = line;
      this.emit("diagnostic", { kind: "stderr", line });
    }
    run.stderrTail = "";
  }

  private close(run: Run, cause?: Error): void {
    if (!this.isCurrent(run) || run.closing) return;
    run.closing = true;
    run.cause = cause;
    run.framer.clear();
    for (const pending of run.pending.values()) pending.cleanup();
    for (const controller of run.incoming.values()) controller.abort(new Error("RPC process exited"));
    run.incoming.clear();
    // Reject writes immediately; requests are rejected only after collecting stderr.
    run.writer.close(new Error("RPC connection is closing"));
    void this.finishRun(run);
  }

  private async finishRun(run: Run): Promise<void> {
    let treeTerminated = true;
    try { await terminateTree(run.child, this.options.stopGraceMs ?? 3_000); }
    catch (error) { treeTerminated = false; run.cause ??= asError(error); run.child.kill("SIGKILL"); }
    await run.exited;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run.stderrEnded, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.stderrDrainTimeoutMs ?? 500); })]);
    clearTimeout(timer);
    this.flushStderr(run);
    if (treeTerminated && run.recordPath) {
      try { removeProcessRecord(run.recordPath); }
      catch (error) { run.cause ??= asError(error); }
    }
    const exitSummary = `RPC process exited ${run.signal ? `with signal ${run.signal}` : `with code ${run.code}`}`;
    const reason = run.stopped ? "RPC process stopped" :
      run.cause ? `${run.cause.message} (${exitSummary})` : exitSummary;
    const error = new ProcessExitError(run.code, run.signal, run.lastStderrLine, reason,
      run.cause ? { cause: run.cause } : undefined);
    for (const pending of run.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    run.pending.clear();
    run.late.clear();
    run.child.stdin.destroy();
    run.child.stdout.destroy();
    run.child.stderr.destroy();
    run.finalized = true;
    run.finish();
    this.emit("exit", error);
  }
}
