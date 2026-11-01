// Subprocess fixture: exercise terminal signals and SIGKILL without killing tests.
import { fileURLToPath } from "node:url";
import { RpcConnection, installRpcSignalHandlers } from "../../src/rpc";

const connections = Array.from({ length: 2 }, () => new RpcConnection({
  command: process.execPath,
  args: [fileURLToPath(new URL("./fake-agent.ts", import.meta.url))],
  requestTimeoutMs: 10_000, maxLineBytes: 1024 * 1024,
  maxQueuedWriteBytes: 1024 * 1024, maxBadLines: 3,
  stopGraceMs: 100, stderrDrainTimeoutMs: 50, processRecordDir: process.argv[2]!,
}));
const shutdown = installRpcSignalHandlers(connections);
try {
  for (const connection of connections) connection.start();
  await Promise.all(connections.map((connection) => connection.request("ping", {})));
  await Promise.all(connections.map((connection) => connection.request("graceful-stop", { delayMs: 40 })));
  console.log(JSON.stringify({ pids: connections.map((connection) => connection.pid) }));
  await Promise.allSettled(connections.map((connection) => connection.request("stall", {})));
  process.exitCode = shutdown.exitCode ?? 1;
} finally {
  await Promise.all(connections.map((connection) => connection.stop()));
  shutdown.dispose();
}
