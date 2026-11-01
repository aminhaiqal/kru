// A deterministic JSON-RPC peer. No providers, credentials, or network access.
import { spawn } from "node:child_process";
import { ByteLineFramer } from "../../src/rpc/framing";

type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const framer = new ByteLineFramer(64 * 1024 * 1024);
const send = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + "\n"); };
const result = (id: string | number, value: unknown): void => send({ jsonrpc: "2.0", id, result: value });
const notification = (method: string, params: unknown): string => JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
const reverseRequests: Message[] = [];
const callbacks = new Map<string | number, string | number>();
let callbackId = 0;

function handle(message: Message): void {
  if (!message.method) {
    if (message.id === undefined) return;
    const original = callbacks.get(message.id);
    if (original !== undefined) {
      callbacks.delete(message.id);
      result(original, message.error ? { error: message.error } : { result: message.result });
    }
    return;
  }
  const id = message.id;
  const params = message.params ?? {};
  if (id === undefined) return;
  switch (message.method) {
    case "ping":
      if (!process.argv.includes("--stall")) result(id, "pong");
      break;
    case "echo": result(id, message.params); break;
    case "request-id": result(id, id); break;
    case "reverse": {
      reverseRequests.push(message);
      if (reverseRequests.length === 100) {
        // Seeded Fisher-Yates: deliberately reordered, reproducible on every run.
        let seed = 42;
        for (let i = reverseRequests.length - 1; i > 0; i--) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const j = seed % (i + 1);
          [reverseRequests[i], reverseRequests[j]] = [reverseRequests[j]!, reverseRequests[i]!];
        }
        for (const request of reverseRequests.splice(0)) result(request.id!, request.params);
      }
      break;
    }
    case "error": send({ jsonrpc: "2.0", id, error: { code: -32042, message: "scripted failure", data: { retry: false } } }); break;
    case "stall": break;
    case "notifications":
      for (let i = 0; i < 5; i++) process.stdout.write(notification("tick", { index: i }));
      result(id, null);
      break;
    case "ask": {
      const requestId = params.numericId === true ? ++callbackId : `fake-${++callbackId}`;
      callbacks.set(requestId, id);
      send({ jsonrpc: "2.0", id: requestId, method: "question", params: { text: "hello" } });
      break;
    }
    case "fragments": {
      const bytes = Buffer.from(notification("fragment", { text: "kru 🦜 café" }));
      const splitAt = bytes.indexOf(Buffer.from("🦜")) + 2;
      process.stdout.write(bytes.subarray(0, splitAt));
      setTimeout(() => {
        process.stdout.write(Buffer.concat([
          bytes.subarray(splitAt),
          Buffer.from(notification("merged", { index: 1 }) + notification("merged", { index: 2 })),
          Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: null }) + "\n"),
        ]));
      }, 5);
      break;
    }
    case "bad-between":
      process.stdout.write(notification("good", { index: 1 }) + "not-json\n" + notification("good", { index: 2 }) + JSON.stringify({ jsonrpc: "2.0", id, result: null }) + "\n");
      break;
    case "bad-lines": process.stdout.write("broken\n".repeat(Number(params.count ?? 3))); break;
    case "invalid-utf8":
      process.stdout.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"bad","params":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
      result(id, null);
      break;
    case "oversize": process.stdout.write("x".repeat(Number(params.bytes))); break;
    case "stderr": process.stderr.write("diagnostic 🦜\n"); result(id, "ok"); break;
    case "late": setTimeout(() => result(id, "late"), Number(params.delayMs ?? 80)); break;
    case "crash":
      process.stderr.write("first error\nfinal crash detail", () => process.exit(23));
      break;
    case "descendant": {
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.once("data", () => result(id, { pid: child.pid }));
      // Stay alive to reap the resistant child after the group's forced kill.
      process.on("SIGTERM", () => {});
      break;
    }
    default: send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown fake method" } });
  }
}

if (process.argv.includes("--no-read")) {
  send({ jsonrpc: "2.0", method: "ready", params: null });
  if (process.argv.includes("--crash-after-ready")) {
    setTimeout(() => process.stderr.write("blocked stdin crash", () => process.exit(23)), 30);
  }
  setInterval(() => {}, 1_000);
} else {
  process.stdin.on("data", (chunk: Buffer) => framer.push(chunk, (line) => handle(JSON.parse(line.toString("utf8")) as Message)));
}
