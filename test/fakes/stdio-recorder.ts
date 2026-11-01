// Transparent byte recorder: the smoke test compares what actually reaches Codex.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Transform } from "node:stream";

const [capture, command, ...args] = process.argv.slice(2);
if (!capture || !command) throw new Error("expected capture path and command");
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
const recorder = new Transform({
  transform(chunk: Buffer, _encoding, callback) {
    try { appendFileSync(capture, chunk); callback(null, chunk); }
    catch (error) { callback(error as Error); }
  },
});
process.stdin.pipe(recorder).pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  process.stdin.destroy();
});
